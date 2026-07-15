// systems/atow-battletech/module/mech-attack.js
// Version 0.1.3
// Centralized mech attack logic (to-hit, range bands, chat card).
// UI-agnostic core, with an optional UI prompt helper at the bottom.

import { enqueueActorAudioCues } from "./audio-helper.js";

const SYSTEM_ID = "atow-battletech";// ------------------------------------------------------------
const VEHICLE_ATTACK_TEMPLATE = `systems/${SYSTEM_ID}/templates/vehicle-attack.hbs`;
const TAGGED_STATUS_ID = "tagged";
const NARC_STATUS_ID = "narc";
const ARROW_IV_INDIRECT_FLAG = "arrowIVIndirectStrikes";
const ARROW_IV_INDIRECT_MIN_HEXES = 17;
const ARROW_IV_LAUNCH_VFX = "jb2a.smoke.puff.side.grey";
const ARROW_IV_IMPACT_VFX = "jb2a.explosion.08.orange";
const ARROW_IV_LAUNCH_SFX = `systems/${SYSTEM_ID}/assets/sounds/weapon-missile-medium.ogg`;
const ARROW_IV_IMPACT_SFX = `systems/${SYSTEM_ID}/assets/sounds/effect-explosion1.ogg`;

function ensureAttackDialogHandlebarsHelpers() {
  const handlebarsInstances = [
    globalThis.Handlebars,
    globalThis.foundry?.applications?.handlebars?.Handlebars
  ].filter(Boolean);

  for (const hbs of handlebarsInstances) {
    hbs.registerHelper?.("ifEq", function (a, b, options) {
      return (a === b) ? options.fn(this) : options.inverse(this);
    });
    hbs.registerHelper?.("signed", function (n) {
      const value = Number(n ?? 0);
      if (!Number.isFinite(value)) return "0";
      return value > 0 ? `+${value}` : `${value}`;
    });
  }
}

function getATOWSocket() {
  return game?.[SYSTEM_ID]?.socket ?? null;
}

function isWeaponFireLimitEnforced() {
  const enforce = game.settings.get(SYSTEM_ID, "enforceWeaponFireLimits");
  if (enforce === false) return false;

  // Legacy compatibility with the earlier inverse test-only setting.
  try {
    const legacyIgnore = game.settings.get(SYSTEM_ID, "ignoreWeaponFireLimits");
    if (legacyIgnore === true) return false;
  } catch (_) {}

  return true;
}

function getCombatTurnStamp() {
  return `${game.combat?.id ?? "no-combat"}:${game.combat?.round ?? 0}:${game.combat?.turn ?? 0}`;
}

if (!globalThis.__ATOW_BT_WEAPON_FIRE_TRACKER__) {
  globalThis.__ATOW_BT_WEAPON_FIRE_TRACKER__ = new Map();
}

function normalizeWeaponFireKeys(raw) {
  if (Array.isArray(raw?.keys)) {
    const keys = new Set();
    for (const key of raw.keys) {
      const normalized = String(key ?? "").trim();
      if (normalized) keys.add(normalized);
    }
    return Array.from(keys);
  }

  const keys = new Set();

  if (Array.isArray(raw?.fired)) {
    for (const key of raw.fired) {
      const normalized = String(key ?? "").trim();
      if (normalized) keys.add(normalized);
    }
  } else if (raw?.fired && typeof raw.fired === "object") {
    for (const [key, value] of Object.entries(raw.fired)) {
      const normalized = String(key ?? "").trim();
      if (normalized && value) keys.add(normalized);
    }
  }

  return Array.from(keys);
}

function getWeaponFireTrackerTarget(actor, opts = {}) {
  const activeCombatantToken = game.combat?.combatant?.token ?? null;
  if (activeCombatantToken?.setFlag) {
    const activeActorId = String(activeCombatantToken?.actor?.id ?? activeCombatantToken?.baseActor?.id ?? "");
    const actorId = String(actor?.id ?? "");
    if (activeActorId && actorId && activeActorId === actorId) return activeCombatantToken;
  }

  const tokenDoc = opts?.attackerToken?.document ?? opts?.attackerToken ?? null;
  if (game.combat?.started) {
    if (tokenDoc?.setFlag) return tokenDoc;
    const activeTokens = actor?.getActiveTokens?.(true, true) ?? actor?.getActiveTokens?.() ?? [];
    for (const tok of activeTokens) {
      const doc = tok?.document ?? tok;
      if (doc?.setFlag) return doc;
    }
  }

  if (tokenDoc?.setFlag) return tokenDoc;
  return actor ?? null;
}

function getWeaponFireTrackerTargets(actor, opts = {}) {
  if (game.combat?.started) {
    const primary = getWeaponFireTrackerTarget(actor, opts);
    return primary?.setFlag ? [primary] : [];
  }

  const docs = new Set();

  const primary = getWeaponFireTrackerTarget(actor, opts);
  if (primary?.setFlag) docs.add(primary);

  const tokenDoc = opts?.attackerToken?.document ?? opts?.attackerToken ?? null;
  if (tokenDoc?.setFlag) docs.add(tokenDoc);

  const activeCombatantToken = game.combat?.combatant?.token ?? null;
  const activeActorId = String(activeCombatantToken?.actor?.id ?? activeCombatantToken?.baseActor?.id ?? "");
  const actorId = String(actor?.id ?? "");
  if (activeCombatantToken?.setFlag && activeActorId && actorId && activeActorId === actorId) {
    docs.add(activeCombatantToken);
  }

  if (actor?.setFlag) docs.add(actor);

  const worldActor = actor?.id ? game.actors?.get?.(actor.id) ?? null : null;
  if (worldActor?.setFlag) docs.add(worldActor);

  for (const tok of actor?.getActiveTokens?.(true, true) ?? actor?.getActiveTokens?.() ?? []) {
    const doc = tok?.document ?? tok;
    if (doc?.setFlag) docs.add(doc);
  }

  return Array.from(docs);
}

function getWeaponFireCacheKey(target) {
  return String(target?.uuid ?? target?.id ?? "");
}

function getCachedWeaponFireTracker(target) {
  const key = getWeaponFireCacheKey(target);
  if (!key) return { stamp: "", keys: [] };
  const cached = globalThis.__ATOW_BT_WEAPON_FIRE_TRACKER__?.get?.(key) ?? null;
  const stamp = String(cached?.stamp ?? "");
  const keysList = normalizeWeaponFireKeys(cached);
  return { stamp, keys: keysList };
}

function setCachedWeaponFireTracker(target, tracker) {
  const key = getWeaponFireCacheKey(target);
  if (!key) return;
  const keysList = normalizeWeaponFireKeys(tracker);
  globalThis.__ATOW_BT_WEAPON_FIRE_TRACKER__?.set?.(key, {
    stamp: String(tracker?.stamp ?? ""),
    keys: keysList
  });
}

function getWeaponFireTracker(actor, opts = {}) {
  const target = getWeaponFireTrackerTarget(actor, opts);
  const raw = target?.getFlag?.(SYSTEM_ID, "weaponFireTracker") ?? target?.flags?.[SYSTEM_ID]?.weaponFireTracker ?? null;
  const flagStamp = String(raw?.stamp ?? "");
  const flagKeys = normalizeWeaponFireKeys(raw);
  const cached = getCachedWeaponFireTracker(target);

  if (flagStamp) {
    const tracker = { stamp: flagStamp, keys: flagKeys };
    setCachedWeaponFireTracker(target, tracker);
    return tracker;
  }

  return cached;
}

function getWeaponFireKey(actor, weaponItem, opts = {}) {
  const explicit = String(opts?.weaponFireKey ?? "").trim();
  if (explicit) return explicit;

  const uuid = String(weaponItem?.uuid ?? weaponItem?.itemUuid ?? "").trim();
  if (uuid) return uuid;

  const id = String(weaponItem?.id ?? weaponItem?._id ?? "").trim();
  if (id) return `actor:${actor?.id ?? "unknown"}:item:${id}`;

  const name = String(weaponItem?.name ?? "").trim().toLowerCase();
  if (name) return `actor:${actor?.id ?? "unknown"}:name:${name}`;

  return "";
}

function hasWeaponFiredThisTurn(actor, weaponItem, opts = {}) {
  if (!game.combat?.started) return false;
  if (!isWeaponFireLimitEnforced()) return false;

  const target = getWeaponFireTrackerTarget(actor, opts);
  const currentStamp = getCombatTurnStamp();
  const targetTurnStamp = String(target?.getFlag?.(SYSTEM_ID, "turnStamp") ?? "");
  const consumedThisTurn = target?.getFlag?.(SYSTEM_ID, "weaponFireConsumedThisTurn");
  const isFreshTurn = (targetTurnStamp !== currentStamp) || (consumedThisTurn !== true);
  if (isFreshTurn) return false;

  const key = getWeaponFireKey(actor, weaponItem, opts);
  if (!key) return false;

  const tracker = getWeaponFireTracker(actor, opts);
  const firedSet = new Set(tracker.keys ?? []);
  if (tracker.stamp !== currentStamp) return false;
  return firedSet.has(key);
}

async function markWeaponFiredThisTurn(actor, weaponItem, opts = {}) {
  if (!game.combat?.started) return;
  if (!isWeaponFireLimitEnforced()) return;
  const target = getWeaponFireTrackerTarget(actor, opts);
  if (!target?.setFlag) return;

  const key = getWeaponFireKey(actor, weaponItem, opts);
  if (!key) return;

  const stamp = getCombatTurnStamp();
  const targetTurnStamp = String(target?.getFlag?.(SYSTEM_ID, "turnStamp") ?? "");
  const consumedThisTurn = target?.getFlag?.(SYSTEM_ID, "weaponFireConsumedThisTurn");
  const tracker = getWeaponFireTracker(actor, opts);
  const isFreshTurn = (targetTurnStamp !== stamp) || (consumedThisTurn !== true);
  const reuseExistingKeys = !isFreshTurn && tracker.stamp === stamp;
  const firedSet = new Set(reuseExistingKeys ? (tracker.keys ?? []) : []);
  firedSet.add(key);
  const keys = Array.from(firedSet);

  const targets = getWeaponFireTrackerTargets(actor, opts);
  for (const doc of targets) {
    setCachedWeaponFireTracker(doc, { stamp, keys });
    await doc.unsetFlag?.(SYSTEM_ID, "weaponFireTracker").catch?.(() => {});
    await doc.setFlag(SYSTEM_ID, "weaponFireTracker", { stamp, keys });
    await doc.setFlag(SYSTEM_ID, "weaponFireConsumedThisTurn", true);
  }
}

async function markMovementResetLockedThisTurn(actor, opts = {}) {
  if (!game.combat?.started) return;
  const stamp = getCombatTurnStamp();
  await actor?.setFlag?.(SYSTEM_ID, "movementResetLockedStamp", stamp).catch?.(() => {});
  const tokenDoc = opts?.attackerToken?.document ?? opts?.attackerToken ?? opts?.token?.document ?? opts?.token ?? null;
  await tokenDoc?.setFlag?.(SYSTEM_ID, "movementResetLockedStamp", stamp).catch?.(() => {});
}

function hasActorChargedThisTurn(actor, tokenDoc = null) {
  if (!game.combat?.started) return false;
  const stamp = getCombatTurnStamp();
  const actorStamp = String(actor?.getFlag?.(SYSTEM_ID, "chargeAttackStamp") ?? "");
  const tokenStamp = String(tokenDoc?.getFlag?.(SYSTEM_ID, "chargeAttackStamp") ?? "");
  return actorStamp === stamp || tokenStamp === stamp;
}

function hasAnyWeaponFiredThisTurn(actor, opts = {}) {
  if (!game.combat?.started) return false;
  if (!isWeaponFireLimitEnforced()) return false;
  const target = getWeaponFireTrackerTarget(actor, opts);
  const currentStamp = getCombatTurnStamp();
  const targetTurnStamp = String(target?.getFlag?.(SYSTEM_ID, "turnStamp") ?? "");
  const consumedThisTurn = target?.getFlag?.(SYSTEM_ID, "weaponFireConsumedThisTurn");
  if (targetTurnStamp !== currentStamp || consumedThisTurn !== true) return false;
  const tracker = getWeaponFireTracker(actor, opts);
  return tracker.stamp === currentStamp && Array.isArray(tracker.keys) && tracker.keys.length > 0;
}

async function markActorChargedThisTurn(actor, tokenDoc = null) {
  if (!game.combat?.started) return;
  const stamp = getCombatTurnStamp();
  await actor?.setFlag?.(SYSTEM_ID, "chargeAttackStamp", stamp).catch?.(() => {});
  await tokenDoc?.setFlag?.(SYSTEM_ID, "chargeAttackStamp", stamp).catch?.(() => {});
}

async function _resolveActorFromUuid(actorUuid) {
  if (!actorUuid) return null;
  try {
    const doc = await fromUuid(actorUuid);
    return (doc?.documentName === "Actor") ? doc : null;
  } catch (_) {
    return null;
  }
}

async function _resolveSceneFromUuid(sceneUuid) {
  if (!sceneUuid) return canvas?.scene ?? game.scenes?.active ?? null;
  try {
    const doc = await fromUuid(sceneUuid);
    return (doc?.documentName === "Scene") ? doc : null;
  } catch (_) {
    return canvas?.scene ?? game.scenes?.active ?? null;
  }
}

async function _gmApplyDamageToTargetActor(actorUuid, hitLoc, damage, opts = {}) {
  const targetActor = await _resolveActorFromUuid(actorUuid);
  if (!targetActor) return { ok: false, reason: "No target actor" };
  const result = await applyDamageToTargetActor(targetActor, hitLoc, damage, opts);
  await _triggerAmmoExplosionsForDamageResult(targetActor, result, { side: opts?.side });
  return result;
}

async function _gmApplyDamageToVehicleActor(actorUuid, hitLoc, damage, opts = {}) {
  const targetActor = await _resolveActorFromUuid(actorUuid);
  if (!targetActor) return { ok: false, reason: "No target actor" };
  return applyDamageToVehicleActor(targetActor, hitLoc, damage, opts);
}

async function _gmApplyDamageToDropshipActor(actorUuid, hitLoc, damage, opts = {}) {
  const targetActor = await _resolveActorFromUuid(actorUuid);
  if (!targetActor) return { ok: false, reason: "No target actor" };
  return applyDamageToDropshipActor(targetActor, hitLoc, damage, opts);
}

async function _gmApplyDamageToAbominationActor(actorUuid, damage) {
  const targetActor = await _resolveActorFromUuid(actorUuid);
  if (!targetActor) return { ok: false, reason: "No target actor" };
  return applyDamageToAbominationActor(targetActor, damage);
}

async function _gmResolveAmmoExplosionEvent(actorUuid, event = {}) {
  const targetActor = await _resolveActorFromUuid(actorUuid);
  if (!targetActor) return false;
  return _resolveAmmoExplosionEventLocal(targetActor, event);
}

async function _gmApplyActorStatus(actorUuid, statusId, active = true) {
  const targetActor = await _resolveActorFromUuid(actorUuid);
  if (!targetActor) return { ok: false, reason: "No target actor" };
  return applyActorStatus(targetActor, statusId, active);
}

async function _gmAddHeatToActor(actorUuid, amount) {
  const targetActor = await _resolveActorFromUuid(actorUuid);
  if (!targetActor) return { ok: false, reason: "No target actor" };
  await addHeatToActor(targetActor, amount);
  return { ok: true, amount: Math.max(0, Number(amount ?? 0) || 0) };
}

async function _gmScheduleArrowIVIndirectStrike(sceneUuid, strikeData = {}) {
  const scene = await _resolveSceneFromUuid(sceneUuid);
  if (!scene?.setFlag) return { ok: false, reason: "No scene" };
  const existing = scene.getFlag(SYSTEM_ID, ARROW_IV_INDIRECT_FLAG);
  const strikes = Array.isArray(existing) ? foundry.utils.deepClone(existing) : [];
  strikes.push(strikeData);
  await scene.setFlag(SYSTEM_ID, ARROW_IV_INDIRECT_FLAG, strikes);
  return { ok: true, id: strikeData?.id ?? null };
}

function isTAGWeapon(item) {
  const name = String(item?.name ?? item?.system?.name ?? "").trim().toLowerCase();
  return name === "tag";
}

function isNarcMissileBeaconWeapon(item) {
  const name = String(item?.name ?? item?.system?.name ?? "").trim().toLowerCase();
  return name === "narc missile beacon";
}

function isAMSWeapon(item) {
  const name = String(item?.name ?? item?.system?.name ?? "").trim().toLowerCase();
  return name === "ams" || /\banti\s*-?\s*missile\s+system\b/i.test(name);
}

function isArrowIVSystemWeapon(item) {
  const name = String(item?.name ?? item?.system?.name ?? "").trim().toLowerCase();
  return name === "arrow iv system" || name === "arrow iv system (c)";
}

function getStatusDefinition(statusId) {
  try {
    return (CONFIG.statusEffects ?? []).find(e => e?.id === statusId) ?? null;
  } catch (_) {
    return null;
  }
}

function buildTagEffectData(source = {}) {
  const def = getStatusDefinition(TAGGED_STATUS_ID);
  const combat = game.combat?.started ? game.combat : null;
  const attackerToken = source.attackerToken?.document ?? source.attackerToken ?? null;
  const attackerActor = source.attackerActor ?? attackerToken?.actor ?? null;
  const sourceActorUuid = source.attackerActorUuid ?? attackerActor?.uuid ?? null;
  const sourceActorId = source.attackerActorId ?? attackerActor?.id ?? null;
  const sourceTokenUuid = source.attackerTokenUuid ?? attackerToken?.uuid ?? null;
  const sourceTokenId = source.attackerTokenId ?? attackerToken?.id ?? null;
  const attackerCombatant = combat
    ? (combat.combatants?.find?.(c => {
      const tokenId = String(c?.tokenId ?? c?.token?.id ?? "");
      const actorId = String(c?.actorId ?? c?.actor?.id ?? "");
      return (sourceTokenId && tokenId === String(sourceTokenId)) ||
        (sourceActorId && actorId === String(sourceActorId));
    }) ?? null)
    : null;

  return {
    name: def?.name ?? def?.label ?? "Tagged",
    icon: def?.icon ?? `systems/${SYSTEM_ID}/assets/status/tagged.svg`,
    disabled: false,
    statuses: [TAGGED_STATUS_ID],
    flags: {
      core: { statusId: TAGGED_STATUS_ID },
      [SYSTEM_ID]: {
        tag: {
          attackerActorUuid: sourceActorUuid,
          attackerActorId: sourceActorId,
          attackerTokenUuid: sourceTokenUuid,
          attackerTokenId: sourceTokenId,
          attackerCombatantId: attackerCombatant?.id ?? null,
          combatId: combat?.id ?? null,
          appliedRound: combat?.round ?? null,
          appliedTurn: combat?.turn ?? null
        }
      }
    }
  };
}

async function applyTaggedToTargetActor(targetActor, source = {}) {
  if (!targetActor) return { ok: false, reason: "No target actor" };
  if (!game.user?.isGM && !targetActor.isOwner) return { ok: false, reason: "No permission to tag target" };

  const effectData = buildTagEffectData(source);
  const effects = Array.from(targetActor.effects ?? []);
  const matches = effects.filter(e => {
    const sid = (e.getFlag?.("core", "statusId") ?? e.flags?.core?.statusId) ?? null;
    if (sid === TAGGED_STATUS_ID) return true;
    if (e.statuses?.has && e.statuses.has(TAGGED_STATUS_ID)) return true;
    if (Array.isArray(e.statuses) && e.statuses.includes(TAGGED_STATUS_ID)) return true;
    return false;
  });

  if (matches.length) {
    const keep = matches.find(e => !e.disabled) ?? matches[0];
    await keep.update({
      disabled: false,
      statuses: [TAGGED_STATUS_ID],
      flags: foundry.utils.mergeObject(keep.flags ?? {}, effectData.flags ?? {}, { inplace: false })
    });

    for (const e of matches) {
      if (e?.id === keep?.id) continue;
      if (!e.disabled && typeof e.update === "function") await e.update({ disabled: true }).catch(() => {});
      else if (typeof e.delete === "function") await e.delete().catch(() => {});
    }

    return { ok: true, effectId: keep.id, refreshed: true };
  }

  const created = await targetActor.createEmbeddedDocuments("ActiveEffect", [effectData]);
  return { ok: true, effectId: created?.[0]?.id ?? null, refreshed: false };
}

async function _gmApplyTaggedToTargetActor(actorUuid, source = {}) {
  const targetActor = await _resolveActorFromUuid(actorUuid);
  if (!targetActor) return { ok: false, reason: "No target actor" };
  return applyTaggedToTargetActor(targetActor, source);
}

async function applyTaggedToTargetActorAuto(targetActor, source = {}) {
  if (!targetActor) return { ok: false, reason: "No target actor" };
  if (game.user?.isGM || targetActor.isOwner) return applyTaggedToTargetActor(targetActor, source);
  const socket = getATOWSocket();
  if (!socket) return { ok: false, reason: "AToW socket is not ready" };
  return socket.executeAsGM("gmApplyTaggedToTargetActor", targetActor.uuid, source);
}

function _effectHasStatus(effect, statusId) {
  const sid = (effect?.getFlag?.("core", "statusId") ?? effect?.flags?.core?.statusId) ?? null;
  if (sid === statusId) return true;
  if (effect?.statuses?.has?.(statusId)) return true;
  return Array.isArray(effect?.statuses) && effect.statuses.includes(statusId);
}

function _narcEffectForActor(actor) {
  return Array.from(actor?.effects ?? []).find(effect => !effect?.disabled && _effectHasStatus(effect, NARC_STATUS_ID)) ?? null;
}

function _normalizeNarcPods(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(pod => ({ ...pod, loc: String(pod?.loc ?? "").trim().toLowerCase() }))
    .filter(pod => Boolean(pod.loc));
}

function buildNarcEffectData(source = {}) {
  const def = getStatusDefinition(NARC_STATUS_ID);
  const loc = String(source.loc ?? "").trim().toLowerCase();
  return {
    name: def?.name ?? def?.label ?? "Narc'd",
    icon: def?.icon ?? `systems/${SYSTEM_ID}/assets/status/tagged.svg`,
    disabled: false,
    statuses: [NARC_STATUS_ID],
    flags: {
      core: { statusId: NARC_STATUS_ID },
      [SYSTEM_ID]: {
        narcPods: [{
          loc,
          attackerActorUuid: source.attackerActorUuid ?? null,
          attackerTokenUuid: source.attackerTokenUuid ?? null,
          appliedRound: game.combat?.started ? game.combat.round : null,
          appliedTurn: game.combat?.started ? game.combat.turn : null
        }]
      }
    }
  };
}

async function applyNarcToTargetActor(targetActor, source = {}) {
  if (!targetActor) return { ok: false, reason: "No target actor" };
  if (!isMechActor(targetActor)) return { ok: false, reason: "Narc pods can only attach to a BattleMech" };
  if (!game.user?.isGM && !targetActor.isOwner) return { ok: false, reason: "No permission to update target" };

  const loc = _normalizeDamageLocation(targetActor, source.loc);
  if (!loc) return { ok: false, reason: "No valid hit location" };
  const effectData = buildNarcEffectData({ ...source, loc });
  const matches = Array.from(targetActor.effects ?? []).filter(effect => _effectHasStatus(effect, NARC_STATUS_ID));

  if (matches.length) {
    const keep = matches.find(effect => !effect.disabled) ?? matches[0];
    const existingPods = _normalizeNarcPods(keep.getFlag?.(SYSTEM_ID, "narcPods") ?? keep.flags?.[SYSTEM_ID]?.narcPods);
    const nextPod = effectData.flags[SYSTEM_ID].narcPods[0];
    // One entry per location is enough to preserve the rules-relevant state. A
    // later hit to the same location refreshes its source metadata.
    const pods = [...existingPods.filter(pod => pod.loc !== loc), nextPod];
    await keep.update({
      disabled: false,
      statuses: [NARC_STATUS_ID],
      [`flags.${SYSTEM_ID}.narcPods`]: pods
    });
    for (const effect of matches) {
      if (effect.id !== keep.id) await effect.delete().catch(() => {});
    }
    return { ok: true, effectId: keep.id, refreshed: true, loc, pods };
  }

  const created = await targetActor.createEmbeddedDocuments("ActiveEffect", [effectData]);
  return { ok: true, effectId: created?.[0]?.id ?? null, refreshed: false, loc, pods: effectData.flags[SYSTEM_ID].narcPods };
}

async function _gmApplyNarcToTargetActor(actorUuid, source = {}) {
  const targetActor = await _resolveActorFromUuid(actorUuid);
  return targetActor ? applyNarcToTargetActor(targetActor, source) : { ok: false, reason: "No target actor" };
}

async function applyNarcToTargetActorAuto(targetActor, source = {}) {
  if (!targetActor) return { ok: false, reason: "No target actor" };
  if (game.user?.isGM || targetActor.isOwner) return applyNarcToTargetActor(targetActor, source);
  const socket = getATOWSocket();
  if (!socket) return { ok: false, reason: "AToW socket is not ready" };
  return socket.executeAsGM("gmApplyNarcToTargetActor", targetActor.uuid, source);
}

/** Remove attached Narc pods whose recorded structure location has been destroyed. */
export async function syncNarcPodsForDestroyedLocations(actor) {
  if (!actor || (!game.user?.isGM && !actor.isOwner)) return { ok: false, reason: "No permission" };
  const effect = _narcEffectForActor(actor);
  if (!effect) return { ok: true, changed: false, pods: [] };
  const pods = _normalizeNarcPods(effect.getFlag?.(SYSTEM_ID, "narcPods") ?? effect.flags?.[SYSTEM_ID]?.narcPods);
  // A manually toggled Narc status has no location metadata; leave it under GM control.
  if (!pods.length) return { ok: true, changed: false, pods: [] };
  const remaining = pods.filter(pod => {
    const node = actor.system?.structure?.[pod.loc];
    const max = Number(node?.max ?? 0);
    const dmg = Number(node?.dmg ?? 0);
    return !(max > 0 && dmg >= max);
  });
  if (remaining.length === pods.length) return { ok: true, changed: false, pods: remaining };
  if (!remaining.length) {
    await effect.delete();
    return { ok: true, changed: true, removed: true, pods: [] };
  }
  await effect.update({ [`flags.${SYSTEM_ID}.narcPods`]: remaining });
  return { ok: true, changed: true, pods: remaining };
}

async function applyActorStatus(targetActor, statusId, active = true) {
  if (!targetActor || !statusId) return { ok: false, reason: "No target actor or status" };
  if (!game.user?.isGM && !targetActor.isOwner) return { ok: false, reason: "No permission to update target status" };

  const def = getStatusDefinition(statusId);
  const effects = Array.from(targetActor.effects ?? []);
  const existing = effects.find(e => {
    const sid = (e.getFlag?.("core", "statusId") ?? e.flags?.core?.statusId) ?? null;
    if (sid === statusId) return true;
    if (e.statuses?.has && e.statuses.has(statusId)) return true;
    if (Array.isArray(e.statuses) && e.statuses.includes(statusId)) return true;
    return false;
  });

  if (typeof targetActor.toggleStatusEffect === "function") {
    try {
      await targetActor.toggleStatusEffect(statusId, { active: Boolean(active) });
      return { ok: true, statusId, active: Boolean(active), toggled: true };
    } catch (_) {}
  }

  if (active) {
    if (existing) {
      if (existing.disabled) await existing.update({ disabled: false }).catch(() => {});
      return { ok: true, statusId, active: true, effectId: existing.id };
    }
    const created = await targetActor.createEmbeddedDocuments("ActiveEffect", [{
      name: def?.name ?? def?.label ?? statusId,
      icon: def?.icon ?? "icons/svg/daze.svg",
      disabled: false,
      statuses: [statusId],
      flags: { core: { statusId } }
    }]);
    return { ok: true, statusId, active: true, effectId: created?.[0]?.id ?? null };
  }

  if (existing && !existing.disabled) await existing.update({ disabled: true }).catch(() => {});
  return { ok: true, statusId, active: false, effectId: existing?.id ?? null };
}

async function applyActorStatusAuto(targetActor, statusId, active = true) {
  if (!targetActor) return { ok: false, reason: "No target actor" };
  if (game.user?.isGM || targetActor.isOwner) return applyActorStatus(targetActor, statusId, active);
  const socket = getATOWSocket();
  if (!socket) return { ok: false, reason: "AToW socket is not ready" };
  return socket.executeAsGM("gmApplyActorStatus", targetActor.uuid, statusId, active);
}

async function addHeatToActorAuto(targetActor, amount) {
  if (!targetActor) return { ok: false, reason: "No target actor" };
  if (game.user?.isGM || targetActor.isOwner) {
    await addHeatToActor(targetActor, amount);
    return { ok: true, amount: Math.max(0, Number(amount ?? 0) || 0) };
  }
  const socket = getATOWSocket();
  if (!socket) return { ok: false, reason: "AToW socket is not ready" };
  return socket.executeAsGM("gmAddHeatToActor", targetActor.uuid, amount);
}

async function applyDamageToTargetActorAuto(targetActor, hitLoc, damage, opts = {}) {
  if (!targetActor) return { ok: false, reason: "No target actor" };
  if (game.user?.isGM) return _gmApplyDamageToTargetActor(targetActor.uuid, hitLoc, damage, opts);
  const socket = getATOWSocket();
  if (!socket) return { ok: false, reason: "AToW socket is not ready" };
  return socket.executeAsGM("gmApplyDamageToTargetActor", targetActor.uuid, hitLoc, damage, opts);
}

export async function applyMechDamageCluster(targetActor, hitLoc, damage, opts = {}) {
  return applyDamageToTargetActorAuto(targetActor, hitLoc, damage, opts);
}

async function applyDamageToVehicleActorAuto(targetActor, hitLoc, damage, opts = {}) {
  if (!targetActor) return { ok: false, reason: "No target actor" };
  if (game.user?.isGM) return _gmApplyDamageToVehicleActor(targetActor.uuid, hitLoc, damage, opts);
  const socket = getATOWSocket();
  if (!socket) return { ok: false, reason: "AToW socket is not ready" };
  return socket.executeAsGM("gmApplyDamageToVehicleActor", targetActor.uuid, hitLoc, damage, opts);
}

async function applyDamageToDropshipActorAuto(targetActor, hitLoc, damage, opts = {}) {
  if (!targetActor) return { ok: false, reason: "No target actor" };
  if (game.user?.isGM) return _gmApplyDamageToDropshipActor(targetActor.uuid, hitLoc, damage, opts);
  const socket = getATOWSocket();
  if (!socket) return { ok: false, reason: "AToW socket is not ready" };
  return socket.executeAsGM("gmApplyDamageToDropshipActor", targetActor.uuid, hitLoc, damage, opts);
}

async function applyDamageToAbominationActorAuto(targetActor, damage) {
  if (!targetActor) return { ok: false, reason: "No target actor" };
  if (game.user?.isGM) return _gmApplyDamageToAbominationActor(targetActor.uuid, damage);
  const socket = getATOWSocket();
  if (!socket) return { ok: false, reason: "AToW socket is not ready" };
  return socket.executeAsGM("gmApplyDamageToAbominationActor", targetActor.uuid, damage);
}

export function registerATOWAttackSockets() {
  const socketlibApi = globalThis.socketlib;
  if (!socketlibApi?.registerSystem) {
    console.warn(`${SYSTEM_ID} | socketlib is not available; GM-executed attack automation is disabled.`);
    return null;
  }

  const socket = socketlibApi.registerSystem(SYSTEM_ID);
  if (!socket) {
    console.warn(`${SYSTEM_ID} | Failed to register system socket.`);
    return null;
  }

  if (!socket.functions?.has?.("gmApplyDamageToTargetActor")) socket.register("gmApplyDamageToTargetActor", _gmApplyDamageToTargetActor);
  if (!socket.functions?.has?.("gmApplyDamageToVehicleActor")) socket.register("gmApplyDamageToVehicleActor", _gmApplyDamageToVehicleActor);
  if (!socket.functions?.has?.("gmApplyDamageToDropshipActor")) socket.register("gmApplyDamageToDropshipActor", _gmApplyDamageToDropshipActor);
  if (!socket.functions?.has?.("gmApplyDamageToAbominationActor")) socket.register("gmApplyDamageToAbominationActor", _gmApplyDamageToAbominationActor);
  if (!socket.functions?.has?.("gmResolveAmmoExplosionEvent")) socket.register("gmResolveAmmoExplosionEvent", _gmResolveAmmoExplosionEvent);
  if (!socket.functions?.has?.("gmApplyTaggedToTargetActor")) socket.register("gmApplyTaggedToTargetActor", _gmApplyTaggedToTargetActor);
  if (!socket.functions?.has?.("gmApplyNarcToTargetActor")) socket.register("gmApplyNarcToTargetActor", _gmApplyNarcToTargetActor);
  if (!socket.functions?.has?.("gmApplyActorStatus")) socket.register("gmApplyActorStatus", _gmApplyActorStatus);
  if (!socket.functions?.has?.("gmAddHeatToActor")) socket.register("gmAddHeatToActor", _gmAddHeatToActor);
  if (!socket.functions?.has?.("gmApplyMechPilotHit")) socket.register("gmApplyMechPilotHit", _gmApplyMechPilotHit);
  if (!socket.functions?.has?.("gmScheduleArrowIVIndirectStrike")) socket.register("gmScheduleArrowIVIndirectStrike", _gmScheduleArrowIVIndirectStrike);
  if (!socket.functions?.has?.("gmResolveAMSDefense")) socket.register("gmResolveAMSDefense", _gmResolveAMSDefense);

  game[SYSTEM_ID] = game[SYSTEM_ID] ?? {};
  game[SYSTEM_ID].socket = socket;
  return socket;
}


// ------------------------------------------------------------
// CASE (Cellular Ammunition Storage Equipment) helpers
// ------------------------------------------------------------
function _getMechTechBase(actor) {
  const sys = actor?.system ?? {};
  const mech = sys?.mech ?? {};
  const raw = mech.techBase ?? mech.techbase ?? mech.tech ?? sys.techBase ?? sys.techbase ?? sys.tech ?? "";
  const t = String(raw ?? "").toLowerCase();
  if (t.includes("clan")) return "clan";
  if (t.includes("inner")) return "inner";
  return t ? t : "inner";
}


// ------------------------------------------------------------
// Triple-Strength Myomer (TSM) helpers
// - TSM doubles damage for punches, kicks, and physical/melee weapon attacks when ACTIVE.
// - Active approximation: requires intact TSM crit slots (6), Inner Sphere tech base, no MASC, and heat >= 9.
// ------------------------------------------------------------
const _TSM_LABEL_RE = /^triple\s*[-]?\s*strength\s*myomer$/i;
const _MASC_LABEL_RE = /\bmasc\b/i;

function _iterCritSlots(slotsRaw) {
  if (!slotsRaw) return [];
  if (Array.isArray(slotsRaw)) return slotsRaw.map((slot, idx) => ({ idx, slot }));
  return Object.entries(slotsRaw).map(([k, slot]) => ({ idx: Number(k), slot }));
}

/**
 * Count occupied crit slots for a component that can span multiple slots.
 * - Matches on the *start slot* label, but counts every occupied slot (including continuations).
 * - If includeDestroyed=false, destroyed slots are excluded from the count.
 */
function countComponentCritSlots(actorSystem, labelRegex, { includeDestroyed = false } = {}) {
  const sys = actorSystem ?? {};
  const crit = sys?.crit ?? {};
  let count = 0;

  for (const loc of Object.values(crit)) {
    const slotsRaw = loc?.slots;
    if (!slotsRaw) continue;

    // index->slot map to resolve continuations back to their start slot
    const slotMap = new Map();
    for (const { idx, slot } of _iterCritSlots(slotsRaw)) slotMap.set(Number(idx), slot);

    for (const [idx, slot] of slotMap) {
      if (!slot) continue;
      if (!includeDestroyed && Boolean(slot.destroyed)) continue;

      const startIdx = (slot.partOf !== undefined && slot.partOf !== null) ? Number(slot.partOf) : idx;
      const startSlot = slotMap.get(startIdx) ?? slot;
      if (!startSlot) continue;
      if (!includeDestroyed && Boolean(startSlot.destroyed)) continue;

      const label = String(startSlot.label ?? "").trim();
      if (!label) continue;

      if (labelRegex.test(label)) count += 1;
    }
  }

  return count;
}

function getUnventedHeat(actor) {
  const heat = actor?.system?.heat ?? {};
  const effects = heat.effects ?? {};
  const v = (heat.unvented ?? effects.unvented ?? heat.value ?? heat.current ?? 0);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isTSMActive(actor) {
  const techBase = _getMechTechBase(actor);
  if (techBase !== "inner") return false;

  const sys = actor?.system ?? {};
  const tsmSlotsTotal = countComponentCritSlots(sys, _TSM_LABEL_RE, { includeDestroyed: true });
  if (tsmSlotsTotal <= 0) return false;

  const tsmSlotsIntact = countComponentCritSlots(sys, _TSM_LABEL_RE, { includeDestroyed: false });
  if (tsmSlotsIntact < 6) return false;

  const mascSlotsIntact = countComponentCritSlots(sys, _MASC_LABEL_RE, { includeDestroyed: false });
  if (mascSlotsIntact > 0) return false;

  return getUnventedHeat(actor) >= 9;
}


function _hasActiveCASEInLoc(actor, locKey) {
  const lk = String(locKey ?? "").toLowerCase();
  const slots = actor?.system?.crit?.[lk]?.slots;
  const iter = Array.isArray(slots) ? slots : Object.values(slots ?? {});
  for (const s of iter) {
    if (!s) continue;
    // Skip continuations if present
    if (s.partOf !== undefined && s.partOf !== null) continue;
    if (s.destroyed) continue;
    const label = String(s.label ?? "").toLowerCase();
    if (/(^|\b)case(\b|$)/i.test(label)) return true;
  }
  return false;
}

function isLocationProtectedByCASE(actor, locKey) {
  const techBase = _getMechTechBase(actor);
  const lk = String(locKey ?? "").toLowerCase();
  if (techBase === "clan") return true; // Clan CASE everywhere, free
  // Inner Sphere CASE can only protect LT/RT per our implementation
  if (lk !== "lt" && lk !== "rt") return false;
  return _hasActiveCASEInLoc(actor, lk);
}
// Weapon name / flag helpers (for macro + animation compatibility)
// ------------------------------------------------------------

/**
 * Many users keep weapon names "clean" (e.g. "AC/10") and store mounting/location elsewhere.
 * Some sheets append mount info to the displayed name (e.g. "AC/10 (RA)" or "AC/10 - Right Arm"),
 * which can break animation/macro matching that expects the base weapon name.
 *
 * This helper returns:
 * - rawName: whatever the Item/object currently reports
 * - name: a best-effort "base" name with mount suffix stripped
 * - flags: common chat-message flags used by automation modules/macros
 */
function _getWeaponAutomationMeta(weaponItem) {
  const rawName = String(weaponItem?.name ?? "").trim();

  const looksLikeLoc = (s) => {
    const t = String(s ?? "").toLowerCase();
    return /\b(la|ra|lt|rt|ct|ll|rl|hd|head|left arm|right arm|left torso|right torso|center torso|left leg|right leg)\b/.test(t);
  };

  let base = rawName;
  // Strip trailing "(...)" or "[...]" if it looks like a mount/location suffix
  const paren = base.match(/\s*[\(\[]([^\)\]]+)[\)\]]\s*$/);
  if (paren && looksLikeLoc(paren[1])) {
    base = base.replace(/\s*[\(\[]([^\)\]]+)[\)\]]\s*$/, "").trim();
  }
  // Strip trailing " - <loc>" if it looks like a mount/location suffix
  const dash = base.match(/\s*[-–—]\s*([^\-–—]+)\s*$/);
  if (dash && looksLikeLoc(dash[1])) {
    base = base.replace(/\s*[-–—]\s*([^\-–—]+)\s*$/, "").trim();
  }

  if (!base) base = rawName;

  const id = weaponItem?.id ? String(weaponItem.id) : null;
  const uuid = weaponItem?.uuid ? String(weaponItem.uuid) : null;
  const img = weaponItem?.img ? String(weaponItem.img) : null;

  // Provide several commonly-consumed flag shapes so external automation can "see" an item context.
  // These are additive and harmless if the corresponding modules aren't installed.
  const flags = {
    [SYSTEM_ID]: {
      action: "weaponAttack",
      weaponName: base,
      weaponNameRaw: rawName,
      itemId: id,
      itemUuid: uuid,
      img
    },
    // Common ecosystems
    "autoanimations": { itemName: base, itemId: id, itemUuid: uuid },
    "midi-qol": { itemId: id, itemUuid: uuid }
  };

  return { name: base, rawName, id, uuid, img, flags };
}


// ------------------------------------------------------------
// Weapon resolution + Automated Animations integration
// ------------------------------------------------------------

/**
 * Ensure we have a real embedded Item when possible (for module compatibility),
 * falling back to the provided object.
 */
async function _resolveWeaponItem(actor, weaponItem) {
  try {
    if (!actor || !weaponItem) return weaponItem;

    // If it's already an Item document, return it.
    if (weaponItem instanceof Item) return weaponItem;
    if (weaponItem?.documentName === "Item" && weaponItem?.id) return weaponItem;

    // Resolve by id if present
    const wid = weaponItem?.id ? String(weaponItem.id) : null;
    const embedded = wid ? actor.items?.get?.(wid) : null;
    if (embedded) return embedded;

    // Resolve by uuid if present
    const wuuid = weaponItem?.uuid ? String(weaponItem.uuid) : null;
    if (wuuid && typeof fromUuid === "function") {
      const doc = await fromUuid(wuuid).catch(() => null);
      if (doc instanceof Item) return doc;
    }

    // Resolve by normalized name match
    const meta = _getWeaponAutomationMeta(weaponItem);
    const baseName = String(meta?.name ?? weaponItem?.name ?? "").trim();
    if (!baseName) return weaponItem;

    const norm = (s) => String(s ?? "").trim().toLowerCase();
    const candidates = (actor.items ?? []).filter(i => norm(i?.name) === norm(baseName));
    if (candidates.length) return candidates[0];

    return weaponItem;
  } catch (err) {
    console.warn("AToW Battletech | weapon item resolve failed", err);
    return weaponItem;
  }
}

/**
 * Trigger Automated Animations directly (works even for non-standard systems),
 * using either the resolved Item or a pseudo-item with a name for recognition.
 */
async function _maybePlayAutomatedAnimation(attackerToken, weaponItem, weaponMeta, { targetToken = null, hit = false } = {}) {
  try {
    if (!attackerToken) return;

    // Module active?
    const aaMod = (game && game.modules && typeof game.modules.get === "function") ? game.modules.get("autoanimations") : null;
    if (!aaMod || !aaMod.active) return;

    const AA = (globalThis && globalThis.AutomatedAnimations) ? globalThis.AutomatedAnimations : null;
    if (!AA || typeof AA.playAnimation !== "function") return;

    const wmName = (weaponMeta && weaponMeta.name) ? String(weaponMeta.name) : ((weaponItem && weaponItem.name) ? String(weaponItem.name) : "");
    const itemLike = (weaponItem instanceof Item) ? weaponItem : ({ name: wmName.trim() || "Attack" });

    const targets = targetToken ? new Set([targetToken]) : new Set();
    const hitTargets = (hit && targetToken) ? new Set([targetToken]) : new Set();

    // playOnMiss true lets AA handle miss variants when configured
    await AA.playAnimation(attackerToken, itemLike, { targets, hitTargets, playOnMiss: true }).catch(() => {});
  } catch (err) {
    // Never block the attack pipeline for VFX
    console.debug("AToW Battletech | Automated Animations playAnimation failed", err);
  }
}

async function playArrowIVSequencerEffect({ effectFile, soundFile, location, scale = 1, volume = 0.9 } = {}) {
  if (!location && !soundFile) return;

  const canSequence = typeof globalThis.Sequence === "function";
  if (canSequence && effectFile) {
    try {
      const seq = new Sequence();
      seq.effect()
        .file(effectFile)
        .atLocation(location)
        .scale(scale);
      if (soundFile) {
        seq.sound()
          .file(soundFile)
          .volume(volume);
      }
      await seq.play();
      return;
    } catch (err) {
      console.debug("AToW Battletech | Arrow IV Sequencer effect failed", err);
    }
  }

  if (soundFile) {
    try {
      await AudioHelper.play({ src: soundFile, volume, autoplay: true, loop: false }, true);
    } catch (_) {}
  }
}

async function playArrowIVLaunchEffects(attackerToken) {
  await playArrowIVSequencerEffect({
    effectFile: ARROW_IV_LAUNCH_VFX,
    soundFile: ARROW_IV_LAUNCH_SFX,
    location: attackerToken,
    scale: 0.8,
    volume: 0.9
  });
}

async function playArrowIVImpactEffects(location) {
  await playArrowIVSequencerEffect({
    effectFile: ARROW_IV_IMPACT_VFX,
    soundFile: ARROW_IV_IMPACT_SFX,
    location,
    scale: 1.2,
    volume: 0.95
  });
}


// ------------------------------------------------------------
// Location normalization helpers
// ------------------------------------------------------------

/**
 * Normalize a variety of location strings to our canonical keys.
 * Canonical structure keys: head, ct, lt, rt, la, ra, ll, rl
 * Canonical rear armor keys: back, lback, rback
 */
function _normalizeDamageLocation(actor, loc) {
  const raw = String(loc ?? "").trim().toLowerCase();
  if (!raw) return null;

  // If already canonical, return early.
  const canonical = new Set(["head", "ct", "lt", "rt", "la", "ra", "ll", "rl", "lfl", "lrl", "rfl", "rrl", "back", "lback", "rback"]);
  if (canonical.has(raw)) return raw;

  const cleaned = raw.replace(/[\s_\-]+/g, " ").trim();
  const compact = cleaned.replace(/\s+/g, "");

  // Head
  if (cleaned === "head" || compact === "hd") return "head";

  // Center torso
  if (raw === "c" || compact === "ct" || compact === "centertorso" || compact === "centert" || cleaned === "center torso") return "ct";

  // Left / Right torso
  if (compact === "lt" || compact === "lefttorso" || cleaned === "left torso") return "lt";
  if (compact === "rt" || compact === "righttorso" || cleaned === "right torso") return "rt";

  // Left / Right arm
  if (compact === "la" || compact === "leftarm" || compact === "larm" || cleaned === "left arm") return "la";
  if (compact === "ra" || compact === "rightarm" || compact === "rarm" || cleaned === "right arm") return "ra";

  // Left / Right leg
  if (compact === "ll" || compact === "leftleg" || compact === "lleg" || cleaned === "left leg") return "ll";
  if (compact === "rl" || compact === "rightleg" || compact === "rleg" || cleaned === "right leg") return "rl";

// Quad legs (if present on the actor). If the actor doesn't have quad leg tracks,
// map to the nearest equivalent (left legs -> LL, right legs -> RL).
if (compact === "lfl" || compact === "leftfrontleg" || cleaned === "left front leg") {
  return actor?.system?.structure?.lfl ? "lfl" : "ll";
}
if (compact === "lrl" || compact === "leftrearleg" || cleaned === "left rear leg") {
  return actor?.system?.structure?.lrl ? "lrl" : "ll";
}
if (compact === "rfl" || compact === "rightfrontleg" || cleaned === "right front leg") {
  return actor?.system?.structure?.rfl ? "rfl" : "rl";
}
if (compact === "rrl" || compact === "rightrearleg" || cleaned === "right rear leg") {
  return actor?.system?.structure?.rrl ? "rrl" : "rl";
}

  // Rear torso armor aliases
  const hasRear = cleaned.includes("rear") || cleaned.includes("back");
  const hasTorso = cleaned.includes("torso") || cleaned.includes("center") || cleaned.includes("chest");
  const hasLeft = cleaned.includes("left") || compact.startsWith("l");
  const hasRight = cleaned.includes("right") || compact.startsWith("r");

  if (hasRear && hasTorso) {
    if (hasLeft && !hasRight) return "lback";
    if (hasRight && !hasLeft) return "rback";
    return "back";
  }

  // If we have an actor, prefer keys that actually exist.
  // (This helps if downstream code passes something slightly odd.)
  if (actor?.system?.structure) {
    const keys = Object.keys(actor.system.structure);
    const tryKey = (k) => (keys.includes(k) ? k : null);
    return (
      tryKey(raw) ||
      tryKey(compact) ||
      tryKey(cleaned.replace(/\s+/g, ""))
    );
  }

  return null;
}

// ------------------------------------------------------------
// Ammo Explosion (crit / location destruction)
// ------------------------------------------------------------
const AMMO_EXPLOSION_SFX = `systems/${SYSTEM_ID}/assets/ammo-explosion.mp3`;

// Damage values per your table
const AMMO_EXPLOSION_DAMAGE = {
  "ac-20": 100,
  "ac-10": 100,
  "ac-5": 100,
  "ac-2": 90,
  "lrm-20": 120,
  "lrm-15": 120,
  "lrm-10": 120,
  "lrm-5": 120,
  "mrm-40": 120,
  "mrm-30": 120,
  "mrm-20": 120,
  "mrm-10": 120,
  "srm-6": 180,
  "srm-4": 200,
  "srm-2": 200,
  "mml-3": 100,
  "mml-5": 100,
  "mml-7": 100,
  "mml-9": 100,
  "mg": 400,
  "ams": 48,
  "atm-3": 100,
  "atm-3-er": 100,
  "atm-3-he": 100,
  "atm-6": 100,
  "atm-6-er": 100,
  "atm-6-he": 100,
  "atm-9": 100,
  "atm-9-er": 100,
  "atm-9-he": 100,
  "atm-12": 100,
  "atm-12-er": 100,
  "atm-12-he": 100
};

const AMMO_EXPLOSION_DAMAGE_CAP = 20;
const AMMO_EXPLOSION_CASE_DAMAGE_CAP = 10;
const AMMO_EXPLOSION_CASE_II_DAMAGE_CAP = 1;

const MISSILE_AMMO_VARIANTS = Object.freeze({
  STANDARD: "standard",
  ARTEMIS_IV: "artemis-iv",
  ARTEMIS_V: "artemis-v",
  FRAGMENTATION: "fragmentation",
  INFERNO: "inferno",
  NARC: "narc",
  SEMI_GUIDED: "semi-guided"
});

function getMissileAmmoVariant(typeText) {
  const t = String(typeText ?? "").trim().toLowerCase();
  if (/\bartemis[\s-]*(?:v|5)\b/i.test(t)) return MISSILE_AMMO_VARIANTS.ARTEMIS_V;
  if (/\bartemis[\s-]*(?:iv|4)\b/i.test(t)) return MISSILE_AMMO_VARIANTS.ARTEMIS_IV;
  if (/\bfragmentation\b/i.test(t)) return MISSILE_AMMO_VARIANTS.FRAGMENTATION;
  if (/\binferno\b/i.test(t)) return MISSILE_AMMO_VARIANTS.INFERNO;
  if (/\bsemi[ -]?guided\b/i.test(t)) return MISSILE_AMMO_VARIANTS.SEMI_GUIDED;
  if (/\bnarc(?:[ -]?equipped)?\b/i.test(t)) return MISSILE_AMMO_VARIANTS.NARC;
  return MISSILE_AMMO_VARIANTS.STANDARD;
}

function getMissileAmmoKey(typeText) {
  const rack = parseMissileRackLabel(typeText);
  const type = String(rack?.type ?? "").toUpperCase();
  if (!["LRM", "MML", "SRM"].includes(type) || !Number.isFinite(Number(rack?.size))) return null;
  const base = `${type.toLowerCase()}-${Number(rack.size)}`;
  const variant = getMissileAmmoVariant(typeText);
  return variant === MISSILE_AMMO_VARIANTS.STANDARD ? base : `${base}-${variant}`;
}

function isMissileAmmoVariantCompatible(rackType, variant) {
  const type = String(rackType ?? "").toUpperCase();
  if (!["LRM", "MML", "SRM"].includes(type)) return variant === MISSILE_AMMO_VARIANTS.STANDARD;
  switch (variant) {
    case MISSILE_AMMO_VARIANTS.ARTEMIS_IV: return ["LRM", "MML", "SRM"].includes(type);
    case MISSILE_AMMO_VARIANTS.ARTEMIS_V: return ["LRM", "SRM"].includes(type);
    case MISSILE_AMMO_VARIANTS.FRAGMENTATION: return ["LRM", "MML", "SRM"].includes(type);
    case MISSILE_AMMO_VARIANTS.INFERNO: return ["MML", "SRM"].includes(type);
    case MISSILE_AMMO_VARIANTS.NARC: return ["LRM", "MML", "SRM"].includes(type);
    case MISSILE_AMMO_VARIANTS.SEMI_GUIDED: return ["LRM", "MML"].includes(type);
    default: return true;
  }
}

function getBaseMissileAmmoKey(ammoKey) {
  return String(ammoKey ?? "").replace(/-(?:artemis-iv|artemis-v|fragmentation|inferno|narc|semi-guided)$/i, "");
}

function getMissileAmmoVariantLabel(variant) {
  switch (variant) {
    case MISSILE_AMMO_VARIANTS.ARTEMIS_IV: return "Artemis IV";
    case MISSILE_AMMO_VARIANTS.ARTEMIS_V: return "Artemis V";
    case MISSILE_AMMO_VARIANTS.FRAGMENTATION: return "Fragmentation";
    case MISSILE_AMMO_VARIANTS.INFERNO: return "Inferno";
    case MISSILE_AMMO_VARIANTS.NARC: return "Narc-equipped";
    case MISSILE_AMMO_VARIANTS.SEMI_GUIDED: return "Semi-guided";
    default: return "Standard";
  }
}

function _hasCaseIIProtection(_actor, _loc) {
  return false;
}

function _cappedAmmoExplosionDamage(rawDamage, { caseProtected = false, caseIIProtected = false } = {}) {
  const raw = Math.max(0, Number(rawDamage ?? 0) || 0);
  const cap = caseIIProtected
    ? AMMO_EXPLOSION_CASE_II_DAMAGE_CAP
    : (caseProtected ? AMMO_EXPLOSION_CASE_DAMAGE_CAP : AMMO_EXPLOSION_DAMAGE_CAP);
  return Math.min(raw, cap);
}

function _ammoKeyFromType(typeText) {
  const t = String(typeText ?? "").trim().toLowerCase();

  const missileAmmoKey = getMissileAmmoKey(t);
  if (missileAmmoKey) return missileAmmoKey;

  // AC/20, AC 20
  let m = t.match(/\bac\s*\/\s*(\d+)\b/i) || t.match(/\bac\s*(\d+)\b/i);
  if (m?.[1]) return `ac-${Number(m[1])}`;

  // LRM 20, LRM-20
  m = t.match(/\blrm\s*[- ]?\s*(\d+)\b/i);
  if (m?.[1]) return `lrm-${Number(m[1])}`;

  // MRM 20, MRM-20
  m = t.match(/\bmrm\b[^\d]*(\d+)\b/i) ?? t.match(/\bmedium\s+range\s+missiles?\b[^\d]*(10|20|30|40)\b/i);
  if (m?.[1]) return `mrm-${Number(m[1])}`;

  // SRM 6, SRM-6
  m = t.match(/\bsrm\s*[- ]?\s*(\d+)\b/i);
  if (m?.[1]) return `srm-${Number(m[1])}`;

  // ATM 6, ATM-6 ER, ATM/9 HE
  m = t.match(/\batm\s*[-/]?\s*(3|6|9|12)\b/i);
  if (m?.[1]) {
    const variant = /\ber\b/i.test(t) ? "-er" : (/\bhe\b/i.test(t) ? "-he" : "");
    return `atm-${Number(m[1])}${variant}`;
  }

  // Machine Gun / MG
  if (t.includes("machine gun") || /^mg\b/.test(t)) return "mg";

  // Anti-Missile System
  if (t === "ams" || /\banti\s*-?\s*missile\s+system\b/i.test(t)) return "ams";

  if (/\barrow\s*iv\b/i.test(t) && /\bhoming\b/i.test(t)) return "arrow-iv-homing";

  if (t === "narc" || /\bnarc\s+(missile\s+)?(beacon\s+)?pods?\b/i.test(t)) return "narc";

  return null;
}

function _parseAmmoLabel(label) {
  const txt = String(label ?? "").trim();
  // Expected: Ammo (LRM 20) 6
  const m = txt.match(/^\s*Ammo\s*\(([^)]+)\)\s*(\d+)\s*$/i);
  if (!m) return null;

  const typeText = String(m[1] ?? "").trim();
  const qty = Number(m[2] ?? 0) || 0;
  const key = _ammoKeyFromType(typeText);
  if (!key) return null;

  // Gauss ammo never explodes when hit
  if (/\bgauss\b/i.test(typeText)) return { key, typeText, qty, gaussAmmo: true };

  // Narc ammunition explodes for 2 points per remaining pod.
  const damage = key === "narc" ? (2 * qty) : AMMO_EXPLOSION_DAMAGE[getBaseMissileAmmoKey(key)];
  if (!Number.isFinite(damage)) return null;

  return { key, typeText, qty, damage, gaussAmmo: false };
}

function _isGaussRifleLabel(label) {
  const t = String(label ?? "").toLowerCase();
  return t.includes("gauss") && t.includes("rifle") && !t.includes("ammo");
}

async function _playAtowSfx(src, { volume = 1.0 } = {}) {
  try {
    if (!src) return;
    // Foundry VTT AudioHelper
    await AudioHelper.play({ src, volume, autoplay: true, loop: false }, true);
  } catch (_) {
    // ignore
  }
}

async function _postAmmoExplosionChat({ actor, loc, label, damage, rawDamage = null, caseProtected = null, caseIIProtected = false }) {
  try {
    const locName = String(loc ?? "").toUpperCase();
    const nice = String(label ?? "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const protectedByCase = (caseProtected === null) ? isLocationProtectedByCASE(actor, loc) : Boolean(caseProtected);
    const rawLine = Number.isFinite(Number(rawDamage)) && Number(rawDamage) !== Number(damage)
      ? ` <span style="opacity:0.75;">(raw ${Number(rawDamage)}, capped)</span>`
      : "";
    const caseLine = `<p style="margin:0.25rem 0 0 0;">CASE: <b>${caseIIProtected ? "CASE II" : (protectedByCase ? "Yes" : "No")}</b>${(protectedByCase || caseIIProtected) ? " (contained)" : " (vented, no transfer)"}</p>`;
    const content = `
      <div class="atow-bt ammo-explosion">
        <h2 style="margin:0 0 0.25rem 0;">AMMO EXPLOSION!</h2>
        <p style="margin:0;"><b>${actor?.name ?? "Unknown"}</b> — <b>${locName}</b>: ${nice}</p>
        <p style="margin:0.25rem 0 0 0;">Damage: <b>${damage}</b>${rawLine} (location only, internal first)</p>
        ${caseLine}
</div>`;
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content
    });
  } catch (_) {
    // ignore
  }
}

function _getAmmoSlotsInLocation(actor, loc) {
  const slots = actor?.system?.crit?.[loc]?.slots ?? [];
  const out = [];
  for (let i = 0; i < (slots?.length ?? 0); i++) {
    const s = slots[i];
    const label = s?.label ?? s;
    const parsed = _parseAmmoLabel(label);
    if (!parsed) continue;
    if (parsed.gaussAmmo) continue; // Gauss ammo never explodes
    out.push({ idx: i, label, key: parsed.key, typeText: parsed.typeText, qty: parsed.qty, damage: parsed.damage, destroyed: Boolean(s?.destroyed) });
  }
  // Highest damage first
  out.sort((a, b) => (b.damage ?? 0) - (a.damage ?? 0));
  return out;
}

/**
 * Resolve ammo/gauss explosions triggered by newly destroyed crit slots and/or newly destroyed locations.
 * This is GM-only (or requires ownership to update the target).
 */
async function _maybeResolveAmmoExplosions(targetActor, trigger, { side = "front" } = {}) {
  if (!targetActor) return;
  if (!game.user?.isGM) return;

  // Normalize to a queue
  const queue = Array.isArray(trigger) ? [...trigger] : (trigger ? [trigger] : []);
  const processed = new Set(); // actorId|loc|idx|label

  while (queue.length) {
    const ev = queue.shift();
    if (!ev) continue;

    const loc = String(ev.loc ?? "").toLowerCase();
    const label = ev.label ?? ev.typeText ?? "Ammo";
    const damage = Number(ev.damage ?? 0) || 0;

    if (!loc || !damage) continue;


    const caseProtected = isLocationProtectedByCASE(targetActor, loc);
    const caseIIProtected = _hasCaseIIProtection(targetActor, loc);
    const rawDamage = damage;
    const cappedDamage = _cappedAmmoExplosionDamage(rawDamage, { caseProtected, caseIIProtected });
    const key = `${targetActor.id}|${loc}|${ev.idx ?? ""}|${String(label)}`;
    if (processed.has(key)) continue;
    processed.add(key);

    await _playAtowSfx(AMMO_EXPLOSION_SFX, { volume: 1.0 });
    await _postAmmoExplosionChat({ actor: targetActor, loc, label, damage: cappedDamage, rawDamage, caseProtected, caseIIProtected });

    if (!caseProtected && isMechActor(targetActor)) {
      await applyMechPilotHit(targetActor, { reason: "Ammo explosion without CASE" }).catch(err => {
        console.warn("AToW Battletech | Pilot hit from ammo explosion failed", err);
      });
    }

    // Best-effort: zero the matching ammo bin (if present) so it can't be fired after the detonation.
    const updateAmmo = {};
    if (ev.ammoKey) {
      updateAmmo[`system.ammoBins.${ev.ammoKey}.current`] = 0;
    } else if (ev.key) {
      updateAmmo[`system.ammoBins.${ev.key}.current`] = 0;
    }

    // If we know the exact crit slot, mark it destroyed
    if (Number.isInteger(ev.idx)) {
      updateAmmo[`system.crit.${loc}.slots.${ev.idx}.destroyed`] = true;
    }

    if (Object.keys(updateAmmo).length) {
      try { await targetActor.update(updateAmmo, { atowFromAttack: true, atowAmmoExplosion: true }); } catch (_) {}
    }

    // Apply explosion damage (internal structure first on the starting location)
    const res = await applyDamageToTargetActor(targetActor, loc, cappedDamage, { side, internalFirstStartLoc: true, preventTransfer: true });

    // If the actor died as a side effect, you still get the chain from the damage result,
    // but we can stop once no new triggers are produced.
    const nextTriggers = [];

    // Crit-slot triggers from this damage packet
    for (const c of (res?.newlyDestroyedCritSlots ?? [])) {
      const ammo = _parseAmmoLabel(c.label);
      if (ammo && !ammo.gaussAmmo) nextTriggers.push({ loc: c.loc, idx: c.idx, label: c.label, damage: ammo.damage, ammoKey: ammo.key });
      else if (_isGaussRifleLabel(c.label)) nextTriggers.push({ loc: c.loc, idx: c.idx, label: c.label, damage: 15 });
    }

    // NOTE: Location destruction does not automatically detonate ammo bins.
    // Only crit-selected ammo bins (or a critted Gauss Rifle) trigger explosions.

    queue.push(...nextTriggers);
  }
}

/**
 * Convenience wrapper: given the result object returned by applyDamageToTargetActor,
 * enqueue any ammo/gauss explosions caused by newly-destroyed crit slots or locations.
 */
async function _triggerAmmoExplosionsForDamageResult(targetActor, damageResult, { side = "front" } = {}) {
  try {
    if (!targetActor) return;
    if (!game.user?.isGM) return; // Only the GM should drive explosion chains
    if (!damageResult || damageResult.ok === false) return;

    const triggers = [];

    // Crit-slot triggers
    for (const c of (damageResult.newlyDestroyedCritSlots ?? [])) {
      const label = c?.label;
      const ammo = _parseAmmoLabel(label);
      if (ammo && !ammo.gaussAmmo) {
        triggers.push({ loc: c.loc, idx: c.idx, label, damage: ammo.damage, ammoKey: ammo.key });
      } else if (_isGaussRifleLabel(label)) {
        // Gauss rifle itself can explode when critted
        triggers.push({ loc: c.loc, idx: c.idx, label, damage: 15 });
      }
    }


    // NOTE: Do NOT auto-detonate ammo just because a location was destroyed.
    // Ammo only detonates when a crit roll actually selects an ammo bin (handled via newlyDestroyedCritSlots).

    if (triggers.length) await _maybeResolveAmmoExplosions(targetActor, triggers, { side });
  } catch (err) {
    console.warn("AToW Battletech | Failed to trigger ammo explosions", err);
  }
}

/**
 * Public wrapper to trigger an ammo (or Gauss rifle) explosion at a specific location.
 * Used by mech-sheet.js for heat-driven explosions so we reuse the same chain logic
 * as crit-triggered explosions.
 *
 * @param {Actor} targetActor
 * @param {object} event - { loc, label, idx?, side? }
 *   - loc: canonical location key (ct/lt/rt/la/ra/ll/rl/head)
 *   - label: crit-slot label (e.g. "Ammo (LRM 20) 6") or "Gauss Rifle"
 *   - idx: optional crit slot index (if known)
 *   - side: optional hit side (front/rear/left/right). Defaults to "front".
 */
async function _resolveAmmoExplosionEventLocal(targetActor, event = {}) {
  if (!targetActor) return false;
  if (!game.user?.isGM) return false;

  const loc = String(event.loc ?? "").toLowerCase();
  const label = event.label ?? event.typeText ?? "";
  const side = String(event.side ?? "front");

  if (!loc || !label) return false;

  // Ammo bin label (Ammo (LRM 20) 6)
  const parsed = _parseAmmoLabel(label);
  if (parsed && !parsed.gaussAmmo) {
    await _maybeResolveAmmoExplosions(targetActor, [{
      loc,
      idx: Number.isInteger(event.idx) ? event.idx : undefined,
      label,
      damage: parsed.damage,
      ammoKey: parsed.key
    }], { side });
    return true;
  }

  // Gauss rifle (weapon) explosion is always 15 internal
  if (_isGaussRifleLabel(label)) {
    await _maybeResolveAmmoExplosions(targetActor, [{
      loc,
      idx: Number.isInteger(event.idx) ? event.idx : undefined,
      label,
      damage: 15
    }], { side });
    return true;
  }

  return false;
}

export async function resolveAmmoExplosionEvent(targetActor, event = {}) {
  if (!targetActor) return false;
  if (game.user?.isGM) return _resolveAmmoExplosionEventLocal(targetActor, event);
  const socket = getATOWSocket();
  if (!socket) return false;
  try {
    return await socket.executeAsGM("gmResolveAmmoExplosionEvent", targetActor.uuid, event);
  } catch (err) {
    console.warn("AToW Battletech | Failed to resolve ammo explosion via GM socket", err);
    return false;
  }
}


const HIT_LOCATION_TABLES = {
  front: {
    2: "ct", 3: "ra", 4: "ra", 5: "rl", 6: "rt",
    7: "ct", 8: "lt", 9: "ll", 10: "la", 11: "la", 12: "head"
  },
  rear: {
    2: "ct", 3: "ra", 4: "ra", 5: "rl", 6: "rt",
    7: "ct", 8: "lt", 9: "ll", 10: "la", 11: "la", 12: "head"
  },
  left: {
    2: "lt", 3: "lt", 4: "ll", 5: "la", 6: "lt",
    7: "ct", 8: "ll", 9: "lt", 10: "head", 11: "ct", 12: "ra"
  },
  right: {
    2: "rt", 3: "rt", 4: "rl", 5: "ra", 6: "rt",
    7: "ct", 8: "rl", 9: "rt", 10: "head", 11: "ct", 12: "la"
  }
};

// Cluster Hits Table (2d6).
// Values are the number of projectiles that hit on a successful attack, keyed by "weapon size" (rack/shots fired).
// This matches the BattleTech Cluster Hits Table (Total Warfare/A Time of War).
const CLUSTER_HITS_TABLE = (() => {
  // Columns in the table (weapon size)
  const SIZES = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 40];

  // Row arrays are aligned with SIZES above.
  // Keys are the 2d6 total (2..12).
  const ROWS = {
    2:  [1, 1, 1, 1, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 7, 7, 7, 8, 8, 9, 9, 9, 10, 10, 12],
    3:  [1, 1, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 7, 7, 7, 8, 8, 9, 9, 9, 10, 10, 12],
    4:  [1, 1, 2, 2, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 9, 10, 10, 10, 11, 11, 11, 12, 12, 18],
    5:  [1, 2, 2, 3, 3, 4, 4, 5, 6, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 13, 14, 15, 16, 16, 17, 17, 17, 18, 18, 24],
    6:  [1, 2, 2, 3, 4, 4, 5, 5, 6, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 13, 14, 15, 16, 16, 17, 17, 17, 18, 18, 24],
    7:  [1, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 13, 14, 15, 16, 16, 17, 17, 17, 18, 18, 24],
    8:  [2, 2, 3, 3, 4, 4, 5, 5, 6, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 13, 14, 15, 16, 16, 17, 17, 17, 18, 18, 24],
    9:  [2, 2, 3, 4, 5, 6, 6, 7, 8, 9, 10, 11, 11, 12, 13, 14, 14, 15, 16, 17, 18, 19, 20, 21, 21, 22, 23, 23, 24, 32],
    10: [2, 3, 3, 4, 5, 6, 6, 7, 8, 9, 10, 11, 11, 12, 13, 14, 14, 15, 16, 17, 18, 19, 20, 21, 21, 22, 23, 23, 24, 32],
    11: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 40],
    12: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 40]
  };

  const tbl = {};
  for (const [rollStr, arr] of Object.entries(ROWS)) {
    const rollTotal = Number(rollStr);
    for (let i = 0; i < SIZES.length; i++) {
      const size = SIZES[i];
      const hits = arr[i];
      if (!tbl[size]) tbl[size] = {};
      tbl[size][rollTotal] = hits;
    }
  }
  return tbl;
})();

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Canonical Rotary Autocannon combat profiles. The item name is authoritative so
 * an RAC cannot accidentally use a stale damage, heat, or rapid-fire value from
 * a copied weapon item.
 */
export function getRotaryACProfile(weaponItemOrName) {
  const name = typeof weaponItemOrName === "string"
    ? weaponItemOrName
    : String(weaponItemOrName?.name ?? "");
  const match = name.trim().match(/^(?:rotary\s+(?:auto\s*cannon|autocannon|ac)|rac)\s*\/?\s*([25])$/i);
  if (!match) return null;

  const caliber = Number(match[1]);
  return {
    caliber,
    damage: caliber,
    heat: 1,
    rapidFire: 6,
    ammoKey: `ac-${caliber}`
  };
}


/**
 * Rapid Fire rating (R#). Stored on weapons as a number (e.g. 2 or 6) but older sheets may store
 * it under different keys or as a string like "R6". This helper normalizes to an integer >= 1.
 */
function getRapidFireRating(weaponItem) {
  const rotaryProfile = getRotaryACProfile(weaponItem);
  if (rotaryProfile) return rotaryProfile.rapidFire;

  const sys = weaponItem?.system ?? {};
  const raw = (sys.rapidFire ?? sys.rapidFireRating ?? sys.rapid ?? sys.rof ?? 1);

  if (typeof raw === "string") {
    const m = raw.match(/\d+/);
    if (m) return Math.max(1, parseInt(m[0], 10));
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.max(1, Math.floor(n));
    return 1;
  }

  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.floor(n));
}


/**
 * Extract the base 2d6 total from a Roll like "2d6 + X".
 * Returns null if it can't be determined (Foundry internals can vary).
 */
function getBase2d6Total(roll) {
  const diceTerm = roll?.dice?.[0]
    ?? (roll?.terms ?? []).find(x => x && typeof x === "object" && (x.faces || x.dice || x.number || Array.isArray(x.results)));
  const results = diceTerm?.results;
  if (Array.isArray(results) && results.length) {
    const activeResults = results.filter(result => result?.active !== false && result?.discarded !== true);
    const sum = activeResults.reduce((total, result) => total + num(result?.result ?? result?.value, 0), 0);
    if (sum >= 2) return sum;
  }

  const t = diceTerm?.total;
  if (Number.isFinite(t) && t >= 2) return t;

  return null;
}

// Simple clamp helper (Foundry utils availability varies by version)
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const clampInt = (value, min, max, fallback = 0) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
};

function isAbominationActor(actor) {
  const abom = actor?.system?.abomination;
  return Boolean(abom && typeof abom === "object");
}

function isVehicleActor(actor) {
  if (!actor) return false;
  if (actor.type === "vehicle" || actor.type === "wheeledvehicle") return true;
  const v = actor?.system?.vehicle;
  return Boolean(v && typeof v === "object");
}

function isDropshipActor(actor) {
  if (!actor) return false;
  if (actor.type === "dropship") return true;
  const ds = actor?.system?.dropship;
  return Boolean(ds && typeof ds === "object");
}

function _getAbominationTrackConfig(actor) {
  const abom = actor?.system?.abomination ?? {};
  const trackCount = clampInt(abom.trackCount, 1, 6, 0);
  const trackPips = clampInt(abom.trackPips, 1, 95, 0);
  return { trackCount, trackPips };
}

function _getAliveAbominationTracks(actor, { trackCount, trackPips }) {
  const abom = actor?.system?.abomination ?? {};
  const alive = [];
  for (let i = 1; i <= trackCount; i++) {
    const value = num(abom[`track${i}`], 0);
    if (value < trackPips) alive.push({ idx: i, value });
  }
  return alive;
}

async function applyDamageToAbominationActor(targetActor, damage) {
  if (!targetActor) return { ok: false, reason: "No target actor" };

  const { trackCount, trackPips } = _getAbominationTrackConfig(targetActor);
  if (!trackCount || !trackPips) return { ok: false, reason: "No abomination tracks" };

  const alive = _getAliveAbominationTracks(targetActor, { trackCount, trackPips });
  if (!alive.length) return { ok: false, reason: "No living abominations" };

  const pick = alive[Math.floor(Math.random() * alive.length)];
  const appliedDamage = Math.max(0, num(damage, 0));
  const next = clamp(pick.value + appliedDamage, 0, trackPips);
  await targetActor.update({ [`system.abomination.track${pick.idx}`]: next });

  return {
    ok: true,
    hitAbomination: pick.idx,
    prev: pick.value,
    next,
    damage: appliedDamage,
    damageApplied: next - pick.value
  };
}

function _normalizeVehicleLocation(loc) {
  const raw = String(loc ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (["front", "rear", "left", "right", "turret"].includes(raw)) return raw;
  if (raw === "back") return "rear";
  if (raw === "side") return "left";
  return null;
}

const VEHICLE_HIT_LOCATION_TABLES = {
  front: {
    2: "front",
    3: "front",
    4: "front",
    5: "right",
    6: "front",
    7: "front",
    8: "front",
    9: "left",
    10: "turret",
    11: "turret",
    12: "turret"
  },
  rear: {
    2: "rear",
    3: "rear",
    4: "rear",
    5: "left",
    6: "rear",
    7: "rear",
    8: "rear",
    9: "right",
    10: "turret",
    11: "turret",
    12: "turret"
  },
  side: {
    2: "side",
    3: "side",
    4: "side",
    5: "front",
    6: "side",
    7: "side",
    8: "side",
    9: "rear",
    10: "turret",
    11: "turret",
    12: "turret"
  }
};

async function rollVehicleHitLocation(attackSide = "front", { hasTurret = true } = {}) {
  const side = String(attackSide ?? "front").toLowerCase();
  const dir = (side === "left" || side === "right") ? "side" : (side === "rear" ? "rear" : "front");
  const table = VEHICLE_HIT_LOCATION_TABLES[dir] ?? VEHICLE_HIT_LOCATION_TABLES.front;
  const roll = await (new Roll("2d6")).evaluate();
  let loc = table[roll.total] ?? "front";

  if (loc === "side") {
    loc = (side === "right") ? "right" : "left";
  }

  if (loc === "turret" && !hasTurret) {
    if (side === "left" || side === "right") loc = side;
    else loc = (dir === "rear") ? "rear" : "front";
  }

  const critTrigger = (roll.total === 2 || roll.total === 12 || (dir === "side" && roll.total === 8));
  const critTableLoc = (loc === "left" || loc === "right") ? "side" : loc;

  return {
    roll,
    loc,
    display: loc,
    critTrigger,
    critTableLoc
  };
}

const VEHICLE_CRIT_TABLE = {
  front: {
    2: "none", 3: "none", 4: "none", 5: "none",
    6: "driverHit",
    7: "weaponMalfunction",
    8: "stabilizer",
    9: "sensors",
    10: "commanderHit",
    11: "weaponDestroyed",
    12: "crewKilled"
  },
  side: {
    2: "none", 3: "none", 4: "none", 5: "none",
    6: "cargoInfantry",
    7: "weaponMalfunction",
    8: "crewStunned",
    9: "stabilizer",
    10: "weaponDestroyed",
    11: "engineHit",
    12: "fuelTank"
  },
  rear: {
    2: "none", 3: "none", 4: "none", 5: "none",
    6: "weaponMalfunction",
    7: "cargoInfantry",
    8: "stabilizer",
    9: "weaponDestroyed",
    10: "engineHit",
    11: "ammunition",
    12: "fuelTank"
  },
  turret: {
    2: "none", 3: "none", 4: "none", 5: "none",
    6: "stabilizer",
    7: "turretJam",
    8: "weaponMalfunction",
    9: "turretLocks",
    10: "weaponDestroyed",
    11: "ammunition",
    12: "turretBlownOff"
  }
};

function _vehicleHasAmmo(actor) {
  const items = actor?.items ?? [];
  return items.some(i => {
    const name = String(i?.name ?? "").toLowerCase();
    const sys = i?.system ?? {};
    return name.includes("ammo") || Number(sys?.ammoAmount ?? sys?.ammo ?? sys?.shots ?? 0) > 0 || Boolean(sys?.ammoType);
  });
}

function _vehicleIsFusion(actor) {
  const t = String(actor?.system?.vehicle?.engine ?? "").toLowerCase();
  if (!t) return false;
  if (t.includes("ice")) return false;
  return t.includes("fusion");
}

function _vehicleTypeModifier(actor) {
  const t = String(actor?.system?.vehicle?.movement?.type ?? "").toLowerCase();
  if (t.includes("hover") || t.includes("hydrofoil")) return 3;
  if (t.includes("vtol")) return 4;
  if (t.includes("wheeled")) return 2;
  return 0; // tracked/naval/unknown
}

function _motiveAttackDirectionModifier(attackSide) {
  const side = String(attackSide ?? "front").toLowerCase();
  if (side === "rear") return 1;
  if (side === "left" || side === "right") return 2;
  return 0;
}

async function _rollMotiveSystemDamage(actor, attackSide) {
  const roll = await (new Roll("2d6")).evaluate();
  const baseTotal = Number(roll.total ?? 0) || 0;
  const mod = _motiveAttackDirectionModifier(attackSide) + _vehicleTypeModifier(actor);
  const total = baseTotal + mod;

  let severity = 0;
  let effect = "No effect";
  if (total >= 12) {
    severity = 4;
    effect = "Major damage: no movement for the rest of the game (immobile)";
  } else if (total >= 10) {
    severity = 3;
    effect = "Heavy damage: half Cruising MP (round up), +3 Driving Skill";
  } else if (total >= 8) {
    severity = 2;
    effect = "Moderate damage: -1 Cruising MP, +2 Driving Skill";
  } else if (total >= 6) {
    severity = 1;
    effect = "Minor damage: +1 Driving Skill";
  }

  return { roll, baseTotal, mod, total, severity, effect };
}

async function applyVehicleCritical(targetActor, critTableLoc, { attackSide = "front", loc = null } = {}) {
  const tableKey = ["front", "rear", "side", "turret"].includes(critTableLoc) ? critTableLoc : "front";
  const roll = await (new Roll("2d6")).evaluate();
  const total = Number(roll.total ?? 0) || 0;
  const resultKey = VEHICLE_CRIT_TABLE[tableKey]?.[total] ?? "none";

  const updates = {};
  const notes = [];
  let motive = null;

  const crew = targetActor.system?.crew ?? {};
  const crit = targetActor.system?.crit ?? {};
  const tonnage = Number(targetActor.system?.vehicle?.tonnage ?? 0) || 0;
  const structMax = Math.max(0, Math.floor(tonnage / 10));

  const bump = (path, cur, max) => {
    const next = clampInt(Number(cur ?? 0) + 1, 0, max, 0);
    updates[path] = next;
  };

  switch (resultKey) {
    case "driverHit":
      bump("system.crew.driverHit", crew.driverHit, 2);
      break;
    case "commanderHit":
      bump("system.crew.commanderHit", crew.commanderHit, 2);
      break;
    case "crewKilled":
      updates["system.crew.driverHit"] = 2;
      updates["system.crew.commanderHit"] = 2;
      notes.push("Crew killed");
      break;
    case "sensors":
      bump("system.crit.sensorHits", crit.sensorHits, 2);
      break;
    case "engineHit":
      updates["system.crit.engineHit"] = true;
      break;
    case "stabilizer": {
      const left = Boolean(crit.stabilizerLeft);
      const right = Boolean(crit.stabilizerRight);
      if (!left) updates["system.crit.stabilizerLeft"] = true;
      else if (!right) updates["system.crit.stabilizerRight"] = true;
      motive = await _rollMotiveSystemDamage(targetActor, attackSide);
      if (motive.severity > 0) {
        const current = Number(crit.motiveHits ?? 0) || 0;
        updates["system.crit.motiveHits"] = Math.max(current, motive.severity);
      }
      break;
    }
    case "turretJam":
    case "turretLocks":
      updates["system.crit.turretLocked"] = true;
      break;
    case "turretBlownOff": {
      updates["system.crit.turretLocked"] = true;
      const armorMax = Number(targetActor.system?.armor?.turret?.max ?? 0) || 0;
      updates["system.armor.turret.dmg"] = clampInt(armorMax, 0, armorMax, 0);
      updates["system.structure.turret.dmg"] = clampInt(structMax, 0, structMax, 0);
      notes.push("Turret blown off");
      break;
    }
    case "ammunition":
      if (_vehicleHasAmmo(targetActor)) notes.push("Ammunition hit");
      else {
        notes.push("Ammunition hit (no ammo carried): treated as Weapon Destroyed");
      }
      break;
    case "fuelTank":
      if (_vehicleIsFusion(targetActor)) {
        updates["system.crit.engineHit"] = true;
        notes.push("Fuel Tank hit (fusion): treated as Engine Hit");
      } else {
        notes.push("Fuel Tank hit");
      }
      break;
    case "weaponMalfunction":
      notes.push("Weapon malfunction");
      break;
    case "weaponDestroyed":
      notes.push("Weapon destroyed");
      break;
    case "cargoInfantry":
      notes.push("Cargo/Infantry hit");
      break;
    case "crewStunned":
      notes.push("Crew stunned");
      break;
    default:
      break;
  }

  if (Object.keys(updates).length) await targetActor.update(updates);

  return {
    ok: true,
    table: tableKey,
    roll,
    resultKey,
    notes,
    motive
  };
}

async function applyDamageToVehicleActor(targetActor, hitLoc, damage, { attackSide = "front", crit = null } = {}) {
  if (!targetActor) return { ok: false, reason: "No target actor" };

  const loc = _normalizeVehicleLocation(hitLoc);
  if (!loc) return { ok: false, reason: "No hit location" };

  const tonnage = Number(targetActor.system?.vehicle?.tonnage ?? 0) || 0;
  const structMax = Math.max(0, Math.floor(tonnage / 10));

  const armorNode = targetActor.system?.armor?.[loc] ?? {};
  const armorMax = Number(armorNode.max ?? 0) || 0;
  const armorDmg = Number(armorNode.dmg ?? 0) || 0;
  const armorRemaining = Math.max(0, armorMax - armorDmg);

  let remaining = num(damage, 0);
  const armorApplied = Math.min(remaining, armorRemaining);
  remaining -= armorApplied;

  const structNode = targetActor.system?.structure?.[loc] ?? {};
  const structDmg = Number(structNode.dmg ?? 0) || 0;
  const structRemaining = Math.max(0, structMax - structDmg);
  const structApplied = Math.min(remaining, structRemaining);
  remaining -= structApplied;

  const updates = {};
  if (armorApplied > 0) updates[`system.armor.${loc}.dmg`] = clampInt(armorDmg + armorApplied, 0, armorMax, 0);
  if (structApplied > 0 || structMax > 0) updates[`system.structure.${loc}.dmg`] = clampInt(structDmg + structApplied, 0, structMax, 0);

  if (Object.keys(updates).length) {
    await targetActor.update(updates);
  }

  let vehicleCrit = null;
  if (crit?.trigger) {
    vehicleCrit = await applyVehicleCritical(targetActor, crit.tableLoc, { attackSide, loc });
  }

  return {
    ok: true,
    loc,
    armorApplied,
    structureApplied: structApplied,
    overflow: remaining,
    vehicleCrit
  };
}

function _normalizeDropshipLocation(loc) {
  const raw = String(loc ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (["nose", "left", "right", "aft"].includes(raw)) return raw;
  if (["front", "fore"].includes(raw)) return "nose";
  if (["rear", "back", "stern"].includes(raw)) return "aft";
  if (["left side", "port"].includes(raw)) return "left";
  if (["right side", "starboard"].includes(raw)) return "right";
  return null;
}

const DROPSHIP_HIT_LOCATION_TABLES = {
  front: {
    2: "left",
    3: "nose",
    4: "nose",
    5: "left",
    6: "nose",
    7: "nose",
    8: "nose",
    9: "right",
    10: "nose",
    11: "nose",
    12: "right"
  },
  rear: {
    2: "left",
    3: "aft",
    4: "aft",
    5: "left",
    6: "aft",
    7: "aft",
    8: "aft",
    9: "right",
    10: "aft",
    11: "aft",
    12: "right"
  },
  left: {
    2: "nose",
    3: "left",
    4: "left",
    5: "nose",
    6: "left",
    7: "left",
    8: "left",
    9: "aft",
    10: "left",
    11: "left",
    12: "aft"
  },
  right: {
    2: "nose",
    3: "right",
    4: "right",
    5: "nose",
    6: "right",
    7: "right",
    8: "right",
    9: "aft",
    10: "right",
    11: "right",
    12: "aft"
  }
};

async function rollDropshipHitLocation(attackSide = "front") {
  const side = ["front", "rear", "left", "right"].includes(String(attackSide ?? "").toLowerCase())
    ? String(attackSide).toLowerCase()
    : "front";
  const table = DROPSHIP_HIT_LOCATION_TABLES[side] ?? DROPSHIP_HIT_LOCATION_TABLES.front;
  const roll = await (new Roll("2d6")).evaluate();
  const loc = table[roll.total] ?? (side === "rear" ? "aft" : side === "left" ? "left" : side === "right" ? "right" : "nose");

  return {
    roll,
    loc,
    display: loc
  };
}

async function applyDamageToDropshipActor(targetActor, hitLoc, damage) {
  if (!targetActor) return { ok: false, reason: "No target actor" };

  const loc = _normalizeDropshipLocation(hitLoc);
  if (!loc) return { ok: false, reason: "No hit location" };

  const armorNode = targetActor.system?.armor?.[loc] ?? {};
  const armorMax = Number(armorNode.max ?? 0) || 0;
  const armorDmg = Number(armorNode.dmg ?? 0) || 0;
  const armorRemaining = Math.max(0, armorMax - armorDmg);

  let remaining = num(damage, 0);
  const armorApplied = Math.min(remaining, armorRemaining);
  remaining -= armorApplied;

  const siNode = targetActor.system?.structure?.si ?? {};
  const siMax = Number(siNode.max ?? 0) || 0;
  const siDmg = Number(siNode.dmg ?? 0) || 0;
  const structureRemaining = Math.max(0, siMax - siDmg);
  const structureApplied = Math.min(remaining, structureRemaining);
  remaining -= structureApplied;

  const updates = {};
  if (armorApplied > 0) updates[`system.armor.${loc}.dmg`] = clampInt(armorDmg + armorApplied, 0, armorMax, 0);
  if (structureApplied > 0 || siMax > 0) updates["system.structure.si.dmg"] = clampInt(siDmg + structureApplied, 0, siMax, 0);
  if (Object.keys(updates).length) await targetActor.update(updates);

  return {
    ok: true,
    loc,
    armorApplied,
    structureApplied,
    overflow: remaining
  };
}

// Heat can exceed the normal 30-point token/resource bar maximum.
// Keep system.heat.max at 30 for the bar, but allow stored heat.value/current up to this cap.
const HEAT_HARD_CAP = 100;

// Facing math note:
// - Foundry token rotation and Math.atan2 bearing both use a 0° reference pointing to the right (east)
//   and increase clockwise (because screen Y increases downward).
// - Therefore we generally do NOT need an arbitrary offset here.
// - If you use a third-party facing module with a different 0° reference, you can reintroduce an
//   offset, but the hex-direction-based logic below is preferred.
const FACING_OFFSET_DEG = 0;

function normalizeDeg(d) {
  const n = Number(d);
  if (!Number.isFinite(n)) return 0;
  let x = n % 360;
  if (x < 0) x += 360;
  return x;
}

function getHexFacingOffsetDeg() {
  try {
    const t = canvas?.grid?.type ?? canvas?.scene?.grid?.type;
    if (t === CONST?.GRID_TYPES?.HEXODDQ || t === CONST?.GRID_TYPES?.HEXEVENQ) return 30;
  } catch (_) {
    // ignore
  }
  return 0;
}

function facingIndexToDeg(index, isHex = true) {
  const step = isHex ? 60 : 45;
  const offset = isHex ? getHexFacingOffsetDeg() : 0;
  return normalizeDeg((Number(index ?? 0) || 0) * step + offset);
}

function buildAttackResultBanner({ hit = false, label = null, detail = "" } = {}) {
  const isHit = !!hit;
  const title = label ?? (isHit ? "HIT" : "MISS");
  const bg = isHit ? "linear-gradient(135deg, #1f7a45, #2ca85f)" : "linear-gradient(135deg, #8a1f2d, #c53b4c)";
  const border = isHit ? "#8df0b2" : "#ff9aa5";
  const shadow = isHit ? "rgba(44,168,95,0.25)" : "rgba(197,59,76,0.22)";
  const detailHtml = detail ? `<div style="font-size:12px; font-weight:600; opacity:0.92; margin-top:2px;">${detail}</div>` : "";
  return `<div style="margin:8px 0 10px; padding:10px 12px; border-radius:10px; background:${bg}; border:1px solid ${border}; box-shadow:0 6px 18px ${shadow}; color:#fff; text-align:center;">
    <div style="font-size:18px; font-weight:800; letter-spacing:0.08em;">${title}</div>
    ${detailHtml}
  </div>`;
}

function buildAttackDetailsOpen(summary = "Show Details") {
  return `<details style="margin-top:8px;">
    <summary style="cursor:pointer; font-weight:700; color:#b7c9ff; user-select:none;">${summary}</summary>
    <div style="margin-top:8px;">`;
}

// ------------------------------------------------------------
// About Face integration helpers
// ------------------------------------------------------------

/**
 * Many tables (including yours) use the "About Face" module to track facing without rotating token art.
 * In that case, token.document.rotation may be stuck at 0 even though the token has a real facing.
 *
 * About Face stores per-token values in token flags. We don't hard-code a single schema; instead we
 * probe a few common keys and accept either:
 *   - a snapped direction index (0..5 on hex, 0..7 on square)
 *   - a degree value (0..360)
 */
function _getAboutFaceFlags(token) {
  const flags = token?.document?.flags;
  if (!flags || typeof flags !== "object") return null;
  // Most common module id is "about-face".
  return flags["about-face"] ?? flags.aboutFace ?? flags.aboutface ?? null;
}

function _extractSnappedFacingDir(token) {
  if (!token?.document) return null;

  const candidates = [];

  // Direct About Face flags (most likely)
  const af = _getAboutFaceFlags(token);
  if (af && typeof af === "object") {
    candidates.push(
      af.direction,
      af.dir,
      af.facingDirection,
      af.facingDir,
      af.tokenDirection,
      af.facing
    );
    if (af.facing && typeof af.facing === "object") {
      candidates.push(af.facing.direction, af.facing.dir, af.facing.value);
    }
  }

  // Also try the official getFlag API (covers a few alternate schemas)
  try {
    candidates.push(
      token.document.getFlag?.("about-face", "direction"),
      token.document.getFlag?.("about-face", "dir"),
      token.document.getFlag?.("about-face", "facingDirection"),
      token.document.getFlag?.("about-face", "facingDir"),
      token.document.getFlag?.("about-face", "tokenDirection")
    );
  } catch (_) {
    // ignore
  }

  const grid = canvas?.grid;
  const isHex = Boolean(grid?.isHexagonal || grid?.grid?.isHexagonal);
  const maxDir = isHex ? 5 : 7;

  for (const c of candidates) {
    if (!Number.isFinite(Number(c))) continue;
    const v = Number(c);
    if (!Number.isInteger(v)) continue;
    if (v >= 0 && v <= maxDir) return v;
  }

  return null;
}

function _extractFacingDegFromFlags(token) {
  if (!token?.document) return null;

  const candidates = [];

  const af = _getAboutFaceFlags(token);
  if (af && typeof af === "object") {
    candidates.push(af.rotation, af.angle, af.facingAngle, af.deg, af.degrees);
    if (af.facing && typeof af.facing === "object") {
      candidates.push(af.facing.rotation, af.facing.angle, af.facing.deg, af.facing.degrees);
    }
  }

  // Generic facing flags from other modules
  const flags = token.document.flags ?? {};
  for (const modId of Object.keys(flags)) {
    const f = flags[modId];
    if (!f || typeof f !== "object") continue;
    candidates.push(f.facing, f.direction, f.rotation, f.angle, f.facingAngle);
    if (f.facing && typeof f.facing === "object") {
      candidates.push(f.facing.rotation, f.facing.angle, f.facing.value);
    }
  }

  if (flags.facing && typeof flags.facing === "object") {
    candidates.push(flags.facing.rotation, flags.facing.angle, flags.facing.value);
  }

  for (const c of candidates) {
    if (!Number.isFinite(Number(c))) continue;
    const v = Number(c);
    if (v >= 0 && v < 360) return normalizeDeg(v);
  }

  return null;
}

function _aboutFaceFacingStringToDeg(dir) {
  // About Face may store a simple facingDirection string (especially on token creation)
  // which is one of: right, left, up, down.
  // These map to Foundry canvas degrees where 0° points right and angles increase clockwise.
  const s = String(dir ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s === "right") return 0;
  if (s === "down") return 90;
  if (s === "left") return 180;
  if (s === "up") return 270; // normalizeDeg will keep this as 270 instead of -90
  return null;
}

function _getSystemTorsoFacingDeg(token) {
  try {
    const raw = token?.document?.getFlag?.(SYSTEM_ID, "torsoFacing");
    const deg = Number(raw);
    if (Number.isFinite(deg)) return normalizeDeg(deg);
  } catch (_) {
    // ignore
  }
  return null;
}

/**
 * Try to extract a "facing" angle in degrees from the token.
 * - Default: token.document.rotation (Foundry standard).
 * - If you use a facing module that stores flags, this tries a few common patterns.
 *   If a flag value looks like 0..5 (hex side), it converts to degrees (side*60).
 */
function getTokenFacingDeg(token) {
  if (!token?.document) return null;

  // 0) Prefer torso facing when present; incoming hit arcs use the twisted torso.
  const torsoFacing = _getSystemTorsoFacingDeg(token);
  if (torsoFacing !== null) return torsoFacing;

  // 1) Prefer the system's native leg facing flag when present.
  try {
    const nativeFacing = token.document.getFlag?.(SYSTEM_ID, "facing");
    if (Number.isFinite(Number(nativeFacing))) return normalizeDeg(Number(nativeFacing));
  } catch (_) {
    // ignore
  }

  // 1) If About Face is installed and tracking facing without rotating token art,
  //    prefer its stored direction (in degrees). This avoids relying on token.rotation,
  //    which may remain 0 even when the mech has a real facing.
  try {
    const af = _getAboutFaceFlags(token);
    const afDir = af?.direction ?? token.document.getFlag?.("about-face", "direction");
    if (Number.isFinite(Number(afDir))) return normalizeDeg(Number(afDir));

    const afFacingStr = af?.facingDirection ?? token.document.getFlag?.("about-face", "facingDirection");
    const afDeg = _aboutFaceFacingStringToDeg(afFacingStr);
    if (Number.isFinite(Number(afDeg))) return normalizeDeg(Number(afDeg));
  } catch (_) {
    // ignore
  }

  // 2) Prefer a snapped facing direction index (especially when About Face is used).
  //    We only use this for a best-effort degree display and as a fallback for non-grid arc math.
  const snapped = _extractSnappedFacingDir(token);
  if (Number.isFinite(snapped)) {
    const grid = canvas?.grid;
    const isHex = Boolean(grid?.isHexagonal || grid?.grid?.isHexagonal);
    return facingIndexToDeg(snapped, isHex);
  }

  // 3) Otherwise try to extract degrees from module flags.
  const flagged = _extractFacingDegFromFlags(token);
  if (flagged !== null) return flagged;

  // 4) Fallback: if the token actually rotates, use Foundry's built-in rotation value.
  const rot = token.document.rotation;
  if (Number.isFinite(rot)) return normalizeDeg(rot);

  return null;
}

/**
 * Convert a token's facing to a snapped grid direction (0..5 on hex), using the Scene's grid math.
 * This is more reliable than raw degree thresholds because it respects the current hex orientation
 * (flat-top vs pointy-top) and any Foundry internal direction mapping.
 */
function getTokenFacingDir(token) {
  const torsoDeg = _getSystemTorsoFacingDeg(token);
  if (torsoDeg !== null) return getFacingDirFromDeg(token, torsoDeg);

  // If About Face (or another module) stores a snapped direction index, use it directly.
  // This avoids 0°-reference mismatches that can cause "rear/side" to trigger too often.
  const snapped = _extractSnappedFacingDir(token);
  if (Number.isFinite(snapped)) return snapped;

  const deg = getTokenFacingDeg(token);
  if (deg === null) return null;

  return getFacingDirFromDeg(token, deg);
}

function getFacingDirFromDeg(token, deg) {
  // Best: ask the grid to quantize direction by projecting a point "in front" of the token.
  try {
    const grid = canvas?.grid;
    const origin = token?.center;
    if (grid?.getDirection && origin) {
      const rad = normalizeDeg(deg) * Math.PI / 180;
      const dist = grid.size ?? 100;
      const pt = { x: origin.x + Math.cos(rad) * dist, y: origin.y + Math.sin(rad) * dist };
      const dir = grid.getDirection(origin, pt);
      if (Number.isFinite(dir)) return dir;
    }
  } catch (_) {
    // fall through
  }

  // Fallback: snap degrees to 6 directions, respecting the current hex orientation offset.
  return (Math.round((normalizeDeg(deg) - getHexFacingOffsetDeg()) / 60) % 6 + 6) % 6;
}

/**
 * Determine which side of the TARGET is being attacked from, using target facing.
 * Returns: { side, facingDeg, bearingDeg, relDeg } or null if cannot determine.
 */
function getTargetSideFromFacing(attackerToken, targetToken) {
  if (!attackerToken || !targetToken) return null;

  const facingDeg = getTokenFacingDeg(targetToken);
  if (facingDeg === null) return null;
  const attackerCenter = getTokenCenter(attackerToken);
  const targetCenter = getTokenCenter(targetToken);
  if (!attackerCenter || !targetCenter) return null;

  // If we have a hex grid, use direction indices for exact BattleTech hex-side arcs.
  // Arc mapping (per your screenshot):
  // - FRONT: 3 hex sides (180°) => delta 0, 1, 5
  // - REAR:  1 hex side (centered behind) => delta 3
  // - RIGHT: 1 hex side (rear-right) => delta 2
  // - LEFT:  1 hex side (rear-left) => delta 4
  try {
    const grid = canvas?.grid;
    const origin = targetCenter;
    const attackerPt = attackerCenter;
    if (grid?.getDirection && origin && attackerPt) {
      const facingDir = getTokenFacingDir(targetToken);
      const attackerDir = grid.getDirection(origin, attackerPt);
      if (Number.isFinite(facingDir) && Number.isFinite(attackerDir)) {
        const delta = ((attackerDir - facingDir) % 6 + 6) % 6;

        // Keep the old debug fields (bearing/relDeg) for chat output/diagnostics.
        const dx0 = attackerPt.x - origin.x;
        const dy0 = attackerPt.y - origin.y;
        const bearingDeg = normalizeDeg(Math.atan2(dy0, dx0) * 180 / Math.PI);
        const relDeg = normalizeDeg((bearingDeg - facingDeg) - FACING_OFFSET_DEG);

        let side;
        if (delta === 0 || delta === 1 || delta === 5) side = "front";
        else if (delta === 3) side = "rear";
        else if (delta === 2) side = "right";
        else side = "left"; // delta === 4

        return { side, facingDeg, bearingDeg, relDeg, facingDir, attackerDir, delta };
      }
    }
  } catch (_) {
    // fall through to degree-based fallback
  }

  const dx = attackerCenter.x - targetCenter.x;
  const dy = attackerCenter.y - targetCenter.y;
  const bearingDeg = normalizeDeg(Math.atan2(dy, dx) * 180 / Math.PI);

  // Degree-based fallback that matches the 6-hex-side arcs.
  // FRONT = 180° (±90°), then the remaining hemisphere is split into 3 equal 60° wedges.
  // NOTE: In hex terms, each "side" is effectively a 60° wedge.
  const relDeg = normalizeDeg((bearingDeg - facingDeg) - FACING_OFFSET_DEG);

  let side;
  if (relDeg <= 90 || relDeg >= 270) side = "front";
  else if (relDeg > 90 && relDeg <= 150) side = "right";
  else if (relDeg > 150 && relDeg <= 210) side = "rear";
  else if (relDeg > 210 && relDeg < 270) side = "left";
  else side = "front";

  return { side, facingDeg, bearingDeg, relDeg };
}

function getDefaultTN(fallback = 8) {
  try {
    return game?.settings?.get?.(SYSTEM_ID, "defaultTN") ?? fallback;
  } catch {
    return fallback;
  }
}


// ------------------------------------------------------------
// Scene Environment (global weather/lighting) TN modifiers
// Stored on Scene flags: flags.atow-battletech.environment.*
// ------------------------------------------------------------
function getSceneEnvironment(scene = canvas?.scene ?? game?.scenes?.active) {
  const env = scene?.getFlag?.(SYSTEM_ID, "environment") ?? scene?.flags?.[SYSTEM_ID]?.environment ?? {};
  return env ?? {};
}

function isMissileWeapon(weaponItem) {
  const name = (weaponItem?.name ?? "").toLowerCase();
  const sys = weaponItem?.system ?? {};
  const kind = String(sys.type ?? sys.category ?? sys.weaponType ?? "").toLowerCase();
  return (
    kind.includes("missile") ||
    name.includes("lrm") || name.includes("mrm") || name.includes("mml") || name.includes("srm") ||
    name.includes("missile") || name.includes("rocket") || name.includes("atm")
  );
}

function isDirectFireEnergyWeapon(weaponItem) {
  const name = (weaponItem?.name ?? "").toLowerCase();
  const sys = weaponItem?.system ?? {};
  const kind = String(sys.type ?? sys.category ?? sys.weaponType ?? "").toLowerCase();

  // Heuristic: lasers/PPC/energy but not missile
  if (isMissileWeapon(weaponItem)) return false;

  return (
    kind.includes("energy") ||
    name.includes("laser") ||
    name.includes("ppc") ||
    name.includes("flamer")
  );
}

function isLaserWeapon(weaponItem) {
  const name = String(weaponItem?.name ?? "").toLowerCase();
  const sys = weaponItem?.system ?? {};
  const kind = String(sys.type ?? sys.category ?? sys.weaponType ?? sys.damageType ?? "").toLowerCase();
  return name.includes("laser") || kind.includes("laser");
}

function getXPulseLaserRangeProfile(item) {
  const name = String(item?.name ?? "").trim().toLowerCase();
  const sys = item?.system ?? {};
  const text = [
    name,
    sys.type,
    sys.category,
    sys.weaponType,
    sys.subtype,
    sys.tags
  ].flat().filter(Boolean).map(String).join(" ").toLowerCase();

  if (!/\bx\s*[- ]?\s*pulse\b/i.test(text) || !text.includes("laser")) return null;
  if (/\bsmall\b/i.test(text)) return { min: 0, short: 3, medium: 5, long: 7 };
  if (/\bmedium\b/i.test(text)) return { min: 0, short: 5, medium: 9, long: 14 };
  if (/\blarge\b/i.test(text)) return { min: 0, short: 7, medium: 14, long: 20 };
  return null;
}

function isActorDazzleModeActive(actor) {
  try {
    return Boolean(actor?.getFlag?.(SYSTEM_ID, "dazzleMode"));
  } catch (_) {
    return false;
  }
}

function getEnvironmentTNMods(weaponItem, scene = canvas?.scene ?? game?.scenes?.active) {
  const env = getSceneEnvironment(scene);

  let mod = 0;
  const details = [];

  // Lighting: applies to all attacks
  switch (String(env.lighting ?? "day")) {
    case "dusk":
      mod += 1; details.push("Dusk/Dawn +1"); break;
    case "fullmoon":
      mod += 2; details.push("Full Moon +2"); break;
    case "moonless":
      mod += 3; details.push("Moonless +3"); break;
    default:
      break;
  }

  // Rain: applies to all attacks
  switch (String(env.rain ?? "none")) {
    case "moderate":
      mod += 1; details.push("Moderate Rain +1"); break;
    case "heavy":
      mod += 2; details.push("Heavy Rain +2"); break;
    default:
      break;
  }

  // Snow: applies to all attacks
  if (String(env.snow ?? "none") === "snowing") {
    mod += 1; details.push("Snowing +1");
  }

  // Fog: direct-fire energy only
  if (String(env.fog ?? "none") === "heavy" && isDirectFireEnergyWeapon(weaponItem)) {
    mod += 1; details.push("Heavy Fog (energy) +1");
  }

  // Wind: missiles only (0..3)
  const wind = num(env.wind, 0);
  if (wind > 0 && isMissileWeapon(weaponItem)) {
    mod += wind;
    details.push(`Wind (missiles) +${wind}`);
  }

  return { mod, details, env };
}


// ------------------------------------------------------------
// Ammo tracking (sheet ammo bins)
// Sheet stores ammo at system.ammoBins.<key>.{current,total,name?}
// We decrement current by 1 per shot fired (if a matching bin exists).
// If there is no ammo left for that bin, we abort the attack.
// ------------------------------------------------------------
function slugifyAmmoKey(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/**
 * Convert an ammo "type label" to our bin key format.
 * Accepts inputs like: "AC/20", "AC 20", "LRM 20", "SRM-6", "ac-10", etc.
 */
function ammoKeyFromTypeLabel(typeText) {
  const raw = String(typeText ?? "").trim();
  // Accept both a bare ammo type ("NARC") and the complete crit-slot label
  // ("Ammo (NARC) 6"). Weapon items and mounted-slot fallbacks can supply either.
  const installedAmmoLabel = raw.match(/^\s*ammo\s*\(([^)]+)\)\s*\d+\s*$/i);
  const t = String(installedAmmoLabel?.[1] ?? raw).trim().toLowerCase();

  // Ammo-less weapons use labels like "None" or "N/A"; do not turn those into fake bins.
  if (!t || t === "none" || t === "n/a" || t === "na" || t === "n-a" || t === "no ammo" || t === "ammo none") {
    return null;
  }

  const missileAmmoKey = getMissileAmmoKey(t);
  if (missileAmmoKey) return missileAmmoKey;

  // If already looks like our key, keep it stable
  if (/^(ac|lrm|mrm|srm|atm)-\d+(?:-(?:er|he))?$/.test(t)) return t;
  if (/^lbx-\d+(?:-cluster)?$/.test(t)) return t;

  // LB-X autocannon ammo: accept labels like
  // - "LB 10-X AC"
  // - "LB 10-X AC Slug"
  // - "LB 10-X AC Cluster"
  // - "LB 10-X AC 10"
  // - "LBX AC/10"
  // - "LBX 10"
  let m = t.match(/\blb\s*(\d+)\s*-\s*x\s*ac\b/i);
  if (m?.[1]) {
    return slugifyAmmoKey(`lbx-${m[1]}${/\bcluster\b/i.test(t) ? "-cluster" : ""}`);
  }
  m = t.match(/\blbx\b[^\d]*(\d+)\b/i);
  if (m?.[1]) {
    return slugifyAmmoKey(`lbx-${m[1]}${/\bcluster\b/i.test(t) ? "-cluster" : ""}`);
  }

  // Advanced Tactical Missile ammo: "ATM 6", "ATM 6 ER", "ATM 9 HE", "Advanced Tactical Missile 9 HE"
  const atmRack = parseMissileRackLabel(t);
  if (atmRack?.type === "ATM") {
    const variant = /\ber\b/i.test(t) ? "-er" : (/\bhe\b/i.test(t) ? "-he" : "");
    return slugifyAmmoKey(`atm-${atmRack.size}${variant}`);
  }

  // Autocannons: "AC/20", "AC 20"
  m = t.match(/\bac\s*\/?\s*(\d+)\b/i);
  if (m?.[1]) return slugifyAmmoKey(`ac-${m[1]}`);

  // LRMs / MRMs / SRMs
  m = t.match(/\b(lrm|mrm|srm)\s*-?\s*(\d+)\b/i) ?? t.match(/\b(lrm|mrm|srm)\b[^\d]*(\d+)\b/i);
  if (m?.[1] && m?.[2]) return slugifyAmmoKey(`${m[1]}-${m[2]}`);
  m = t.match(/\bmedium\s+range\s+missiles?\b[^\d]*(10|20|30|40)\b/i);
  if (m?.[1]) return slugifyAmmoKey(`mrm-${m[1]}`);

  // Machine guns / other common ammo users (optional)
  if (t.includes("machine gun") || t === "mg") return "mg";
  if (t === "ams" || /\banti\s*-?\s*missile\s+system\b/i.test(t)) return "ams";

  if (t === "narc" || /\bnarc\s+(missile\s+)?(beacon\s+)?pods?\b/i.test(t)) return "narc";

  return slugifyAmmoKey(t);
}

function getLBXWeaponSize(weaponItem) {
  const name = String(weaponItem?.name ?? "").trim().toLowerCase();
  let m = name.match(/\blb\s*(\d+)\s*-\s*x\s*ac\b/i);
  if (m?.[1]) return Number(m[1]);
  m = name.match(/\blbx\b[^\d]*(\d+)\b/i);
  if (m?.[1]) return Number(m[1]);
  return null;
}

function isLBXWeapon(weaponItem) {
  return Number.isFinite(getLBXWeaponSize(weaponItem));
}

function getLBXAmmoKeysForWeapon(weaponItem) {
  const size = getLBXWeaponSize(weaponItem);
  if (!Number.isFinite(size)) return [];
  return [
    slugifyAmmoKey(`lbx-${size}`),
    slugifyAmmoKey(`lbx-${size}-cluster`)
  ];
}

function getATMWeaponSize(weaponItem) {
  const sys = weaponItem?.system ?? {};
  const candidates = [
    weaponItem?.name,
    sys.ammoKey,
    sys.ammoType,
    sys.ammoName,
    sys.ammoLabel,
    sys.ammoBin,
    typeof sys.ammo === "string" ? sys.ammo : null,
    sys.ammo?.key,
    sys.ammo?.type,
    sys.ammo?.name
  ];

  for (const candidate of candidates) {
    const rack = parseMissileRackLabel(candidate);
    if (rack?.type === "ATM") return rack.size;
  }

  return null;
}

function isATMWeapon(weaponItem) {
  return Number.isFinite(getATMWeaponSize(weaponItem));
}

function getATMAmmoKeysForWeapon(weaponItem) {
  const size = getATMWeaponSize(weaponItem);
  if (!Number.isFinite(size)) return [];
  return [
    slugifyAmmoKey(`atm-${size}`),
    slugifyAmmoKey(`atm-${size}-er`),
    slugifyAmmoKey(`atm-${size}-he`)
  ];
}

function getATMAmmoVariant(ammoKey) {
  const key = String(ammoKey ?? "").trim().toLowerCase();
  if (/-er$/.test(key)) return "er";
  if (/-he$/.test(key)) return "he";
  return "standard";
}

function getATMProfile(weaponItem, ammoKey = null) {
  if (!isATMWeapon(weaponItem)) return null;
  const variant = getATMAmmoVariant(ammoKey);
  if (variant === "er") {
    return {
      variant,
      label: "ER",
      damagePerMissile: 1,
      groupSize: 5,
      range: { min: 4, short: 9, medium: 18, long: 27 }
    };
  }
  if (variant === "he") {
    return {
      variant,
      label: "HE",
      damagePerMissile: 3,
      groupSize: 5,
      range: { min: 0, short: 3, medium: 6, long: 9 }
    };
  }
  return {
    variant: "standard",
    label: "Standard",
    damagePerMissile: 2,
    groupSize: 5,
    range: null
  };
}

function weaponSupportsAmmoSelection(weaponItem) {
  const rack = getMissileRack(weaponItem);
  const rackType = String(rack?.type ?? "").toUpperCase();
  const isStreak = /\bstreak\b/i.test(String(weaponItem?.name ?? ""));
  return isLBXWeapon(weaponItem) || isATMWeapon(weaponItem) || (["LRM", "MML", "SRM"].includes(rackType) && !isStreak);
}

function getAmmoKeyForWeapon(weaponItem) {
  const sys = weaponItem?.system ?? {};

  const rotaryProfile = getRotaryACProfile(weaponItem);
  if (rotaryProfile) return rotaryProfile.ammoKey;

  // Allow explicit mapping on the weapon item (many possible schemas)
  const explicit =
    sys.ammoKey ??
    sys.ammoType ??
    sys.ammoName ??
    sys.ammoLabel ??
    sys.ammoBin ??
    (typeof sys.ammo === "string" ? sys.ammo : null) ??
    sys.ammo?.key ??
    sys.ammo?.type ??
    sys.ammo?.name ??
    null;

  if (explicit) {
    const explicitKey = ammoKeyFromTypeLabel(explicit);
    if (explicitKey) return explicitKey;
  }

  const name = String(weaponItem?.name ?? "").toLowerCase();

  const lbxSize = getLBXWeaponSize(weaponItem);
  if (Number.isFinite(lbxSize)) {
    return slugifyAmmoKey(`lbx-${lbxSize}`);
  }

  const atmSize = getATMWeaponSize(weaponItem);
  if (Number.isFinite(atmSize)) {
    return slugifyAmmoKey(`atm-${atmSize}`);
  }

  // Autocannons: "AC/20", "AC 20"
  let m = name.match(/\bac\s*\/?\s*(\d+)\b/i);
  if (m?.[1]) return slugifyAmmoKey(`ac-${m[1]}`);

  // LRMs / MMLs / MRMs / SRMs
  m = name.match(/\b(lrm|mml|mrm|srm)\s*-?\s*(\d+)\b/i) ?? name.match(/\b(lrm|mml|mrm|srm)\b[^\d]*(\d+)\b/i);
  if (m?.[1] && m?.[2]) return slugifyAmmoKey(`${m[1]}-${m[2]}`);
  m = name.match(/\bmedium\s+range\s+missiles?\b[^\d]*(10|20|30|40)\b/i);
  if (m?.[1]) return slugifyAmmoKey(`mrm-${m[1]}`);

  // Machine guns
  if (name.includes("machine gun") || name.includes("mg")) return "mg";
  if (name === "ams" || /\banti\s*-?\s*missile\s+system\b/i.test(name)) return "ams";
  if (name === "arrow iv system" || name === "arrow iv system (c)") return ammoKeyFromTypeLabel("Arrow IV Homing");

  return null;
}

async function getAmmoSelectionOptions(actor, weaponItem) {
  const options = [];
  const { totals } = await ensureActorAmmoBins(actor);
  const bins = actor?.system?.ammoBins ?? {};

  const addOption = (key, label) => {
    if (!key) return;
    const bin = bins?.[key];
    const total = num(bin?.total, totals.get(key)?.total ?? 0);
    const current = Number.isFinite(Number(bin?.current)) ? num(bin.current, total) : total;
    if (!bin && !totals.has(key)) return;
    if (current <= 0) return;
    options.push({
      key,
      label: label ?? String(bin?.name ?? totals.get(key)?.name ?? key),
      current,
      total
    });
  };

  const lbxSize = getLBXWeaponSize(weaponItem);
  if (Number.isFinite(lbxSize)) {
    addOption(slugifyAmmoKey(`lbx-${lbxSize}`), `Slug (${weaponItem?.name ?? `LB ${lbxSize}-X AC`} Slug)`);
    addOption(slugifyAmmoKey(`lbx-${lbxSize}-cluster`), `Cluster (${weaponItem?.name ?? `LB ${lbxSize}-X AC`} Cluster)`);
  }

  const atmSize = getATMWeaponSize(weaponItem);
  if (Number.isFinite(atmSize)) {
    addOption(slugifyAmmoKey(`atm-${atmSize}`), `Standard (ATM ${atmSize})`);
    addOption(slugifyAmmoKey(`atm-${atmSize}-er`), `ER (ATM ${atmSize})`);
    addOption(slugifyAmmoKey(`atm-${atmSize}-he`), `HE (ATM ${atmSize})`);
  }

  const missileRack = getMissileRack(weaponItem);
  const missileType = String(missileRack?.type ?? "").toUpperCase();
  if (["LRM", "MML", "SRM"].includes(missileType) && Number.isFinite(Number(missileRack?.size))) {
    const baseKey = `${missileType.toLowerCase()}-${Number(missileRack.size)}`;
    const variants = [
      MISSILE_AMMO_VARIANTS.STANDARD,
      MISSILE_AMMO_VARIANTS.ARTEMIS_IV,
      MISSILE_AMMO_VARIANTS.ARTEMIS_V,
      MISSILE_AMMO_VARIANTS.FRAGMENTATION,
      MISSILE_AMMO_VARIANTS.INFERNO,
      MISSILE_AMMO_VARIANTS.NARC,
      MISSILE_AMMO_VARIANTS.SEMI_GUIDED
    ];
    for (const variant of variants) {
      if (!isMissileAmmoVariantCompatible(missileType, variant)) continue;
      const key = variant === MISSILE_AMMO_VARIANTS.STANDARD ? baseKey : `${baseKey}-${variant}`;
      addOption(key, `${getMissileAmmoVariantLabel(variant)} (${missileType}-${missileRack.size})`);
    }
  }

  if (!options.length) return { options: [], defaultKey: null, hasMultiple: false };

  const available = options.filter(opt => opt.current > 0);
  const defaultKey = available.find(opt => !/cluster$/i.test(opt.key))?.key
    ?? available[0]?.key
    ?? options[0].key;
  return {
    options,
    defaultKey,
    hasMultiple: options.length > 1
  };
}

/**
 * Build ammo totals from crit slots (same source as the sheet's Ammo section).
 * Crit labels are expected like: "Ammo (LRM 20) 6"
 */
function buildAmmoTotalsFromCritSlots(actorSystem) {
  const crit = actorSystem?.crit ?? {};
  const totals = new Map(); // key -> { key, name, total }

  const add = (name, key, amt) => {
    const n = Number(amt);
    if (!key || !Number.isFinite(n) || n <= 0) return;
    const prev = totals.get(key);
    if (!prev) totals.set(key, { key, name, total: n });
    else prev.total += n;
  };

  for (const loc of Object.values(crit)) {
    const slots = loc?.slots;
    if (!slots) continue;

    const iter = Array.isArray(slots) ? slots : Object.values(slots);
    for (const slot of iter) {
      const label = (typeof slot === "string") ? String(slot).trim() : String(slot?.label ?? "").trim();
      if (!label) continue;

      const m = label.match(/^\s*Ammo\s*\(([^)]+)\)\s*(\d+)\s*$/i);
      if (!m) continue;

      const typeText = String(m[1] ?? "").trim();
      const amt = Number(m[2] ?? 0);
      const key = ammoKeyFromTypeLabel(typeText);

      add(typeText, key, amt);
    }
  }

  return totals;
}

function actorHasOperationalAMS(actor) {
  const crit = actor?.system?.crit ?? {};
  for (const loc of Object.values(crit)) {
    const slots = loc?.slots;
    if (!slots) continue;
    const iter = Array.isArray(slots) ? slots : Object.values(slots);
    for (const slot of iter) {
      if (!slot || (slot.partOf !== undefined && slot.partOf !== null)) continue;
      if (Boolean(slot.destroyed)) continue;
      const label = String(slot?.label ?? slot?.name ?? slot ?? "").trim().toLowerCase();
      if (label === "ams" || /\banti\s*-?\s*missile\s+system\b/i.test(label)) return true;
    }
  }
  return false;
}

async function addHeatToActor(actor, amount) {
  const add = Math.max(0, Number(amount ?? 0) || 0);
  if (!actor || add <= 0) return;
  const addActorPendingHeat = game?.[SYSTEM_ID]?.api?.addActorPendingHeat ?? null;
  if (typeof addActorPendingHeat === "function") {
    await addActorPendingHeat(actor, add);
    return;
  }

  const current = num(actor.system?.heat?.value ?? actor.system?.heat?.current, 0);
  const max = num(actor.system?.heat?.max, 30);
  const next = clamp(current + add, 0, 99);
  await actor.update({
    "system.heat.value": next,
    "system.heat.current": next,
    "system.heat.max": max,
    "system.heat.unvented": next,
    "system.heat.effects.unvented": next
  }).catch(() => {});
}

async function spendActorAmmoBin(actor, key, amount = 1) {
  if (!actor || !key) return { ok: false, reason: "No actor or ammo key" };
  const amt = Math.max(1, num(amount, 1));
  const { totals } = await ensureActorAmmoBins(actor);
  const bins = actor.system?.ammoBins ?? {};
  const bin = bins?.[key];
  const total = num(bin?.total, totals.get(key)?.total ?? 0);
  const current = Number.isFinite(Number(bin?.current)) ? num(bin.current, total) : total;
  const name = String(bin?.name ?? totals.get(key)?.name ?? key);
  if (current < amt) return { ok: false, key, name, before: current, after: current, total, reason: "No ammo" };
  const next = Math.max(0, current - amt);
  await actor.update({ [`system.ammoBins.${key}.current`]: next }).catch(() => {});
  return { ok: true, key, name, before: current, after: next, total, spent: amt };
}

async function resolveAMSDefenseLocal(defenderActor, { attackerName = "", weaponName = "", streak = false } = {}) {
  if (!defenderActor || !isMechActor(defenderActor)) return { active: false, reason: "notMech" };
  if (defenderActor.getFlag?.(SYSTEM_ID, "amsEnabled") === false) return { active: false, reason: "disabled" };
  if (!actorHasOperationalAMS(defenderActor)) return { active: false, reason: "noAMS" };

  const stamp = getCombatTurnStamp();
  const lastStamp = String(defenderActor.getFlag?.(SYSTEM_ID, "amsUsedStamp") ?? "");
  if (game.combat?.started && lastStamp === stamp) return { active: false, reason: "alreadyUsed", stamp };

  const ammo = await spendActorAmmoBin(defenderActor, "ams", 1);
  if (!ammo.ok) return { active: false, reason: "noAmmo", ammo };

  await defenderActor.setFlag?.(SYSTEM_ID, "amsUsedStamp", stamp).catch?.(() => {});
  await addHeatToActor(defenderActor, 1);

  return {
    active: true,
    streak: Boolean(streak),
    clusterMod: streak ? 0 : -4,
    forcedClusterTotal: streak ? 7 : null,
    ammo,
    heat: 1,
    stamp,
    defenderName: defenderActor.name,
    attackerName,
    weaponName
  };
}

async function _gmResolveAMSDefense(actorUuid, source = {}) {
  const targetActor = await _resolveActorFromUuid(actorUuid);
  if (!targetActor) return { active: false, reason: "No target actor" };
  return resolveAMSDefenseLocal(targetActor, source);
}

async function resolveAMSDefense(defenderActor, source = {}) {
  if (!defenderActor) return { active: false, reason: "No defender" };
  if (game.user?.isGM || defenderActor.isOwner) return resolveAMSDefenseLocal(defenderActor, source);
  const socket = getATOWSocket();
  if (!socket) return { active: false, reason: "socketUnavailable" };
  return socket.executeAsGM("gmResolveAMSDefense", defenderActor.uuid, source);
}

/**
 * Ensure actor.system.ammoBins contains entries for any ammo installed in crit slots.
 * - Sets/updates .total (derived) and .name (display)
 * - Initializes .current to .total when missing
 * - Clamps .current down to .total if it exceeds it
 *
 * Returns: { totals: Map, bins: Object }
 */
async function ensureActorAmmoBins(actor) {
  if (!actor) return { totals: new Map(), bins: {} };

  const totals = buildAmmoTotalsFromCritSlots(actor.system ?? {});
  const bins = actor.system?.ammoBins ?? {};

  if (!totals.size) return { totals, bins };

  const updates = {};
  for (const [key, row] of totals.entries()) {
    const total = num(row.total, 0);
    const name = String(row.name ?? key);

    const existing = bins?.[key] ?? {};
    const existingTotal = num(existing.total, total);
    const existingCurrent = Number.isFinite(Number(existing.current))
      ? num(existing.current, total)
      : total;

    const clampedCurrent = clamp(existingCurrent, 0, total);

    if (!bins?.[key] || existingTotal !== total) {
      updates[`system.ammoBins.${key}.total`] = total;
      updates[`system.ammoBins.${key}.name`] = name;
    }
    if (!bins?.[key] || clampedCurrent !== existingCurrent) {
      updates[`system.ammoBins.${key}.current`] = clampedCurrent;
    }
  }

  if (Object.keys(updates).length) {
    await actor.update(updates).catch(() => {});
  }

  return { totals, bins: actor.system?.ammoBins ?? bins };
}

function weaponConsumesAmmo(weaponItem, actor, { ammoKey = null } = {}) {
  const sys = weaponItem?.system ?? {};

  // Explicit override
  if (sys.usesAmmo === false) return false;
  if (sys.usesAmmo === true) return true;

  const key = ammoKey ? ammoKeyFromTypeLabel(ammoKey) : getAmmoKeyForWeapon(weaponItem);
  if (!key) return false;

  // If the actor already has a bin, great.
  const bins = actor?.system?.ammoBins ?? {};
  if (bins?.[key]) return true;

  // Otherwise, see if crit slots imply this ammo exists (sheet can display it even before edits)
  const totals = buildAmmoTotalsFromCritSlots(actor?.system ?? {});
  return totals.has(key);
}

/**
 * Spend ammo for this weapon (defaults to 1). If no ammo remains, abort.
 * Returns:
 *  - { ok:true, spent, key, name, before, after, total }
 *  - { ok:false, key, name, before, after, total, reason }
 */
async function spendAmmoIfApplicable(actor, weaponItem, amount = 1, { ammoKey = null } = {}) {
  if (!actor || !weaponItem) return { ok: true, spent: 0, key: null };

  const key = ammoKey ? ammoKeyFromTypeLabel(ammoKey) : getAmmoKeyForWeapon(weaponItem);
  if (!key) return { ok: true, spent: 0, key: null };

  const { totals } = await ensureActorAmmoBins(actor);

  const bins = actor.system?.ammoBins ?? {};
  const bin = bins?.[key];

  const totalFromCrit = totals.get(key)?.total ?? null;
  const nameFromCrit = totals.get(key)?.name ?? null;

  const total = num(bin?.total, (totalFromCrit ?? 0));
  const name = String(bin?.name ?? nameFromCrit ?? key);

  // If we still can't find a bin or a total, treat as non-ammo weapon.
  if (!bin && !Number.isFinite(Number(totalFromCrit))) {
    return {
      ok: false,
      key,
      name,
      before: 0,
      after: 0,
      total: 0,
      reason: `No ammo of ${name} type`
    };
  }

  const cur = Number.isFinite(Number(bin?.current)) ? num(bin.current, total) : total;
  const amt = Math.max(1, num(amount, 1));

  if (cur < amt) {
    return {
      ok: false,
      spent: 0,
      key,
      name,
      before: cur,
      after: cur,
      total,
      reason: `No ammo of ${name} type`
    };
  }

  const next = Math.max(0, cur - amt);
  const updatePath = `system.ammoBins.${key}.current`;
  await actor.update({ [updatePath]: next });

  return { ok: true, spent: amt, key, name, before: cur, after: next, total };
}


function getWeaponRanges(item, { ammoKey = null } = {}) {
  const atmProfile = getATMProfile(item, ammoKey);
  if (atmProfile?.range) return { ...atmProfile.range };

  const sys = item?.system ?? {};
  const r = sys.range ?? {};
  const xPulseProfile = getXPulseLaserRangeProfile(item);
  if (xPulseProfile) {
    const positiveOrDefault = (value, fallback) => {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };

    return {
      min: num(r.min ?? sys.min, xPulseProfile.min),
      short: positiveOrDefault(r.short ?? sys.sht ?? sys.short, xPulseProfile.short),
      medium: positiveOrDefault(r.medium ?? sys.med ?? sys.medium, xPulseProfile.medium),
      long: positiveOrDefault(r.long ?? sys.lng ?? sys.long, xPulseProfile.long)
    };
  }

  const rack = getMissileRack(item);
  const isMRM = String(rack?.type ?? "").toUpperCase() === "MRM";

  if (isMRM) {
    const short = num(r.short ?? sys.sht ?? sys.short, 3);
    const medium = num(r.medium ?? sys.med ?? sys.medium, 8);
    const long = num(r.long ?? sys.lng ?? sys.long, 15);
    return { min: 0, short, medium, long };
  }

  return {
    min: num(r.min ?? sys.min, 0),
    short: num(r.short ?? sys.sht ?? sys.short, 0),
    medium: num(r.medium ?? sys.med ?? sys.medium, 0),
    long: num(r.long ?? sys.lng ?? sys.long, 0)
  };
}


function getActorMoveSpeeds(actor) {
  const sys = actor?.system ?? {};
  const mv = sys.movement ?? sys.move ?? sys.derived?.move ?? {};
  return {
    walk: num(mv.walk ?? mv.Walk ?? mv.w ?? 0, 0),
    run: num(mv.run ?? mv.Run ?? mv.r ?? 0, 0),
    jump: num(mv.jump ?? mv.Jump ?? mv.j ?? 0, 0)
  };
}

function inferAttackerMoveMode(actor, attackerToken) {
  const tokenDoc = attackerToken?.document ?? attackerToken;
  const flagMode = tokenDoc?.getFlag?.(SYSTEM_ID, "moveMode");
  if (flagMode) return String(flagMode);

  // If the token has the Jumped status, treat it as a jump for movement-mode inference.
  // (We apply the +3 attacker jump penalty via status TN mods, not via movement mode.)
  if (tokenHasStatus(tokenDoc, "atow-jumped")) return "jump";

  const moved = num(tokenDoc?.getFlag?.(SYSTEM_ID, "movedThisTurn"), 0);
  const { walk } = getActorMoveSpeeds(actor);

  if (moved < 1) return "stationary";
  if (walk > 0 && moved <= walk) return "walk";
  return "run";
}

function getAutoAttackerMoveMod(actor, attackerToken) {
  const tokenDoc = attackerToken?.document ?? attackerToken;
  const moved = num(tokenDoc?.getFlag?.(SYSTEM_ID, "movedThisTurn"), 0);
  const mode = inferAttackerMoveMode(actor, attackerToken);

  let mod = 0;
  switch (mode) {
    case "walk": mod = 1; break;
    case "run": mod = 2; break;
    // Jumping penalty is handled by the "atow-jumped" status effect (see getStatusTNMods).
    case "jump": mod = 0; break;
    default: mod = 0; break;
  }
  return { mod, mode, moved };
}


function getAutoTargetMoveData(targetToken) {
  const tokenDoc = targetToken?.document ?? targetToken;
  const moved = num(
    tokenDoc?.getFlag?.(SYSTEM_ID, "displacementThisTurn")
      ?? tokenDoc?.getFlag?.(SYSTEM_ID, "movedThisTurn"),
    0
  );
  const mod = calcTargetMoveModFromHexes(moved);
  return { moved, mod };
}


// ------------------------------------------------------------
// Status-based TN modifiers (token HUD statuses)
// ------------------------------------------------------------
function tokenHasStatus(tokenOrDoc, statusId) {
  const token = tokenOrDoc?.document ? tokenOrDoc : null;
  const doc = tokenOrDoc?.document ?? tokenOrDoc;

  try {
    // Foundry TokenDocument helper (v11+)
    if (doc?.hasStatusEffect) return !!doc.hasStatusEffect(statusId);
  } catch (_) {}

  try {
    // Actor maintains a Set of active statuses in recent Foundry versions
    const actor = token?.actor ?? doc?.actor;
    if (actor?.statuses?.has) return actor.statuses.has(statusId);
    if (Array.isArray(actor?.statuses)) return actor.statuses.includes(statusId);
  } catch (_) {}

  try {
    // Fallback: some systems store statuses directly on the token document
    if (doc?.statuses?.has) return doc.statuses.has(statusId);
    if (Array.isArray(doc?.statuses)) return doc.statuses.includes(statusId);
  } catch (_) {}

  return false;
}

/**
 * Compute automatic TN modifiers from Battletech status effects.
 * - attackerMods: apply when the attacker is affected (harder to fire)
 * - targetMods: apply when the target is affected (harder to hit / has cover)
 */
function getStatusTNMods(attackerToken, targetToken) {
  const a = attackerToken?.document ? attackerToken : attackerToken;
  const t = targetToken?.document ? targetToken : targetToken;

  let attackerMod = 0;
  let targetMod = 0;
  const details = [];

  // Prone
  if (tokenHasStatus(a, "prone")) {
    attackerMod += 2;
    details.push("Attacker Prone +2");
  }
  if (tokenHasStatus(t, "prone")) {
    targetMod += 1;
    details.push("Target Prone +1");
  }

  // Skidding
  if (tokenHasStatus(a, "skidding")) {
    attackerMod += 1;
    details.push("Attacker Skidding +1");
  }
  if (tokenHasStatus(t, "skidding")) {
    targetMod += 2;
    details.push("Target Skidding +2");
  }

  // Jumped
  if (tokenHasStatus(a, "atow-jumped")) {
    attackerMod += 3;
    details.push("Attacker Jumped +3");
  }
  if (tokenHasStatus(t, "atow-jumped")) {
    targetMod += 1;
    details.push("Target Jumped +1");
  }

  // Woods (target only, first pass)
  if (tokenHasStatus(t, "light-woods")) {
    targetMod += 1;
    details.push("Target Light Woods +1");
  }
  if (tokenHasStatus(t, "heavy-woods")) {
    targetMod += 2;
    details.push("Target Heavy Woods +2");
  }

  // Water / Partial Cover (target only)
  if (tokenHasStatus(t, "in-water")) {
    targetMod += 1;
    details.push("Target In Water +1");
  }
  if (tokenHasStatus(t, "partial-cover")) {
    targetMod += 1;
    details.push("Target Partial Cover +1");
  }


  // Immobile (easier to hit)
  if (tokenHasStatus(t, "atow-immobile") || tokenHasStatus(t, "immobile")) {
    targetMod -= 4;
    details.push("Target Immobile -4");
  }

  return {
    attackerMod,
    targetMod,
    total: attackerMod + targetMod,
    details
  };
}
// ------------------------------------------------------------
// Targeting Computer / Aimed Shot helpers
// ------------------------------------------------------------

function actorHasTargetingComputer(actor) {
  if (!actor) return false;

  // Prefer crit-slot presence (per your rules)
  try {
    const crit = actor.system?.crit ?? {};
    for (const loc of Object.keys(crit)) {
      const slots = crit?.[loc]?.slots ?? [];
      for (const s of slots) {
        if (!s) continue;
        const destroyed = Boolean(s.destroyed);
        if (destroyed) continue;

        const label = String(s.label ?? s ?? "").toLowerCase();
        if (label.includes("targeting computer")) return true;
      }
    }
  } catch (_) {}

  // Fallback: item list (in case TC is represented as an Item instead of a raw crit-slot label)
  try {
    for (const it of (actor.items ?? [])) {
      const n = String(it?.name ?? "").toLowerCase();
      if (n.includes("targeting computer")) return true;
    }
  } catch (_) {}

  return false;
}

function _weaponHeuristicText(item) {
  const sys = item?.system ?? {};

  let parts = [
    item?.name,
    sys?.name,
    sys?.type,
    sys?.weaponType,
    sys?.category,
    sys?.attackType,
    sys?.class,
    sys?.weaponClass,
    sys?.damageType,
    sys?.special,
    Array.isArray(sys?.tags) ? sys.tags.join(" ") : ""
  ].filter(Boolean).map(String);
  return parts.join(" ").toLowerCase();
}

function weaponIsPulseWeapon(item) {
  const t = _weaponHeuristicText(item);
  return t.includes("pulse");
}

function weaponIsAreaEffectWeapon(item) {
  const sys = item?.system ?? {};
  if (sys?.areaEffect === true || sys?.aoe === true) return true;
  if (Number.isFinite(Number(sys?.blastRadius)) && Number(sys?.blastRadius) > 0) return true;
  const t = _weaponHeuristicText(item);
  return t.includes("area-effect") || t.includes("area effect") || t.includes("aoe") || t.includes("artillery") || t.includes("arrow iv") || t.includes("mine");
}

function weaponIsFlakWeapon(item) {
  const sys = item?.system ?? {};
  if (sys?.flak === true) return true;
  const t = _weaponHeuristicText(item);
  return t.includes("flak");
}

function weaponIsTCTNEligible(item) {
  const sys = item?.system ?? {};
  if (sys?.tcEligible === true) return true;

  // Heuristic: look for DB/DE/P codes in likely fields
  const raw = String(sys?.atowType ?? sys?.typeCode ?? sys?.weaponClass ?? sys?.class ?? sys?.damageClass ?? sys?.attackClass ?? sys?.category ?? sys?.type ?? "").toUpperCase();
  if (!raw) return false;

  if (raw === "DB" || raw === "DE" || raw === "P") return true;
  if (/\bDB\b/.test(raw) || /\bDE\b/.test(raw)) return true;
  // "P" is too common; only treat as eligible if it's a standalone code
  if (raw.trim() === "P") return true;

  return false;
}

function isLegLocationKey(loc) {
  return ["ll", "rl", "lfl", "lrl", "rfl", "rrl"].includes(String(loc ?? "").toLowerCase());
}

async function rollHitLocationNoLeg(side) {
  // Safety cap to avoid infinite loops with bad tables
  for (let i = 0; i < 50; i++) {
    const r = await rollHitLocation(side);
    if (!isLegLocationKey(r?.loc)) return r;
  }
  return rollHitLocation(side);
}




function getAttackerToken(actor) {
  const controlled = canvas?.tokens?.controlled ?? [];
  const matchControlled = controlled.find(t => t?.actor?.id === actor?.id);
  if (matchControlled) return matchControlled;

  const active = actor?.getActiveTokens?.(true, true) ?? actor?.getActiveTokens?.() ?? [];
  const tok = active?.[0] ?? null;
  return tok?.object ?? tok ?? null;
}

function getSingleTargetToken() {
  const targets = [...(game?.user?.targets ?? [])];
  if (targets.length !== 1) return null;
  return targets[0] ?? null;
}

function isMechActor(actor) {
  return String(actor?.type ?? "").toLowerCase() === "mech";
}

function getTokenCenter(tokenLike) {
  if (!tokenLike) return null;

  // Token (placeable) on canvas
  const c = tokenLike?.center;
  if (c && Number.isFinite(c.x) && Number.isFinite(c.y)) return c;

  // TokenDocument may have an embedded placeable object
  const oc = tokenLike?.object?.center;
  if (oc && Number.isFinite(oc.x) && Number.isFinite(oc.y)) return oc;

  // Fallback: compute from document data (pixels + grid)
  const x = tokenLike?.x ?? tokenLike?.document?.x;
  const y = tokenLike?.y ?? tokenLike?.document?.y;
  const w = tokenLike?.width ?? tokenLike?.document?.width;
  const h = tokenLike?.height ?? tokenLike?.document?.height;

  if (!canvas?.grid) return null;
  const size = canvas.grid.size ?? canvas.dimensions?.size;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(size)) return null;

  return { x: x + (w * size) / 2, y: y + (h * size) / 2 };
}

function measureTokenDistance(attackerToken, targetToken) {
  if (!canvas?.grid || !attackerToken || !targetToken) return null;

  const a = getTokenCenter(attackerToken);
  const b = getTokenCenter(targetToken);
  if (!a || !b) return null;

  const ray = new Ray(a, b);
  const distances = canvas.grid.measureDistances([{ ray }], { gridSpaces: true });
  return num(distances?.[0], null);
}

function measurePointDistance(fromPoint, toPoint) {
  if (!canvas?.grid || !fromPoint || !toPoint) return null;
  const ray = new Ray(fromPoint, toPoint);
  const distances = canvas.grid.measureDistances([{ ray }], { gridSpaces: true });
  return num(distances?.[0], null);
}

function getGridOffsetForPoint(point) {
  if (!point || !canvas?.grid) return null;
  try {
    const off = canvas.grid.getOffset?.({ x: point.x, y: point.y });
    if (off && Number.isFinite(Number(off.i)) && Number.isFinite(Number(off.j))) {
      return { i: Number(off.i), j: Number(off.j) };
    }
  } catch (_) {}
  try {
    const pos = canvas.grid.getGridPositionFromPixels?.(point.x, point.y) ?? canvas.grid.getGridPosition?.(point.x, point.y);
    if (Array.isArray(pos) && pos.length >= 2) return { i: Number(pos[0]), j: Number(pos[1]) };
  } catch (_) {}
  const size = Number(canvas.grid.size ?? canvas.dimensions?.size ?? 100) || 100;
  return { i: Math.floor(Number(point.x ?? 0) / size), j: Math.floor(Number(point.y ?? 0) / size) };
}

function getGridKeyForPoint(point) {
  const off = getGridOffsetForPoint(point);
  if (!off) return "";
  return `${off.i},${off.j}`;
}

function getGridCenterForPoint(point) {
  const off = getGridOffsetForPoint(point);
  if (!off || !canvas?.grid) return point;
  try {
    const center = canvas.grid.getCenterPoint?.(off);
    if (center && Number.isFinite(center.x) && Number.isFinite(center.y)) return { x: center.x, y: center.y };
  } catch (_) {}
  try {
    const topLeft = canvas.grid.getTopLeftPoint?.(off);
    const cellW = Number(canvas.grid.sizeX ?? canvas.grid.size ?? 0) || 100;
    const cellH = Number(canvas.grid.sizeY ?? canvas.grid.size ?? 0) || cellW;
    if (topLeft && Number.isFinite(topLeft.x) && Number.isFinite(topLeft.y)) {
      return { x: topLeft.x + cellW / 2, y: topLeft.y + cellH / 2 };
    }
  } catch (_) {}
  try {
    if (typeof canvas.grid.getCenter === "function") {
      const v = canvas.grid.getCenter(off.i, off.j);
      if (Array.isArray(v)) return { x: Number(v[0]), y: Number(v[1]) };
      if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) return { x: v.x, y: v.y };
    }
  } catch (_) {}
  return point;
}

function getTokensInGridKey(sceneId, gridKey) {
  const tokens = Array.from(canvas?.tokens?.placeables ?? []);
  return tokens.filter(t => {
    const doc = t?.document ?? t;
    if (sceneId && String(doc?.parent?.id ?? canvas?.scene?.id ?? "") !== String(sceneId)) return false;
    const center = getTokenCenter(t);
    return center && getGridKeyForPoint(center) === gridKey;
  });
}

function pickCanvasPointOnce() {
  return new Promise((resolve) => {
    const stage = canvas?.stage;
    if (!stage) {
      resolve(null);
      return;
    }

    const emitters = [
      stage,
      canvas?.tokens,
      canvas?.primary,
      canvas?.interface,
      ...(canvas?.tokens?.placeables ?? [])
    ].filter(e => e && typeof e.on === "function" && typeof e.off === "function");

    const cleanup = () => {
      for (const emitter of emitters) {
        try { emitter.off("pointerdown", onDown); } catch (_) {}
        try { emitter.off("rightdown", onRight); } catch (_) {}
      }
      try { stage.eventMode = priorEventMode; } catch (_) {}
      try { stage.interactive = priorInteractive; } catch (_) {}
    };

    const toPoint = (event) => {
      try {
        const local = event?.data?.getLocalPosition?.(stage) ?? event?.getLocalPosition?.(stage) ?? null;
        if (local) return local;
        const global = event?.data?.global ?? event?.global ?? null;
        if (global && typeof stage.toLocal === "function") return stage.toLocal(global);
        return null;
      } catch (_) {
        return null;
      }
    };

    const onRight = (event) => {
      event?.stopPropagation?.();
      cleanup();
      resolve(null);
    };

    const onDown = (event) => {
      if (event?.data?.button === 2 || event?.button === 2) return onRight(event);
      event?.stopPropagation?.();
      const point = toPoint(event);
      cleanup();
      resolve(point ? { x: point.x, y: point.y } : null);
    };

    const priorEventMode = stage.eventMode;
    const priorInteractive = stage.interactive;
    try { stage.eventMode = "static"; } catch (_) {}
    try { stage.interactive = true; } catch (_) {}
    for (const emitter of emitters) {
      try { emitter.on("pointerdown", onDown); } catch (_) {}
      try { emitter.on("rightdown", onRight); } catch (_) {}
    }
  });
}

function getTerrainKeyAtPoint(point) {
  try {
    const fn = game?.[SYSTEM_ID]?.api?.terrain?.getTerrainKeyAtPoint;
    if (typeof fn === "function") return fn(point);
  } catch (_) {}
  return null;
}

function getTerrainAtKey(key) {
  try {
    const fn = game?.[SYSTEM_ID]?.api?.terrain?.getTerrainAtGridKey;
    if (typeof fn === "function") return fn(key);
  } catch (_) {}
  return null;
}

function getTerrainAtPointForAttack(point) {
  try {
    const fn = game?.[SYSTEM_ID]?.api?.terrain?.getTerrainAtPoint;
    if (typeof fn === "function") return fn(point);
  } catch (_) {}
  return null;
}

function getLineOfSightTerrainKeys(attackerToken, targetToken) {
  const a = getTokenCenter(attackerToken);
  const b = getTokenCenter(targetToken);
  if (!a || !b || !game?.[SYSTEM_ID]?.api?.terrain) return [];

  const attackerKey = getTerrainKeyAtPoint(a);
  const targetKey = getTerrainKeyAtPoint(b);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  const gridSize = Number(canvas?.grid?.size ?? canvas?.dimensions?.size ?? 100) || 100;
  const samples = Math.max(16, Math.ceil(length / Math.max(6, gridSize / 8)));
  const keys = new Set();

  for (let i = 1; i < samples; i++) {
    const t = i / samples;
    const point = { x: a.x + dx * t, y: a.y + dy * t };
    const key = getTerrainKeyAtPoint(point);
    if (!key || key === attackerKey || key === targetKey) continue;
    keys.add(key);
  }

  return Array.from(keys);
}

async function scheduleArrowIVIndirectStrikeAuto(scene, strikeData) {
  if (!scene || !strikeData) return { ok: false, reason: "No scene or strike data" };
  if (game.user?.isGM) return _gmScheduleArrowIVIndirectStrike(scene.uuid, strikeData);
  const socket = getATOWSocket();
  if (!socket) return { ok: false, reason: "AToW socket is not ready" };
  return socket.executeAsGM("gmScheduleArrowIVIndirectStrike", scene.uuid, strikeData);
}

function buildArrowIVStrikeId() {
  try {
    if (typeof foundry?.utils?.randomID === "function") return foundry.utils.randomID();
  } catch (_) {}
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function currentCombatantMatchesStrike(combat, strike) {
  const combatant = combat?.combatant ?? null;
  if (!combatant || !strike) return false;
  const currentCombatantId = String(combatant.id ?? "");
  const currentActorId = String(combatant.actorId ?? combatant.actor?.id ?? "");
  const currentTokenId = String(combatant.tokenId ?? combatant.token?.id ?? "");
  return (strike.attackerCombatantId && currentCombatantId === String(strike.attackerCombatantId)) ||
    (strike.attackerTokenId && currentTokenId === String(strike.attackerTokenId)) ||
    (strike.attackerActorId && currentActorId === String(strike.attackerActorId));
}

function arrowIVStrikeIsDue(combat, strike) {
  if (!combat?.started || !strike) return false;
  if (strike.combatId && String(strike.combatId) !== String(combat.id ?? "")) return false;
  if (!currentCombatantMatchesStrike(combat, strike)) return false;
  const firedRound = Number(strike.firedRound ?? 0) || 0;
  const currentRound = Number(combat.round ?? 0) || 0;
  return currentRound > firedRound;
}

async function applyArrowIVIndirectDamageToToken(targetToken, damage, strike) {
  const targetActor = targetToken?.actor;
  if (!targetActor) return { ok: false, reason: "No target actor" };
  const attackerToken = strike?.attackerTokenId ? (canvas?.tokens?.get?.(strike.attackerTokenId) ?? null) : null;
  const side = attackerToken ? (getTargetSideFromFacing(attackerToken, targetToken)?.side ?? "front") : "front";
  const locResult = await rollHitLocation(side);
  const result = await applyDamageToTargetActorAuto(targetActor, locResult.loc, damage, { side, tac: false, tacLoc: locResult.loc });
  return { ok: result?.ok !== false, result, locResult, side };
}

async function resolveArrowIVIndirectStrike(scene, strike) {
  if (!scene || !strike) return { ok: false, reason: "No strike" };
  const gridKey = String(strike.gridKey ?? "");
  const targetTokens = getTokensInGridKey(scene.id, gridKey).filter(t => isMechActor(t?.actor));
  const impactPoint = strike?.point ? { x: Number(strike.point.x), y: Number(strike.point.y) } : null;
  if (impactPoint && Number.isFinite(impactPoint.x) && Number.isFinite(impactPoint.y)) {
    await playArrowIVImpactEffects(impactPoint);
  }
  const attackerName = String(strike.attackerName ?? "Arrow IV");
  const weaponName = String(strike.weaponName ?? "Arrow IV System");
  const hexLabel = String(strike.hexLabel ?? gridKey);
  const targetLines = [];
  const rolls = [];

  for (const targetToken of targetTokens) {
    const roll = await (new Roll("2d6")).evaluate();
    rolls.push(roll);
    const hit = (roll.total ?? 0) >= 4;
    const damage = hit ? 20 : 5;
    const applied = await applyArrowIVIndirectDamageToToken(targetToken, damage, strike);
    let massiveDamagePsr = null;
    if (damage >= 20 && applied?.result?.ok) {
      massiveDamagePsr = await resolveMassiveDamagePSR(targetToken, damage, { source: "Arrow IV indirect impact" });
    }
    const loc = applied?.locResult?.loc ? String(applied.locResult.loc).toUpperCase() : "?";
    const locRoll = applied?.locResult?.roll?.total ?? "?";
    const appliedText = applied?.result?.ok
      ? `Applied to ${loc} (location roll ${locRoll})`
      : `Not applied: ${applied?.result?.reason ?? applied?.reason ?? "unknown reason"}`;
    const psrText = massiveDamagePsr?.required ? ` Massive damage PSR: ${massiveDamagePsr.success ? "passed" : "failed"}.` : "";
    targetLines.push(`<li><b>${targetToken.name}</b>: roll ${roll.total} vs 4 - ${hit ? "HIT" : "GROUND IMPACT"}, ${damage} damage. ${appliedText}${psrText}</li>`);
  }

  const content = [
    `<div class="atow-chat-card atow-mech-attack">`,
    `<header><b>${weaponName}</b> - Indirect Impact</header>`,
    `<div><b>Attacker:</b> ${attackerName}</div>`,
    `<div><b>Designated Hex:</b> ${hexLabel}</div>`,
    targetTokens.length
      ? `<ul>${targetLines.join("")}</ul>`
      : `<div>No mechs occupied the designated hex when the Arrow IV arrived.</div>`,
    `</div>`
  ].join("");
  const flags = {
    [SYSTEM_ID]: {
      action: "weaponAttack",
      weaponAttack: true,
      attackMode: "arrowIVIndirectImpact",
      weaponName,
      attackerActorId: strike.attackerActorId ?? null,
      attackerTokenId: strike.attackerTokenId ?? null,
      strikeId: strike.id ?? null
    }
  };

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ alias: attackerName }),
    content,
    rolls,
    type: rolls.length ? CONST.CHAT_MESSAGE_TYPES.ROLL : CONST.CHAT_MESSAGE_TYPES.OTHER,
    flags
  }).catch(err => console.warn("AToW Battletech | Arrow IV indirect impact chat failed", err));

  return { ok: true, targets: targetTokens.length };
}

async function processDueArrowIVIndirectStrikes(combat) {
  if (!game.user?.isGM || !combat?.started) return;
  const scene = combat.scene ?? canvas?.scene ?? game.scenes?.active ?? null;
  if (!scene?.getFlag || !scene?.setFlag) return;
  const strikes = Array.isArray(scene.getFlag(SYSTEM_ID, ARROW_IV_INDIRECT_FLAG))
    ? foundry.utils.deepClone(scene.getFlag(SYSTEM_ID, ARROW_IV_INDIRECT_FLAG))
    : [];
  if (!strikes.length) return;

  const due = [];
  const remaining = [];
  for (const strike of strikes) {
    if (arrowIVStrikeIsDue(combat, strike)) due.push(strike);
    else remaining.push(strike);
  }
  if (!due.length) return;

  await scene.setFlag(SYSTEM_ID, ARROW_IV_INDIRECT_FLAG, remaining);
  for (const strike of due) {
    try {
      await resolveArrowIVIndirectStrike(scene, strike);
    } catch (err) {
      console.warn("AToW Battletech | Failed to resolve Arrow IV indirect strike", err);
    }
  }
}

if (!globalThis.__ATOW_BT_ARROW_IV_INDIRECT_HOOK__) {
  globalThis.__ATOW_BT_ARROW_IV_INDIRECT_HOOK__ = true;
  Hooks.on("updateCombat", async (combat, changed) => {
    if (!("turn" in (changed ?? {})) && !("round" in (changed ?? {}))) return;
    await processDueArrowIVIndirectStrikes(combat);
  });
}

function getLineOfSightWoodsMods(attackerToken, targetToken) {
  const keys = getLineOfSightTerrainKeys(attackerToken, targetToken);
  if (!keys.length) {
    return { mod: 0, blocked: false, woodsPoints: 0, light: 0, heavy: 0, keys: [], details: [] };
  }

  let light = 0;
  let heavy = 0;
  const woodedKeys = [];
  for (const key of keys) {
    const terrain = getTerrainAtKey(key);
    const woods = String(terrain?.woods ?? "").toLowerCase();
    if (woods === "light") {
      light += 1;
      woodedKeys.push({ key, woods: "light" });
    } else if (woods === "heavy") {
      heavy += 1;
      woodedKeys.push({ key, woods: "heavy" });
    }
  }

  const woodsPoints = light + (heavy * 2);
  const details = [];
  if (light) details.push(`${light} intervening Light Woods +${light}`);
  if (heavy) details.push(`${heavy} intervening Heavy Woods +${heavy * 2}`);

  return {
    mod: woodsPoints,
    blocked: woodsPoints >= 3,
    woodsPoints,
    light,
    heavy,
    keys: woodedKeys,
    details
  };
}

function getLineOfSightCoverMods(attackerToken, targetToken) {
  const attackerCenter = getTokenCenter(attackerToken);
  const targetCenter = getTokenCenter(targetToken);
  const attackerTerrain = attackerCenter ? getTerrainAtPointForAttack(attackerCenter) : null;
  const targetTerrain = targetCenter ? getTerrainAtPointForAttack(targetCenter) : null;
  const attackerElevation = Number(attackerTerrain?.elevation ?? 0) || 0;
  const targetElevation = Number(targetTerrain?.elevation ?? 0) || 0;
  const targetWaterDepth = Number(targetTerrain?.waterDepth ?? 0) || 0;
  const keys = getLineOfSightTerrainKeys(attackerToken, targetToken);
  const hillKeys = [];
  let maxInterveningElevation = 0;

  for (const key of keys) {
    const terrain = getTerrainAtKey(key);
    const elevation = Number(terrain?.elevation ?? 0) || 0;
    if (elevation > 0) {
      hillKeys.push({ key, elevation });
      maxInterveningElevation = Math.max(maxInterveningElevation, elevation);
    }
  }

  const highEndpointElevation = Math.max(attackerElevation, targetElevation);
  const endpointsSameElevation = attackerElevation === targetElevation;
  const hillBlocksLos = maxInterveningElevation >= (highEndpointElevation + 2);
  const hillPartialCover = endpointsSameElevation && maxInterveningElevation === (highEndpointElevation + 1);
  const elevationDifferenceIgnoresHillCover = !endpointsSameElevation && maxInterveningElevation === (highEndpointElevation + 1);
  const blocked = hillBlocksLos;
  const partialCover = !blocked && (targetWaterDepth > 0 || hillPartialCover);
  const details = [];
  if (targetWaterDepth > 0) details.push(`Target in water depth ${targetWaterDepth}`);
  if (hillPartialCover) details.push(`Intervening level ${maxInterveningElevation} hill`);
  if (elevationDifferenceIgnoresHillCover) details.push("Elevation difference ignores hill cover");
  if (blocked) details.push(`Intervening level ${maxInterveningElevation} hill blocks LOS`);

  return {
    partialCover,
    blocked,
    mod: partialCover ? 1 : 0,
    attackerElevation,
    targetElevation,
    targetWaterDepth,
    maxInterveningElevation,
    hillPartialCover,
    elevationDifferenceIgnoresHillCover,
    hillKeys,
    details
  };
}

function applyPartialCoverToHitLocation(locResult, targetPartialCover) {
  if (!targetPartialCover || !isLegLocationKey(locResult?.loc)) {
    return { locResult, covered: false };
  }
  return {
    locResult: {
      ...locResult,
      partialCoverBlocked: true
    },
    covered: true
  };
}

function applyPartialCoverToPacket(packet, targetPartialCover) {
  if (!targetPartialCover || !isLegLocationKey(packet?.loc)) return packet;
  return {
    ...packet,
    partialCoverBlocked: true,
    originalDamage: packet.damage,
    damage: 0
  };
}

function parseMissileRackLabel(label) {
  const name = String(label ?? "").trim();
  if (!name) return null;

  let m = name.match(/\b(LRM|SRM|MRM|MML|ATM)\s*[-/]?\s*(\d+)\b/i);
  if (!m) m = name.match(/\b(LRM|SRM|MRM|MML|ATM)\b[^\d]*(\d+)\b/i);
  if (!m) {
    m = name.match(/\badvanced\s+tactical\s+missiles?\b[^\d]*(3|6|9|12)\b/i);
    if (m?.[1]) return { type: "ATM", size: Number(m[1]) };
  }
  if (!m) return null;

  const type = String(m[1]).toUpperCase();
  const size = Number(m[2]);
  if (!Number.isFinite(size) || size <= 0) return null;

  return { type, size };
}

function getMissileRack(itemOrName) {
  const sys = (itemOrName && typeof itemOrName === "object") ? (itemOrName.system ?? {}) : {};
  const candidates = (typeof itemOrName === "string")
    ? [itemOrName]
    : [
        itemOrName?.name,
        sys.ammoKey,
        sys.ammoType,
        sys.ammoName,
        sys.ammoLabel,
        sys.ammoBin,
        typeof sys.ammo === "string" ? sys.ammo : null,
        sys.ammo?.key,
        sys.ammo?.type,
        sys.ammo?.name,
        getAmmoKeyForWeapon(itemOrName)
      ];

  for (const candidate of candidates) {
    const rack = parseMissileRackLabel(candidate);
    if (rack) return rack;
  }

  return null;
}

function randomUnit() {
  return Math.random();
}

function rollManualD6() {
  return clamp(Math.floor(randomUnit() * 6) + 1, 1, 6);
}

function rollManual2d6() {
  const dice = [rollManualD6(), rollManualD6()];
  const total = dice[0] + dice[1];
  return {
    total,
    formula: "2d6",
    dice: [{ faces: 6, number: 2, total, results: dice.map(result => ({ result, active: true })) }],
    manualDice: dice
  };
}

async function rollClusterHits(rackSize, bonus = 0, { forcedTotal = null } = {}) {
  const hasForcedTotal = forcedTotal !== null && forcedTotal !== undefined && forcedTotal !== "";
  const roll = hasForcedTotal && Number.isFinite(Number(forcedTotal))
    ? { total: clamp(Math.floor(Number(forcedTotal)), 2, 12), formula: "2d6", forced: true }
    : rollManual2d6();
  const baseTotal = clamp(Math.floor(Number(roll.total)), 2, 12);

  // Artemis IV FCS: +2 to the Cluster Hits Table roll, maximum modified roll of 12.
  const mod = num(bonus, 0);
  const modifiedTotal = clamp(baseTotal + mod, 2, 12);

  const hits = CLUSTER_HITS_TABLE?.[rackSize]?.[modifiedTotal] ?? 0;
  return { roll, baseTotal, modifiedTotal, mod, hits };
}

// ------------------------------------------------------------
// Artemis IV FCS (advanced equipment)
// - 1 crit, 1 ton per launcher
// - +2 to Cluster Hits Table roll (max modified roll of 12)
// - Must be installed in the same location as each eligible launcher
// - If any launcher is Artemis-linked, all eligible launchers must be linked
// - MRMs are unguided and are not eligible for Artemis IV.
// ------------------------------------------------------------
const ARTEMIS_LABELS = Object.freeze({ iv: "artemis iv fcs", v: "artemis v fcs" });

function _isArtemisLabel(label, version = "iv") {
  const normalized = String(label ?? "").trim().toLowerCase().replace(/\bartemis\s+4\b/, "artemis iv").replace(/\bartemis\s+5\b/, "artemis v");
  return normalized === ARTEMIS_LABELS[version];
}

function _isEligibleLauncherLabel(label, version = "iv") {
  const t = String(label ?? "").trim();
  if (!t) return false;
  // Use the same detection as getMissileRack (but from a string label)
  if (/\bstreak\s*srm\b/i.test(t)) return false;
  if (/\bammo\b/i.test(t)) return false;
  const match = t.match(/\b(lrm|mml|srm)\s*[-]?\s*(\d+)\b/i);
  if (!match) return false;
  return version !== "v" || String(match[1]).toUpperCase() !== "MML";
}

function _getCritLocMax(locKey) {
  const lk = String(locKey ?? "").toLowerCase();
  return (lk === "head" || lk === "ll" || lk === "rl") ? 6 : 12;
}

function _iterCritStartSlots(actor) {
  const crit = actor?.system?.crit ?? {};
  const out = [];
  for (const [locKey, loc] of Object.entries(crit)) {
    const arr = loc?.slots;
    if (!arr) continue;
    const slots = Array.isArray(arr) ? arr : Object.values(arr);
    const locMax = _getCritLocMax(locKey);

    for (let i = 0; i < Math.min(slots.length, locMax); i++) {
      const s = slots[i] ?? {};
      if (!s) continue;
      if (s.partOf !== undefined && s.partOf !== null) continue;

      const label = String(s.label ?? "").trim();
      const uuid = String(s.uuid ?? "").trim();
      if (!label && !uuid) continue;

      // Respect destroyed across span (best-effort)
      const span = clamp(num(s.span, 1), 1, locMax - i);
      let destroyed = false;
      for (let j = 0; j < span; j++) destroyed ||= Boolean(slots[i + j]?.destroyed);

      out.push({ locKey: String(locKey).toLowerCase(), index: i, label, uuid, span, destroyed });
    }
  }
  return out;
}

function _countArtemisAndLaunchers(actor, version = "iv") {
  const byLoc = {};
  let totalLaunchers = 0;
  let totalArtemis = 0;

  for (const s of _iterCritStartSlots(actor)) {
    if (s.destroyed) continue;

    if (_isArtemisLabel(s.label, version)) {
      byLoc[s.locKey] ??= { launchers: 0, artemis: 0 };
      byLoc[s.locKey].artemis += 1;
      totalArtemis += 1;
      continue;
    }

    if (_isEligibleLauncherLabel(s.label, version)) {
      byLoc[s.locKey] ??= { launchers: 0, artemis: 0 };
      byLoc[s.locKey].launchers += 1;
      totalLaunchers += 1;
    }
  }

  return { byLoc, totalLaunchers, totalArtemis };
}

function _isArtemisFullyLinked(actor, version = "iv") {
  const { byLoc, totalLaunchers, totalArtemis } = _countArtemisAndLaunchers(actor, version);

  // No eligible launchers => no functional Artemis.
  if (totalLaunchers <= 0) return false;

  // If you have any Artemis installed, you must have it for ALL eligible launchers.
  if (totalArtemis <= 0) return false;
  if (totalArtemis !== totalLaunchers) return false;

  for (const v of Object.values(byLoc)) {
    if (num(v.artemis, 0) !== num(v.launchers, 0)) return false;
  }

  return true;
}

function _findWeaponCritLoc(actor, weaponItem) {
  const wUuid = String(weaponItem?.uuid ?? "").trim();

  const norm = (s) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[\s\-_]+/g, " ")
      .replace(/[^\w\s\/]+/g, "")
      .trim();

  const wName = norm(weaponItem?.name);

  if (!wUuid && !wName) return null;

  for (const s of _iterCritStartSlots(actor)) {
    // Prefer UUID match when possible
    if (wUuid && s.uuid && s.uuid === wUuid) return s.locKey;

    const sName = norm(s.label);
    if (wName && sName && sName === wName) return s.locKey;
  }
  return null;
}

function _weaponHasArtemisLink(actor, weaponItem, pre = null, version = "iv") {
  const fullyLinked = Boolean(pre?.fullyLinked ?? _isArtemisFullyLinked(actor, version));
  if (!fullyLinked) return false;

  const locKey = _findWeaponCritLoc(actor, weaponItem);
  if (!locKey) return false;

  const byLoc = pre?.byLoc ?? _countArtemisAndLaunchers(actor, version).byLoc;
  const v = byLoc?.[locKey];
  return Boolean(v && num(v.artemis, 0) > 0 && num(v.launchers, 0) > 0);
}

function splitIntoNs(totalHits, n) {
  const hits = Math.max(0, num(totalHits, 0));
  const size = Math.max(1, num(n, 1));
  const groups = [];
  const full = Math.floor(hits / size);
  const rem = hits % size;
  for (let i = 0; i < full; i++) groups.push(size);
  if (rem) groups.push(rem);
  return groups;
}

function buildClusterDamagePackets(rackType, missilesHit, perHitDamage, groupSize) {
  const type = String(rackType ?? "").toUpperCase();
  const missileCount = Math.max(0, Math.floor(num(missilesHit, 0)));
  const damagePerMissile = Math.max(0, num(perHitDamage, 0));
  const clusterSize = Math.max(1, Math.floor(num(groupSize, 1)));

  if (type === "ATM") {
    return splitIntoNs(missileCount * damagePerMissile, clusterSize)
      .map(damage => ({
        hits: null,
        damage,
        damageCluster: true
      }));
  }

  return splitIntoNs(missileCount, clusterSize)
    .map(hits => ({
      hits,
      damage: hits * damagePerMissile,
      damageCluster: false
    }));
}

const D6_DICE_FACES = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

function formatD6Face(value) {
  const n = Math.floor(num(value, 0));
  return D6_DICE_FACES[n] ?? String(value ?? "?");
}


// ------------------------------------------------------------
// Weapon destroyed checks (crit slots / location destruction)
// ------------------------------------------------------------
/**
 * Returns true if the given weapon is destroyed on the actor.
 * This is determined by scanning crit slots for a destroyed entry matching the weapon's UUID/ID/name.
 *
 * Note: this is intentionally a little permissive on name matching to support legacy sheets that
 * only store labels in crit slots.
 */
export async function isWeaponDestroyedOnActor(actor, weaponItem) {
  try {
    if (!actor || !weaponItem) return false;

    // Some items may track destroyed directly
    if (weaponItem.system?.destroyed === true) return true;

    const weaponUuid = String(weaponItem.uuid ?? "").trim();
    const weaponId = String(weaponItem.id ?? "").trim();

    const norm = (s) =>
      String(s ?? "")
        .toLowerCase()
        .replace(/[\s\-_]+/g, " ")
        .replace(/[^\w\s\/]+/g, "")
        .trim();

    const weaponName = norm(weaponItem.name);

    const crit = actor.system?.crit ?? {};
    for (const [locKey, locData] of Object.entries(crit)) {
      const rawSlots = locData?.slots;
      if (!rawSlots) continue;
      const locMax = _getCritLocMax(locKey);
      const slots = Array.isArray(rawSlots) ? rawSlots : Object.values(rawSlots);

      for (let i = 0; i < Math.min(slots.length, locMax); i++) {
        const slot = slots[i] ?? {};
        if (!slot || (slot.partOf !== undefined && slot.partOf !== null)) continue;

        const slotUuid = String(
          (slot?.uuid ?? slot?.itemUuid ?? slot?.sourceUuid ?? slot?.documentUuid ?? "")
        ).trim();
        const slotItemId = String(slot?.itemId ?? "").trim();
        const label = (typeof slot === "string") ? slot : (slot?.label ?? slot?.name ?? "");
        const slotLabel = norm(label);

        let matches = false;
        if (weaponUuid && slotUuid && slotUuid === weaponUuid) matches = true;
        if (!matches && weaponId) {
          if (slotItemId && slotItemId === weaponId) matches = true;
          else if (slotUuid && (slotUuid.endsWith(`.Item.${weaponId}`) || slotUuid.endsWith(weaponId))) matches = true;
        }
        if (!matches && weaponName && slotLabel && (slotLabel === weaponName || slotLabel.includes(weaponName))) {
          matches = true;
        }
        if (!matches) continue;

        const span = clamp(num(slot?.span, 1), 1, locMax - i);
        for (let j = 0; j < span; j++) {
          if (Boolean(slots[i + j]?.destroyed)) return true;
        }
        return false;
      }
    }
  } catch (_) {
    // ignore and treat as not destroyed
  }
  return false;
}

function isWeaponDestroyedForFireKey(actor, weaponFireKey = "") {
  const key = String(weaponFireKey ?? "").trim();
  if (!actor || !key) return null;

  const mountMatch = /^mount:(.+)$/i.exec(key);
  const critMatch = /^crit:([^:]+):(\d+)(?::\d+)?$/i.exec(key);
  if (!mountMatch && !critMatch) return null;

  const crit = actor.system?.crit ?? {};
  for (const [locKey, locData] of Object.entries(crit)) {
    const rawSlots = locData?.slots;
    if (!rawSlots) continue;
    const locMax = _getCritLocMax(locKey);
    const slots = Array.isArray(rawSlots) ? rawSlots : Object.values(rawSlots);

    for (let i = 0; i < Math.min(slots.length, locMax); i++) {
      const slot = slots[i] ?? {};
      if (!slot || (slot.partOf !== undefined && slot.partOf !== null)) continue;

      let matches = false;
      if (mountMatch) {
        matches = String(slot?.mountId ?? "").trim() === String(mountMatch[1] ?? "").trim();
      } else if (critMatch) {
        matches = String(locKey).toLowerCase() === String(critMatch[1] ?? "").toLowerCase() && i === Number(critMatch[2]);
      }
      if (!matches) continue;

      const span = clamp(num(slot?.span, 1), 1, locMax - i);
      let destroyed = false;
      for (let j = 0; j < span; j++) destroyed ||= Boolean(slots[i + j]?.destroyed);
      return destroyed;
    }
  }
  return null;
}

function normalizeMechWeaponMountLoc(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "";
  const compact = raw.replace(/[^a-z0-9]/g, "");
  if (["h", "hd", "head"].includes(compact)) return "head";
  if (["ct", "centertorso", "centretorso", "center"].includes(compact)) return "ct";
  if (["lt", "lefttorso"].includes(compact)) return "lt";
  if (["rt", "righttorso"].includes(compact)) return "rt";
  if (["la", "leftarm"].includes(compact)) return "la";
  if (["ra", "rightarm"].includes(compact)) return "ra";
  if (["ll", "leftleg"].includes(compact)) return "ll";
  if (["rl", "rightleg"].includes(compact)) return "rl";
  return compact;
}

function mechWeaponMountLocLabel(locKey) {
  const map = {
    head: "HD",
    ct: "CT",
    lt: "LT",
    rt: "RT",
    la: "LA",
    ra: "RA",
    ll: "LL",
    rl: "RL"
  };
  return map[locKey] ?? String(locKey ?? "").toUpperCase();
}

function findWeaponMountInfoForFireKey(actor, weaponItem, weaponFireKey = "") {
  const key = String(weaponFireKey ?? "").trim();
  const mountMatch = /^mount:(.+)$/i.exec(key);
  const critMatch = /^crit:([^:]+):(\d+)(?::\d+)?$/i.exec(key);
  const itemUuid = String(weaponItem?.uuid ?? "").trim();
  const itemId = String(weaponItem?.id ?? "").trim();

  const norm = (s) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[\s\-_]+/g, " ")
      .replace(/[^\w\s\/]+/g, "")
      .trim();
  const itemName = norm(weaponItem?.name);

  const crit = actor?.system?.crit ?? {};
  for (const [locKey, locData] of Object.entries(crit)) {
    const rawSlots = locData?.slots;
    if (!rawSlots) continue;
    const locMax = _getCritLocMax(locKey);
    const slots = Array.isArray(rawSlots) ? rawSlots : Object.values(rawSlots);

    for (let i = 0; i < Math.min(slots.length, locMax); i++) {
      const slot = slots[i] ?? {};
      if (!slot || (slot.partOf !== undefined && slot.partOf !== null)) continue;

      const slotUuid = String(slot?.uuid ?? slot?.itemUuid ?? slot?.sourceUuid ?? slot?.documentUuid ?? "").trim();
      const slotItemId = String(slot?.itemId ?? "").trim();
      const label = (typeof slot === "string") ? slot : (slot?.label ?? slot?.name ?? "");
      const slotLabel = norm(label);

      let matches = false;
      if (mountMatch) matches = String(slot?.mountId ?? "").trim() === String(mountMatch[1] ?? "").trim();
      else if (critMatch) matches = String(locKey).toLowerCase() === String(critMatch[1] ?? "").toLowerCase() && i === Number(critMatch[2]);
      else if (itemUuid && slotUuid) matches = slotUuid === itemUuid;
      if (!matches && itemId) {
        if (slotItemId && slotItemId === itemId) matches = true;
        else if (slotUuid && (slotUuid.endsWith(`.Item.${itemId}`) || slotUuid.endsWith(itemId))) matches = true;
      }
      if (!matches && itemName && slotLabel && (slotLabel === itemName || slotLabel.includes(itemName))) matches = true;
      if (!matches) continue;

      const normalized = normalizeMechWeaponMountLoc(locKey);
      return {
        locKey: normalized,
        locLabel: mechWeaponMountLocLabel(normalized),
        index: i,
        mountId: String(slot?.mountId ?? "").trim(),
        rearMounted: Boolean(slot?.rearMounted)
      };
    }
  }

  const fallbackLoc = normalizeMechWeaponMountLoc(weaponItem?.system?.loc ?? weaponItem?.system?.location ?? "");
  if (fallbackLoc) return { locKey: fallbackLoc, locLabel: mechWeaponMountLocLabel(fallbackLoc), index: null, mountId: "", rearMounted: false };
  return { locKey: "", locLabel: "Unknown", index: null, mountId: "", rearMounted: false };
}

function getAllowedFiringArcsForWeapon(actor, weaponItem, opts = {}) {
  const mount = findWeaponMountInfoForFireKey(actor, weaponItem, opts?.weaponFireKey ?? "");
  const explicitLoc = normalizeMechWeaponMountLoc(opts?.weaponMountLoc ?? "");
  if (explicitLoc) {
    mount.locKey = explicitLoc;
    mount.locLabel = mechWeaponMountLocLabel(explicitLoc);
  }
  const rearMounted = Boolean(opts?.weaponRearMounted ?? mount?.rearMounted);
  const allowed = rearMounted ? ["rear"] : ["front"];
  if (!rearMounted && mount.locKey === "ra") allowed.push("right");
  if (!rearMounted && mount.locKey === "la") allowed.push("left");
  return { mount, rearMounted, allowed };
}

function formatArcList(arcs = []) {
  return arcs.map(a => String(a ?? "").toUpperCase()).join("/");
}

function getWeaponFiringArcInfo(actor, weaponItem, opts = {}, attackerToken = null, targetToken = null) {
  if (!isMechActor(actor) || !attackerToken || !targetToken) return { applies: false, legal: true };
  const { mount, rearMounted, allowed } = getAllowedFiringArcsForWeapon(actor, weaponItem, opts);
  const arc = getTargetSideFromFacing(targetToken, attackerToken);
  const side = arc?.side ?? "front";
  const legal = allowed.includes(side);
  return {
    applies: true,
    legal,
    side,
    arc,
    mount,
    rearMounted,
    allowed,
    allowedLabel: formatArcList(allowed)
  };
}

async function isWeaponDestroyedForAttack(actor, weaponItem, opts = {}) {
  const byKey = isWeaponDestroyedForFireKey(actor, opts?.weaponFireKey ?? "");
  if (typeof byKey === "boolean") return byKey;
  return isWeaponDestroyedOnActor(actor, weaponItem);
}

export function calcRangeBandAndMod(item, distance, { ammoKey = null } = {}) {
  const d = num(distance, 0);
  const { min, short, medium, long } = getWeaponRanges(item, { ammoKey });

  const minPenalty = (min > 0 && d < min) ? Math.max(0, (min - d) + 1) : 0;

  if (short && d <= short) return { band: "Short", mod: 0 + minPenalty, minPenalty };
  if (medium && d <= medium) return { band: "Medium", mod: 2 + minPenalty, minPenalty };
  if (long && d <= long) return { band: "Long", mod: 4 + minPenalty, minPenalty };

  return { band: "Out of Range", mod: 8 + minPenalty, minPenalty };
}

export function calcTargetMoveModFromHexes(hexesMoved) {
  const h = num(hexesMoved, 0);
  // Target Movement Modifier table (by hexes moved this turn)
  // 0-2: +0, 3-4:+1, 5-6:+2, 7-9:+3, 10-17:+4, 18-24:+5, 25+:+6
  if (h <= 2) return 0;
  if (h <= 4) return 1;
  if (h <= 6) return 2;
  if (h <= 9) return 3;
  if (h <= 17) return 4;
  if (h <= 24) return 5;
  return 6;
}

export async function rollHitLocation(side = "front") {
  const table = HIT_LOCATION_TABLES[side] ?? HIT_LOCATION_TABLES.front;
  const roll = await (new Roll("2d6")).evaluate();
  const loc = table[roll.total] ?? "ct";
  return { roll, loc };
}

function getMechTonnage(actor) {
  const candidates = [
    actor?.system?.mech?.tonnage,
    actor?.system?.mech?.tons,
    actor?.system?.tonnage,
    actor?.system?.tons,
    actor?.system?.stats?.tonnage
  ];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function getFallSideFromRoll(rollTotal) {
  if (rollTotal === 1) return "front";
  if (rollTotal === 2 || rollTotal === 3) return "right";
  if (rollTotal === 4) return "rear";
  return "left";
}

function getFallDamageClusters(damage) {
  const clusters = [];
  let remaining = Math.max(0, Math.ceil(Number(damage ?? 0) || 0));
  while (remaining > 0) {
    const cluster = Math.min(5, remaining);
    clusters.push(cluster);
    remaining -= cluster;
  }
  return clusters;
}

function getLegLossPSRTNMod(actor) {
  const flagLegLoss = num(actor?.getFlag?.(SYSTEM_ID, "legLoss") ?? actor?.flags?.[SYSTEM_ID]?.legLoss, 0);
  const isLegDestroyed = (locKey) => {
    const loc = actor?.system?.structure?.[locKey] ?? {};
    const max = num(loc.max, 0);
    const dmg = num(loc.dmg, 0);
    return max > 0 && dmg >= max;
  };
  const legLoss = Math.min(2, Math.max(0, flagLegLoss, (isLegDestroyed("ll") ? 1 : 0) + (isLegDestroyed("rl") ? 1 : 0)));
  return legLoss >= 1 ? 5 : 0;
}

function htmlEscape(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}

const PILOT_CONSCIOUSNESS_TN_BY_HIT = {
  1: 3,
  2: 5,
  3: 7,
  4: 10,
  5: 11
};

async function markMechDefeatedForPilot(actor, { dead = false } = {}) {
  if (!actor) return;
  await applyActorStatusAuto(actor, "prone", true).catch(() => {});
  await applyActorStatusAuto(actor, CONFIG?.specialStatusEffects?.DEFEATED ?? "defeated", true).catch(() => {});
  if (dead) await applyActorStatusAuto(actor, "dead", true).catch(() => {});

  try {
    for (const combat of game.combats?.contents ?? []) {
      const updates = [];
      for (const combatant of combat?.combatants ?? []) {
        const actorId = String(combatant?.actorId ?? combatant?.actor?.id ?? combatant?.token?.actor?.id ?? "");
        const tokenActorId = String(combatant?.token?.actor?.id ?? "");
        if (actorId !== String(actor.id) && tokenActorId !== String(actor.id)) continue;
        if (Boolean(combatant?.defeated) === true) continue;
        updates.push({ _id: combatant.id, defeated: true });
      }
      if (updates.length) await combat.updateEmbeddedDocuments("Combatant", updates).catch(() => {});
    }
  } catch (err) {
    console.warn("AToW Battletech | Failed to mark pilot-defeated combatant", err);
  }
}

export async function applyMechPilotHit(actor, { reason = "Pilot hit", token = null } = {}) {
  if (!actor || !isMechActor(actor)) return { ok: false, reason: "Not a mech actor" };
  if (!game.user?.isGM && !actor.isOwner) {
    const socket = getATOWSocket();
    if (socket) return socket.executeAsGM("gmApplyMechPilotHit", actor.uuid, { reason });
    return { ok: false, reason: "AToW socket is not ready" };
  }

  const currentHits = clampInt(actor.system?.pilot?.hitsTaken, 0, 6, 0);
  if (currentHits >= 6) return { ok: true, alreadyDead: true, hits: currentHits };

  const nextHits = clampInt(currentHits + 1, 0, 6, 0);
  const rolls = [];
  const lines = [
    `<div class="atow-chat-card atow-mech-attack">`,
    `<header><b>Pilot Hit</b></header>`,
    `<div><b>${htmlEscape(actor.name ?? "Mech")}</b>: ${htmlEscape(reason)}</div>`,
    `<div><b>Pilot hits:</b> ${nextHits}/6</div>`
  ];

  const updates = { "system.pilot.hitsTaken": nextHits };
  let result = { ok: true, hits: nextHits, unconscious: false, dead: false };

  if (nextHits >= 6) {
    updates["system.pilot.consciousness"] = "Dead";
    await actor.update(updates).catch(() => {});
    await markMechDefeatedForPilot(actor, { dead: true });
    lines.push(`<div><b>Result:</b> Pilot killed. Mech defeated.</div>`);
    result.dead = true;
  } else {
    const tn = PILOT_CONSCIOUSNESS_TN_BY_HIT[nextHits] ?? 11;
    const roll = await (new Roll("2d6")).evaluate();
    rolls.push(roll);
    const total = Number(roll?.total ?? 0) || 0;
    const conscious = total >= tn;
    updates["system.pilot.consciousness"] = conscious ? String(tn) : "Unconscious";
    await actor.update(updates).catch(() => {});

    lines.push(`<div><b>Consciousness:</b> ${total} vs TN ${tn} - <b>${conscious ? "PASS" : "FAIL"}</b></div>`);
    if (!conscious) {
      await markMechDefeatedForPilot(actor, { dead: false });
      lines.push(`<div><b>Result:</b> Pilot unconscious. Mech falls prone and is defeated.</div>`);
      result.unconscious = true;
    }
  }

  lines.push(`</div>`);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ token, actor }),
    rolls,
    content: lines.join("")
  }).catch(() => {});

  return result;
}

async function _gmApplyMechPilotHit(actorUuid, opts = {}) {
  const actor = await fromUuid(actorUuid).catch(() => null);
  return applyMechPilotHit(actor, opts);
}

export async function resolvePilotSeatbeltCheck(actor, { source = "Fall", token = null } = {}) {
  if (!actor || !isMechActor(actor)) return null;
  if (!game.user?.isGM && !actor.isOwner) return null;

  const piloting = num(actor.system?.pilot?.piloting, 0);
  const legLossMod = getLegLossPSRTNMod(actor);
  const tn = 8 + legLossMod;
  const roll = await (new Roll(`2d6 + ${piloting}`)).evaluate();
  const success = Number(roll?.total ?? 0) >= tn;
  const rolls = [roll];
  const lines = [
    `<div class="atow-chat-card atow-mech-attack">`,
    `<header><b>Pilot Seatbelt Check</b></header>`,
    `<div><b>${htmlEscape(actor.name ?? "Mech")}</b>: ${htmlEscape(source)}</div>`,
    `<div><b>Roll:</b> ${roll.total} (2d6 + Piloting ${piloting}) vs TN ${tn}${legLossMod ? ` (leg destroyed +${legLossMod})` : ""} - <b>${success ? "PASS" : "PILOT HIT"}</b></div>`
  ];

  let pilotHit = null;
  if (!success) {
    pilotHit = await applyMechPilotHit(actor, { reason: `${source}: failed seatbelt check`, token });
  }

  lines.push(`</div>`);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ token, actor }),
    rolls,
    content: lines.join("")
  }).catch(() => {});

  return { ok: true, success, roll, pilotHit };
}

async function resolveMassiveDamagePSR(targetToken, attackDamage, { source = "Massive Damage" } = {}) {
  const targetActor = targetToken?.actor;
  if (!targetActor || !isMechActor(targetActor)) return null;
  if (Number(attackDamage ?? 0) < 20) return null;

  const piloting = num(targetActor.system?.pilot?.piloting, 0);
  const legLossMod = getLegLossPSRTNMod(targetActor);
  const tn = 8 + legLossMod;
  const psr = await (new Roll(`2d6 + ${piloting}`)).evaluate();
  const success = Number(psr?.total ?? 0) >= tn;
  const rolls = [psr];
  const lines = [
    `<div class="atow-chat-card atow-mech-attack">`,
    `<header><b>Massive Damage PSR</b></header>`,
    `<div><b>Target:</b> ${htmlEscape(targetToken.name ?? targetActor.name ?? "Mech")}</div>`,
    `<div><b>Trigger:</b> ${htmlEscape(source)} dealt ${Number(attackDamage ?? 0)} damage in a single attack.</div>`,
    `<div><b>Roll:</b> ${psr.total} (2d6 + Piloting ${piloting}) vs <b>TN ${tn}</b>${legLossMod ? ` (leg destroyed +${legLossMod})` : ""} - <b>${success ? "PASS" : "FALL"}</b></div>`
  ];

  const result = { ok: true, required: true, success, psr, fallDamage: 0, fallResults: [] };

  if (!success) {
    const fallRoll = await (new Roll("1d6")).evaluate();
    rolls.push(fallRoll);
    const side = getFallSideFromRoll(Number(fallRoll?.total ?? 1));
    const tonnage = getMechTonnage(targetActor);
    const fallDamage = Math.max(1, Math.ceil(tonnage / 10));
    const clusters = getFallDamageClusters(fallDamage);
    result.side = side;
    result.fallRoll = fallRoll;
    result.fallDamage = fallDamage;

    const proneResult = await applyActorStatusAuto(targetActor, "prone", true);
    result.proneResult = proneResult;
    result.seatbelt = await resolvePilotSeatbeltCheck(targetActor, { source, token: targetToken }).catch(err => {
      console.warn("AToW Battletech | Pilot seatbelt check failed", err);
      return null;
    });

    lines.push(`<div><b>Fall:</b> ${fallRoll.total} - ${htmlEscape(side)} side. Damage ${fallDamage}${tonnage ? ` (${tonnage} tons / 10)` : ""}.</div>`);
    if (proneResult?.ok === false) lines.push(`<div><b>Prone:</b> Not applied - ${htmlEscape(proneResult.reason ?? "unknown reason")}</div>`);

    const hitRows = [];
    for (const cluster of clusters) {
      const locResult = await rollHitLocation(side);
      if (locResult?.roll) rolls.push(locResult.roll);
      const loc = locResult?.loc ?? "ct";
      const dmgResult = await applyDamageToTargetActorAuto(targetActor, loc, cluster, { side, tac: false, tacLoc: loc });
      result.fallResults.push({ cluster, locResult, damage: dmgResult });
      hitRows.push(`<li>${cluster} damage to <b>${htmlEscape(String(loc).toUpperCase())}</b> (location roll ${locResult?.roll?.total ?? "?"})${dmgResult?.ok === false ? ` - ${htmlEscape(dmgResult.reason ?? "not applied")}` : ""}</li>`);
    }
    if (hitRows.length) lines.push(`<ul>${hitRows.join("")}</ul>`);
  }

  lines.push(`</div>`);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ token: targetToken, actor: targetActor }),
    rolls,
    content: lines.join(""),
    flags: {
      [SYSTEM_ID]: {
        action: "massiveDamagePSR",
        attackDamage,
        success
      }
    }
  }).catch(err => console.warn("AToW Battletech | Massive damage PSR chat failed", err));

  return result;
}

/**
 * Core roll: 2d6 + Gunnery vs TN (>= TN hits)
 */
export async function rollWeaponAttack(actor, weaponItem, opts = {}) {
  if (!actor || !weaponItem) return null;
  // Resolve to an actual embedded Item when possible (module compatibility)
  weaponItem = await _resolveWeaponItem(actor, weaponItem);
  const isAbomChat = opts?.chatMode === "abomination";

  if (isAMSWeapon(weaponItem)) {
    ui?.notifications?.warn?.("Anti-Missile Systems fire automatically against incoming missiles and cannot be fired manually.");
    return { ok: false, blocked: true, reason: "amsCannotFireManually" };
  }

  const chargeLockToken = opts.attackerToken ?? getAttackerToken(actor);
  if (hasActorChargedThisTurn(actor, chargeLockToken?.document ?? chargeLockToken)) {
    ui?.notifications?.warn?.("This mech charged this turn and cannot make weapon attacks.");
    return { ok: false, blocked: true, reason: "chargedThisTurn" };
  }

  if (await isWeaponDestroyedForAttack(actor, weaponItem, opts)) {
    ui?.notifications?.warn?.(`${weaponItem?.name ?? "This weapon"} is destroyed and cannot be fired.`);
    return { ok: false, blocked: true, reason: "destroyedWeapon" };
  }

  if (hasWeaponFiredThisTurn(actor, weaponItem, opts)) {
    ui?.notifications?.warn?.(`${weaponItem?.name ?? "This weapon"} has already been fired this turn.`);
    return { ok: false, blocked: true, reason: "alreadyFiredThisTurn" };
  }

// Rapid-fire jam: if this weapon jammed previously, it cannot be fired again.
  if (!isAbomChat && weaponItem?.system?.jammed) {
    ui?.notifications?.warn?.(`${weaponItem.name} is jammed and cannot be fired.`);
    return null;
  }
  const isTagAttack = isTAGWeapon(weaponItem);
  const isNarcAttack = isNarcMissileBeaconWeapon(weaponItem);
  const isArrowIVHomingAttack = isArrowIVSystemWeapon(weaponItem);

  const pilot = actor.system?.pilot ?? {};
  const crew = actor.system?.crew ?? {};
  const isVehicleAttacker = isVehicleActor(actor);
  const hasSkillOverride = Number.isFinite(Number(opts.skillValue));
  const baseGunnery = isVehicleAttacker ? num(crew.gunnery, 0) : num(pilot.gunnery, 0);
  const gunnery = hasSkillOverride ? num(opts.skillValue, 0) : baseGunnery;
  const skillLabel = (opts.skillLabel && String(opts.skillLabel).trim()) ? String(opts.skillLabel).trim() : "Gunnery";

  const baseTN = (opts.tn ?? getDefaultTN(8));
  const attackerToken = opts.attackerToken ?? getAttackerToken(actor);
  const targetToken = opts.targetToken ?? getSingleTargetToken();
  const targetActor = targetToken?.actor;
  const isAbomTarget = isAbominationActor(targetActor);
  const isVehicleTarget = isVehicleActor(targetActor);
  const isDropshipTarget = isDropshipActor(targetActor);
  const hasVehicleTurret = isVehicleTarget && (num(targetActor?.system?.armor?.turret?.max, 0) > 0);

  if (!targetToken) {
    ui?.notifications?.warn?.("Select exactly 1 target token before making an attack.");
    return null;
  }
  if (!attackerToken) {
    ui?.notifications?.warn?.("Place/control your attacker token on the scene before making an attack.");
    return null;
  }
  if (isNarcAttack && !isMechActor(targetActor)) {
    ui?.notifications?.warn?.("Narc Missile Beacon pods can only attach to a BattleMech target.");
    return { ok: false, blocked: true, reason: "narcRequiresMechTarget" };
  }
  if (isArrowIVHomingAttack && !tokenHasStatus(targetToken, TAGGED_STATUS_ID)) {
    ui?.notifications?.warn?.("Arrow IV Homing direct fire requires a Tagged target.");
    return { ok: false, blocked: true, reason: "targetNotTagged" };
  }
  if (isArrowIVHomingAttack) {
    const ammoKey = ammoKeyFromTypeLabel("Arrow IV Homing");
    const { totals } = await ensureActorAmmoBins(actor);
    const bins = actor.system?.ammoBins ?? {};
    const bin = bins?.[ammoKey];
    const total = num(bin?.total, totals.get(ammoKey)?.total ?? 0);
    const cur = Number.isFinite(Number(bin?.current)) ? num(bin.current, total) : total;
    if (!bin && !totals.has(ammoKey)) {
      ui?.notifications?.error?.("Arrow IV Homing direct fire requires Ammo (Arrow IV Homing).");
      return { ok: false, blocked: true, reason: "missingArrowIVHomingAmmo" };
    }
    if (cur < 1) {
      ui?.notifications?.error?.("No Arrow IV Homing ammo remaining.");
      return { ok: false, blocked: true, reason: "noArrowIVHomingAmmo" };
    }
  }

  const distance = Number.isFinite(opts.distance) ? num(opts.distance, 0) : measureTokenDistance(attackerToken, targetToken);
  if (distance === null) {
    ui?.notifications?.warn?.("Couldn't measure distance (no canvas/grid?).");
    return null;
  }

  let ammoKey = String(opts.ammoKey ?? "").trim();
  ammoKey = ammoKey ? ammoKeyFromTypeLabel(ammoKey) : getAmmoKeyForWeapon(weaponItem);
  const rotaryProfile = getRotaryACProfile(weaponItem);
  const atmSize = getATMWeaponSize(weaponItem);
  if (Number.isFinite(atmSize) && !ammoKey) ammoKey = slugifyAmmoKey(`atm-${atmSize}`);
  const weaponRack = getMissileRack(weaponItem);
  const weaponRackType = String(weaponRack?.type ?? "").toUpperCase();
  const selectedMissileAmmoVariant = ["LRM", "MML", "SRM"].includes(weaponRackType)
    ? getMissileAmmoVariant(ammoKey)
    : MISSILE_AMMO_VARIANTS.STANDARD;
  if (!isMissileAmmoVariantCompatible(weaponRackType, selectedMissileAmmoVariant)) {
    const variantLabel = getMissileAmmoVariantLabel(selectedMissileAmmoVariant);
    ui?.notifications?.warn?.(`${variantLabel} ammunition is not compatible with ${weaponRackType || "this"} launchers.`);
    return { ok: false, blocked: true, reason: "incompatibleMissileAmmo", weaponRackType, selectedMissileAmmoVariant };
  }
  const artemisIVCounts = Boolean(weaponRack) ? _countArtemisAndLaunchers(actor, "iv") : { byLoc: {}, totalLaunchers: 0, totalArtemis: 0 };
  const artemisVCounts = Boolean(weaponRack) ? _countArtemisAndLaunchers(actor, "v") : { byLoc: {}, totalLaunchers: 0, totalArtemis: 0 };
  const artemisIVFullyLinked = Boolean(weaponRack) && _isArtemisFullyLinked(actor, "iv");
  const artemisVFullyLinked = Boolean(weaponRack) && _isArtemisFullyLinked(actor, "v");
  const artemisIVLinked = Boolean(weaponRack) && _weaponHasArtemisLink(actor, weaponItem, { fullyLinked: artemisIVFullyLinked, byLoc: artemisIVCounts.byLoc }, "iv");
  const artemisVLinked = Boolean(weaponRack) && _weaponHasArtemisLink(actor, weaponItem, { fullyLinked: artemisVFullyLinked, byLoc: artemisVCounts.byLoc }, "v");
  if (selectedMissileAmmoVariant === MISSILE_AMMO_VARIANTS.ARTEMIS_IV && !artemisIVLinked) {
    ui?.notifications?.warn?.("Artemis IV missiles require a fully linked, operational Artemis IV FCS in this launcher's location.");
    return { ok: false, blocked: true, reason: "artemisIVAmmoNotLinked" };
  }
  if (selectedMissileAmmoVariant === MISSILE_AMMO_VARIANTS.ARTEMIS_V && !artemisVLinked) {
    ui?.notifications?.warn?.("Artemis V missiles require a fully linked, operational Artemis V FCS in this launcher's location.");
    return { ok: false, blocked: true, reason: "artemisVAmmoNotLinked" };
  }
  const mrmTNMod = weaponRackType === "MRM" ? 1 : 0;

  const { band, mod: rangeMod, minPenalty } = calcRangeBandAndMod(weaponItem, distance, { ammoKey });

  // Heat-based fire modifier and shutdown (computed at turn start)
  const heatFireMod = isVehicleAttacker ? 0 : num(actor.system?.heat?.effects?.fireMod, 0);
  const isShutdown = !isVehicleAttacker && (Boolean(actor.system?.heat?.shutdown) || Boolean(attackerToken?.document?.getFlag?.(SYSTEM_ID, "shutdown")));

  if (isShutdown) {
    ui?.notifications?.warn?.("This mech is shut down due to heat and cannot attack.");
    return null;
  }

  const firingArcInfo = getWeaponFiringArcInfo(actor, weaponItem, opts, attackerToken, targetToken);
  if (firingArcInfo.applies && !firingArcInfo.legal) {
    const mountLabel = firingArcInfo.rearMounted ? "Rear-mounted" : `${firingArcInfo.mount?.locLabel ?? "Unknown"} mounted`;
    ui?.notifications?.warn?.(`${weaponItem.name} cannot fire into the ${String(firingArcInfo.side ?? "unknown").toUpperCase()} arc. ${mountLabel} weapons may fire ${firingArcInfo.allowedLabel}.`);
    return { ok: false, blocked: true, reason: "weaponFiringArcBlocked", firingArcInfo };
  }

  const autoMove = getAutoAttackerMoveMod(actor, attackerToken);

  const attackerMoveMod = Number.isFinite(opts.attackerMoveMod)
    ? num(opts.attackerMoveMod, 0)
    : (() => {
        const mode = String(opts.attackerMoveMode ?? "auto").toLowerCase();
        if (mode === "auto" || mode === "sheet" || mode === "token") return autoMove.mod;

        switch (mode) {
          case "walk": return 1;
          case "run": return 2;
          case "jump": return 3;
          case "stationary":
          default: return 0;
        }
      })();

  const autoTargetMove = getAutoTargetMoveData(targetToken);
  const targetHexesUsed = Number.isFinite(opts.targetHexes) ? num(opts.targetHexes, 0) : autoTargetMove.moved;

  const statusTNMods = getStatusTNMods(attackerToken, targetToken);
  const envTNMods = getEnvironmentTNMods(weaponItem, canvas?.scene ?? game?.scenes?.active);
  const losWoodsMods = getLineOfSightWoodsMods(attackerToken, targetToken);
  const losCoverMods = getLineOfSightCoverMods(attackerToken, targetToken);
  if (losWoodsMods.blocked) {
    const detail = losWoodsMods.details?.length ? ` (${losWoodsMods.details.join("; ")})` : "";
    ui?.notifications?.warn?.(`Line of sight blocked by ${losWoodsMods.woodsPoints} woods points${detail}.`);
    return { ok: false, blocked: true, reason: "woodsLineOfSightBlocked", losWoodsMods };
  }
  if (losCoverMods.blocked) {
    const detail = losCoverMods.details?.length ? ` (${losCoverMods.details.join("; ")})` : "";
    ui?.notifications?.warn?.(`Line of sight blocked by terrain${detail}.`);
    return { ok: false, blocked: true, reason: "hillLineOfSightBlocked", losCoverMods };
  }

  const targetMoveMod = Number.isFinite(opts.targetMoveMod)
    ? num(opts.targetMoveMod, 0)
    : calcTargetMoveModFromHexes(targetHexesUsed);
  const terrainMod = num(opts.terrainMod, 0);
  const otherMod = num(opts.otherMod, 0);

  // --- Targeting Computer / Aimed Shot ---
  const ignoreTC = Boolean(opts.ignoreTargetingComputer);
  const hasTargetingComputer = ignoreTC ? false : actorHasTargetingComputer(actor);
  const tcEligible = ignoreTC ? false : weaponIsTCTNEligible(weaponItem);
  let tcMod = (hasTargetingComputer && tcEligible) ? -1 : 0;

  const aimed = opts.aimedShot ?? {};
  let aimedEnabled = Boolean(aimed.enabled) && !isAbomTarget;
  let aimedDisabledReason = "";
  if ((isArrowIVHomingAttack || isNarcAttack) && aimedEnabled) {
    ui?.notifications?.warn?.(`${isNarcAttack ? "Narc Missile Beacon" : "Arrow IV Homing"} attacks cannot make aimed shots.`);
    return null;
  }
  if (isVehicleTarget && aimedEnabled) {
    aimedEnabled = false;
    aimedDisabledReason = "Aimed shots are not supported against vehicles.";
  } else if (isDropshipTarget && aimedEnabled) {
    aimedEnabled = false;
    aimedDisabledReason = "Aimed shots are not supported against DropShips.";
  }
  let aimedLocRaw = String(aimed.location ?? "").trim().toLowerCase();
  let useTCForAim = Boolean(aimed.useTC);
  const indirectFire = Boolean(opts.indirectFire);
  const rapidFireRating = (isTagAttack || isNarcAttack || isArrowIVHomingAttack) ? 1 : getRapidFireRating(weaponItem);
  const clusterShotsOverride = num(opts.clusterShots, null);
  const hasClusterShotsOverride = Number.isFinite(clusterShotsOverride);
  const rapidShots = (isTagAttack || isNarcAttack || isArrowIVHomingAttack) ? 1 : (hasClusterShotsOverride
    ? clamp(Math.max(1, clusterShotsOverride), 1, Math.max(1, Math.floor(clusterShotsOverride)))
    : clamp(Math.max(1, num(opts.rapidShots ?? 1, 1)), 1, rapidFireRating));

  // Validate the whole RAC burst before rolling. This prevents a partial/failed
  // six-shot attack from adding heat before discovering that only five rounds remain.
  if (rotaryProfile) {
    const { totals } = await ensureActorAmmoBins(actor);
    const bins = actor.system?.ammoBins ?? {};
    const bin = bins?.[rotaryProfile.ammoKey];
    const total = num(bin?.total, totals.get(rotaryProfile.ammoKey)?.total ?? 0);
    const current = Number.isFinite(Number(bin?.current)) ? num(bin.current, total) : total;
    if (!bin && !totals.has(rotaryProfile.ammoKey)) {
      ui?.notifications?.error?.(`${weaponItem.name} requires Ammo (AC/${rotaryProfile.caliber}).`);
      return { ok: false, blocked: true, reason: "missingRotaryACAmmo" };
    }
    if (current < rapidShots) {
      ui?.notifications?.error?.(`${weaponItem.name} needs ${rapidShots} round(s), but only ${current} remain.`);
      return { ok: false, blocked: true, reason: "insufficientRotaryACAmmo", required: rapidShots, current };
    }
  }
  const lbxSize = getLBXWeaponSize(weaponItem);
  const lbxSlugAmmoKey = Number.isFinite(lbxSize) ? slugifyAmmoKey(`lbx-${lbxSize}`) : null;
  const lbxClusterAmmoKey = Number.isFinite(lbxSize) ? slugifyAmmoKey(`lbx-${lbxSize}-cluster`) : null;
  if (Number.isFinite(lbxSize) && !ammoKey) ammoKey = lbxSlugAmmoKey;
  const isLBXClusterFire = Boolean(lbxClusterAmmoKey && ammoKey === lbxClusterAmmoKey);
  const atmProfile = getATMProfile(weaponItem, ammoKey);
  const ammoSelectionLabel = isLBXClusterFire
    ? `LB-X cluster ammo (${ammoKey})`
    : (Number.isFinite(lbxSize)
      ? `LB-X slug ammo (${ammoKey})`
      : (atmProfile
          ? `ATM ${atmProfile.label} ammo (${ammoKey})`
          : (["LRM", "MML", "SRM"].includes(weaponRackType)
              ? `${getMissileAmmoVariantLabel(selectedMissileAmmoVariant)} ${weaponRackType}-${weaponRack?.size} missiles (${ammoKey})`
              : String(ammoKey ?? ""))));

  const targetImmobile = tokenHasStatus(targetToken, "atow-immobile") || tokenHasStatus(targetToken, "immobile");
  const targetHasStatusPartialCover = tokenHasStatus(targetToken, "partial-cover");
  const targetHasWaterStatus = tokenHasStatus(targetToken, "in-water");
  const partialCoverAlreadyAddsTN = targetHasStatusPartialCover || (targetHasWaterStatus && losCoverMods.targetWaterDepth > 0);
  const terrainPartialCoverMod = (losCoverMods.partialCover && !partialCoverAlreadyAddsTN) ? 1 : 0;
  const targetPartialCover = targetHasStatusPartialCover || losCoverMods.partialCover;

  let aimedTNMod = 0;
  let coverCancelMod = 0;
  let immobileCancelMod = 0;
  const aimedDetails = [];

  // Validate aimed-shot legality and compute modifier deltas.
  if (aimedEnabled) {
    const designated = _normalizeDamageLocation(targetToken?.actor, aimedLocRaw) ?? aimedLocRaw;
    const isHead = String(designated) === "head";

    // Must be immobile unless a targeting computer is installed
    if (!targetImmobile && !hasTargetingComputer) {
      ui?.notifications?.warn?.("Aimed shots require an immobile target (unless you have a Targeting Computer installed).");
      return null;
    }

    // Cannot be used with indirect fire or multi-shot rapid fire
    if (indirectFire) {
      ui?.notifications?.warn?.("Indirect fire attacks cannot be aimed shots.");
      return null;
    }
    if (rapidShots > 1) {
      ui?.notifications?.warn?.("Rapid-Fire attacks firing more than one shot cannot be aimed shots.");
      return null;
    }

    // Weapon-type restrictions
    if (getMissileRack(weaponItem)) {
      ui?.notifications?.warn?.("Cluster weapons (LRMs/SRMs, etc.) cannot make aimed shots.");
      return null;
    }
    if (weaponIsAreaEffectWeapon(weaponItem)) {
      ui?.notifications?.warn?.("Area-effect weapons cannot make aimed shots.");
      return null;
    }
    if (weaponIsFlakWeapon(weaponItem)) {
      ui?.notifications?.warn?.("Flak weapons cannot make aimed shots.");
      return null;
    }

    // Partial Cover: you may not aim for covered legs
    if (targetPartialCover && isLegLocationKey(designated)) {
      ui?.notifications?.warn?.("With Partial Cover, you cannot aim for leg locations.");
      return null;
    }

    // If the target is mobile, a TC must be used; head may not be targeted; pulse is ineligible.
    if (!targetImmobile) {
      useTCForAim = true;

      if (isHead) {
        ui?.notifications?.warn?.("Aimed shots using a Targeting Computer against a mobile target may not target the head.");
        return null;
      }
      if (weaponIsPulseWeapon(weaponItem)) {
        ui?.notifications?.warn?.("Pulse weapons cannot be used for aimed shots with a Targeting Computer against a mobile target.");
        return null;
      }

      aimedTNMod += 3;
      aimedDetails.push("Aimed Shot (TC, mobile) +3");

      // Ignore the TC's normal -1 to-hit modifier for mobile aimed shots
      tcMod = 0;
    } else {
      // Target is immobile
      if (isHead) {
        // Head shots: ignore immobile -4; add +3 instead; TC provides no bonus
        aimedTNMod += 3;
        immobileCancelMod += 4;
        aimedDetails.push("Aimed Head Shot +3 (ignore Immobile)");

        tcMod = 0;
        useTCForAim = false;
      } else if (hasTargetingComputer && useTCForAim) {
        aimedDetails.push(`Aimed Shot (immobile, TC)`);
        // Immobile -4 is already applied by the Immobile status effect; TC mod remains (if eligible)
      } else {
        aimedDetails.push("Aimed Shot (immobile)");
      }
    }

    // Partial Cover: ignore its TN modifier for aimed shots
    if (targetPartialCover) {
      coverCancelMod -= (partialCoverAlreadyAddsTN ? 1 : 0) + terrainPartialCoverMod;
      aimedDetails.push("Ignore Partial Cover");
    }
  }

  const aimedNetMod = aimedTNMod + coverCancelMod + immobileCancelMod;
  const tcModStr = (tcMod >= 0) ? `+${tcMod}` : `${tcMod}`;
  const aimedModStr = (aimedNetMod >= 0) ? `+${aimedNetMod}` : `${aimedNetMod}`;

  const totalTN = isArrowIVHomingAttack
    ? 4
    : num(baseTN, 8) + rangeMod + attackerMoveMod + targetMoveMod + heatFireMod + statusTNMods.total + envTNMods.mod + losWoodsMods.mod + terrainPartialCoverMod + terrainMod + otherMod + mrmTNMod + tcMod + aimedNetMod;

  const tn = isArrowIVHomingAttack
    ? 4
    : num(baseTN, 8) + rangeMod + attackerMoveMod + targetMoveMod + heatFireMod + statusTNMods.total + envTNMods.mod + losWoodsMods.mod + terrainPartialCoverMod + terrainMod + otherMod + mrmTNMod + tcMod + aimedNetMod;

  const toHit = await (new Roll(isArrowIVHomingAttack ? "2d6" : `2d6 + ${gunnery}`)).evaluate();
  // Missile rack size (LRM/SRM/MRM etc). Used to distinguish missile cluster weapons vs rapid-fire cluster.
  const rack = (isTagAttack || isNarcAttack || isArrowIVHomingAttack) ? null : (isLBXClusterFire ? { type: "LBX", size: lbxSize } : weaponRack);
  const rackType = String(rack?.type ?? "").toUpperCase();
  const rackATMProfile = (rackType === "ATM") ? (atmProfile ?? getATMProfile(weaponItem, ammoKey)) : null;
  const rackPerHitDamage = rackATMProfile?.damagePerMissile ?? ((rackType === "SRM") ? 2 : (rackType === "LBX" ? 1 : 1));
  const rackGroupSize = rackATMProfile?.groupSize ?? ((rackType === "SRM") ? 1 : (rackType === "LBX" ? 1 : 5));
  // Streak missile launchers: if the attack misses, the launcher does not fire (no ammo/heat).
  // If the attack hits, the Cluster Hits Table result is treated as 12 (i.e., all missiles in the rack hit).
  const isStreakLauncher = Boolean(rack) && ["LRM", "SRM"].includes(rackType) && /streak/i.test(String(weaponItem.name ?? ""));

  // For Streak launchers, ensure there is at least 1 ammo available before allowing an attack.
  if (isStreakLauncher && weaponConsumesAmmo(weaponItem, actor, { ammoKey })) {
    const key = ammoKey || getAmmoKeyForWeapon(weaponItem);
    if (key) {
      await ensureActorAmmoBins(actor);
      const bins = actor.system?.ammoBins ?? {};
      const bin = bins?.[key];
      const total = num(bin?.total, 0);
      const cur = Number.isFinite(Number(bin?.current)) ? num(bin.current, total) : total;
      if (cur < 1) {
        if (ui?.notifications?.error) ui.notifications.error(`No ammo remaining for ${String(bin?.name ?? key)}.`);
        return null;
      }
    }
  }


// Rapid-fire jam check (only when firing more than one shot; based on the base 2d6 result).
// - 2–3 shots: jam on 2
// - 4–5 shots: jam on 3 or less
// - 6–7 shots: jam on 4 or less, and so on.
const base2d6 = getBase2d6Total(toHit);
let jam = null;
if (!isAbomChat && rapidShots > 1 && !rack) {
  const threshold = Math.floor(rapidShots / 2) + 1;
  let rollTotal = (base2d6 ?? null);

  // If we can't reliably extract the dice total from the to-hit roll (Foundry internals vary),
  // roll a separate 2d6 just for the jam check.
  if (rollTotal === null) {
    const jr = await (new Roll("2d6")).evaluate();
    rollTotal = num(jr?.total, null);
  }

  const jammed = (rollTotal !== null) && (rollTotal <= threshold);

  if (jammed) {
    // Persist jam state on the weapon so it can't be fired again.
    await weaponItem.update({ "system.jammed": true }).catch(() => {});
    enqueueActorAudioCues(actor, ["weaponJammed"], { volume: 0.95 });
  }

  jam = { rollTotal, threshold, jammed };
}

const hit = (toHit.total ?? 0) >= tn;

  const rawHeat = rotaryProfile?.heat ?? num(weaponItem.system?.heat, 0);
  const rawBaseDamage = rotaryProfile?.damage ?? num(weaponItem.system?.damage, 0);
  const dazzleMode = isActorDazzleModeActive(actor) && isLaserWeapon(weaponItem);
  const dazzleHalvesDamage = dazzleMode && !isAbomTarget;

  let heat = isVehicleAttacker ? 0 : rawHeat;
  let baseDamage = (isTagAttack || isNarcAttack) ? 0 : rawBaseDamage;

  if (dazzleMode) {
    if (!isVehicleAttacker) heat = Math.max(0, Math.floor(rawHeat / 2));
    if (dazzleHalvesDamage) baseDamage = Math.max(0, Math.floor(rawBaseDamage / 2));
  }

  if (isArrowIVHomingAttack) baseDamage = hit ? 20 : 5;

  // Streak launchers do not fire on a miss (no ammo spent, no heat generated).
  const weaponFired = !(isStreakLauncher && !hit);
  if (!weaponFired) heat = 0;

  // Determine arc side from target facing unless explicitly provided
  const arc = getTargetSideFromFacing(attackerToken, targetToken);
  const side = (opts.side && ["front", "rear", "left", "right"].includes(opts.side)) ? opts.side : (arc?.side ?? "front");

  // Optional rule toggle: floating TAC criticals (see TAC rules). Off by default.
  const floatingCrits = Boolean(opts.floatingCrits);

  // Cluster handling (LRM/SRM/MRM)
  const isRapidFireCluster = (!rack && rapidShots > 1 && (hasClusterShotsOverride || rapidFireRating > 1));
  let cluster = null;
  let damage = baseDamage;

  // Rapid Fire: for ballistic rapid-fire weapons (Ultra/RAC/etc.).
  // Heat/ammo are spent per shot fired (even on a miss), but damage is resolved via the Cluster Hits Table.
  // (Cluster weapons like LRM/SRM/MRM already use the cluster table and ignore rapid fire.)
  if (isRapidFireCluster) {
    heat = heat * rapidShots;
  }

  const artemisInstalled = num(artemisIVCounts.totalArtemis, 0) > 0;
  const artemisVInstalled = num(artemisVCounts.totalArtemis, 0) > 0;
  const artemisLinked = selectedMissileAmmoVariant === MISSILE_AMMO_VARIANTS.ARTEMIS_IV && artemisIVLinked;
  const artemisVActive = selectedMissileAmmoVariant === MISSILE_AMMO_VARIANTS.ARTEMIS_V && artemisVLinked;
  const targetNarced = Boolean(rack) && tokenHasStatus(targetToken, NARC_STATUS_ID);
  const narcAmmoSelected = selectedMissileAmmoVariant === MISSILE_AMMO_VARIANTS.NARC;
  const narcActive = narcAmmoSelected && targetNarced && !isStreakLauncher;
  const amsEligible = hit && isMechActor(targetActor) && Boolean(rack) && ["LRM", "MML", "MRM", "SRM"].includes(String(rack.type ?? "").toUpperCase());
  const amsDefense = amsEligible
    ? await resolveAMSDefense(targetActor, {
        attackerName: attackerToken?.name ?? actor.name,
        weaponName: weaponItem?.name ?? "Missile attack",
        streak: isStreakLauncher
      }).catch(err => {
        console.warn("AToW Battletech | AMS defense failed", err);
        return { active: false, reason: "error" };
      })
    : { active: false };
  const atmBuiltInArtemis = rackType === "ATM";
  const guidanceBonus = !isStreakLauncher
    ? (artemisVActive ? 3 : ((narcActive || artemisLinked || atmBuiltInArtemis) ? 2 : 0))
    : 0;
  const clusterBonus = guidanceBonus + ((amsDefense?.active && !isStreakLauncher) ? -4 : 0);

  if (hit && rack && hasClusterShotsOverride) {
    const volleyRoll = await rollClusterHits(rapidShots, 0);
    const volleyHits = clamp(Math.min(rapidShots, num(volleyRoll.hits, 0)), 0, rapidShots);

    const perHitDamage = rackPerHitDamage;
    const groupSize = rackGroupSize;

    const subclusters = [];
    const packets = [];

    for (let i = 0; i < volleyHits; i++) {
      let clusterRoll;
      let missilesHit;
      if (isStreakLauncher) {
        clusterRoll = amsDefense?.active
          ? await rollClusterHits(rack.size, 0, { forcedTotal: 7 })
          : { roll: { total: 12 }, baseTotal: 12, mod: 0, modifiedTotal: 12, hits: rack.size };
        missilesHit = Math.min(rack.size, num(clusterRoll.hits, 0));
      } else {
        clusterRoll = await rollClusterHits(rack.size, clusterBonus);
        missilesHit = Math.min(rack.size, num(clusterRoll.hits, 0));
      }

      subclusters.push({
        clusterRoll: clusterRoll.roll,
        clusterRollBaseTotal: clusterRoll.baseTotal,
        clusterRollMod: clusterRoll.mod,
        clusterRollModifiedTotal: clusterRoll.modifiedTotal,
        missilesHit
      });

      for (const packet of buildClusterDamagePackets(rack.type, missilesHit, perHitDamage, groupSize)) {
        if (isAbomTarget) {
          packets.push({
            hits: packet.hits,
            loc: "abom",
            roll: { total: null },
            tacFrom2: false,
            damage: packet.damage,
            damageCluster: packet.damageCluster,
            floating: null
          });
          continue;
        }
        if (isVehicleTarget) {
          const locRes = await rollVehicleHitLocation(side, { hasTurret: hasVehicleTurret });
          packets.push({
            hits: packet.hits,
            loc: locRes.loc,
            roll: locRes.roll,
            tacFrom2: false,
            vehicleCrit: locRes.critTrigger ? { trigger: true, tableLoc: locRes.critTableLoc } : null,
            damage: packet.damage,
            damageCluster: packet.damageCluster,
            floating: null
          });
          continue;
        }
        if (isDropshipTarget) {
          const locRes = await rollDropshipHitLocation(side);
          packets.push({
            hits: packet.hits,
            loc: locRes.loc,
            roll: locRes.roll,
            tacFrom2: false,
            damage: packet.damage,
            damageCluster: packet.damageCluster,
            floating: null
          });
          continue;
        }

        let locRes = await rollHitLocation(side);
        const tacFrom2 = (locRes?.roll?.total ?? 0) === 2;

        if (tacFrom2 && floatingCrits) {
          const reroll = await rollHitLocation(side);
          locRes = { ...reroll, floating: { original: { loc: locRes.loc, rollTotal: 2 }, reroll: { loc: reroll.loc, rollTotal: reroll?.roll?.total ?? 0 } } };
        }

        packets.push(applyPartialCoverToPacket({
          hits: packet.hits,
          loc: locRes.loc,
          roll: locRes.roll,
          tacFrom2,
          damage: packet.damage,
          damageCluster: packet.damageCluster,
          floating: locRes.floating
        }, targetPartialCover));
      }
    }

    cluster = {
      mode: "volley",
      type: rack.type,
      rackSize: rack.size,
      label: (opts?.clusterLabel ? String(opts.clusterLabel) : "Volley"),
      volleySize: rapidShots,
      volleyHits,
      volleyRoll: volleyRoll.roll,
      volleyRollBaseTotal: volleyRoll.baseTotal,
      volleyRollMod: volleyRoll.mod,
      volleyRollModifiedTotal: volleyRoll.modifiedTotal,
      artemisLinked: artemisLinked || artemisVActive || atmBuiltInArtemis,
      narcActive,
      ams: amsDefense,
      streakUsed: isStreakLauncher,
      perHitDamage,
      groupSize,
      side,
      subclusters,
      packets
    };

    damage = packets.reduce((sum, p) => sum + num(p.damage, 0), 0);
  } else if (hit && rack) {
    // Streak launchers: on a hit, treat the Cluster Hits Table roll as 12 (all missiles hit).
    // Otherwise, roll normally (Artemis IV may modify the roll).
    let clusterRoll;
    let missilesHit;
    if (isStreakLauncher) {
      clusterRoll = amsDefense?.active
        ? await rollClusterHits(rack.size, 0, { forcedTotal: 7 })
        : { roll: { total: 12 }, baseTotal: 12, mod: 0, modifiedTotal: 12, hits: rack.size };
      missilesHit = Math.min(rack.size, num(clusterRoll.hits, 0));
    } else {
      clusterRoll = await rollClusterHits(rack.size, clusterBonus);
      missilesHit = Math.min(rack.size, num(clusterRoll.hits, 0));
    }

    const perHitDamage = rackPerHitDamage;
    const groupSize = rackGroupSize;

    const packets = [];
      for (const packet of buildClusterDamagePackets(rack.type, missilesHit, perHitDamage, groupSize)) {
        if (isAbomTarget) {
          packets.push({
            hits: packet.hits,
            loc: "abom",
            roll: { total: null },
            tacFrom2: false,
            damage: packet.damage,
            damageCluster: packet.damageCluster,
            floating: null
          });
          continue;
        }
        if (isVehicleTarget) {
          const locRes = await rollVehicleHitLocation(side, { hasTurret: hasVehicleTurret });
          packets.push({
            hits: packet.hits,
            loc: locRes.loc,
            roll: locRes.roll,
            tacFrom2: false,
            vehicleCrit: locRes.critTrigger ? { trigger: true, tableLoc: locRes.critTableLoc } : null,
            damage: packet.damage,
            damageCluster: packet.damageCluster,
            floating: null
          });
          continue;
        }
        if (isDropshipTarget) {
          const locRes = await rollDropshipHitLocation(side);
          packets.push({
            hits: packet.hits,
            loc: locRes.loc,
            roll: locRes.roll,
            tacFrom2: false,
            damage: packet.damage,
            damageCluster: packet.damageCluster,
            floating: null
          });
          continue;
        }

        let locRes = await rollHitLocation(side);
        const tacFrom2 = (locRes?.roll?.total ?? 0) === 2;

        // Optional floating TAC rule: if the *original* hit-location roll is 2, reroll location for where the shot actually hits.
        // Any criticals (including the TAC check) are then applied to the rerolled location.
        if (tacFrom2 && floatingCrits) {
          const reroll = await rollHitLocation(side);
          locRes = { ...reroll, floating: { original: { loc: locRes.loc, rollTotal: 2 }, reroll: { loc: reroll.loc, rollTotal: reroll?.roll?.total ?? 0 } } };
        }

        packets.push({
          hits: packet.hits,
          loc: locRes.loc,
          roll: locRes.roll,
          tacFrom2,
          damage: packet.damage,
          damageCluster: packet.damageCluster,
          floating: locRes.floating
        });
      }

    cluster = {
      mode: "missile",
      type: rack.type,
      rackSize: rack.size,
      clusterRoll: clusterRoll.roll,
      clusterRollBaseTotal: clusterRoll.baseTotal,
      clusterRollMod: clusterRoll.mod,
      clusterRollModifiedTotal: clusterRoll.modifiedTotal,
      artemisLinked: artemisLinked || artemisVActive || atmBuiltInArtemis,
      narcActive,
      ams: amsDefense,
      streakUsed: isStreakLauncher,
      missilesHit,
      perHitDamage,
      groupSize,
      side,
      packets
    };

    damage = packets.reduce((sum, p) => sum + num(p.damage, 0), 0);

  }

  let infernoHeat = 0;
  if (cluster && selectedMissileAmmoVariant === MISSILE_AMMO_VARIANTS.INFERNO) {
    const missilesHit = cluster.mode === "volley"
      ? (cluster.subclusters ?? []).reduce((sum, row) => sum + num(row?.missilesHit, 0), 0)
      : num(cluster.missilesHit, 0);
    infernoHeat = Math.max(0, missilesHit * 2);
    cluster.infernoHeat = infernoHeat;
    cluster.packets = [];
    damage = 0;
  }

  // Rapid-fire cluster handling: resolve how many shells hit via the Cluster Hits Table,
  // then apply each hit as its own packet (group size 1).
  if (hit && isRapidFireCluster) {
    const clusterRoll = await rollClusterHits(rapidShots, 0);
    const shotsHit = clamp(Math.min(rapidShots, num(clusterRoll.hits, 0)), 0, rapidShots);

    const packets = [];
    for (let i = 0; i < shotsHit; i++) {
      if (isAbomTarget) {
        packets.push({
          hits: 1,
          loc: "abom",
          roll: { total: null },
          tacFrom2: false,
          damage: baseDamage,
          floating: null
        });
        continue;
      }
      if (isVehicleTarget) {
        const locRes = await rollVehicleHitLocation(side, { hasTurret: hasVehicleTurret });
        packets.push({
          hits: 1,
          loc: locRes.loc,
          roll: locRes.roll,
          tacFrom2: false,
          vehicleCrit: locRes.critTrigger ? { trigger: true, tableLoc: locRes.critTableLoc } : null,
          damage: baseDamage,
          floating: null
        });
        continue;
      }
      if (isDropshipTarget) {
        const locRes = await rollDropshipHitLocation(side);
        packets.push({
          hits: 1,
          loc: locRes.loc,
          roll: locRes.roll,
          tacFrom2: false,
          damage: baseDamage,
          floating: null
        });
        continue;
      }

      let locRes = await rollHitLocation(side);
      const tacFrom2 = (locRes?.roll?.total ?? 0) === 2;

      // Optional floating TAC rule: if the *original* hit-location roll is 2, reroll location for where the shot actually hits.
      // Any criticals (including the TAC check) are then applied to the rerolled location.
      if (tacFrom2 && floatingCrits) {
        const reroll = await rollHitLocation(side);
        locRes = { ...reroll, floating: { original: { loc: locRes.loc, rollTotal: 2 }, reroll: { loc: reroll.loc, rollTotal: reroll?.roll?.total ?? 0 } } };
      }

      packets.push(applyPartialCoverToPacket({
        hits: 1,
        loc: locRes.loc,
        roll: locRes.roll,
        tacFrom2,
        damage: baseDamage,
        floating: locRes.floating
      }, targetPartialCover));
    }

    cluster = {
      mode: "rapid",
      type: "RF",
      rackSize: rapidShots,
      label: (opts?.clusterLabel ? String(opts.clusterLabel) : "Rapid Fire"),
      clusterRoll: clusterRoll.roll,
      clusterRollBaseTotal: clusterRoll.baseTotal,
      clusterRollMod: 0,
      clusterRollModifiedTotal: clusterRoll.modifiedTotal,
      artemisLinked: false,
      missilesHit: shotsHit,
      perHitDamage: baseDamage,
      groupSize: 1,
      side,
      packets
    };

    damage = packets.reduce((sum, p) => sum + num(p.damage, 0), 0);
  }


  let locResult = null;
  let tacSingle = false;
  const shouldResolveHitLocation = (hit || isArrowIVHomingAttack) && (opts.showLocation || opts.applyDamage || isNarcAttack) && !cluster && !isAbomTarget && !isTagAttack;
  if (shouldResolveHitLocation) {
    if (isVehicleTarget) {
      locResult = await rollVehicleHitLocation(side, { hasTurret: hasVehicleTurret });
    } else if (isDropshipTarget) {
      locResult = await rollDropshipHitLocation(side);
    } else if (aimedEnabled) {
      const designated = _normalizeDamageLocation(targetToken?.actor, aimedLocRaw) ?? aimedLocRaw;
      const aimRoll = await (new Roll("2d6")).evaluate({ async: true });
      const aimTotal = aimRoll.total ?? 0;

      const usedDesignated = [6, 7, 8].includes(aimTotal);
      if (usedDesignated) {
        locResult = {
          roll: aimRoll,
          loc: designated,
          aim: { designated, roll: aimRoll, rollTotal: aimTotal, used: true, partialCoverReroll: false }
        };
      } else {
        const fallback = await rollHitLocation(side);
        locResult = {
          roll: fallback.roll,
          loc: fallback.loc,
          aim: { designated, roll: aimRoll, rollTotal: aimTotal, used: false, partialCoverReroll: !!targetPartialCover }
        };
      }
    } else {
      locResult = await rollHitLocation(side);
    }
    const coverResult = applyPartialCoverToHitLocation(locResult, targetPartialCover && !isArrowIVHomingAttack);
    locResult = coverResult.locResult;
    if (coverResult.covered) tacSingle = false;
  }

  // TAC + optional Floating Criticals (non-cluster):
  // - Standard TAC: if the hit-location table roll was 2, we make an extra TAC critical check on that location.
  // - Floating Criticals (optional): if TAC is possible (original roll was 2), reroll location; apply TAC/criticals to the rerolled location.
  if (hit && locResult && !cluster && !isVehicleTarget && !isDropshipTarget && !isArrowIVHomingAttack) {
    const fromHitLocationTable = !locResult.aim || locResult.aim.used === false;
    if (fromHitLocationTable && (locResult.roll?.total ?? 0) === 2) {
      tacSingle = true;

      if (floatingCrits) {
        const reroll = await rollHitLocation(side);
        locResult = {
          roll: reroll.roll,
          loc: reroll.loc,
          aim: locResult.aim,
          floating: {
            original: { loc: locResult.loc, rollTotal: 2 },
            reroll: { loc: reroll.loc, rollTotal: reroll?.roll?.total ?? 0 }
          }
        };
        const coverResult = applyPartialCoverToHitLocation(locResult, targetPartialCover);
        locResult = coverResult.locResult;
        if (coverResult.covered) tacSingle = false;
      }
    }
  }



  if (!isVehicleAttacker && opts.applyHeat && heat && weaponFired) {
    const heatActor = attackerToken?.actor ?? actor;
    const addActorPendingHeat = game?.[SYSTEM_ID]?.api?.addActorPendingHeat ?? null;
    if (typeof addActorPendingHeat === "function") {
      await addActorPendingHeat(heatActor, heat);
    } else {
      const cur = num((heatActor.system?.heat?.value ?? heatActor.system?.heat?.current), 0);
      const barMax = num(heatActor.system?.heat?.max, 30);
      const next = clamp(cur + heat, 0, HEAT_HARD_CAP);
      await heatActor.update({
        "system.heat.value": next,
        "system.heat.current": next,
        "system.heat.unvented": next,
        "system.heat.effects.unvented": next,
        "system.heat.max": barMax
      });
    }
  }


// Spend ammo (1 per firing) if an ammo bin exists for this weapon.
// This happens whether the shot hits or misses (ammo is expended when fired).
let ammoSpend = null;
if (weaponFired && opts.spendAmmo !== false && (weaponConsumesAmmo(weaponItem, actor, { ammoKey }) || Boolean(ammoKey))) {
  ammoSpend = await spendAmmoIfApplicable(actor, weaponItem, rapidShots, { ammoKey });

  // Abort if out of ammo
  if (ammoSpend && ammoSpend.ok === false) {
    if (ui && ui.notifications && typeof ui.notifications.error === "function") ui.notifications.error(ammoSpend.reason || `No ammo remaining for ${ammoSpend.name || "this weapon"}.`);
    return null;
  }

  if (ammoSpend?.key && ammoSpend?.after === 0) {
    {
      const n = (ammoSpend && (ammoSpend.name ?? ammoSpend.key)) ? String(ammoSpend.name ?? ammoSpend.key) : String(ammoSpend && ammoSpend.key ? ammoSpend.key : "");
      if (ui && ui.notifications && typeof ui.notifications.warn === "function") ui.notifications.warn(`${actor.name}: ${n.toUpperCase()} ammo depleted!`);
      enqueueActorAudioCues(actor, ["ammoDepleted"], { volume: 0.95 });
    }
  }
}

let infernoHeatApplied = null;
if (weaponFired && hit && infernoHeat > 0) {
  if (isMechActor(targetActor)) {
    infernoHeatApplied = await addHeatToActorAuto(targetActor, infernoHeat);
    if (infernoHeatApplied?.ok === false) {
      ui?.notifications?.warn?.(`Inferno missiles hit, but target heat was not applied: ${infernoHeatApplied.reason ?? "unknown reason"}`);
    }
  } else {
    infernoHeatApplied = { ok: false, reason: "Target is not a BattleMech" };
  }
}

if (weaponFired) {
  try {
    await markWeaponFiredThisTurn(actor, weaponItem, opts);
    if (isArrowIVHomingAttack) await playArrowIVLaunchEffects(attackerToken);
    try {
      const sheet = actor?.sheet;
      if (sheet?.rendered) sheet.render(false);
    } catch (_) {}
  } catch (err) {
    console.warn("AToW Battletech | Failed to mark weapon as fired this turn", err);
  }
}

let tagApplied = null;
if (isTagAttack && hit) {
  tagApplied = await applyTaggedToTargetActorAuto(targetActor, {
    attackerActorUuid: actor?.uuid ?? null,
    attackerActorId: actor?.id ?? null,
    attackerTokenUuid: (attackerToken?.document ?? attackerToken)?.uuid ?? null,
    attackerTokenId: (attackerToken?.document ?? attackerToken)?.id ?? null
  });
  if (tagApplied?.ok === false) {
    ui?.notifications?.warn?.(`TAG hit, but Tagged status was not applied: ${tagApplied.reason ?? "unknown reason"}`);
  }
}

let narcApplied = null;
if (isNarcAttack && hit && locResult?.loc && !locResult.partialCoverBlocked) {
  narcApplied = await applyNarcToTargetActorAuto(targetActor, {
    loc: locResult.loc,
    attackerActorUuid: actor?.uuid ?? null,
    attackerTokenUuid: (attackerToken?.document ?? attackerToken)?.uuid ?? null
  });
  if (narcApplied?.ok === false) {
    ui?.notifications?.warn?.(`Narc hit, but the pod was not attached: ${narcApplied.reason ?? "unknown reason"}`);
  }
}

// ---- Automatic Damage Application (first pass) ----
// If enabled, apply damage to the targeted mech immediately after resolving the hit location.
  let damageApplied = null;
  let massiveDamagePsr = null;
  const shouldApplyAttackDamage = (hit || isArrowIVHomingAttack) && opts.applyDamage && !isTagAttack && !isNarcAttack && infernoHeat <= 0;
  if (shouldApplyAttackDamage) {
    if (!targetActor) {
      ui?.notifications?.warn?.("No target actor found to apply damage.");
    } else {
      try {
        if (cluster?.packets?.length) {
          const results = [];
          for (const p of cluster.packets) {
            let r;
            if (p.partialCoverBlocked) {
              r = { ok: true, partialCoverBlocked: true, reason: "Partial cover blocked leg hit", damage: 0, hitLoc: p.loc };
            } else if (isAbomTarget) {
              r = await applyDamageToAbominationActorAuto(targetActor, p.damage);
              if (r?.ok) p.abomIndex = r.hitAbomination;
            } else if (isVehicleTarget) {
              r = await applyDamageToVehicleActorAuto(targetActor, p.loc, p.damage, { attackSide: side, crit: p.vehicleCrit });
            } else if (isDropshipTarget) {
              r = await applyDamageToDropshipActorAuto(targetActor, p.loc, p.damage);
            } else {
              r = await applyDamageToTargetActorAuto(targetActor, p.loc, p.damage, { side, tac: Boolean(p.tacFrom2), tacLoc: p.loc });
            }
            results.push({ packet: p, result: r });
            // If we lack permissions, stop spamming updates
            if (r && r.ok === false && r.reason?.includes("permission")) break;
          }
          damageApplied = { type: "cluster", results };
        } else {
          let r;
          if (locResult?.partialCoverBlocked) {
            r = { ok: true, partialCoverBlocked: true, reason: "Partial cover blocked leg hit", damage: 0, hitLoc: locResult.loc };
          } else if (isAbomTarget) {
            r = await applyDamageToAbominationActorAuto(targetActor, damage);
          } else if (isVehicleTarget) {
            let loc = locResult?.loc ?? null;
            let crit = locResult?.critTrigger ? { trigger: true, tableLoc: locResult.critTableLoc } : null;
            if (!loc) {
              const fallback = await rollVehicleHitLocation(side, { hasTurret: hasVehicleTurret });
              loc = fallback.loc;
              if (fallback.critTrigger) crit = { trigger: true, tableLoc: fallback.critTableLoc };
            }
            r = await applyDamageToVehicleActorAuto(targetActor, loc, damage, { attackSide: side, crit });
          } else if (isDropshipTarget) {
            let loc = locResult?.loc ?? null;
            if (!loc) loc = (await rollDropshipHitLocation(side))?.loc;
            r = await applyDamageToDropshipActorAuto(targetActor, loc, damage);
          } else {
            const loc = locResult?.loc ?? (await rollHitLocation(side))?.loc;
            r = await applyDamageToTargetActorAuto(targetActor, loc, damage, { side, tac: tacSingle, tacLoc: loc });
          }
          damageApplied = { type: "single", result: r };
        }
      } catch (err) {
        // Never let an exception here abort the attack workflow; record the error for the chat card.
        console.warn("AToW Battletech | Damage application threw an exception", err);
        damageApplied = { type: "error", error: String(err?.message ?? err) };
      }

      // If we couldn't apply (permissions), whisper the GM with details so it can be applied manually.
      const fail = (damageApplied?.type === "single" && damageApplied?.result?.ok === false) ||
                   (damageApplied?.type === "cluster" && damageApplied?.results?.some(x => x.result?.ok === false));
      if (fail && !game.user?.isGM) {
        const gmIds = (game.users ?? []).filter(u => u.isGM).map(u => u.id);
        if (gmIds.length) {
          const reason = (damageApplied?.result?.reason ?? damageApplied?.results?.find(x => x.result?.ok === false)?.result?.reason ?? "Unknown");
          await ChatMessage.create({
            whisper: gmIds,
            content: `<b>${actor.name}</b> attempted to auto-apply damage to <b>${targetToken?.name ?? "target"}</b> but failed: ${reason}`
          }).catch(()=>{});
        }
    }
  }
}

if (!cluster && isMechActor(targetActor) && Number(damage ?? 0) >= 20) {
  const singleResult = damageApplied?.type === "single" ? damageApplied.result : null;
  const damageWasApplied = singleResult?.ok && !singleResult?.partialCoverBlocked;
  if (damageWasApplied) {
    massiveDamagePsr = await resolveMassiveDamagePSR(targetToken, damage, { source: weaponItem?.name ?? "Weapon attack" });
  }
}

if (isArrowIVHomingAttack && weaponFired) {
  await playArrowIVImpactEffects(getTokenCenter(targetToken) ?? targetToken);
}



  const targetName = targetToken?.name ?? "Target";
  const attackerName = attackerToken?.name ?? actor.name;

const clusterNote = cluster
  ? (selectedMissileAmmoVariant === MISSILE_AMMO_VARIANTS.INFERNO
      ? "Inferno missiles deal no damage; each missile that hits adds 2 heat to the target BattleMech."
      : (cluster.mode === "missile"
      ? (cluster.type === "SRM"
          ? "SRM damage is 2 per missile; each missile rolls its own location (group size 1)."
          : (cluster.type === "LBX"
              ? "LB-X cluster ammo deals 1 damage per pellet; each pellet rolls its own location."
              : (cluster.type === "ATM"
                  ? `ATM ${rackATMProfile?.label ?? "Standard"} ammo deals ${cluster.perHitDamage} damage per missile; total damage is grouped into 5-point clusters.`
                  : (cluster.type === "MRM"
                      ? "MRM damage is 1 per missile; packets are grouped in 5s."
                      : (cluster.type === "MML"
                          ? "MML damage is resolved from the selected missile ammunition; packets are grouped in 5s."
                          : "LRM damage is 1 per missile; packets are grouped in 5s.")))))
      : (cluster.mode === "volley"
          ? `${cluster.label ?? "Volley"}: roll to see how many attackers hit, then resolve missile clusters per hit.`
          : `${cluster.label ?? "Rapid Fire"} damage is applied per hit; each hit is resolved as its own packet.`)))
  : "";

  const facingLine = arc
    ? `<div><b>Target Facing:</b> ${Math.round(arc.facingDeg)}° | <b>Attack Arc:</b> ${side.toUpperCase()}</div>`
    : `<div><b>Attack Arc:</b> ${side.toUpperCase()} (no facing data found)</div>`;

  const firingArcLine = firingArcInfo.applies
    ? `<div><b>Weapon Arc:</b> ${String(firingArcInfo.side ?? "front").toUpperCase()} target arc | ${firingArcInfo.rearMounted ? "Rear-mounted" : `${htmlEscape(firingArcInfo.mount?.locLabel ?? "Unknown")} mounted`} | Allowed ${htmlEscape(firingArcInfo.allowedLabel ?? "")}</div>`
    : "";

  const weaponMeta = _getWeaponAutomationMeta(weaponItem);

  const artemisInfoLine = artemisLinked
    ? `<div><b>Artemis IV FCS:</b> Artemis IV missiles linked (+2 to cluster roll)</div>`
    : (artemisVActive
        ? `<div><b>Artemis V FCS:</b> Artemis V missiles linked (+3 to cluster roll)</div>`
        : (rackType === "ATM"
            ? `<div><b>Artemis IV:</b> Built into ATM launcher (+2 to cluster roll)</div>`
            : ((artemisInstalled || artemisVInstalled) && selectedMissileAmmoVariant === MISSILE_AMMO_VARIANTS.STANDARD
                ? `<div><b>Artemis FCS:</b> Standard ammunition selected (no Artemis bonus)</div>`
                : "")));

  const narcInfoLine = rack
    ? (narcActive
        ? `<div><b>Narc Guidance:</b> Narc-equipped missiles tracking Narc'd target (+2 to cluster roll)</div>`
        : (narcAmmoSelected
            ? `<div><b>Narc Guidance:</b> Narc-equipped missiles selected, but target is not Narc'd (no bonus)</div>`
            : (targetNarced ? `<div><b>Narc Guidance:</b> Target is Narc'd, but Narc-equipped ammunition was not selected (no bonus)</div>` : "")))
    : "";

  const specialMissileAmmoInfoLine = selectedMissileAmmoVariant === MISSILE_AMMO_VARIANTS.INFERNO
    ? `<div><b>Inferno Missiles:</b> ${Math.floor(infernoHeat / 2)} hit; ${infernoHeat} heat applied to target; no damage.</div>`
    : (selectedMissileAmmoVariant === MISSILE_AMMO_VARIANTS.FRAGMENTATION
        ? `<div><b>Fragmentation Missiles:</b> Selected. Woods/jungle damage automation is not yet implemented.</div>`
        : (selectedMissileAmmoVariant === MISSILE_AMMO_VARIANTS.SEMI_GUIDED
            ? `<div><b>Semi-guided LRMs:</b> Selected. Indirect-fire/TAG modifier automation is not yet implemented.</div>`
            : ""));

  const streakInfoLine = isStreakLauncher
    ? (hit
        ? (amsDefense?.active
            ? `<div><b>Streak:</b> HIT — AMS forces cluster result 7</div>`
            : `<div><b>Streak:</b> HIT — Cluster result is automatically 12 (all missiles hit)</div>`)
        : `<div><b>Streak:</b> MISS — launcher did not fire (no ammo/heat)</div>`)
    : "";

  const amsInfoLine = amsDefense?.active
    ? `<div><b>AMS:</b> ${htmlEscape(amsDefense.defenderName ?? targetName)} engages ${htmlEscape(weaponItem.name ?? "missiles")} (${isStreakLauncher ? "Streak uses cluster total 7" : "-4 Cluster Hits"}); ammo ${amsDefense.ammo?.after ?? "?"}/${amsDefense.ammo?.total ?? "?"}, +1 heat.</div>`
    : "";

  const arrowIVInfoLine = isArrowIVHomingAttack
    ? (hit
        ? `<div><b>Arrow IV Homing:</b> Guided hit. Apply 20 damage.</div>`
        : `<div><b>Arrow IV Homing:</b> Roll 2-3. Missile scatters into the ground; apply 5 damage to the target.</div>`)
    : "";

const rapidFireInfoLine = (!rack && rapidFireRating > 1)
  ? `<div><b>Rapid Fire:</b> R${rapidFireRating} — Fired ${rapidShots} shot(s)${rapidShots > 1 ? " (uses Cluster Hits table)" : ""}</div>`
  : "";

const jamInfoLine = (jam && !isAbomChat && !rack && rapidShots > 1)
  ? `<div><b>Jam Check:</b> Rolled ${jam.rollTotal ?? "?"} (2d6); jams on ${jam.threshold} or less → <b>${jam.jammed ? "JAMMED" : "OK"}</b></div>`
  : "";

  const weaponSummary = isTagAttack
    ? "TAG designation (no damage)"
    : isNarcAttack
      ? "Narc homing pod (no damage)"
    : isArrowIVHomingAttack
      ? `Arrow IV Homing (${hit ? "guided hit" : "ground impact"}), Damage ${damage}`
    : cluster
      ? (cluster.mode === "missile"
        ? `${cluster.type}-${cluster.rackSize} (cluster) — Missiles Hit ${cluster.missilesHit}, Total Damage ${damage}`
        : (cluster.mode === "volley"
            ? `${cluster.label ?? "Volley"} (${cluster.type}-${cluster.rackSize}) — Hits ${cluster.volleyHits}/${cluster.volleySize}, Total Damage ${damage}`
            : `${cluster.label ?? "Rapid Fire"} (cluster) — Shots Hit ${cluster.missilesHit}/${cluster.rackSize}, Total Damage ${damage}`))
      : `Damage ${damage}`;

  const weaponLine = `<div><b>Weapon</b>: ${weaponSummary}${(!isAbomChat && heat ? `, Heat ${heat}` : "")}</div>`;
  const dazzleInfoLine = dazzleMode
    ? `<div><b>Dazzle Mode:</b> Active${(!isVehicleAttacker && rawHeat !== heat) ? ` | Heat ${rawHeat} → ${heat}` : ""}${dazzleHalvesDamage ? ` | Damage ${rawBaseDamage} → ${baseDamage}` : ` | Full damage vs abominations`}</div>`
    : "";

  const clusterPacketsHtml = cluster ? (() => {
    const isMissile = cluster.mode === "missile";
    const isVolley = cluster.mode === "volley";
    const projWord = (isMissile || isVolley) ? "missiles" : "shots";
    const formatClusterModTag = (mod, modifiedTotal) => {
      const n = Number(mod);
      if (!Number.isFinite(n) || n === 0) return "";
      return ` ${n >= 0 ? "+" : ""}${n} = ${modifiedTotal}`;
    };
    const formatClusterRoll = (roll) => {
      const dice = Array.isArray(roll?.manualDice) ? roll.manualDice : null;
      const diceTag = dice?.length
        ? `: <span class="atow-dice-faces">${dice.map(d => `<span class="atow-die-face" title="d6: ${d}">${formatD6Face(d)}</span>`).join("<span class=\"atow-dice-plus\">+</span>")}</span>`
        : "";
      return `${roll?.total ?? "?"} (2d6${diceTag})`;
    };
    const streakTag = (isMissile && cluster.streakUsed)
      ? (cluster.ams?.active ? ` (Streak: AMS forces 7)` : ` (Streak: auto 12)`)
      : "";
    const artemisTag = (isMissile && !cluster.streakUsed)
      ? (cluster.clusterRollMod
          ? formatClusterModTag(cluster.clusterRollMod, cluster.clusterRollModifiedTotal)
          : (artemisInstalled ? " (Artemis not applied)" : ""))
      : "";

    const volleySummary = isVolley
      ? `<div>${cluster.label ?? "Volley"} Roll: ${formatClusterRoll(cluster.volleyRoll)} — Hits ${cluster.volleyHits}/${cluster.volleySize}</div>`
      : "";

    const volleySubLines = isVolley
      ? (cluster.subclusters ?? []).map((sc, idx) => {
          const modTag = formatClusterModTag(sc.clusterRollMod, sc.clusterRollModifiedTotal);
          return `<div>Attack ${idx + 1}: Cluster Roll ${formatClusterRoll(sc.clusterRoll)}${modTag} — Missiles Hit ${sc.missilesHit}</div>`;
        }).join("")
      : "";

    const extraLine = (!isMissile && !isVolley)
      ? `<div>${cluster.label ?? "Rapid Fire"}: Fired ${cluster.rackSize} shot(s) — Hits ${cluster.missilesHit}</div>`
      : "";

    const list = (cluster.packets ?? []).map(p => {
      const tacTag = (p?.tacFrom2 && p?.roll?.total === 2) ? " — <b>TAC check</b>" : "";
      const floatTag = p?.floating ? ` — Floating: 2 → ${String(p.floating.reroll.loc).toUpperCase()} (rolled ${p.floating.reroll.rollTotal})` : "";
      const vehicleCritTag = (isVehicleTarget && p?.vehicleCrit?.trigger) ? " — <b>Vehicle Critical</b>" : "";
      const coverTag = p?.partialCoverBlocked ? " — <b>Partial cover: leg hit ignored</b>" : "";
      const qty = p?.damageCluster ? `${p.damage} damage cluster` : (isMissile ? `${p.hits} ${projWord}` : `${p.hits} shot(s)`);
      const locLabel = Number.isFinite(p?.abomIndex) ? `ABOM ${p.abomIndex}` : String(p.loc).toUpperCase();
      const rollText = Number.isFinite(p?.abomIndex)
        ? ` (${qty})`
        : (isVehicleTarget
            ? ` (location roll ${p.roll.total}; ${qty}${vehicleCritTag})`
            : ` (location roll ${p.roll.total}; ${qty}${tacTag}${floatTag}${coverTag})`);
      return `<li>${p.damage} dmg to ${locLabel}${rollText}</li>`;
    }).join("");

    return `<div><b>Cluster Packets</b></div>` +
      (isMissile ? `<div>Cluster Roll: ${formatClusterRoll(cluster.clusterRoll)}${artemisTag}${streakTag}</div>` : "") +
      volleySummary +
      volleySubLines +
      extraLine +
      `<ul>${list}</ul>` +
      `<div><i>${clusterNote}</i></div>`;
  })() : "";
  const ammoModeLine = ammoKey ? `<div><b>Ammo Mode:</b> ${htmlEscape(ammoSelectionLabel)}</div>` : "";

  let parts = [
    `<div class="atow-chat-card atow-mech-attack">`,
    `<header><b>${weaponMeta.name}</b> — Attack</header>`,
    (weaponMeta.rawName && weaponMeta.rawName !== weaponMeta.name) ? `<div><small>Mounted as: ${weaponMeta.rawName}</small></div>` : "",
    buildAttackResultBanner({
      hit,
      detail: `Roll ${toHit.total} vs TN ${tn}`
    }),
    `<div><b>Attacker:</b> ${attackerName} | <b>Target:</b> ${targetName}</div>`,
    facingLine,
    firingArcLine,
    `<div><b>Distance:</b> ${distance} (${band})</div>`,
    `<div><b>Roll:</b> ${toHit.total} (${isArrowIVHomingAttack ? "2d6" : `2d6 + ${skillLabel} ${gunnery}`}) vs <b>TN:</b> ${tn} -> <b>${hit ? "HIT" : "MISS"}</b></div>`,
    buildAttackDetailsOpen(),
    `<hr/>`,
    `<div><b>Breakdown</b></div>`,
    `<ul>`,
    `<li>Base TN: ${isArrowIVHomingAttack ? "Arrow IV Homing 4+" : baseTN}</li>`,
    `<li>Range (${band}${minPenalty ? `, min +${minPenalty}` : ""}): +${rangeMod}</li>`,
    `<li>Attacker movement: +${attackerMoveMod}${(String(opts.attackerMoveMode ?? 'auto').toLowerCase() === 'auto') ? ` (auto: ${autoMove.mode.toUpperCase()}, moved ${autoMove.moved})` : ''}</li>`,
    `<li>Target movement: +${targetMoveMod}${Number.isFinite(opts.targetHexes) ? ` (entered: ${opts.targetHexes})` : ` (auto: moved ${autoTargetMove.moved})`}</li>`,
    `<li>Heat: +${heatFireMod}</li>`,
    `<li>Targeting Computer: ${tcModStr}</li>`,
    `<li>Aimed Shot: ${aimedEnabled ? aimedModStr : "+0"}${(aimedDetails.length) ? ` (${aimedDetails.join('; ')})` : ``}${(!aimedEnabled && aimedDisabledReason) ? ` (${aimedDisabledReason})` : ""}</li>`,
    `<li>Statuses: +${statusTNMods.total}${statusTNMods.details?.length ? ` (${statusTNMods.details.join('; ')})` : ''}</li>`,
    `<li>Environment: +${envTNMods.mod}${envTNMods.details?.length ? ` (${envTNMods.details.join('; ')})` : ''}</li>`,
    `<li>Intervening Woods: +${losWoodsMods.mod}${losWoodsMods.details?.length ? ` (${losWoodsMods.details.join('; ')})` : ''}</li>`,
    `<li>Partial Cover: +${terrainPartialCoverMod}${losCoverMods.details?.length ? ` (${losCoverMods.details.join('; ')})` : ''}</li>`,
    `<li>Terrain: +${terrainMod}</li>`,
    `<li>Weapon Accuracy: +${mrmTNMod}${mrmTNMod ? " (MRM unguided)" : ""}</li>`,
    `<li>Other: +${otherMod}</li>`,
    `</ul>`,
    `${weaponLine}`,
    `${dazzleInfoLine}`,
    `${rapidFireInfoLine}`,
    `${jamInfoLine}`,
    `${artemisInfoLine}`,
    `${narcInfoLine}`,
    `${specialMissileAmmoInfoLine}`,
    `${amsInfoLine}`,
    `${streakInfoLine}`,
    `${arrowIVInfoLine}`,
    `${ammoModeLine}`,
    `${ammoSpend?.key ? `<div><b>Ammo</b>: ${ammoSpend.after}/${ammoSpend.total} (${ammoSpend.key.toUpperCase()})</div>` : ""}`,
    `${isTagAttack ? `<div><b>TAG:</b> ${hit ? (tagApplied?.ok ? "Target marked with Tagged status until the TAG user's next turn." : `Hit, but status was not applied (${tagApplied?.reason ?? "unknown reason"}).`) : "No mark applied on miss."}</div>` : ""}`,
    `${isNarcAttack ? `<div><b>Narc:</b> ${!hit ? "No pod attached on miss." : (locResult?.partialCoverBlocked ? "Pod struck a location protected by partial cover and did not attach." : (narcApplied?.ok ? `Pod attached to ${String(narcApplied.loc ?? locResult?.loc ?? "unknown").toUpperCase()}; the status remains until that location is destroyed.` : `Hit, but pod was not attached (${narcApplied?.reason ?? "unknown reason"}).`))}</div>` : ""}`,
    `${clusterPacketsHtml}`,
  ];

  if (isAbomChat) {
    parts = parts.filter(line => !line.includes("Attacker movement:") && !line.includes("Heat:") && !line.includes("Aimed Shot:") && !line.includes("Targeting Computer:"));
  }

  if (locResult?.aim && !isAbomChat) {
    const a = locResult.aim;
    parts.push(`<div><b>Aimed Shot:</b> ${String(a.designated).toUpperCase()} — Aim Roll ${a.rollTotal} → <b>${a.used ? "DESIGNATED" : "NORMAL"}</b>${a.partialCoverReroll ? " (partial cover: legs re-rolled)" : ""}</div>`);
  }

  if (locResult && opts.showLocation) {
    parts.push(`<div><b>Hit Location:</b> ${locResult.loc.toUpperCase()} (rolled ${locResult.roll.total})</div>`);
    if (locResult.partialCoverBlocked) {
      parts.push(`<div><b>Partial Cover:</b> Leg hit ignored.</div>`);
    }

    if (isVehicleTarget && locResult.critTrigger) {
      parts.push(`<div><b>Vehicle Critical:</b> Triggered (${String(locResult.critTableLoc).toUpperCase()} table)</div>`);
    }

    if (locResult.floating) {
      const o = locResult.floating.original;
      const r = locResult.floating.reroll;
      parts.push(`<div><b>Floating Criticals:</b> Original roll was 2 (${String(o.loc).toUpperCase()}), rerolled to ${String(r.loc).toUpperCase()} (rolled ${r.rollTotal}).</div>`);
    }

    if (tacSingle && !cluster) {
      parts.push(`<div><b>TAC:</b> Through-Armor Critical check triggered (hit-location table roll was 2).</div>`);
    }
  }

  if (opts.showLocation && isAbomTarget) {
    const abomIdx = damageApplied?.result?.hitAbomination;
    if (Number.isFinite(abomIdx)) {
      parts.push(`<div><b>Hit Abomination:</b> ${abomIdx}</div>`);
    }
  }


  const renderCritEvents = (events = []) => {
    const evs = Array.isArray(events) ? events : [];
    const interesting = evs.filter(e => Boolean(e?.blownOff) || Number(e?.critCount ?? 0) > 0 || Boolean(e?.tac));
    if (!interesting.length) return "";

    const lines = interesting.map((e) => {
      const loc = String(e.loc ?? "?").toUpperCase();
      const tag = e.tac ? "TAC" : "Crit";
      if (e.blownOff) return `<li><b>${tag}</b>: ${loc} — Roll ${e.checkTotal} → <b>BLOWN OFF</b></li>`;
      const count = Number(e.critCount ?? 0);
      const picks = (e.crits ?? []).filter(c => c?.ok).map(c => `${String(c.label ?? "?")}`);
      const pickStr = picks.length ? ` — ${picks.join(", ")}` : "";
      return `<li><b>${tag}</b>: ${loc} — Roll ${e.checkTotal} → ${count} crit(s)${pickStr}</li>`;
    });

    return `<div><b>Criticals:</b><ul>${lines.join("")}</ul></div>`;
  };

  const renderVehicleCrit = (crit) => {
    if (!crit) return "";
    const labels = {
      none: "No Critical Hit",
      driverHit: "Driver Hit",
      commanderHit: "Commander Hit",
      crewKilled: "Crew Killed",
      sensors: "Sensor Hits",
      engineHit: "Engine Hit",
      stabilizer: "Stabilizer",
      turretJam: "Turret Jam",
      turretLocks: "Turret Locks",
      turretBlownOff: "Turret Blown Off",
      ammunition: "Ammunition Hit",
      fuelTank: "Fuel Tank",
      weaponMalfunction: "Weapon Malfunction",
      weaponDestroyed: "Weapon Destroyed",
      cargoInfantry: "Cargo/Infantry Hit",
      crewStunned: "Crew Stunned"
    };
    const label = labels[crit.resultKey] ?? String(crit.resultKey ?? "Critical");
    const lines = [
      `<li><b>Table:</b> ${String(crit.table ?? "?").toUpperCase()} — Roll ${crit.roll?.total ?? "?"} — ${label}</li>`
    ];
    if (crit.notes?.length) lines.push(`<li><b>Notes:</b> ${crit.notes.join(", ")}</li>`);
    if (crit.motive) {
      const m = crit.motive;
      lines.push(`<li><b>Motive Damage:</b> Roll ${m.baseTotal} + ${m.mod} = ${m.total} — ${m.effect}</li>`);
    }
    return `<div><b>Vehicle Critical:</b><ul>${lines.join("")}</ul></div>`;
  };

  const renderVehicleCrits = (crits = []) => {
    const items = (Array.isArray(crits) ? crits : []).filter(Boolean);
    if (!items.length) return "";
    return items.map(renderVehicleCrit).filter(Boolean).join("");
  };


  if (opts.applyDamage && damageApplied) {
    if (damageApplied.type === "error") {
      parts.push(`<div style="color:#c00"><b>Damage Apply Error:</b> ${damageApplied.error ?? "Unknown error"}</div>`);
    } else if (damageApplied.type === "single") {
      const r = damageApplied.result;
      if (r?.ok) {
        if (r?.partialCoverBlocked) {
          parts.push(`<div><b>Damage Ignored:</b> Partial cover blocked the leg hit.</div>`);
        } else if (isAbomTarget) {
          const hitIdx = Number.isFinite(r.hitAbomination) ? r.hitAbomination : "?";
          parts.push(`<div><b>Damage Applied:</b> ${r.damage} to Abomination ${hitIdx}</div>`);
        } else if (isVehicleTarget) {
          parts.push(`<div><b>Damage Applied:</b> ${damage} to ${String(r.loc).toUpperCase()} — Armor ${r.armorApplied}, Structure ${r.structureApplied}${r.overflow ? ` (Overflow ${r.overflow})` : ""}</div>`);
          const vehicleCritHtml = renderVehicleCrit(r.vehicleCrit);
          if (vehicleCritHtml) parts.push(vehicleCritHtml);
        } else if (isDropshipTarget) {
          parts.push(`<div><b>Damage Applied:</b> ${damage} to ${String(r.loc).toUpperCase()} — Armor ${r.armorApplied}, SI ${r.structureApplied}${r.overflow ? ` (Overflow ${r.overflow})` : ""}</div>`);
        } else {
          parts.push(`<div><b>Damage Applied:</b> ${r.damage} to ${String(r.hitLoc).toUpperCase()} → Armor ${r.armorApplied}, Structure ${r.structureApplied}${r.overflow ? ` (Overflow ${r.overflow})` : ""}</div>`);
          const critHtml = renderCritEvents(r.critEvents);
          if (critHtml) parts.push(critHtml);
        }
      } else {
        parts.push(`<div style="color:#c00"><b>Damage NOT Applied:</b> ${r?.reason ?? "Unknown reason"}</div>`);
      }
    } else if (damageApplied.type === "cluster") {
      const failures = damageApplied.results?.filter(x => x?.result?.ok === false) ?? [];
      if (failures.length) {
        parts.push(`<div style="color:#c00"><b>Damage NOT Fully Applied:</b> ${failures[0].result?.reason ?? "Unknown reason"}</div>`);
      } else {
        parts.push(`<div><b>Damage Applied:</b> ${damageApplied.results.length} packet(s) applied to target.</div>`);
        if (isVehicleTarget) {
          const vehicleCrits = (damageApplied.results ?? []).map(p => p?.result?.vehicleCrit).filter(Boolean);
          const vehicleCritHtml = renderVehicleCrits(vehicleCrits);
          if (vehicleCritHtml) parts.push(vehicleCritHtml);
        } else if (!isDropshipTarget) {
          const allCritEvents = (damageApplied.results ?? []).flatMap(p => p?.result?.critEvents ?? []);
          const critHtml = renderCritEvents(allCritEvents);
          if (critHtml) parts.push(critHtml);
        }
      }
    }
  }

  if (massiveDamagePsr?.required) {
    parts.push(`<div><b>Massive Damage PSR:</b> ${massiveDamagePsr.success ? "Passed" : "Failed - target fell prone."}</div>`);
  }

  parts.push(`</div></details></div>`);

  try {
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: parts.join(""),
      flavor: `${weaponMeta.name} Attack`,
      rolls: [toHit],
      type: CONST.CHAT_MESSAGE_TYPES.ROLL,
      flags: weaponMeta.flags
});
  } catch (err) {
    // Some modules hook ChatMessage creation and can throw; don't block the attack/damage pipeline.
    console.warn("AToW Battletech | ChatMessage creation failed (attack already resolved)", err);
    ui?.notifications?.warn?.("Attack resolved, but the chat card could not be created (see console).");
  }

  // Trigger Automated Animations directly (if installed)
  await _maybePlayAutomatedAnimation(attackerToken, weaponItem, weaponMeta, { targetToken, hit });

  return {
    baseTN,
    tn,
    toHit,
    hit,
    distance,
    band,
    rangeMod,
    attackerMoveMod,
    targetMoveMod,
    heatFireMod,
    statusMods: statusTNMods,
    environmentMods: envTNMods,
    losWoodsMods,
    losCoverMods,
    terrainMod,
    otherMod,
    gunnery,
    heat,
    damage,
    baseDamage,
    isTagAttack,
    isArrowIVHomingAttack,
    tagApplied,
    side,
    arc,
    locResult,
    cluster,
    ammoSpend,
    damageApplied,
    massiveDamagePsr,
    attackerTokenId: attackerToken?.id,
    targetTokenId: targetToken?.id
  };
}

async function scheduleArrowIVIndirectAttack(actor, weaponItem, opts = {}) {
  if (!actor || !weaponItem) return null;
  weaponItem = await _resolveWeaponItem(actor, weaponItem);
  if (!isArrowIVSystemWeapon(weaponItem)) return null;

  if (!game.combat?.started) {
    ui?.notifications?.warn?.("Arrow IV indirect fire requires an active combat.");
    return { ok: false, blocked: true, reason: "noCombat" };
  }
  if (await isWeaponDestroyedForAttack(actor, weaponItem, opts)) {
    ui?.notifications?.warn?.(`${weaponItem?.name ?? "This weapon"} is destroyed and cannot be fired.`);
    return { ok: false, blocked: true, reason: "destroyedWeapon" };
  }
  if (hasWeaponFiredThisTurn(actor, weaponItem, opts)) {
    ui?.notifications?.warn?.(`${weaponItem?.name ?? "This weapon"} has already been fired this turn.`);
    return { ok: false, blocked: true, reason: "alreadyFiredThisTurn" };
  }

  const attackerToken = opts.attackerToken ?? getAttackerToken(actor);
  if (!attackerToken) {
    ui?.notifications?.warn?.("Place/control your attacker token on the scene before making an indirect Arrow IV attack.");
    return null;
  }
  const attackerCenter = getTokenCenter(attackerToken);
  if (!attackerCenter) {
    ui?.notifications?.warn?.("Couldn't determine the attacker's hex.");
    return null;
  }

  const ammoKey = ammoKeyFromTypeLabel("Arrow IV Homing");
  const { totals } = await ensureActorAmmoBins(actor);
  const bins = actor.system?.ammoBins ?? {};
  const bin = bins?.[ammoKey];
  const total = num(bin?.total, totals.get(ammoKey)?.total ?? 0);
  const cur = Number.isFinite(Number(bin?.current)) ? num(bin.current, total) : total;
  if (!bin && !totals.has(ammoKey)) {
    ui?.notifications?.error?.("Arrow IV indirect fire requires Ammo (Arrow IV Homing).");
    return { ok: false, blocked: true, reason: "missingArrowIVHomingAmmo" };
  }
  if (cur < 1) {
    ui?.notifications?.error?.("No Arrow IV Homing ammo remaining.");
    return { ok: false, blocked: true, reason: "noArrowIVHomingAmmo" };
  }

  let designatedPoint = opts.designatedPoint ?? null;
  while (!designatedPoint) {
    ui?.notifications?.info?.(`Arrow IV indirect fire: click a target hex more than ${ARROW_IV_INDIRECT_MIN_HEXES} hexes away. Right-click to cancel.`);
    const picked = await pickCanvasPointOnce();
    if (!picked) return null;
    const center = getGridCenterForPoint(picked);
    const distance = measurePointDistance(attackerCenter, center);
    if (!Number.isFinite(distance)) {
      ui?.notifications?.warn?.("Couldn't measure distance to that hex.");
      continue;
    }
    if (distance <= ARROW_IV_INDIRECT_MIN_HEXES) {
      ui?.notifications?.warn?.(`Arrow IV indirect fire must target a hex more than ${ARROW_IV_INDIRECT_MIN_HEXES} hexes away. That hex is ${distance} away.`);
      continue;
    }
    designatedPoint = center;
  }

  const designatedDistance = measurePointDistance(attackerCenter, designatedPoint);
  if (!Number.isFinite(designatedDistance) || designatedDistance <= ARROW_IV_INDIRECT_MIN_HEXES) {
    ui?.notifications?.warn?.(`Arrow IV indirect fire must target a hex more than ${ARROW_IV_INDIRECT_MIN_HEXES} hexes away.`);
    return { ok: false, blocked: true, reason: "targetTooClose" };
  }
  if (!game.user?.isGM && !getATOWSocket()) {
    ui?.notifications?.error?.("AToW socket is not ready, so the GM cannot schedule this indirect strike.");
    return { ok: false, blocked: true, reason: "socketNotReady" };
  }

  let ammoSpend = null;
  if (opts.spendAmmo !== false && weaponConsumesAmmo(weaponItem, actor, { ammoKey: opts.ammoKey })) {
    ammoSpend = await spendAmmoIfApplicable(actor, weaponItem, 1, { ammoKey: opts.ammoKey });
    if (ammoSpend?.ok === false) {
      ui?.notifications?.error?.(ammoSpend.reason || `No ammo remaining for ${ammoSpend.name || "this weapon"}.`);
      return null;
    }
  }

  const isVehicleAttacker = isVehicleActor(actor);
  const heat = isVehicleAttacker ? 0 : num(weaponItem.system?.heat, 0);
  if (!isVehicleAttacker && opts.applyHeat !== false && heat) {
    const heatActor = attackerToken?.actor ?? actor;
    const addActorPendingHeat = game?.[SYSTEM_ID]?.api?.addActorPendingHeat ?? null;
    if (typeof addActorPendingHeat === "function") {
      await addActorPendingHeat(heatActor, heat);
    } else {
      const curHeat = num((heatActor.system?.heat?.value ?? heatActor.system?.heat?.current), 0);
      const barMax = num(heatActor.system?.heat?.max, 30);
      const next = clamp(curHeat + heat, 0, HEAT_HARD_CAP);
      await heatActor.update({
        "system.heat.value": next,
        "system.heat.current": next,
        "system.heat.unvented": next,
        "system.heat.effects.unvented": next,
        "system.heat.max": barMax
      });
    }
  }

  await markWeaponFiredThisTurn(actor, weaponItem, opts);
  await playArrowIVLaunchEffects(attackerToken);

  const combat = game.combat;
  const attackerTokenDoc = attackerToken?.document ?? attackerToken;
  const attackerCombatant = combat?.combatants?.find?.(c => {
    const tokenId = String(c?.tokenId ?? c?.token?.id ?? "");
    const actorId = String(c?.actorId ?? c?.actor?.id ?? "");
    return (attackerTokenDoc?.id && tokenId === String(attackerTokenDoc.id)) ||
      (actor?.id && actorId === String(actor.id));
  }) ?? combat?.combatant ?? null;
  const offset = getGridOffsetForPoint(designatedPoint);
  const gridKey = getGridKeyForPoint(designatedPoint);
  const strike = {
    id: buildArrowIVStrikeId(),
    type: "arrowIVIndirect",
    action: "weaponAttack",
    weaponAttack: true,
    attackMode: "arrowIVIndirectLaunch",
    combatId: combat?.id ?? null,
    sceneId: canvas?.scene?.id ?? null,
    attackerActorId: actor?.id ?? null,
    attackerActorUuid: actor?.uuid ?? null,
    attackerTokenId: attackerTokenDoc?.id ?? null,
    attackerTokenUuid: attackerTokenDoc?.uuid ?? null,
    attackerCombatantId: attackerCombatant?.id ?? null,
    attackerName: attackerToken?.name ?? actor.name,
    weaponName: weaponItem.name ?? "Arrow IV System",
    weaponUuid: weaponItem.uuid ?? null,
    firedRound: combat?.round ?? 0,
    firedTurn: combat?.turn ?? 0,
    gridKey,
    hex: offset,
    hexLabel: offset ? `${offset.i}, ${offset.j}` : gridKey,
    point: { x: designatedPoint.x, y: designatedPoint.y },
    distance: designatedDistance
  };

  const scheduled = await scheduleArrowIVIndirectStrikeAuto(canvas?.scene ?? game.scenes?.active, strike);
  if (scheduled?.ok === false) {
    ui?.notifications?.error?.(`Could not schedule Arrow IV indirect strike: ${scheduled.reason ?? "unknown reason"}`);
    return scheduled;
  }

  const weaponMeta = _getWeaponAutomationMeta(weaponItem);
  const chatFlags = foundry.utils.mergeObject(weaponMeta.flags ?? {}, {
    [SYSTEM_ID]: {
      action: "weaponAttack",
      weaponAttack: true,
      attackMode: "arrowIVIndirectLaunch",
      indirect: true,
      strikeId: strike.id
    }
  }, { inplace: false });
  const ammoLine = ammoSpend?.key ? `<div><b>Ammo</b>: ${ammoSpend.after}/${ammoSpend.total} (${ammoSpend.key.toUpperCase()})</div>` : "";
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: [
      `<div class="atow-chat-card atow-mech-attack">`,
      `<header><b>${weaponMeta.name}</b> - Indirect Fire</header>`,
      `<div><b>Attacker:</b> ${strike.attackerName}</div>`,
      `<div><b>Designated Hex:</b> ${strike.hexLabel} (${designatedDistance} hexes)</div>`,
      `<div>Impact will resolve at the start of this attacker's next turn in the following round.</div>`,
      ammoLine,
      `</div>`
    ].join(""),
    flavor: `${weaponMeta.name} Indirect Fire`,
    flags: chatFlags
  }).catch(err => console.warn("AToW Battletech | Arrow IV indirect scheduling chat failed", err));

  return { ok: true, indirect: true, strike, ammoSpend };
}


// ------------------------------------------------------------
// Melee Weapons (Hatchet, Sword, etc.)
// ------------------------------------------------------------

function isCanonicalHatchet(itemOrName) {
  const name = typeof itemOrName === "string" ? itemOrName : (itemOrName?.name ?? "");
  return String(name).trim().toLowerCase() === "hatchet";
}

function isCanonicalSword(itemOrName) {
  const name = typeof itemOrName === "string" ? itemOrName : (itemOrName?.name ?? "");
  return String(name).trim().toLowerCase() === "sword";
}

/** Derive the canonical Hatchet statistics from its carrier's BattleMech tonnage. */
export function getHatchetProfile(actor) {
  const mechTonnage = Math.max(0, Number(getMechTonnage(actor) ?? 0) || 0);
  const tons = mechTonnage > 0 ? Math.ceil(mechTonnage / 15) : 0;
  return {
    mechTonnage,
    damage: mechTonnage > 0 ? Math.floor(mechTonnage / 5) : 0,
    tonnage: tons,
    critSlots: tons
  };
}

/** Derive the canonical Sword statistics from its carrier's BattleMech tonnage. */
export function getSwordProfile(actor) {
  const mechTonnage = Math.max(0, Number(getMechTonnage(actor) ?? 0) || 0);
  return {
    mechTonnage,
    damage: mechTonnage > 0 ? (Math.ceil(mechTonnage / 10) + 1) : 0,
    tonnage: mechTonnage > 0 ? Math.ceil(mechTonnage / 20) : 0,
    critSlots: mechTonnage > 0 ? Math.ceil(mechTonnage / 15) : 0
  };
}

function isMeleeWeaponItem(weaponItem) {
  const name = String(weaponItem?.name ?? "").toLowerCase();
  const sys = weaponItem?.system ?? {};
  const kind = String(sys.type ?? sys.category ?? sys.weaponType ?? sys.attackType ?? "").toLowerCase();

  // Exclude built-in physical attacks (handled elsewhere)
  if (name.includes("punch") || name.includes("kick")) return false;
  if (kind.includes("punch") || kind.includes("kick")) return false;

  // Heuristics: explicit melee/physical category, or common melee names.
  if (kind.includes("melee") || kind.includes("physical") || kind.includes("hand to hand")) return true;
  if (name.includes("hatchet") || name.includes("sword")) return true;

  // Some item packs store "Melee" in a dedicated field.
  const mode = String(sys.mode ?? sys.attackMode ?? "").toLowerCase();
  if (mode.includes("melee") || mode.includes("physical")) return true;

  return false;
}

function getMeleeWeaponTNMod(weaponItem) {
  const name = String(weaponItem?.name ?? "").toLowerCase();
  const sys = weaponItem?.system ?? {};

  // AToW physical weapon modifiers
  if (name.includes("hatchet")) return -1;
  if (name.includes("sword")) return -2;

  // Optional generic per-weapon modifier fields (if you ever add them)
  return num(sys.tnMod ?? sys.toHitMod ?? sys.attackMod ?? 0, 0);
}

/**
 * Core melee-weapon roll: 2d6 + Piloting vs TN (>= TN hits)
 * - Base TN: 8 + modifiers (AToW)
 * - Hatchet: -1 TN, Sword: -2 TN
 * - Adjacent only (range 1)
 * - Hit location: normal shooting table (2d6) by default OR punch table (1d6) with +4 TN
 */
export async function rollMeleeWeaponAttack(actor, weaponItem, opts = {}) {
  if (!actor || !weaponItem) return null;
  // Resolve to an actual embedded Item when possible (module compatibility)
  weaponItem = await _resolveWeaponItem(actor, weaponItem);


  const attackerToken = opts.attackerToken ?? getAttackerToken(actor);
  const targetToken = opts.targetToken ?? getSingleTargetToken();

  if (!targetToken) {
    ui?.notifications?.warn?.("Select exactly 1 target token before making an attack.");
    return null;
  }
  if (!attackerToken) {
    ui?.notifications?.warn?.("Place/control your mech token on the scene before making an attack.");
    return null;
  }

  const targetActor = targetToken?.actor;
  const isVehicleTarget = isVehicleActor(targetActor);
  const hasVehicleTurret = isVehicleTarget && (num(targetActor?.system?.armor?.turret?.max, 0) > 0);

  // Heat shutdown prevents all attacks
  const isShutdown = Boolean(actor.system?.heat?.shutdown) || Boolean(attackerToken?.document?.getFlag?.(SYSTEM_ID, "shutdown"));
  if (isShutdown) {
    ui?.notifications?.warn?.("This mech is shut down due to heat and cannot attack.");
    return null;
  }

  const distance = Number.isFinite(opts.distance) ? num(opts.distance, 0) : measureTokenDistance(attackerToken, targetToken);
  if (distance === null) {
    ui?.notifications?.warn?.("Couldn't measure distance (no canvas/grid?).");
    return null;
  }
  if (distance > 1) {
    ui?.notifications?.warn?.("Melee weapon attacks require the target to be adjacent (range 1).");
    return null;
  }

  const pilot = actor.system?.pilot ?? {};
  const piloting = num(pilot.piloting, 0);
  if (!piloting) ui?.notifications?.warn?.("No Piloting skill found on this mech (system.pilot.piloting). Using 0.");

  const autoMove = getAutoAttackerMoveMod(actor, attackerToken);
  const attackerMoveMod = Number.isFinite(opts.attackerMoveMod)
    ? num(opts.attackerMoveMod, 0)
    : (() => {
        const mode = String(opts.attackerMoveMode ?? "auto").toLowerCase();
        if (mode === "auto" || mode === "sheet" || mode === "token") return autoMove.mod;
        switch (mode) {
          case "walk": return 1;
          case "run": return 2;
          case "jump": return 3;
          case "stationary":
          default: return 0;
        }
      })();

  const autoTargetMove = getAutoTargetMoveData(targetToken);
  const targetHexesUsed = Number.isFinite(opts.targetHexes) ? num(opts.targetHexes, 0) : autoTargetMove.moved;
  const targetMoveMod = Number.isFinite(opts.targetMoveMod) ? num(opts.targetMoveMod, 0) : calcTargetMoveModFromHexes(targetHexesUsed);

  const terrainMod = num(opts.terrainMod, 0);
  const otherMod = num(opts.otherMod, 0);

  const statusTNMods = getStatusTNMods(attackerToken, targetToken);

  // Base TN is 8 (AToW)
  const baseTN = 8;

  const weaponTNMod = getMeleeWeaponTNMod(weaponItem);
  const usePunchTable = Boolean(opts.usePunchTable) && !isVehicleTarget;

  // Determine arc side from target facing unless explicitly provided
  const arc = getTargetSideFromFacing(attackerToken, targetToken);
  const side = (opts.side && ["front", "rear", "left", "right"].includes(opts.side)) ? opts.side : (arc?.side ?? "front");
  // Optional rule toggle: floating TAC criticals (see TAC rules). Off by default.
  const floatingCrits = Boolean(opts.floatingCrits);


  const targetType = String(opts.targetType ?? "biped").toLowerCase() === "quad" ? "quad" : "biped";

  const punchTableMod = usePunchTable ? 4 : 0;

  const tn = baseTN + attackerMoveMod + targetMoveMod + statusTNMods.total + terrainMod + otherMod + weaponTNMod + punchTableMod;

  const toHit = await (new Roll(`2d6 + ${piloting}`)).evaluate();
  const hit = (toHit.total ?? 0) >= tn;

  const hatchetProfile = isCanonicalHatchet(weaponItem) ? getHatchetProfile(actor) : null;
  const swordProfile = isCanonicalSword(weaponItem) ? getSwordProfile(actor) : null;
  const derivedMeleeProfile = hatchetProfile ?? swordProfile;
  let damage = derivedMeleeProfile ? derivedMeleeProfile.damage : num(weaponItem.system?.damage, 0);
  if (isTSMActive(actor)) damage = damage * 2;

  let locResult = null;
  let tacMelee = false;
  let damageApplied = null;
  let massiveDamagePsr = null;

  if (hit && (opts.showLocation || opts.applyDamage)) {
    if (isVehicleTarget) {
      locResult = await rollVehicleHitLocation(side, { hasTurret: hasVehicleTurret });
    } else if (usePunchTable) {
      locResult = await rollPunchHitLocation({ targetActor, side, targetType });
    } else {
      locResult = await rollHitLocation(side);
      locResult.loc = _normalizeDamageLocation(targetActor, locResult.loc);

      // TAC: only applies when using the standard Hit Location Table (not the Punch table).
      if ((locResult?.roll?.total ?? 0) === 2) {
        tacMelee = true;
        if (floatingCrits) {
          const reroll = await rollHitLocation(side);
          locResult = {
            roll: reroll.roll,
            loc: _normalizeDamageLocation(targetActor, reroll.loc),
            floating: {
              original: { loc: locResult.loc, rollTotal: 2 },
              reroll: { loc: reroll.loc, rollTotal: reroll?.roll?.total ?? 0 }
            }
          };
        }
      }
    }
  }

  if (hit && opts.applyDamage && targetActor && locResult?.loc) {
    try {
      let r;
      if (isVehicleTarget) {
        const crit = locResult?.critTrigger ? { trigger: true, tableLoc: locResult.critTableLoc } : null;
        r = await applyDamageToVehicleActorAuto(targetActor, locResult.loc, damage, { attackSide: side, crit });
      } else {
        r = await applyDamageToTargetActorAuto(targetActor, locResult.loc, damage, { side, tac: tacMelee, tacLoc: locResult.loc });
      }
      damageApplied = r;
    } catch (err) {
      console.warn("AToW Battletech | Melee weapon damage application threw", err);
      damageApplied = { ok: false, reason: String(err?.message ?? err) };
    }
  }

  if (!isVehicleTarget && isMechActor(targetActor) && hit && damage >= 20 && damageApplied?.ok) {
    massiveDamagePsr = await resolveMassiveDamagePSR(targetToken, damage, { source: weaponItem?.name ?? "Melee weapon attack" });
  }

  // Chat card
  try {
    const attackerName = attackerToken?.name ?? actor.name;
    const targetName = targetToken?.name ?? "Target";
    const weaponMeta = _getWeaponAutomationMeta(weaponItem);

    // Artemis guidance is missile-only and never applies to melee weapons.
    const artemisInfoLine = "";
    const header = `<header><b>${weaponMeta.name}</b> — Melee Weapon Attack</header>`;
    const facingLine = arc
      ? `<div><b>Target Facing:</b> ${Math.round(arc.facingDeg)}° | <b>Attack Arc:</b> ${side.toUpperCase()}</div>`
      : `<div><b>Attack Arc:</b> ${side.toUpperCase()} (no facing data found)</div>`;

    const lines = [
      `<div class="atow-chat-card atow-mech-attack">`,
      header,
      buildAttackResultBanner({
        hit,
        detail: `Roll ${toHit.total} vs TN ${tn}`
      }),
      `<div><b>Attacker:</b> ${attackerName} | <b>Target:</b> ${targetName}</div>`,
      facingLine,
      `<div><b>Distance:</b> ${distance} (adjacent)</div>`,
      `${hatchetProfile ? `<div><b>Hatchet Profile:</b> ${hatchetProfile.mechTonnage}-ton carrier; Damage ${hatchetProfile.damage}, Weight ${hatchetProfile.tonnage} tons, ${hatchetProfile.critSlots} critical slots</div>` : ""}`,
      `${swordProfile ? `<div><b>Sword Profile:</b> ${swordProfile.mechTonnage}-ton carrier; Damage ${swordProfile.damage}, Weight ${swordProfile.tonnage} tons, ${swordProfile.critSlots} critical slots</div>` : ""}`,
      `<div><b>Hit Location:</b> ${isVehicleTarget ? "Vehicle Hit Location Table" : (usePunchTable ? `Punch Table (+${punchTableMod} TN)` : "Normal (Shooting) Table")}</div>`,
      `<div><b>Roll:</b> ${toHit.total} (2d6 + Piloting ${piloting}) vs <b>TN:</b> ${tn} → <b>${hit ? "HIT" : "MISS"}</b></div>`,
      buildAttackDetailsOpen(),
      `<hr/>`,
      `<div><b>Breakdown</b></div>`,
      `<ul>`,
      `<li>Base TN: ${baseTN}</li>`,
      `<li>Weapon Mod: ${weaponTNMod >= 0 ? "+" : ""}${weaponTNMod} (${String(weaponItem.name).toLowerCase().includes("hatchet") ? "Hatchet" : String(weaponItem.name).toLowerCase().includes("sword") ? "Sword" : "Melee"})</li>`,
      `${usePunchTable ? `<li>Punch-table called shot: +${punchTableMod}</li>` : ""}`,
      `<li>Attacker movement: +${attackerMoveMod}${(String(opts.attackerMoveMode ?? 'auto').toLowerCase() === 'auto') ? ` (auto: ${autoMove.mode.toUpperCase()}, moved ${autoMove.moved})` : ''}</li>`,
      `<li>Target movement: +${targetMoveMod}${Number.isFinite(opts.targetHexes) ? ` (entered: ${opts.targetHexes})` : ` (auto: moved ${autoTargetMove.moved})`}</li>`,
      `<li>Statuses: +${statusTNMods.total}${statusTNMods.details?.length ? ` (${statusTNMods.details.join('; ')})` : ''}</li>`,
      `<li>Terrain: +${terrainMod}</li>`,
      `<li>Other: +${otherMod}</li>`,
      `</ul>`,
      `${hit ? `<div><b>Damage:</b> ${damage}</div>` : ""}`,
      `${hit && locResult?.loc ? `<div><b>Hit Location:</b> ${String(locResult.loc).toUpperCase()} (roll ${locResult.roll.total})</div>` : ""}`,
      `${(opts.applyDamage && hit && damageApplied)
        ? (damageApplied.ok
            ? (isVehicleTarget
                ? `<div><b>Applied:</b> ${String(damageApplied.loc).toUpperCase()} — Armor ${damageApplied.armorApplied}, Structure ${damageApplied.structureApplied}${damageApplied.overflow ? ` (Overflow ${damageApplied.overflow})` : ""}</div>${damageApplied.vehicleCrit ? `<div><b>Vehicle Critical:</b> Roll ${damageApplied.vehicleCrit.roll?.total ?? "?"}</div>` : ""}`
                : `<div><b>Applied:</b> Armor ${damageApplied.armorApplied}, Structure ${damageApplied.structureApplied}</div>`)
            : `<div style="color:#c00"><b>NOT applied:</b> ${damageApplied.reason}</div>`)
        : ""}`,
      `${massiveDamagePsr?.required ? `<div><b>Massive Damage PSR:</b> ${massiveDamagePsr.success ? "Passed" : "Failed - target fell prone."}</div>` : ""}`,
      `</div></details></div>`
    ];

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: lines.join(""),
      flavor: `${weaponMeta.name} Melee Attack`,
      rolls: [toHit],
      type: CONST.CHAT_MESSAGE_TYPES.ROLL,
      flags: weaponMeta.flags
    }).catch(()=>{});
  } catch (err) {
    console.warn("AToW Battletech | Melee weapon chat card failed", err);
  }

  // Trigger Automated Animations directly (if installed)
  await _maybePlayAutomatedAnimation(attackerToken, weaponItem, _getWeaponAutomationMeta(weaponItem), { targetToken, hit });

  return {
    baseTN,
    tn,
    toHit,
    hit,
    distance,
    side,
    arc,
    piloting,
    attackerMoveMod,
    targetMoveMod,
    statusMods: statusTNMods,
    terrainMod,
    otherMod,
    weaponTNMod,
    usePunchTable,
    punchTableMod,
    targetType,
    damage,
    locResult,
    damageApplied,
    massiveDamagePsr,
    attackerTokenId: attackerToken?.id,
    targetTokenId: targetToken?.id
  };
}

export async function promptAndRollMeleeWeaponAttack(actor, weaponItem, { defaultSide = "front" } = {}) {
  const attackerToken = getAttackerToken(actor);
  const targetToken = getSingleTargetToken();

  if (!targetToken) {
    ui?.notifications?.warn?.("Select exactly 1 target token before making an attack.");
    return null;
  }
  if (!attackerToken) {
    ui?.notifications?.warn?.("Place/control your mech token on the scene before making an attack.");
    return null;
  }

  const distance = measureTokenDistance(attackerToken, targetToken);
  if (distance === null) {
    ui?.notifications?.warn?.("Couldn't measure distance (no canvas/grid?).");
    return null;
  }
  if (distance > 1) {
    ui?.notifications?.warn?.("Melee weapon attacks require the target to be adjacent (range 1).");
    return null;
  }

  const arc = getTargetSideFromFacing(attackerToken, targetToken);
  const computedSide = arc?.side ?? defaultSide;

  const autoTargetMove = getAutoTargetMoveData(targetToken);
  const statusTNMods = getStatusTNMods(attackerToken, targetToken);
  const weaponTNMod = getMeleeWeaponTNMod(weaponItem);

  const dialogHtml = `
  <form class="atow-attack-dialog">
    <div class="form-group">
      <label>Target</label>
      <div><b>${targetToken.name}</b></div>
    </div>

    <div class="form-group">
      <label>Distance</label>
      <div>${distance} (adjacent)</div>
      <input type="hidden" name="distance" value="${distance}"/>
    </div>

    <div class="form-group">
      <label>Weapon TN Modifier</label>
      <div><b>${weaponTNMod >= 0 ? "+" : ""}${weaponTNMod}</b></div>
      <small>Hatchet −1 TN, Sword −2 TN.</small>
    </div>

    <div class="form-group">
      <label>Hit Location Table</label>
      <select name="locTable">
        <option value="normal" selected>Normal (Shooting) Table</option>
        <option value="punch">Punch Table (+4 TN)</option>
      </select>
      <small>Punch-table option adds +4 TN (in addition to weapon modifier).</small>
    </div>

    <div class="form-group">
      <label>Target Type (for Punch Table)</label>
      <select name="targetType">
        <option value="biped" selected>Biped</option>
        <option value="quad">Quad</option>
      </select>
    </div>

    <div class="form-group">
      <label>Auto status mods</label>
      <div><small>Applied automatically: +${statusTNMods.total} (${statusTNMods.details.join("; ") || "none"})</small></div>
    </div>

    <div class="form-group">
      <label>Attacker Move</label>
      <select name="attackerMoveMode">
        <option value="auto" selected>Auto (from movement)</option>
        <option value="stationary">Stationary</option>
        <option value="walk">Walk (+1)</option>
        <option value="run">Run (+2)</option>
        <option value="jump">Jump (+3)</option>
      </select>
    </div>

    <div class="form-group">
      <label>Target Hexes Moved</label>
      <input type="number" name="targetHexes" value="${autoTargetMove.moved}" min="0"/>
      <small>Auto-filled from target displacement this turn. Override if needed.</small>
    </div>

    <div class="form-group">
      <label>Terrain Mod</label>
      <input type="number" name="terrainMod" value="0"/>
    </div>

    <div class="form-group">
      <label>Other Mod</label>
      <input type="number" name="otherMod" value="0"/>
    </div>


    
    <div class="form-group">
      <label>Hit Side (auto-detected)</label>
      <select name="side">
        <option value="front" ${computedSide === "front" ? "selected" : ""}>Front</option>
        <option value="rear"  ${computedSide === "rear" ? "selected" : ""}>Rear</option>
        <option value="left"  ${computedSide === "left" ? "selected" : ""}>Left</option>
        <option value="right" ${computedSide === "right" ? "selected" : ""}>Right</option>
      </select>
      <small>${arc ? `Target facing ${Math.round(arc.facingDeg)}° → arc ${computedSide.toUpperCase()}` : `No facing data found; defaulting to ${computedSide.toUpperCase()}`}</small>
    </div>

    <div class="form-group">
      <label><input type="checkbox" name="applyDamage" checked/> Apply Damage (auto)</label>
    </div>

    <div class="form-group">
      <label><input type="checkbox" name="showLocation" checked/> Roll Hit Location on Hit</label>
    </div>
  </form>`;

  return new Promise((resolve) => {
    new Dialog({
      title: `${weaponItem.name} — Melee Weapon Attack`,
      content: dialogHtml,
      buttons: {
        roll: {
          icon: '<i class="fas fa-dice"></i>',
          label: "Roll",
          callback: async (html) => {
            const form = html[0].querySelector("form.atow-attack-dialog");
            const fd = new FormData(form);

            const opts = {
              attackerToken,
              targetToken,
              distance: num(fd.get("distance"), 0),
              attackerMoveMode: String(fd.get("attackerMoveMode") ?? "auto"),
              targetHexes: num(fd.get("targetHexes"), 0),
              terrainMod: num(fd.get("terrainMod"), 0),
              otherMod: num(fd.get("otherMod"), 0),
              side: String(fd.get("side") ?? computedSide),
              targetType: String(fd.get("targetType") ?? "biped"),
              usePunchTable: String(fd.get("locTable") ?? "normal") === "punch",
              applyDamage: fd.get("applyDamage") === "on",
              showLocation: fd.get("showLocation") === "on"
            };

            const result = await rollMeleeWeaponAttack(actor, weaponItem, opts);
            resolve(result);
          }
        },
        cancel: {
          label: "Cancel",
          callback: () => resolve(null)
        }
      },
      default: "roll"
    }).render(true);
  });
}

/**
 * Convenience UI: requires 1 targeted token, auto-measures distance, then prompts for the remaining mods.
 * Defaults "Hit Side" to the computed attack arc (from target facing), but you can override it.
 */
function addDialogMod(mods, label, value) {
  const n = num(value, 0);
  if (!n) return;
  mods.push({ label, value: n });
}

function addDetailDialogMods(mods, details = []) {
  for (const detail of details) {
    const text = String(detail ?? "").trim();
    if (!text) continue;
    const match = text.match(/^(.*?)([+-]\d+)\s*$/);
    if (!match) continue;
    const label = match[1].trim().replace(/\s+/g, " ");
    const value = Number(match[2]);
    if (!label || !Number.isFinite(value) || !value) continue;
    mods.push({ label, value });
  }
}

function buildAttackDialogMods({ statusMods, envMods, losWoodsMods, losCoverMods, terrainCoverMod = 0 }) {
  const mods = [];
  const blockedNotes = [];

  addDetailDialogMods(mods, statusMods?.details);
  addDetailDialogMods(mods, envMods?.details);
  addDialogMod(mods, "Intervening Woods", losWoodsMods?.mod);
  addDialogMod(mods, "Cover", terrainCoverMod);

  if (losWoodsMods?.blocked) {
    const detail = losWoodsMods.details?.length ? ` (${losWoodsMods.details.join("; ")})` : "";
    blockedNotes.push(`Line of sight blocked by ${losWoodsMods.woodsPoints} woods points${detail}.`);
  }

  if (losCoverMods?.blocked) {
    const detail = losCoverMods.details?.length ? ` (${losCoverMods.details.join("; ")})` : "";
    blockedNotes.push(`Line of sight blocked by terrain${detail}.`);
  }

  return { mods, blockedNotes };
}

function enrichAmmoSelectionOptionsForDialog(options, weaponItem, distance, baseTNWithoutRange) {
  return (Array.isArray(options) ? options : []).map(opt => {
    const range = calcRangeBandAndMod(weaponItem, distance, { ammoKey: opt?.key });
    return {
      ...opt,
      rangeBand: range.band,
      rangeMod: num(range.mod, 0),
      totalTN: num(baseTNWithoutRange, 0) + num(range.mod, 0)
    };
  });
}

function bindAttackDialogTNUpdater(html) {
  const form = html?.[0]?.querySelector?.("form.atow-attack-dialog") ?? html?.querySelector?.("form.atow-attack-dialog");
  if (!form) return;
  const ammoSelect = form.querySelector("select[name='ammoKey']");
  const attackerMoveSelect = form.querySelector("select[name='attackerMoveMode']");
  const targetHexesInput = form.querySelector("input[name='targetHexes']");
  const otherModInput = form.querySelector("input[name='otherMod']");
  const totalEl = form.querySelector("[data-attack-total-tn]");
  const bandEl = form.querySelector("[data-attack-band]");

  const targetMoveModForHexes = (hexes) => {
    const h = Number(hexes);
    if (!Number.isFinite(h) || h <= 2) return 0;
    if (h <= 4) return 1;
    if (h <= 6) return 2;
    if (h <= 9) return 3;
    if (h <= 17) return 4;
    if (h <= 24) return 5;
    return 6;
  };
  const attackerMoveMod = () => {
    const value = String(attackerMoveSelect?.value ?? "auto").toLowerCase();
    if (value === "walk") return 1;
    if (value === "run") return 2;
    if (value === "jump") return 3;
    if (value === "stationary") return 0;
    return num(form.dataset.autoAttackerMoveMod, 0);
  };
  const updateTN = () => {
    const selected = ammoSelect?.selectedOptions?.[0] ?? null;
    const rangeMod = num(selected?.dataset?.rangeMod ?? form.dataset.rangeMod, 0);
    const rangeBand = selected?.dataset?.rangeBand ?? null;
    const base = num(form.dataset.baseTnWithoutRange, 8);
    const targetMoveMod = targetMoveModForHexes(targetHexesInput?.value ?? 0);
    const otherMod = num(otherModInput?.value, 0);
    const total = base + rangeMod + attackerMoveMod() + targetMoveMod + otherMod;
    if (totalEl) totalEl.textContent = String(total);
    if (bandEl && rangeBand) bandEl.textContent = rangeBand;
  };

  ammoSelect?.addEventListener?.("change", updateTN);
  attackerMoveSelect?.addEventListener?.("change", updateTN);
  targetHexesInput?.addEventListener?.("input", updateTN);
  otherModInput?.addEventListener?.("input", updateTN);
  updateTN();
}

export async function promptAndRollWeaponAttack(actor, weaponItem, { defaultSide = "front", attackerToken = null, weaponFireKey = "", weaponMountLoc = "", weaponRearMounted = false } = {}) {
  // If this weapon is a melee weapon (hatchet/sword/etc.), use the melee weapon workflow.
  if (isMeleeWeaponItem(weaponItem)) {
    return promptAndRollMeleeWeaponAttack(actor, weaponItem, { defaultSide });
  }

  if (isAMSWeapon(weaponItem)) {
    ui?.notifications?.warn?.("Anti-Missile Systems fire automatically against incoming missiles and cannot be fired manually.");
    return null;
  }

  const chargeLockToken = attackerToken ?? getAttackerToken(actor);
  if (hasActorChargedThisTurn(actor, chargeLockToken?.document ?? chargeLockToken)) {
    ui?.notifications?.warn?.("This mech charged this turn and cannot make weapon attacks.");
    return null;
  }

  if (await isWeaponDestroyedForAttack(actor, weaponItem, { weaponFireKey })) {
    ui?.notifications?.warn?.(`${weaponItem?.name ?? "This weapon"} is destroyed and cannot be fired.`);
    return null;
  }

  const attackerTok = attackerToken ?? getAttackerToken(actor);
  const targetToken = getSingleTargetToken();
  const isArrowIVAttack = isArrowIVSystemWeapon(weaponItem);

  if (!targetToken && !isArrowIVAttack) {
    ui?.notifications?.warn?.("Select exactly 1 target token before making an attack.");
    return null;
  }
  if (!attackerTok) {
    ui?.notifications?.warn?.("Place/control your attacker token on the scene before making an attack.");
    return null;
  }

  const distance = targetToken ? measureTokenDistance(attackerTok, targetToken) : 0;
  if (distance === null) {
    ui?.notifications?.warn?.("Couldn't measure distance (no canvas/grid?).");
    return null;
  }

  const arc = targetToken ? getTargetSideFromFacing(attackerTok, targetToken) : null;
  const computedSide = arc?.side ?? defaultSide;
  const firingArcInfo = targetToken
    ? getWeaponFiringArcInfo(actor, weaponItem, { weaponFireKey, weaponMountLoc, weaponRearMounted }, attackerTok, targetToken)
    : { applies: false, legal: true };

  const ammoSelection = weaponSupportsAmmoSelection(weaponItem) ? await getAmmoSelectionOptions(actor, weaponItem) : { options: [], defaultKey: null, hasMultiple: false };
  const selectedAmmoKey = ammoSelection.defaultKey ?? getAmmoKeyForWeapon(weaponItem);
  const { band } = targetToken ? calcRangeBandAndMod(weaponItem, distance, { ammoKey: selectedAmmoKey }) : { band: "Indirect" };

  const autoTargetMove = targetToken ? getAutoTargetMoveData(targetToken) : { moved: 0, mod: 0 };
  const dialogStatusMods = targetToken ? getStatusTNMods(attackerTok, targetToken) : { total: 0, details: [] };
  const dialogEnvMods = getEnvironmentTNMods(weaponItem);
  const dialogLosWoodsMods = targetToken ? getLineOfSightWoodsMods(attackerTok, targetToken) : { mod: 0, blocked: false, details: [] };
  const dialogLosCoverMods = targetToken ? getLineOfSightCoverMods(attackerTok, targetToken) : { partialCover: false, blocked: false, mod: 0, targetWaterDepth: 0, details: [] };
  const targetHasStatusPartialCover = targetToken ? tokenHasStatus(targetToken, "partial-cover") : false;
  const targetHasWaterStatus = targetToken ? tokenHasStatus(targetToken, "in-water") : false;
  const partialCoverAlreadyAddsTN = targetHasStatusPartialCover || (targetHasWaterStatus && dialogLosCoverMods.targetWaterDepth > 0);
  const dialogTerrainCoverMod = (dialogLosCoverMods.partialCover && !partialCoverAlreadyAddsTN) ? 1 : 0;
  const dialogBaseTN = 8;
  const dialogRack = getMissileRack(weaponItem);
  const dialogMRMTNMod = String(dialogRack?.type ?? "").toUpperCase() === "MRM" ? 1 : 0;
  const dialogAttackerMoveMod = getAutoAttackerMoveMod(actor, attackerTok).mod;
  const dialogTargetMoveMod = autoTargetMove.mod;
  const dialogHeatFireMod = num(actor.system?.heat?.effects?.fireMod, 0);
  const dialogBaseWithoutRange = dialogBaseTN
    + dialogEnvMods.mod
    + dialogLosWoodsMods.mod
    + dialogTerrainCoverMod
    + dialogStatusMods.total
    + dialogMRMTNMod
    + dialogAttackerMoveMod
    + dialogTargetMoveMod
    + dialogHeatFireMod;
  const dialogRangeMod = num(calcRangeBandAndMod(weaponItem, distance, { ammoKey: selectedAmmoKey }).mod, 0);
  const dialogTN = dialogBaseWithoutRange + dialogRangeMod;

  const isSpecialDesignationAttack = isTAGWeapon(weaponItem) || isArrowIVSystemWeapon(weaponItem);
  const rapidFireRating = isSpecialDesignationAttack ? 1 : getRapidFireRating(weaponItem);
  const { mods, blockedNotes } = buildAttackDialogMods({
    statusMods: dialogStatusMods,
    envMods: dialogEnvMods,
    losWoodsMods: dialogLosWoodsMods,
    losCoverMods: dialogLosCoverMods,
    terrainCoverMod: dialogTerrainCoverMod
  });
  if (dialogMRMTNMod) mods.push({ label: "MRM Unguided", value: dialogMRMTNMod });
  if (firingArcInfo.applies && !firingArcInfo.legal) {
    const mountLabel = firingArcInfo.rearMounted ? "Rear-mounted" : `${firingArcInfo.mount?.locLabel ?? "Unknown"} mounted`;
    blockedNotes.push(`${mountLabel} weapon cannot fire into the ${String(firingArcInfo.side ?? "unknown").toUpperCase()} arc. Allowed: ${firingArcInfo.allowedLabel}.`);
  }

  const firingArcNote = firingArcInfo.applies
    ? ` Weapon arc: ${String(firingArcInfo.side ?? "front").toUpperCase()} target arc; ${firingArcInfo.rearMounted ? "rear-mounted" : `${firingArcInfo.mount?.locLabel ?? "Unknown"} mounted`}; allowed ${firingArcInfo.allowedLabel}.`
    : "";

  const ammoSelectionOptions = enrichAmmoSelectionOptionsForDialog(ammoSelection.options, weaponItem, distance, dialogBaseWithoutRange);
  const selectedAmmoRange = targetToken ? calcRangeBandAndMod(weaponItem, distance, { ammoKey: selectedAmmoKey }) : { band: "Indirect", mod: 0 };

  ensureAttackDialogHandlebarsHelpers();
  const dialogHtml = await renderTemplate(VEHICLE_ATTACK_TEMPLATE, {
    weaponName: weaponItem.name,
    attackerName: attackerTok.name ?? actor.name,
    targetName: targetToken?.name ?? "Designated hex",
    distance,
    band,
    mods,
    hasMods: mods.length > 0,
    blockedNotes,
    hasBlockedNotes: blockedNotes.length > 0,
    autoTargetMove: autoTargetMove.moved,
    computedSide,
    arcNote: arc
      ? `Target facing ${Math.round(arc.facingDeg)} degrees; hit arc ${computedSide.toUpperCase()}.${firingArcNote}`
      : `No facing data found; defaulting hit arc to ${computedSide.toUpperCase()}.${firingArcNote}`,
    totalTN: dialogTN,
    showRapidFire: !isSpecialDesignationAttack && rapidFireRating > 1,
    rapidFireRating,
    weaponHeat: getRotaryACProfile(weaponItem)?.heat ?? num(weaponItem.system?.heat, 0),
    showArrowIVIndirectControl: isArrowIVAttack,
    showAmmoSelection: weaponSupportsAmmoSelection(weaponItem) && ammoSelection.options.length > 0,
    ammoSelectionOptions,
    selectedAmmoKey,
    selectedRangeMod: num(selectedAmmoRange.mod, 0),
    baseTNWithoutRange: dialogBaseTN + dialogEnvMods.mod + dialogLosWoodsMods.mod + dialogTerrainCoverMod + dialogStatusMods.total + dialogHeatFireMod + dialogMRMTNMod,
    autoAttackerMoveMod: dialogAttackerMoveMod
  });


  return new Promise((resolve) => {
    new Dialog({
      title: `${weaponItem.name} - Attack`,
      content: dialogHtml,
      buttons: {
        roll: {
          icon: '<i class="fas fa-dice"></i>',
          label: "Roll",
          callback: async (html) => {
            const form = html[0].querySelector("form.atow-attack-dialog");
            const fd = new FormData(form);
            const opts = {
              attackerToken,
              targetToken,
              distance: num(fd.get("distance"), 0),
              attackerMoveMode: String(fd.get("attackerMoveMode") ?? "auto"),
              targetHexes: num(fd.get("targetHexes"), 0),
              terrainMod: 0,
              otherMod: num(fd.get("otherMod"), 0),
              side: String(fd.get("side") ?? computedSide),
              applyDamage: true,
              applyHeat: true,
              showLocation: true,
              rapidShots: num(fd.get("rapidShots"), 1),
              ammoKey: String(fd.get("ammoKey") ?? selectedAmmoKey ?? ""),
              weaponFireKey,
              weaponMountLoc,
              weaponRearMounted
            };
            if (isArrowIVAttack && fd.get("arrowIVIndirect") === "on") {
              const result = await scheduleArrowIVIndirectAttack(actor, weaponItem, { ...opts, attackerToken: attackerTok });
              resolve(result);
              return;
            }
            if (!targetToken) {
              ui?.notifications?.warn?.("Select exactly 1 target token for direct fire.");
              resolve(null);
              return;
            }
            const result = await rollWeaponAttack(actor, weaponItem, { ...opts, attackerToken: attackerTok, targetToken });
            resolve(result);
          }
        },
        cancel: {
          label: "Cancel",
          callback: () => resolve(null)
        }
      },
      default: "roll",
      render: bindAttackDialogTNUpdater
    }).render(true);
  });
}


// ------------------------------------------------------------
// Melee / Physical Attacks (Punch, Kick)
// ------------------------------------------------------------

// Punch Location Table (Classic BattleTech) with columns Left / Front-Rear / Right.
// We treat "rear" the same as "front" for punch locations (Front-Rear column).
// Keys use our canonical location keys; quad leg keys are supported if the target actor has them.
const PUNCH_LOCATION_TABLE = {
  biped: {
    left:  { 1: "lt", 2: "lt", 3: "ct", 4: "la", 5: "la", 6: "head" },
    front: { 1: "la", 2: "lt", 3: "ct", 4: "rt", 5: "ra", 6: "head" },
    right: { 1: "rt", 2: "rt", 3: "ct", 4: "ra", 5: "ra", 6: "head" }
  },
  quad: {
    left:  { 1: "lt", 2: "lt", 3: "ct", 4: "lfl", 5: "lrl", 6: "head" },
    front: { 1: ["lfl", "lrl"], 2: "lt", 3: "ct", 4: "rt", 5: ["rfl", "rrl"], 6: "head" },
    right: { 1: "rt", 2: "rt", 3: "ct", 4: "rfl", 5: "rrl", 6: "head" }
  }
};

function _punchSideKey(side) {
  const s = String(side ?? "front").toLowerCase();
  if (s === "left") return "left";
  if (s === "right") return "right";
  // front + rear both use Front-Rear column
  return "front";
}

async function rollPunchHitLocation({ targetActor, side = "front", targetType = "biped" } = {}) {
  const tType = String(targetType ?? "biped").toLowerCase() === "quad" ? "quad" : "biped";
  const sKey = _punchSideKey(side);
  const table = PUNCH_LOCATION_TABLE[tType]?.[sKey] ?? PUNCH_LOCATION_TABLE.biped.front;

  const roll = await (new Roll("1d6")).evaluate();
  const d = Number(roll.total ?? 1) || 1;

  let entry = table[d];
  let loc = entry;

  // If the table row is a choice (quad front column), pick one at random.
  if (Array.isArray(entry)) {
    const r2 = await (new Roll("1d2")).evaluate();
    loc = entry[(Number(r2.total ?? 1) <= 1) ? 0 : 1];
  }

  // Normalize (handles quad fallback to LL/RL if the target doesn't have quad tracks)
  loc = _normalizeDamageLocation(targetActor, loc);

  return { loc, roll };
}

function _critLabel(slot) {
  if (!slot) return "";
  if (typeof slot === "string") return slot;
  return String(slot.label ?? "");
}

function _critDestroyed(slot) {
  if (!slot) return false;
  if (typeof slot === "string") return false;
  return Boolean(slot.destroyed);
}

function _getArmActuatorState(actor, armLoc /* "la" | "ra" */) {
  // Crit slots may be stored as an Array or an Object keyed by index.
  // Normalize to an array so we can iterate safely.
  const rawSlots = actor?.system?.crit?.[armLoc]?.slots;
  const slots = Array.isArray(rawSlots)
    ? rawSlots
    : (rawSlots && typeof rawSlots === "object")
        ? Object.keys(rawSlots)
            .sort((a, b) => Number(a) - Number(b))
            .map((k) => rawSlots[k])
        : [];
  const out = {
    shoulderDestroyed: false,
    upperDamagedOrMissing: false,
    lowerDamagedOrMissing: false,
    handDamagedOrMissing: false,
    // best-effort: whether we even saw the actuator definition in the crit table
    sawShoulder: false,
    sawUpper: false,
    sawLower: false,
    sawHand: false
  };

  for (const s of slots) {
    const label = _critLabel(s).toLowerCase();

    if (label.includes("shoulder") && label.includes("actuator")) {
      out.sawShoulder = true;
      if (_critDestroyed(s)) out.shoulderDestroyed = true;
    }
    if (label.includes("upper arm") && label.includes("actuator")) {
      out.sawUpper = true;
      if (_critDestroyed(s)) out.upperDamagedOrMissing = true;
    }
    if (label.includes("lower arm") && label.includes("actuator")) {
      out.sawLower = true;
      if (_critDestroyed(s)) out.lowerDamagedOrMissing = true;
    }
    if (label.includes("hand") && label.includes("actuator")) {
      out.sawHand = true;
      if (_critDestroyed(s)) out.handDamagedOrMissing = true;
    }
  }

  // If the crit table explicitly doesn't contain the actuator (by design), treat it as "missing".
  // This is only a best-effort heuristic; some sheets may not model these actuators explicitly.
  if (slots?.length) {
    if (!out.sawUpper) out.upperDamagedOrMissing = out.upperDamagedOrMissing || false;
    if (!out.sawLower) out.lowerDamagedOrMissing = out.lowerDamagedOrMissing || false;
    if (!out.sawHand) out.handDamagedOrMissing = out.handDamagedOrMissing || false;
  }

  return out;
}

function _mechTonnage(actor) {
  const t = Number(actor?.system?.mech?.tonnage ?? actor?.system?.tonnage ?? actor?.system?.chassis?.tonnage ?? 0);
  return Number.isFinite(t) && t > 0 ? t : 50;
}

function calcPunchBaseDamage(actor) {
  const tons = _mechTonnage(actor);
  return Math.max(1, Math.ceil(tons / 10));
}

function calcPunchDamageForArm(actor, armLoc) {
  let dmg = calcPunchBaseDamage(actor);
  const a = _getArmActuatorState(actor, armLoc);

  // Each upper/lower arm actuator damaged/missing halves damage (cumulative).
  if (a.upperDamagedOrMissing) dmg = Math.floor(dmg / 2);
  if (a.lowerDamagedOrMissing) dmg = Math.floor(dmg / 2);

  dmg = Math.max(1, dmg);
  const _tsm = isTSMActive(actor);
  if (_tsm) dmg = dmg * 2;

  return { damage: dmg, actuator: a };
}

function calcPunchTNModsForArm(actuatorState) {
  let mod = 0;
  if (actuatorState?.handDamagedOrMissing) mod += 1;
  if (actuatorState?.lowerDamagedOrMissing) mod += 2;
  return mod;
}

/**
 * Roll a punch attack. Supports left/right/both arms (each arm is a separate attack roll).
 *
 * opts:
 *  - attackerToken, targetToken (optional; auto uses selected)
 *  - attackerMoveMode ("auto"|"stationary"|"walk"|"run"|"jump")
 *  - targetHexes (number)
 *  - terrainMod, otherMod (numbers)
 *  - side ("front"|"rear"|"left"|"right") (defaults auto-detected)
 *  - targetType ("biped"|"quad")
 *  - arms ("left"|"right"|"both")
 *  - applyDamage (bool)
 *  - showLocation (bool)
 */
export async function rollPunchAttack(actor, opts = {}) {
  if (!actor) return null;

  // Pseudo weapon metadata for chat/VFX integrations (Automated Animations, etc.)
  // This mirrors the pattern used for real weapon items (name + flags).
  const weaponMeta = _getWeaponAutomationMeta({ name: "Punch" });

  const attackerToken = opts.attackerToken ?? getAttackerToken(actor);
  const targetToken = opts.targetToken ?? getSingleTargetToken();

  if (!targetToken) {
    ui?.notifications?.warn?.("Select exactly 1 target token before making an attack.");
    return null;
  }
  if (!attackerToken) {
    ui?.notifications?.warn?.("Place/control your mech token on the scene before making an attack.");
    return null;
  }

  const isVehicleAttacker = isVehicleActor(actor);

  // Heat shutdown prevents all attacks
  const isShutdown = !isVehicleAttacker && (Boolean(actor.system?.heat?.shutdown) || Boolean(attackerToken?.document?.getFlag?.(SYSTEM_ID, "shutdown")));
  if (isShutdown) {
    ui?.notifications?.warn?.("This mech is shut down due to heat and cannot attack.");
    return null;
  }

  const distance = Number.isFinite(opts.distance) ? num(opts.distance, 0) : measureTokenDistance(attackerToken, targetToken);
  if (distance === null) {
    ui?.notifications?.warn?.("Couldn't measure distance (no canvas/grid?).");
    return null;
  }
  if (distance > 1) {
    ui?.notifications?.warn?.("Punch attacks require the target to be adjacent (range 1).");
    return null;
  }

  const pilot = actor.system?.pilot ?? {};
  const piloting = num(pilot.piloting, 0);
  if (!piloting) ui?.notifications?.warn?.("No Piloting skill found on this mech (system.pilot.piloting). Using 0.");

  const autoMove = getAutoAttackerMoveMod(actor, attackerToken);
  const attackerMoveMod = Number.isFinite(opts.attackerMoveMod)
    ? num(opts.attackerMoveMod, 0)
    : (() => {
        const mode = String(opts.attackerMoveMode ?? "auto").toLowerCase();
        if (mode === "auto" || mode === "sheet" || mode === "token") return autoMove.mod;
        switch (mode) {
          case "walk": return 1;
          case "run": return 2;
          case "jump": return 3;
          case "stationary":
          default: return 0;
        }
      })();

  const autoTargetMove = getAutoTargetMoveData(targetToken);
  const targetHexesUsed = Number.isFinite(opts.targetHexes) ? num(opts.targetHexes, 0) : autoTargetMove.moved;
  const targetMoveMod = Number.isFinite(opts.targetMoveMod) ? num(opts.targetMoveMod, 0) : calcTargetMoveModFromHexes(targetHexesUsed);

  const terrainMod = num(opts.terrainMod, 0);
  const otherMod = num(opts.otherMod, 0);

  const statusTNMods = getStatusTNMods(attackerToken, targetToken);

  // AToW: fixed target number base (8). Roll 2d6 + Piloting vs TN.
  const baseTN = 8;

  // Arc side (optional; defaults to auto-detected)
  const arc = getTargetSideFromFacing(attackerToken, targetToken);
  const side = (opts.side && ["front", "rear", "left", "right"].includes(opts.side)) ? opts.side : (arc?.side ?? "front");

  const arms = String(opts.arms ?? "both").toLowerCase();
  const armList = (arms === "left") ? ["la"] : (arms === "right") ? ["ra"] : ["la", "ra"];

  const targetType = String(opts.targetType ?? "biped").toLowerCase() === "quad" ? "quad" : "biped";

  const results = [];
  const targetActor = targetToken?.actor;
  const isVehicleTarget = isVehicleActor(targetActor);
  const hasVehicleTurret = isVehicleTarget && (num(targetActor?.system?.armor?.turret?.max, 0) > 0);

  for (const armLoc of armList) {
    const { damage, actuator } = calcPunchDamageForArm(actor, armLoc);

    if (actuator.shoulderDestroyed) {
      results.push({
        armLoc,
        ok: false,
        reason: `${armLoc.toUpperCase()}: Shoulder actuator destroyed — cannot punch.`
      });
      continue;
    }

    const armTNMod = calcPunchTNModsForArm(actuator);

    // Base TN is piloting skill, plus mods
    const tn = baseTN + attackerMoveMod + targetMoveMod + statusTNMods.total + terrainMod + otherMod + armTNMod;

    const toHit = await (new Roll(`2d6 + ${piloting}`)).evaluate();
    const hit = (toHit.total ?? 0) >= tn;

    let locResult = null;
    let damageApplied = null;

    if (hit && (opts.showLocation || opts.applyDamage)) {
      locResult = isVehicleTarget
        ? await rollVehicleHitLocation(side, { hasTurret: hasVehicleTurret })
        : await rollPunchHitLocation({ targetActor, side, targetType });
    }

    if (hit && opts.applyDamage && targetActor && locResult?.loc) {
      try {
        let r;
        if (isVehicleTarget) {
          const crit = locResult?.critTrigger ? { trigger: true, tableLoc: locResult.critTableLoc } : null;
          r = await applyDamageToVehicleActorAuto(targetActor, locResult.loc, damage, { attackSide: side, crit });
        } else {
          r = await applyDamageToTargetActorAuto(targetActor, locResult.loc, damage, { side });
        }
        damageApplied = r;
      } catch (err) {
        console.warn("AToW Battletech | Punch damage application threw", err);
        damageApplied = { ok: false, reason: String(err?.message ?? err) };
      }
    }

    results.push({
      armLoc,
      tn,
      toHit,
      hit,
      damage,
      side,
      targetType,
      actuator,
      armTNMod,
      locResult,
      damageApplied
    });
  }

	  // Chat card
	  try {
	    const attackerName = attackerToken?.name ?? actor.name;
	    const targetName = targetToken?.name ?? "Target";
      const anyHit = (results ?? []).some(r => r?.hit);

	    const header = `<header><b>${weaponMeta.name}</b> — Physical Attack</header>`;
    const facingLine = arc
      ? `<div><b>Target Facing:</b> ${Math.round(arc.facingDeg)}° | <b>Attack Arc:</b> ${side.toUpperCase()}</div>`
      : `<div><b>Attack Arc:</b> ${side.toUpperCase()} (no facing data found)</div>`;

    const lines = [
      `<div class="atow-chat-card atow-mech-attack">`,
      header,
      buildAttackResultBanner({
        hit: anyHit,
        label: anyHit ? "HIT" : "MISS",
        detail: anyHit ? "At least one punch connected" : "No punches connected"
      }),
      `<div><b>Attacker:</b> ${attackerName} | <b>Target:</b> ${targetName}</div>`,
      facingLine,
      `<div><b>Distance:</b> ${distance} (adjacent)</div>`,
      `<hr/>`,
      `<div><b>Mods</b></div>`,
      `<ul>`,
      `<li>Base TN: ${baseTN}</li>`,
      `<li>Attacker movement: +${attackerMoveMod}${(String(opts.attackerMoveMode ?? 'auto').toLowerCase() === 'auto') ? ` (auto: ${autoMove.mode.toUpperCase()}, moved ${autoMove.moved})` : ''}</li>`,
      `<li>Target movement: +${targetMoveMod}${Number.isFinite(opts.targetHexes) ? ` (entered: ${opts.targetHexes})` : ` (auto: moved ${autoTargetMove.moved})`}</li>`,
      `<li>Statuses: +${statusTNMods.total}${statusTNMods.details?.length ? ` (${statusTNMods.details.join('; ')})` : ''}</li>`,
      `<li>Terrain: +${terrainMod}</li>`,
      `<li>Other: +${otherMod}</li>`,
      `</ul>`,
      `<div><b>Results</b></div>`,
      `<ul>`
    ];

    for (const r of results) {
      const armName = (r.armLoc === "la") ? "Left Arm" : (r.armLoc === "ra") ? "Right Arm" : String(r.armLoc);
      if (r.ok === false) {
        lines.push(`<li><b>${armName}:</b> <span style="color:#c00">${r.reason}</span></li>`);
        continue;
      }

      const armNote = [];
      if (r.actuator?.handDamagedOrMissing) armNote.push("Hand +1 TN");
      if (r.actuator?.lowerDamagedOrMissing) armNote.push("Lower Arm +2 TN");
      if (r.actuator?.upperDamagedOrMissing) armNote.push("Upper Arm: half dmg");
      if (r.actuator?.lowerDamagedOrMissing) armNote.push("Lower Arm: half dmg");

      lines.push(
        `<li><b>${armName}:</b> Roll ${r.toHit.total} (2d6 + Piloting ${piloting}) vs <b>TN ${r.tn}</b>${r.armTNMod ? ` (arm mods +${r.armTNMod})` : ""} → <b>${r.hit ? "HIT" : "MISS"}</b>` +
        `${r.hit ? ` | Damage <b>${r.damage}</b>` : ""}` +
        `${r.locResult?.loc ? ` | Loc ${String(r.locResult.loc).toUpperCase()} (roll ${r.locResult.roll.total})` : ""}` +
        `${(opts.applyDamage && r.damageApplied) ? (r.damageApplied.ok ? ` | Applied: Armor ${r.damageApplied.armorApplied}, Structure ${r.damageApplied.structureApplied}` : ` | <span style="color:#c00">NOT applied: ${r.damageApplied.reason}</span>`) : ""}` +
        `${armNote.length ? `<br/><small>${armNote.join("; ")}</small>` : ""}` +
        `</li>`
      );
    }

    lines.push(`</ul></div></details></div>`);

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: lines.join(""),
      flavor: `${weaponMeta.name} Attack`,
      rolls: results.map(r => r.toHit).filter(Boolean),
      type: CONST.CHAT_MESSAGE_TYPES.ROLL,
      flags: weaponMeta.flags
    }).catch(()=>{});
  } catch (err) {
    console.warn("AToW Battletech | Punch chat card failed", err);
  }

  // Trigger Automated Animations directly (if installed)
  await _maybePlayAutomatedAnimation(attackerToken, null, _getWeaponAutomationMeta({ name: "Punch" }), { targetToken, hit: anyHit });
  await markMovementResetLockedThisTurn(actor, { attackerToken });

  return {
    attackerTokenId: attackerToken?.id,
    targetTokenId: targetToken?.id,
    distance,
    side,
    targetType,
    piloting,
    attackerMoveMod,
    targetMoveMod,
    terrainMod,
    otherMod,
    statusMods: statusTNMods,
    results
  };
}


// ------------------------------------------------------------
// Kick Attacks (Physical)
// ------------------------------------------------------------

/**
 * Simple BattleMech Kick Location Table (1d6)
 * (We are not enforcing forward-arc or quad rear-kick yet; this just resolves the hit location.)
 *
 * Table (Biped):                         (Classic BT)
 *  Left Side:   1-6 -> LL
 *  Right Side:  1-6 -> RL
 *  Front/Rear:  1-3 -> RL, 4-6 -> LL
 */
async function rollKickHitLocation({ targetActor, side = "front", targetType = "biped" } = {}) {
  const s = String(side ?? "front").toLowerCase();
  const r = await (new Roll("1d6")).evaluate();
  const d = Number(r.total ?? 1);

  let loc = null;
  if (s === "left") loc = "ll";
  else if (s === "right") loc = "rl";
  else {
    // front/rear
    loc = (d <= 3) ? "rl" : "ll";
  }

  // If target is a quad and uses quad leg keys, _normalizeDamageLocation will map as needed.
  loc = _normalizeDamageLocation(targetActor, loc);

  return { roll: r, loc };
}

function _getLegActuatorState(actor, legLoc = "ll") {
  const loc = String(legLoc ?? "").toLowerCase();
  const slots = actor?.system?.crit?.[loc]?.slots;
  const arr = Array.isArray(slots) ? slots : (slots && typeof slots === "object") ? Object.values(slots) : [];
  const labels = arr.map(s => String(s?.label ?? s ?? "").toLowerCase());
  const destroyed = arr.map(s => Boolean(s?.destroyed));

  const findDestroyed = (needle) => {
    for (let i = 0; i < labels.length; i++) {
      if (labels[i].includes(needle)) return destroyed[i] === true;
    }
    return false;
  };
  const findPresent = (needle) => labels.some(l => l.includes(needle));

  const hipDestroyed = findDestroyed("hip actuator");
  const upperDestroyed = findDestroyed("upper leg actuator");
  const lowerDestroyed = findDestroyed("lower leg actuator");

  // "Missing" (by design) is hard to detect in our current crit model; treat missing as present-but-destroyed
  // only when the label exists. If the label doesn't exist at all, we assume it's present.
  const upperPresent = findPresent("upper leg actuator");
  const lowerPresent = findPresent("lower leg actuator");

  return {
    hipDestroyed,
    upperDamagedOrMissing: upperPresent ? upperDestroyed : false,
    lowerDamagedOrMissing: lowerPresent ? lowerDestroyed : false
  };
}

function calcKickBaseDamage(actor) {
  const tonnage = Number(actor?.system?.mech?.tonnage ?? actor?.system?.tonnage ?? 50) || 50;
  // Per rules: 1 point per 5 tons (ceil, minimum 1)
  return Math.max(1, Math.ceil(tonnage / 5));
}

function calcKickDamageForLeg(actor, legLoc = "ll") {
  const base = calcKickBaseDamage(actor);
  const actuator = _getLegActuatorState(actor, legLoc);

  let dmg = base;

  // Reduce kick damage by half for each upper/lower leg actuator damaged (cumulative), round down, minimum 1.
  if (actuator.upperDamagedOrMissing) dmg = Math.floor(dmg / 2);
  if (actuator.lowerDamagedOrMissing) dmg = Math.floor(dmg / 2);

  dmg = Math.max(1, dmg);

  const _tsm = isTSMActive(actor);
  if (_tsm) dmg = dmg * 2;

  return { damage: dmg, actuator, base };
}

/**
 * Roll a kick attack (single kick).
 *
 * opts:
 *  - attackerToken, targetToken (optional; auto uses selected)
 *  - attackerMoveMode ("auto"|"stationary"|"walk"|"run"|"jump")
 *  - targetHexes (number)
 *  - terrainMod, otherMod (numbers)
 *  - side ("front"|"rear"|"left"|"right") (defaults auto-detected)
 *  - targetType ("biped"|"quad") (for future expansion; currently only affects display)
 *  - leg ("left"|"right")  (defaults right)
 *  - applyDamage (bool)
 *  - showLocation (bool)
 */
export async function rollKickAttack(actor, opts = {}) {
  if (!actor) return null;

  // Pseudo weapon metadata for chat/VFX integrations (Automated Animations, etc.)
  // This mirrors the pattern used for real weapon items (name + flags).
  const weaponMeta = _getWeaponAutomationMeta({ name: "Kick" });

  const attackerToken = opts.attackerToken ?? getAttackerToken(actor);
  const targetToken = opts.targetToken ?? getSingleTargetToken();

  if (!targetToken) {
    ui?.notifications?.warn?.("Select exactly 1 target token before making an attack.");
    return null;
  }
  if (!attackerToken) {
    ui?.notifications?.warn?.("Place/control your mech token on the scene before making an attack.");
    return null;
  }

  const isVehicleAttacker = isVehicleActor(actor);

  // Heat shutdown prevents all attacks
  const isShutdown = !isVehicleAttacker && (Boolean(actor.system?.heat?.shutdown) || Boolean(attackerToken?.document?.getFlag?.(SYSTEM_ID, "shutdown")));
  if (isShutdown) {
    ui?.notifications?.warn?.("This mech is shut down due to heat and cannot attack.");
    return null;
  }

  const distance = Number.isFinite(opts.distance) ? num(opts.distance, 0) : measureTokenDistance(attackerToken, targetToken);
  if (distance === null) {
    ui?.notifications?.warn?.("Couldn't measure distance (no canvas/grid?).");
    return null;
  }
  if (distance > 1) {
    ui?.notifications?.warn?.("Kick attacks require the target to be adjacent (range 1).");
    return null;
  }

  const pilot = actor.system?.pilot ?? {};
  const piloting = num(pilot.piloting, 0);
  if (!piloting) ui?.notifications?.warn?.("No Piloting skill found on this mech (system.pilot.piloting). Using 0.");

  const autoMove = getAutoAttackerMoveMod(actor, attackerToken);
  const attackerMoveMod = Number.isFinite(opts.attackerMoveMod)
    ? num(opts.attackerMoveMod, 0)
    : (() => {
        const mode = String(opts.attackerMoveMode ?? "auto").toLowerCase();
        if (mode === "auto" || mode === "sheet" || mode === "token") return autoMove.mod;
        switch (mode) {
          case "walk": return 1;
          case "run": return 2;
          case "jump": return 3;
          case "stationary":
          default: return 0;
        }
      })();

  const autoTargetMove = getAutoTargetMoveData(targetToken);
  const targetHexesUsed = Number.isFinite(opts.targetHexes) ? num(opts.targetHexes, 0) : autoTargetMove.moved;
  const targetMoveMod = Number.isFinite(opts.targetMoveMod) ? num(opts.targetMoveMod, 0) : calcTargetMoveModFromHexes(targetHexesUsed);

  const terrainMod = num(opts.terrainMod, 0);
  const otherMod = num(opts.otherMod, 0);

  const statusTNMods = getStatusTNMods(attackerToken, targetToken);

  // AToW: fixed target number base (8). Kick has a -2 modifier to TN.
  const baseTN = 8;
  const kickTNMod = -2;

  const arc = getTargetSideFromFacing(attackerToken, targetToken);
  const side = (opts.side && ["front", "rear", "left", "right"].includes(opts.side)) ? opts.side : (arc?.side ?? "front");

  const targetType = String(opts.targetType ?? "biped").toLowerCase() === "quad" ? "quad" : "biped";

  const legChoice = String(opts.leg ?? "right").toLowerCase();
  const kickLegLoc = (legChoice === "left") ? "ll" : "rl";

  // Requirement (per rules): both hip actuators must be undamaged to attempt a kick.
  const leftLeg = _getLegActuatorState(actor, "ll");
  const rightLeg = _getLegActuatorState(actor, "rl");
  const hipsOk = !leftLeg.hipDestroyed && !rightLeg.hipDestroyed;

  const targetActor = targetToken?.actor;
  const isVehicleTarget = isVehicleActor(targetActor);
  const hasVehicleTurret = isVehicleTarget && (num(targetActor?.system?.armor?.turret?.max, 0) > 0);

  const { damage, actuator, base } = calcKickDamageForLeg(actor, kickLegLoc);

    // TN: 8 + kick modifier (-2) + standard mods
  const tnBase = baseTN + kickTNMod;
  const tn = tnBase + attackerMoveMod + targetMoveMod + statusTNMods.total + terrainMod + otherMod;

  let toHit = null;
  let hit = false;
  let locResult = null;
  let damageApplied = null;
  let massiveDamagePsr = null;

  if (!hipsOk) {
    // Can't even attempt
    toHit = null;
    hit = false;
  } else {
    toHit = await (new Roll(`2d6 + ${piloting}`)).evaluate();
    hit = (toHit.total ?? 0) >= tn;

    if (hit && (opts.showLocation || opts.applyDamage)) {
      locResult = isVehicleTarget
        ? await rollVehicleHitLocation(side, { hasTurret: hasVehicleTurret })
        : await rollKickHitLocation({ targetActor, side, targetType });
    }

    if (hit && opts.applyDamage && targetActor && locResult?.loc) {
      try {
        let r;
        if (isVehicleTarget) {
          const crit = locResult?.critTrigger ? { trigger: true, tableLoc: locResult.critTableLoc } : null;
          r = await applyDamageToVehicleActorAuto(targetActor, locResult.loc, damage, { attackSide: side, crit });
        } else {
          r = await applyDamageToTargetActorAuto(targetActor, locResult.loc, damage, { side });
        }
        damageApplied = r;
      } catch (err) {
        console.warn("AToW Battletech | Kick damage application threw", err);
        damageApplied = { ok: false, reason: String(err?.message ?? err) };
      }
    }
  }

  if (!isVehicleTarget && isMechActor(targetActor) && hit && damage >= 20 && damageApplied?.ok) {
    massiveDamagePsr = await resolveMassiveDamagePSR(targetToken, damage, { source: "Kick attack" });
  }

  // Chat card
  try {
    const attackerName = attackerToken?.name ?? actor.name;
    const targetName = targetToken?.name ?? "Target";

    const header = `<header><b>${weaponMeta.name}</b> — Physical Attack</header>`;
    const facingLine = arc
      ? `<div><b>Target Facing:</b> ${Math.round(arc.facingDeg)}° | <b>Attack Arc:</b> ${side.toUpperCase()}</div>`
      : `<div><b>Attack Arc:</b> ${side.toUpperCase()} (no facing data found)</div>`;

    const legName = (kickLegLoc === "ll") ? "Left Leg" : "Right Leg";

    const notes = [];
    if (!hipsOk) notes.push(`<div style="color:#c00"><b>Cannot Kick:</b> One or both hip actuators are destroyed.</div>`);
    if (actuator?.upperDamagedOrMissing) notes.push(`<div><small>Upper Leg Actuator damaged: kick damage halved.</small></div>`);
    if (actuator?.lowerDamagedOrMissing) notes.push(`<div><small>Lower Leg Actuator damaged: kick damage halved.</small></div>`);

    // PSR reminders (not auto-rolled yet)
    const psrNote = hipsOk
      ? (hit ? `<div><b>PSR:</b> Target must make a Piloting Skill Roll (kicked).</div>` : `<div><b>PSR:</b> Attacker must make a Piloting Skill Roll (missed kick).</div>`)
      : "";

    const lines = [
      `<div class="atow-chat-card atow-mech-attack">`,
      header,
      buildAttackResultBanner({
        hit,
        detail: hipsOk ? `Roll ${toHit?.total ?? "—"} vs TN ${tn}` : "Kick could not be made"
      }),
      `<div><b>Attacker:</b> ${attackerName} | <b>Target:</b> ${targetName}</div>`,
      facingLine,
      `<div><b>Distance:</b> ${distance} (adjacent)</div>`,
      `<div><b>Leg:</b> ${legName}</div>`,
      `<hr/>`,
      `<div><b>Mods</b></div>`,
      `<ul>`,
      `<li>Base TN: ${baseTN} + Kick Mod (${kickTNMod}) = ${tnBase}</li>`,
      `<li>Attacker movement: +${attackerMoveMod}${(String(opts.attackerMoveMode ?? 'auto').toLowerCase() === 'auto') ? ` (auto: ${autoMove.mode.toUpperCase()}, moved ${autoMove.moved})` : ''}</li>`,
      `<li>Target movement: +${targetMoveMod}${Number.isFinite(opts.targetHexes) ? ` (entered: ${opts.targetHexes})` : ` (auto: moved ${autoTargetMove.moved})`}</li>`,
      `<li>Statuses: +${statusTNMods.total}${statusTNMods.details?.length ? ` (${statusTNMods.details.join('; ')})` : ''}</li>`,
      `<li>Terrain: +${terrainMod}</li>`,
      `<li>Other: +${otherMod}</li>`,
      `</ul>`,
      `<div><b>Result</b></div>`,
      hipsOk
        ? `<div>Roll ${toHit?.total ?? "—"} (2d6 + Piloting ${piloting}) vs <b>TN ${tn}</b> → <b>${hit ? "HIT" : "MISS"}</b></div>`
        : `<div><b>—</b></div>`,
      hipsOk && hit ? `<div>Damage <b>${damage}</b> (base ${base})</div>` : "",
      hipsOk && hit && locResult?.loc ? `<div>Loc ${String(locResult.loc).toUpperCase()} (roll ${locResult.roll.total})</div>` : "",
      (hipsOk && hit && opts.applyDamage && damageApplied)
        ? (damageApplied.ok
            ? `<div>Applied: Armor ${damageApplied.armorApplied}, Structure ${damageApplied.structureApplied}</div>`
            : `<div style="color:#c00">NOT applied: ${damageApplied.reason}</div>`)
        : "",
      massiveDamagePsr?.required ? `<div><b>Massive Damage PSR:</b> ${massiveDamagePsr.success ? "Passed" : "Failed - target fell prone."}</div>` : "",
      psrNote,
      ...notes,
      `</div></details></div>`
    ];

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: lines.join(""),
      flavor: `${weaponMeta.name} Attack`,
      rolls: [toHit].filter(Boolean),
      type: CONST.CHAT_MESSAGE_TYPES.ROLL,
      flags: weaponMeta.flags
    }).catch(()=>{});
  } catch (err) {
    console.warn("AToW Battletech | Kick chat card failed", err);
  }

  // Trigger Automated Animations directly (if installed)
  await _maybePlayAutomatedAnimation(attackerToken, null, _getWeaponAutomationMeta({ name: "Kick" }), { targetToken, hit });
  await markMovementResetLockedThisTurn(actor, { attackerToken });

  return {
    attackerTokenId: attackerToken?.id,
    targetTokenId: targetToken?.id,
    distance,
    side,
    targetType,
    piloting,
    attackerMoveMod,
    targetMoveMod,
    terrainMod,
    otherMod,
    statusMods: statusTNMods,
    leg: kickLegLoc,
    hipRequirementMet: hipsOk,
    tn,
    toHit,
    hit,
    damage,
    locResult,
    actuator,
    damageApplied,
    massiveDamagePsr
  };
}

function _tokenJumpedThisTurn(tokenDoc) {
  return Boolean(tokenDoc?.getFlag?.(SYSTEM_ID, "jumpedThisTurn")) ||
    String(tokenDoc?.getFlag?.(SYSTEM_ID, "moveMode") ?? "").toLowerCase() === "jump" ||
    tokenHasStatus(tokenDoc, "atow-jumped");
}

function _chargeMovementAllowance(actor, tokenDoc) {
  const speeds = getActorMoveSpeeds(actor);
  const mode = String(tokenDoc?.getFlag?.(SYSTEM_ID, "moveMode") ?? "").toLowerCase();
  const moved = num(tokenDoc?.getFlag?.(SYSTEM_ID, "movedHexesThisTurn") ?? tokenDoc?.getFlag?.(SYSTEM_ID, "movedThisTurn"), 0);
  const turned = num(tokenDoc?.getFlag?.(SYSTEM_ID, "turnedThisTurn"), 0);
  const terrainMp = num(tokenDoc?.getFlag?.(SYSTEM_ID, "terrainMpThisTurn"), 0);
  const spent = num(tokenDoc?.getFlag?.(SYSTEM_ID, "mpSpentThisTurn"), moved + turned + terrainMp);
  const max = (mode === "walk" || Boolean(tokenDoc?.getFlag?.(SYSTEM_ID, "backwardUsedThisTurn")))
    ? num(speeds.walk, 0)
    : Math.max(num(speeds.run, 0), num(speeds.walk, 0));
  return { moved, turned, terrainMp, spent, max, remaining: Math.max(0, max - spent), mode: mode || "auto" };
}

function calcChargeTargetDamage(attackerActor, hexesMoved) {
  const tons = _mechTonnage(attackerActor);
  const hexes = Math.max(0, Math.floor(num(hexesMoved, 0)));
  return Math.max(0, Math.ceil(tons / 10) * hexes);
}

function calcChargeAttackerDamage(targetActor) {
  const tons = _mechTonnage(targetActor);
  return Math.max(1, Math.ceil(tons / 10));
}

async function applyGroupedMechDamage(targetActor, side, totalDamage, { label = "Charge", applyDamage = true } = {}) {
  const groups = splitIntoNs(Math.max(0, Math.floor(num(totalDamage, 0))), 5);
  const packets = [];
  if (!targetActor || !groups.length) return packets;

  for (const damage of groups) {
    const locResult = await rollHitLocation(side);
    let damageApplied = null;
    if (applyDamage) {
      try {
        damageApplied = await applyDamageToTargetActorAuto(targetActor, locResult.loc, damage, { side });
      } catch (err) {
        console.warn(`AToW Battletech | ${label} grouped damage application threw`, err);
        damageApplied = { ok: false, reason: String(err?.message ?? err) };
      }
    }
    packets.push({ damage, locResult, damageApplied });
  }
  return packets;
}

/**
 * Roll a charge attack.
 *
 * Charge uses the physical attack TN chassis (2d6 + Piloting vs base 8 + mods),
 * requires the target to be adjacent when the attack is rolled, and uses hexes
 * moved so far this Movement Phase for target damage.
 */
export async function rollChargeAttack(actor, opts = {}) {
  if (!actor) return null;

  const weaponMeta = _getWeaponAutomationMeta({ name: "Charge" });
  const attackerToken = opts.attackerToken ?? getAttackerToken(actor);
  const targetToken = opts.targetToken ?? getSingleTargetToken();

  if (!targetToken) {
    ui?.notifications?.warn?.("Select exactly 1 target token before making a charge attack.");
    return null;
  }
  if (!attackerToken) {
    ui?.notifications?.warn?.("Place/control your mech token on the scene before making a charge attack.");
    return null;
  }

  const tokenDoc = attackerToken?.document ?? attackerToken;
  if (_tokenJumpedThisTurn(tokenDoc)) {
    ui?.notifications?.warn?.("A mech that jumped this turn cannot charge.");
    return null;
  }
  if (hasAnyWeaponFiredThisTurn(actor, { attackerToken })) {
    ui?.notifications?.warn?.("A mech that has fired weapons this turn cannot charge.");
    return null;
  }
  if (hasActorChargedThisTurn(actor, tokenDoc)) {
    ui?.notifications?.warn?.("This mech has already charged this turn.");
    return null;
  }

  const targetActor = targetToken?.actor;
  if (!isMechActor(targetActor)) {
    ui?.notifications?.warn?.("Charge automation currently supports mech targets.");
    return null;
  }

  const isShutdown = Boolean(actor.system?.heat?.shutdown) || Boolean(tokenDoc?.getFlag?.(SYSTEM_ID, "shutdown"));
  if (isShutdown) {
    ui?.notifications?.warn?.("This mech is shut down due to heat and cannot charge.");
    return null;
  }

  const distance = Number.isFinite(opts.distance) ? num(opts.distance, 0) : measureTokenDistance(attackerToken, targetToken);
  if (distance === null) {
    ui?.notifications?.warn?.("Couldn't measure distance (no canvas/grid?).");
    return null;
  }
  if (distance > 1) {
    ui?.notifications?.warn?.("Charge attacks are rolled from 1 hex away.");
    return null;
  }

  const allowance = _chargeMovementAllowance(actor, tokenDoc);
  if (allowance.max > 0 && allowance.remaining < 1 && opts.ignoreRemainingMp !== true) {
    ui?.notifications?.warn?.("This mech does not have enough MP remaining to enter the target hex.");
    return null;
  }

  const pilot = actor.system?.pilot ?? {};
  const piloting = num(pilot.piloting, 0);
  if (!piloting) ui?.notifications?.warn?.("No Piloting skill found on this mech (system.pilot.piloting). Using 0.");

  const autoMove = getAutoAttackerMoveMod(actor, attackerToken);
  const attackerMoveMod = Number.isFinite(opts.attackerMoveMod)
    ? num(opts.attackerMoveMod, 0)
    : (() => {
        const mode = String(opts.attackerMoveMode ?? "auto").toLowerCase();
        if (mode === "auto" || mode === "sheet" || mode === "token") return autoMove.mod;
        switch (mode) {
          case "walk": return 1;
          case "run": return 2;
          case "jump": return 3;
          case "stationary":
          default: return 0;
        }
      })();

  const autoTargetMove = getAutoTargetMoveData(targetToken);
  const targetHexesUsed = Number.isFinite(opts.targetHexes) ? num(opts.targetHexes, 0) : autoTargetMove.moved;
  const targetMoveMod = Number.isFinite(opts.targetMoveMod) ? num(opts.targetMoveMod, 0) : calcTargetMoveModFromHexes(targetHexesUsed);
  const terrainMod = num(opts.terrainMod, 0);
  const otherMod = num(opts.otherMod, 0);
  const statusTNMods = getStatusTNMods(attackerToken, targetToken);
  const baseTN = 8;
  const tn = baseTN + attackerMoveMod + targetMoveMod + statusTNMods.total + terrainMod + otherMod;

  const arc = getTargetSideFromFacing(attackerToken, targetToken);
  const side = (opts.side && ["front", "rear", "left", "right"].includes(opts.side)) ? opts.side : (arc?.side ?? "front");
  const chargeHexes = Math.max(0, Math.floor(num(opts.chargeHexes, allowance.moved)));
  const targetDamage = calcChargeTargetDamage(actor, chargeHexes);
  const attackerDamage = calcChargeAttackerDamage(targetActor);

  const toHit = await (new Roll(`2d6 + ${piloting}`)).evaluate();
  const hit = (toHit.total ?? 0) >= tn;

  let targetPackets = [];
  let attackerPackets = [];
  let massiveDamagePsr = null;
  if (hit) {
    targetPackets = await applyGroupedMechDamage(targetActor, side, targetDamage, { label: "Charge target", applyDamage: opts.applyDamage !== false });
    attackerPackets = await applyGroupedMechDamage(actor, "front", attackerDamage, { label: "Charge attacker", applyDamage: opts.applyDamage !== false });
    if (targetDamage >= 20 && targetPackets.some(p => p.damageApplied?.ok)) {
      massiveDamagePsr = await resolveMassiveDamagePSR(targetToken, targetDamage, { source: "Charge attack" });
    }
  }

  await markActorChargedThisTurn(actor, tokenDoc);
  await markMovementResetLockedThisTurn(actor, { attackerToken });

  try {
    const attackerName = attackerToken?.name ?? actor.name;
    const targetName = targetToken?.name ?? "Target";
    const facingLine = arc
      ? `<div><b>Target Facing:</b> ${Math.round(arc.facingDeg)}Â° | <b>Attack Arc:</b> ${side.toUpperCase()}</div>`
      : `<div><b>Attack Arc:</b> ${side.toUpperCase()} (no facing data found)</div>`;
    const packetLine = (packets, ownerLabel) => packets.length
      ? `<div><b>${ownerLabel} Damage Groups</b></div><ul>${packets.map(p => {
          const loc = String(p.locResult?.loc ?? "?").toUpperCase();
          const roll = p.locResult?.roll?.total ?? "?";
          const applied = (opts.applyDamage !== false && p.damageApplied)
            ? (p.damageApplied.ok
                ? ` | Applied: Armor ${p.damageApplied.armorApplied}, Structure ${p.damageApplied.structureApplied}`
                : ` | <span style="color:#c00">NOT applied: ${p.damageApplied.reason}</span>`)
            : "";
          return `<li>${p.damage} dmg to ${loc} (location roll ${roll})${applied}</li>`;
        }).join("")}</ul>`
      : "";

    const guidance = hit
      ? `<div><b>Movement:</b> If the attacker survives, move it into the target hex. If the target survives, displace it one hex in the charge direction unless prohibited terrain, board edge, or another mech changes the result.</div>`
      : `<div><b>Movement:</b> Missed charge. Attacker chooses the legal hex to the left or right of its forward arc; if neither is legal, it does not move.</div>`;
    const backwardNote = Boolean(tokenDoc?.getFlag?.(SYSTEM_ID, "backwardUsedThisTurn"))
      ? `<div><small>Backward movement was used this turn; charge damage should count only hexes after the last reversal. The dialog value was used for this roll.</small></div>`
      : "";

    const lines = [
      `<div class="atow-chat-card atow-mech-attack">`,
      `<header><b>${weaponMeta.name}</b> â€” Physical Attack</header>`,
      buildAttackResultBanner({ hit, detail: `Roll ${toHit.total} vs TN ${tn}` }),
      `<div><b>Attacker:</b> ${attackerName} | <b>Target:</b> ${targetName}</div>`,
      facingLine,
      `<div><b>Distance:</b> ${distance} (adjacent)</div>`,
      `<hr/>`,
      `<div><b>Mods</b></div>`,
      `<ul>`,
      `<li>Base TN: ${baseTN}</li>`,
      `<li>Attacker movement: +${attackerMoveMod}${(String(opts.attackerMoveMode ?? 'auto').toLowerCase() === 'auto') ? ` (auto: ${autoMove.mode.toUpperCase()}, moved ${autoMove.moved})` : ''}</li>`,
      `<li>Target movement: +${targetMoveMod}${Number.isFinite(opts.targetHexes) ? ` (entered: ${opts.targetHexes})` : ` (auto: moved ${autoTargetMove.moved})`}</li>`,
      `<li>Statuses: +${statusTNMods.total}${statusTNMods.details?.length ? ` (${statusTNMods.details.join('; ')})` : ''}</li>`,
      `<li>Terrain: +${terrainMod}</li>`,
      `<li>Other: +${otherMod}</li>`,
      `</ul>`,
      `<div><b>Result:</b> Roll ${toHit.total} (2d6 + Piloting ${piloting}) vs <b>TN ${tn}</b> â†’ <b>${hit ? "HIT" : "MISS"}</b></div>`,
      `<div><b>Charge Hexes:</b> ${chargeHexes} | <b>Target Damage:</b> ${targetDamage} | <b>Attacker Damage:</b> ${attackerDamage}</div>`,
      backwardNote,
      hit ? packetLine(targetPackets, targetName) : "",
      hit ? packetLine(attackerPackets, attackerName) : "",
      massiveDamagePsr?.required ? `<div><b>Massive Damage PSR:</b> ${massiveDamagePsr.success ? "Passed" : "Failed - target fell prone."}</div>` : "",
      hit ? `<div><b>PSR:</b> Target should make the required Piloting Skill Roll to avoid falling after the charge.</div>` : "",
      guidance,
      `<div><small>Weapon attacks are blocked for this mech for the rest of this combat turn.</small></div>`,
      `</div></details></div>`
    ];

    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: lines.join(""),
      flavor: `${weaponMeta.name} Attack`,
      rolls: [toHit, ...targetPackets.map(p => p.locResult?.roll).filter(Boolean), ...attackerPackets.map(p => p.locResult?.roll).filter(Boolean)],
      type: CONST.CHAT_MESSAGE_TYPES.ROLL,
      flags: {
        ...weaponMeta.flags,
        [SYSTEM_ID]: {
          ...(weaponMeta.flags?.[SYSTEM_ID] ?? {}),
          action: "chargeAttack",
          chargeAttack: true,
          hit,
          targetDamage,
          attackerDamage,
          chargeHexes
        }
      }
    }).catch(()=>{});
  } catch (err) {
    console.warn("AToW Battletech | Charge chat card failed", err);
  }

  await _maybePlayAutomatedAnimation(attackerToken, null, weaponMeta, { targetToken, hit });

  return {
    attackerTokenId: attackerToken?.id,
    targetTokenId: targetToken?.id,
    distance,
    side,
    piloting,
    attackerMoveMod,
    targetMoveMod,
    terrainMod,
    otherMod,
    statusMods: statusTNMods,
    chargeHexes,
    targetDamage,
    attackerDamage,
    tn,
    toHit,
    hit,
    targetPackets,
    attackerPackets,
    massiveDamagePsr
  };
}

export async function promptAndRollMeleeAttack(actor, meleeType = "punch", { defaultSide = "front" } = {}) {
  const type = String(meleeType ?? "punch").toLowerCase();

  if (type !== "punch" && type !== "kick" && type !== "charge") {
    ui?.notifications?.warn?.(`${String(meleeType)} is not implemented yet.`);
    return null;
  }

  const attackerToken = getAttackerToken(actor);
  const targetToken = getSingleTargetToken();

  if (!targetToken) {
    ui?.notifications?.warn?.("Select exactly 1 target token before making an attack.");
    return null;
  }
  if (!attackerToken) {
    ui?.notifications?.warn?.("Place/control your mech token on the scene before making an attack.");
    return null;
  }

  const distance = measureTokenDistance(attackerToken, targetToken);
  if (distance === null) {
    ui?.notifications?.warn?.("Couldn't measure distance (no canvas/grid?).");
    return null;
  }
  if (distance > 1) {
    const label = type === "kick" ? "Kick" : type === "charge" ? "Charge" : "Punch";
    ui?.notifications?.warn?.(`${label} attacks require the target to be adjacent (range 1).`);
    return null;
  }

  const arc = getTargetSideFromFacing(attackerToken, targetToken);
  const computedSide = arc?.side ?? defaultSide;

  const autoTargetMove = getAutoTargetMoveData(targetToken);
  const statusTNMods = getStatusTNMods(attackerToken, targetToken);
  const tokenDoc = attackerToken?.document ?? attackerToken;
  const chargeAllowance = _chargeMovementAllowance(actor, tokenDoc);
  if (type === "charge") {
    if (_tokenJumpedThisTurn(tokenDoc)) {
      ui?.notifications?.warn?.("A mech that jumped this turn cannot charge.");
      return null;
    }
    if (hasAnyWeaponFiredThisTurn(actor, { attackerToken })) {
      ui?.notifications?.warn?.("A mech that has fired weapons this turn cannot charge.");
      return null;
    }
    if (hasActorChargedThisTurn(actor, tokenDoc)) {
      ui?.notifications?.warn?.("This mech has already charged this turn.");
      return null;
    }
    if (chargeAllowance.max > 0 && chargeAllowance.remaining < 1) {
      ui?.notifications?.warn?.("This mech does not have enough MP remaining to enter the target hex.");
      return null;
    }
  }

  const commonFields = `
    <div class="form-group">
      <label>Target</label>
      <div><b>${targetToken.name}</b></div>
    </div>

    <div class="form-group">
      <label>Distance</label>
      <div>${distance} (adjacent)</div>
      <input type="hidden" name="distance" value="${distance}"/>
    </div>

    <div class="form-group">
      <label>Target Type</label>
      <select name="targetType">
        <option value="biped" selected>Biped</option>
        <option value="quad">Quad</option>
      </select>
      <small>Used for physical hit-location tables (where applicable).</small>
    </div>

    <div class="form-group">
      <label>Auto status mods</label>
      <div><small>Applied automatically: +${statusTNMods.total} (${statusTNMods.details.join("; ") || "none"})</small></div>
    </div>

    <div class="form-group">
      <label>Attacker Move</label>
      <select name="attackerMoveMode">
        <option value="auto" selected>Auto (from movement)</option>
        <option value="stationary">Stationary</option>
        <option value="walk">Walk (+1)</option>
        <option value="run">Run (+2)</option>
        <option value="jump">Jump (+3)</option>
      </select>
    </div>

    <div class="form-group">
      <label>Target Hexes Moved</label>
      <input type="number" name="targetHexes" value="${autoTargetMove.moved}" min="0"/>
      <small>Auto-filled from target displacement this turn. Override if needed.</small>
    </div>

    <div class="form-group">
      <label>Terrain Mod</label>
      <input type="number" name="terrainMod" value="0"/>
    </div>

    <div class="form-group">
      <label>Other Mod</label>
      <input type="number" name="otherMod" value="0"/>
    </div>

    <div class="form-group">
      <label>Hit Side (auto-detected)</label>
      <select name="side">
        <option value="front" ${computedSide === "front" ? "selected" : ""}>Front</option>
        <option value="rear"  ${computedSide === "rear" ? "selected" : ""}>Rear</option>
        <option value="left"  ${computedSide === "left" ? "selected" : ""}>Left</option>
        <option value="right" ${computedSide === "right" ? "selected" : ""}>Right</option>
      </select>
      <small>${arc ? `Target facing ${Math.round(arc.facingDeg)}° → arc ${computedSide.toUpperCase()}` : `No facing data found; defaulting to ${computedSide.toUpperCase()}`}</small>
    </div>

    <div class="form-group">
      <label><input type="checkbox" name="applyDamage" checked/> Apply Damage (auto)</label>
    </div>

    <div class="form-group">
      <label><input type="checkbox" name="showLocation" checked/> Roll Hit Location on Hit</label>
    </div>
  `;

  const punchFields = `
    <div class="form-group">
      <label>Arms</label>
      <select name="arms">
        <option value="both" selected>Both Arms (2 attacks)</option>
        <option value="left">Left Arm</option>
        <option value="right">Right Arm</option>
      </select>
    </div>
  `;

  const kickFields = `
    <div class="form-group">
      <label>Kicking Leg</label>
      <select name="leg">
        <option value="right" selected>Right Leg</option>
        <option value="left">Left Leg</option>
      </select>
      <small>Note: per rules, both hip actuators must be undamaged to attempt a kick.</small>
    </div>
  `;

  const chargeFields = `
    <div class="form-group">
      <label>Charge Hexes Moved</label>
      <input type="number" name="chargeHexes" value="${Math.max(0, Math.floor(chargeAllowance.moved))}" min="0"/>
      <small>Do not count the target hex. If movement reversed, enter only hexes after the last reversal.</small>
    </div>
    <div class="form-group">
      <label>MP Check</label>
      <div><small>Remaining MP before target hex: ${chargeAllowance.remaining}/${chargeAllowance.max || "?"}${chargeAllowance.mode ? ` (${chargeAllowance.mode})` : ""}</small></div>
    </div>
  `;

  const dialogHtml = `
  <form class="atow-attack-dialog">
    ${commonFields}
    ${type === "punch" ? punchFields : type === "kick" ? kickFields : chargeFields}
  </form>`;

  const title = (type === "kick") ? `Kick — Physical Attack` : (type === "charge") ? `Charge — Physical Attack` : `Punch — Physical Attack`;

  return new Promise((resolve) => {
    new Dialog({
      title,
      content: dialogHtml,
      buttons: {
        roll: {
          icon: '<i class="fas fa-dice"></i>',
          label: "Roll",
          callback: async (html) => {
            const form = html[0].querySelector("form.atow-attack-dialog");
            const fd = new FormData(form);
            const opts = {
              attackerToken,
              targetToken,
              distance: num(fd.get("distance"), 0),
              targetType: String(fd.get("targetType") ?? "biped"),
              attackerMoveMode: String(fd.get("attackerMoveMode") ?? "auto"),
              targetHexes: num(fd.get("targetHexes"), 0),
              terrainMod: num(fd.get("terrainMod"), 0),
              otherMod: num(fd.get("otherMod"), 0),
              side: String(fd.get("side") ?? computedSide),
              applyDamage: fd.get("applyDamage") === "on",
              showLocation: fd.get("showLocation") === "on"
            };

            if (type === "punch") {
              opts.arms = String(fd.get("arms") ?? "both");
              const result = await rollPunchAttack(actor, opts);
              resolve(result);
              return;
            }

            if (type === "kick") {
              opts.leg = String(fd.get("leg") ?? "right");
              const result = await rollKickAttack(actor, opts);
              resolve(result);
              return;
            }

            opts.chargeHexes = num(fd.get("chargeHexes"), chargeAllowance.moved);
            const result = await rollChargeAttack(actor, opts);
            resolve(result);
          }
        },
        cancel: {
          label: "Cancel",
          callback: () => resolve(null)
        }
      },
      default: "roll"
    }).render(true);
  });
}
// ------------------------------------------------------------
// Automatic Damage Application
// Applies damage to target armor first, then internal structure.
// Expects target actor data shaped like:
//  system.armor.<loc>.{max,dmg}
//  system.structure.<loc>.{max,dmg}
// Rear torso armor uses keys: back, lback, rback.
// ------------------------------------------------------------
/* -------------------------------------------- */
/*  Critical Hits (first pass)                  */
/* -------------------------------------------- */

/**
 * Determine critical-hit outcome from a 2d6 critical check roll.
 *
 * Table (TW / standard BT):
 * 2–7: no critical hit
 * 8–9: roll 1 critical hit location
 * 10–11: roll 2 critical hit locations
 * 12: head/limb blown off (if head or limb); otherwise roll 3 critical hit locations
 */
const _LIMB_LOCS = new Set(["la", "ra", "ll", "rl", "lfl", "lrl", "rfl", "rrl"]);

function _critOutcomeFromCheckTotal(total, structLoc) {
  const t = Number(total ?? 0);
  const loc = String(structLoc ?? "").toLowerCase();

  if (t <= 7) return { critCount: 0, blownOff: false };
  if (t <= 9) return { critCount: 1, blownOff: false };
  if (t <= 11) return { critCount: 2, blownOff: false };

  // 12
  if (loc === "head" || _LIMB_LOCS.has(loc)) return { critCount: 0, blownOff: true };
  return { critCount: 3, blownOff: false };
}

function _isOccupiedCritSlot(slot) {
  if (!slot) return false;
  if (typeof slot === "string") return slot.trim().length > 0;
  const label = String(slot.label ?? "").trim();
  const uuid = String(slot.uuid ?? "").trim();
  return label.length > 0 || uuid.length > 0;
}

function _critHitTypeFromLabel(label) {
  const l = String(label ?? "").toLowerCase();
  if (!l) return null;
  if (l.includes("engine")) return "engine";
  if (l.includes("gyro")) return "gyro";
  if (l.includes("sensor")) return "sensor";
  if (l.includes("life support")) return "lifeSupport";
  return null;
}

const _CRIT_HIT_LIMITS = { engine: 3, gyro: 2, sensor: 2, lifeSupport: 1 };

function _isFerroFibrousCritSlot(slot) {
  const label = (typeof slot === "string") ? slot : (slot?.label ?? slot?.name ?? "");
  const compact = String(label ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return compact.includes("ferrofibrous");
}

function _isCritRerollSlot(slot) {
  const label = (typeof slot === "string") ? slot : (slot?.label ?? slot?.name ?? "");
  const compact = String(label ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return compact.includes("ferrofibrous") || compact.includes("endosteel");
}

async function _rollCritSlotIndex(targetActor, structLoc) {
  const rawSlots = targetActor.system?.crit?.[structLoc]?.slots;
  const maxSlots = Array.isArray(rawSlots) ? rawSlots.length : Number(targetActor.system?.crit?.[structLoc]?.maxSlots ?? 0) || 0;

  // Best-effort inference: torsos are 12 slots (upper/lower), everything else is 6
  const isTorsoLoc = ["ct", "lt", "rt"].includes(structLoc);
  const size = isTorsoLoc ? 12 : 6;
  const slotCap = Math.max(size, maxSlots);
  const slots = Array.from({ length: slotCap }, () => ({}));

  // If we don't have a crit table for this location, abort.
  if (!rawSlots || (Array.isArray(rawSlots) && rawSlots.length === 0) || (!Array.isArray(rawSlots) && Object.keys(rawSlots).length === 0)) {
    return { ok: false, reason: "No crit table" };
  }

  if (Array.isArray(rawSlots)) {
    for (let i = 0; i < Math.min(slotCap, rawSlots.length); i++) slots[i] = rawSlots[i] ?? {};
  } else if (rawSlots && typeof rawSlots === "object") {
    for (const [k, v] of Object.entries(rawSlots)) {
      const idx = Number(k);
      if (!Number.isNaN(idx) && idx >= 0 && idx < slotCap) slots[idx] = v ?? {};
    }
  }

  // Rule handling:
  // - Re-roll if the selected crit slot was already destroyed.
  // - Multi-slot equipment can still take multiple crits, because each intact occupied
  //   slot within that component remains a valid target until it too is destroyed.
  let hasIntactOccupiedSlot = false;
  const slotCount = Math.min(slots.length, size);
  for (let i = 0; i < slotCount; i++) {
    const slot = slots?.[i];
    if (!_isOccupiedCritSlot(slot)) continue;
    if (_isCritRerollSlot(slot)) continue;
    if (Boolean(slot?.destroyed)) continue;
    hasIntactOccupiedSlot = true;
    break;
  }
  if (!hasIntactOccupiedSlot) {
    return { ok: false, reason: "No intact occupied crit slots" };
  }

  // Try up to N times to avoid infinite loops if everything is empty
  const MAX_TRIES = 50;

  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    if (size === 6) {
      const r = await (new Roll("1d6")).evaluate();
      const idx = (r.total ?? 1) - 1;
      const slot = slots?.[idx];
      if (_isOccupiedCritSlot(slot) && !_isCritRerollSlot(slot) && !Boolean(slot?.destroyed)) {
        return { ok: true, idx, rolls: { slot: r.total }, label: slot?.label ?? slot };
      }
      continue;
    }

    // 12-slot locations: roll upper/lower first (1-3 upper, 4-6 lower), then roll within that band
    const bandRoll = await (new Roll("1d6")).evaluate();
    const upper = (bandRoll.total ?? 1) <= 3;
    const offset = upper ? 0 : 6;

    const slotRoll = await (new Roll("1d6")).evaluate();
    const idx = offset + ((slotRoll.total ?? 1) - 1);

    const slot = slots?.[idx];
    if (_isOccupiedCritSlot(slot) && !_isCritRerollSlot(slot) && !Boolean(slot?.destroyed)) {
      return {
        ok: true,
        idx,
        rolls: { band: bandRoll.total, slot: slotRoll.total, bandName: upper ? "upper" : "lower" },
        label: slot?.label ?? slot,
        wasDestroyed: Boolean(slot?.destroyed)
      };
    }
  }

  return { ok: false, reason: "No occupied crit slots" };
}


async function applyDamageToTargetActor(targetActor, hitLoc, damage, { side = "front", internalFirstStartLoc = false, tac = false, tacLoc = null, preventTransfer = false } = {}) {
  if (!targetActor) return { ok: false, reason: "No target actor" };

  let loc = _normalizeDamageLocation(targetActor, String(hitLoc ?? "").toLowerCase());
  let remaining = Number(damage ?? 0);
  const initialDamage = remaining;
  let transferBlocked = false;

  if (!loc) return { ok: false, reason: "No hit location" };
  if (!Number.isFinite(remaining) || remaining <= 0) return { ok: false, reason: "No damage" };

  const s = String(side ?? "front").toLowerCase();

  // Structure transfer mapping (inward)
  // Limbs -> adjacent torso -> center torso
  const TRANSFER = {
  la: "lt",
  ll: "lt",
  // Quad legs (if present)
  lfl: "lt",
  lrl: "lt",
  ra: "rt",
  rl: "rt",
  rfl: "rt",
  rrl: "rt",
  lt: "ct",
  rt: "ct"
  // ct/head have no transfer in this first pass
};

  const isTorso = (k) => ["ct", "lt", "rt"].includes(k);

  // If caller passed rear torso armor keys, normalize to structure location keys
  if (loc === "back") loc = "ct";
  else if (loc === "lback") loc = "lt";
  else if (loc === "rback") loc = "rt";

  const armorKeyFor = (structLoc) => {
    // default: same key
    let armorLoc = structLoc;

    // Rear torso mapping
    if (s === "rear" && isTorso(structLoc)) {
      if (structLoc === "ct") armorLoc = "back";
      else if (structLoc === "lt") armorLoc = "lback";
      else if (structLoc === "rt") armorLoc = "rback";
    }

    return armorLoc;
  };

  // Local working copies so multi-location transfers update in one actor.update
  const armorState = {};     // key -> { max, dmg, exists }
  const structState = {};    // key -> { max, dmg, exists }
  const touched = { armor: new Set(), structure: new Set() };

// Critical hit bookkeeping (internal damage -> critical check)
const critEvents = [];
const critHitDelta = { engine: 0, gyro: 0, sensor: 0, lifeSupport: 0 };
// Extra staged crit-slot destruction (e.g., limb/head blown off)
const forcedCritSlotUpdates = {};


  const readArmor = (armorLoc) => {
    if (armorState[armorLoc]) return armorState[armorLoc];
    const node = targetActor.system?.armor?.[armorLoc];
    armorState[armorLoc] = {
      max: Number(node?.max ?? 0),
      dmg: Number(node?.dmg ?? 0),
      exists: !!node
    };
    return armorState[armorLoc];
  };

  const readStruct = (structLoc) => {
    if (structState[structLoc]) return structState[structLoc];
    const node = targetActor.system?.structure?.[structLoc];
    structState[structLoc] = {
      max: Number(node?.max ?? 0),
      dmg: Number(node?.dmg ?? 0),
      exists: !!node
    };
    return structState[structLoc];
  };

  const steps = [];
  const startLoc = loc;
  const newlyDestroyedCritSlots = [];
  const newlyDestroyedLocations = new Set();

  // - Set armor + structure to fully destroyed for that location
  // - Destroy all occupied crit slots in that location
  // Note: best-effort automation. If a slot is stored as a plain string, we still record it for
  //       logging/ammo checks, but we won't attempt to set .destroyed.
  const stageBlowOffLocation = (blowLoc) => {
    const bLoc = String(blowLoc ?? "").toLowerCase();
    if (!bLoc) return;

    const armorLoc = armorKeyFor(bLoc);
    const armor = readArmor(armorLoc);
    if (armor?.exists) {
      const armorMax = Number.isFinite(armor.max) ? armor.max : 0;
      const armorDmg = Number.isFinite(armor.dmg) ? armor.dmg : 0;
      armor.dmg = clamp(armorMax, 0, armorMax);
      if (armorDmg !== armor.dmg) touched.armor.add(armorLoc);
    }

    const structure = readStruct(bLoc);
    if (structure?.exists) {
      const structMax = Number.isFinite(structure.max) ? structure.max : 0;
      const structDmg = Number.isFinite(structure.dmg) ? structure.dmg : 0;
      structure.dmg = clamp(structMax, 0, structMax);
      if (structMax > 0 && structDmg < structMax) newlyDestroyedLocations.add(bLoc);
      touched.structure.add(bLoc);
    }

    const slots = targetActor.system?.crit?.[bLoc]?.slots;
    const iter = Array.isArray(slots) ? slots.entries() : Object.entries(slots ?? {});
    for (const [idxRaw, slot] of iter) {
      const idx = Number(idxRaw);
      if (!Number.isFinite(idx)) continue;
      if (!_isOccupiedCritSlot(slot)) continue;
      if (typeof slot === "object" && slot?.destroyed) continue;

      if (typeof slot === "object") {
        forcedCritSlotUpdates[`system.crit.${bLoc}.slots.${idx}.destroyed`] = true;
      }

      const label = (typeof slot === "string") ? slot : (slot?.label ?? "");
      newlyDestroyedCritSlots.push({ loc: bLoc, idx, label });

      const hitType = _critHitTypeFromLabel(label);
      if (hitType) critHitDelta[hitType] = (critHitDelta[hitType] ?? 0) + 1;
    }
  };

  while (remaining > 0) {
    // Determine armor track key for this structure location
    let armorLoc = armorKeyFor(loc);
    let armor = readArmor(armorLoc);

    // Rear torso fallback if rear keys don't exist: use front torso armor
    if (s === "rear" && isTorso(loc) && !armor.exists) {
      armorLoc = loc;
      armor = readArmor(armorLoc);
    }

    const structure = readStruct(loc);

    // If neither track exists, we can't apply or transfer
    if (!armor.exists && !structure.exists) {
      return {
        ok: false,
        reason: `No armor/structure track for ${loc}`,
        startLoc,
        hitLoc: loc,
        remaining
      };
    }

    const beforeRemaining = remaining;

    const internalFirstHere = Boolean(internalFirstStartLoc) && loc === startLoc && steps.length === 0;

    // Armor first (unless this is an internal-first source like an ammo explosion)
    let armorApplied = 0;
    if (!internalFirstHere) {
      const armorMax = Number.isFinite(armor.max) ? armor.max : 0;
      const armorDmg = Number.isFinite(armor.dmg) ? armor.dmg : 0;
      const armorRemaining = Math.max(0, armorMax - armorDmg);
      armorApplied = armor.exists ? Math.min(remaining, armorRemaining) : 0;
      remaining -= armorApplied;

      if (armorApplied > 0) {
        armor.dmg = clamp(armorDmg + armorApplied, 0, armorMax);
        touched.armor.add(armorLoc);
      }
    }

    // Then structure

    const structMax = Number.isFinite(structure.max) ? structure.max : 0;
    const structDmg = Number.isFinite(structure.dmg) ? structure.dmg : 0;
    const structRemaining = Math.max(0, structMax - structDmg);
    const wasDestroyed = (structure.exists && structMax > 0 && structDmg >= structMax);
    const structureApplied = structure.exists ? Math.min(remaining, structRemaining) : 0;
    remaining -= structureApplied;

    if (structureApplied > 0) {
      structure.dmg = clamp(structDmg + structureApplied, 0, structMax);
      touched.structure.add(loc);

      const nowDestroyed = (structure.exists && structMax > 0 && structure.dmg >= structMax);
      if (nowDestroyed && !wasDestroyed) newlyDestroyedLocations.add(loc);

      // Roll critical check once whenever internal structure damage is dealt to a location
      try {
        const check = await (new Roll("2d6")).evaluate();
        const checkTotal = check.total ?? 0;
        const outcome = _critOutcomeFromCheckTotal(checkTotal, loc);
        const critEntry = {
          loc,
          checkTotal,
          critCount: outcome.critCount,
          blownOff: Boolean(outcome.blownOff),
          tac: false,
          crits: []
        };

        // 12 on head/limb: blow off instead of rolling crit slots
        if (outcome.blownOff) {
          stageBlowOffLocation(loc);
          critEvents.push(critEntry);
        } else {
          for (let c = 0; c < outcome.critCount; c++) {
            const pick = await _rollCritSlotIndex(targetActor, loc);
            if (!pick.ok) {
              critEntry.crits.push({ ok: false, reason: pick.reason });
              continue;
            }

            // Mark that specific crit slot as destroyed/damaged
            // Note: crit slots remain valid targets even if already destroyed
            critEntry.crits.push({ ok: true, idx: pick.idx, rolls: pick.rolls, label: pick.label, wasDestroyed: Boolean(pick.wasDestroyed) });

            // Stage the update; we apply it with the main damage update below
            const updateKey = `system.crit.${loc}.slots.${pick.idx}.destroyed`;
            critEntry.crits[critEntry.crits.length - 1].updateKey = updateKey;

            if (!pick.wasDestroyed) newlyDestroyedCritSlots.push({ loc, idx: pick.idx, label: pick.label });

            const hitType = _critHitTypeFromLabel(pick.label);
            if (hitType && !pick.wasDestroyed) critHitDelta[hitType] = (critHitDelta[hitType] ?? 0) + 1;
          }

          critEvents.push(critEntry);
        }
      } catch (err) {
        console.warn("AToW Battletech | Critical roll failed", err);
      }
}

    const destroyed = (structure.exists && structMax > 0 && structure.dmg >= structMax);

    steps.push({
      loc,
      armorLoc,
      applied: beforeRemaining - remaining,
      armorApplied,
      structureApplied,
      destroyed,
      remainingAfter: remaining
    });

    // If damage still remains, transfer inward (unless prevented, e.g. CASE-contained ammo explosions)
    if (remaining > 0) {
      if (preventTransfer) { transferBlocked = true; break; }
      const next = TRANSFER[loc];
      if (!next) break;
      loc = next;
      continue;
    }

    break;
  }

  // --- Through-Armor Critical Hit (TAC) ---
  // If the hit-location table roll was a 2, a TAC critical check may occur even without internal damage,
  // provided at least 1 point of damage was actually dealt. This TAC check is *in addition* to any
  // normal internal-structure critical checks.
  const totalApplied = initialDamage - remaining;
  if (tac && totalApplied >= 1) {
    try {
      let tacLocKey = _normalizeDamageLocation(targetActor, String(tacLoc ?? startLoc).toLowerCase());

      // If caller passed rear torso armor keys, normalize to structure location keys
      if (tacLocKey === "back") tacLocKey = "ct";
      else if (tacLocKey === "lback") tacLocKey = "lt";
      else if (tacLocKey === "rback") tacLocKey = "rt";

      // If a TAC is scored on an already-destroyed side torso, apply the TAC to the center torso.
      if (tacLocKey === "lt" || tacLocKey === "rt") {
        const node = targetActor.system?.structure?.[tacLocKey];
        const m = Number(node?.max ?? 0);
        const d = Number(node?.dmg ?? 0);
        if (m > 0 && d >= m) tacLocKey = "ct";
      }

      const check = await (new Roll("2d6")).evaluate();
      const checkTotal = check.total ?? 0;
      const outcome = _critOutcomeFromCheckTotal(checkTotal, tacLocKey);
      const critEntry = {
        loc: tacLocKey,
        checkTotal,
        critCount: outcome.critCount,
        blownOff: Boolean(outcome.blownOff),
        tac: true,
        crits: []
      };

      // 12 on head/limb: blow off instead of rolling crit slots
      if (outcome.blownOff) {
        stageBlowOffLocation(tacLocKey);
        critEvents.push(critEntry);
      } else {
        for (let c = 0; c < outcome.critCount; c++) {
          const pick = await _rollCritSlotIndex(targetActor, tacLocKey);
          if (!pick.ok) {
            critEntry.crits.push({ ok: false, reason: pick.reason });
            continue;
          }

          critEntry.crits.push({ ok: true, idx: pick.idx, rolls: pick.rolls, label: pick.label, wasDestroyed: Boolean(pick.wasDestroyed) });

          const updateKey = `system.crit.${tacLocKey}.slots.${pick.idx}.destroyed`;
          critEntry.crits[critEntry.crits.length - 1].updateKey = updateKey;

          if (!pick.wasDestroyed) newlyDestroyedCritSlots.push({ loc: tacLocKey, idx: pick.idx, label: pick.label });

          const hitType = _critHitTypeFromLabel(pick.label);
          if (hitType && !pick.wasDestroyed) critHitDelta[hitType] = (critHitDelta[hitType] ?? 0) + 1;
        }

        critEvents.push(critEntry);
      }
    } catch (err) {
      console.warn("AToW Battletech | TAC critical roll failed", err);
    }
  }


  // Build update payload from touched state
  const updates = {};
  for (const armorLoc of touched.armor) {
    updates[`system.armor.${armorLoc}.dmg`] = armorState[armorLoc].dmg;
  }
  for (const structLoc of touched.structure) {
    updates[`system.structure.${structLoc}.dmg`] = structState[structLoc].dmg;
  }

// Apply critical slot destruction updates (if any)
for (const ev of critEvents) {
  for (const c of (ev.crits ?? [])) {
    if (c?.ok && c.updateKey) updates[c.updateKey] = true;
  }
}

// Apply forced crit slot updates (e.g., limb/head blown off)
for (const [k, v] of Object.entries(forcedCritSlotUpdates)) {
  updates[k] = v;
}

// Increment crit hit trackers (engine/gyro/sensor/life support), clamped to known limits
const currentCritHits = targetActor.system?.critHits ?? {};
for (const [k, delta] of Object.entries(critHitDelta)) {
  const lim = _CRIT_HIT_LIMITS[k] ?? 99;
  const cur = Number(currentCritHits?.[k] ?? 0);
  const next = clamp(cur + Number(delta ?? 0), 0, lim);
  if (next !== cur) updates[`system.critHits.${k}`] = next;
}


  try {
    if (Object.keys(updates).length) await targetActor.update(updates);
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e), startLoc, hitLoc: startLoc, remaining };
  }

  let pilotHit = null;
  if (startLoc === "head" && totalApplied > 0 && isMechActor(targetActor)) {
    pilotHit = await applyMechPilotHit(targetActor, { reason: "Head hit" }).catch(err => {
      console.warn("AToW Battletech | Pilot hit from head damage failed", err);
      return null;
    });
  }

  // ---- Extra Crit Chat Message ----
  // Create a separate chat message whenever a critical hit (or blow-off) occurs.
  // Includes whether the optional Floating Criticals rule is enabled and whether it was triggered (TAC opportunity).
  try {
    const floatingEnabled = Boolean(game?.settings?.get?.(SYSTEM_ID, "floatingCrits"));
    const floatingUsed = floatingEnabled && Boolean(tac);

    const importantCrits = (critEvents ?? []).filter(ev => Number(ev?.critCount ?? 0) > 0 || Boolean(ev?.blownOff));
    if (importantCrits.length) {
      const locName = (k) => {
        const key = String(k ?? "").toLowerCase();
        switch (key) {
          case "head": return "Head";
          case "ct": return "Center Torso";
          case "lt": return "Left Torso";
          case "rt": return "Right Torso";
          case "la": return "Left Arm";
          case "ra": return "Right Arm";
          case "ll": return "Left Leg";
          case "rl": return "Right Leg";
          default: return String(k ?? "").toUpperCase() || "Unknown";
        }
      };

      const lines = [];
      lines.push(`<div style="border:1px solid #a00; padding:0.5rem; border-radius:6px; background:rgba(140,0,0,0.08);">`);
      lines.push(`<div style="font-weight:800; color:#b00; letter-spacing:0.02em;">CRITICAL HIT${importantCrits.length > 1 ? "S" : ""}</div>`);
      lines.push(`<div style="margin-top:0.25rem;"><b>${targetActor?.name ?? "Target"}</b> — Floating Criticals: <b>${floatingEnabled ? "ON" : "OFF"}</b>${floatingUsed ? " (used)" : ""}</div>`);
      if (floatingEnabled) {
        lines.push(`<div style="font-size:0.9em; opacity:0.9;">${floatingUsed ? "TAC trigger present — floating location reroll applied." : "No TAC trigger — floating location reroll not used."}</div>`);
      }
      lines.push(`<hr style="margin:0.35rem 0;">`);

      for (const ev of importantCrits) {
        const isTac = Boolean(ev?.tac);
        const checkTotal = Number(ev?.checkTotal ?? 0);
        const critCount = Number(ev?.critCount ?? 0);
        const blownOff = Boolean(ev?.blownOff);

        const typeLabel = isTac ? "TAC Critical Check" : "Critical Check";
        const outcomeLabel = blownOff ? "Blown Off" : `${critCount} Critical${critCount === 1 ? "" : "s"}`;

        lines.push(`<div><b>${typeLabel}</b> — <b>${locName(ev?.loc)}</b> (2d6=${checkTotal}) → <b>${outcomeLabel}</b></div>`);

        if (!blownOff) {
          const crits = Array.isArray(ev?.crits) ? ev.crits : [];
          if (!crits.length) {
            lines.push(`<div style="margin-left:1rem; opacity:0.85;">No crit slot selections recorded.</div>`);
          } else {
            lines.push(`<ul style="margin:0.25rem 0 0.25rem 1.2rem;">`);
            for (const c of crits) {
              if (!c?.ok) {
                lines.push(`<li style="opacity:0.85;"><i>${c?.reason ?? "Failed to select crit slot."}</i></li>`);
                continue;
              }
              const idx = Number(c?.idx);
              const label = String(c?.label ?? "").trim() || `Slot ${Number.isFinite(idx) ? idx + 1 : "?"}`;
              const already = c?.wasDestroyed ? " (already destroyed)" : "";
              lines.push(`<li>Slot ${Number.isFinite(idx) ? idx + 1 : "?"}: <b>${label}</b>${already}</li>`);
            }
            lines.push(`</ul>`);
          }
        }
      }

      lines.push(`</div>`);
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: targetActor }),
        content: lines.join("")
      }).catch(() => {});
    }
  } catch (err) {
    console.warn("AToW Battletech | Crit chat message failed", err);
  }

  return {
    ok: true,
    startLoc,
    hitLoc: startLoc,
    damage: Number(damage ?? 0),
    steps,
    overflow: remaining,
    transferBlocked,
    newlyDestroyedCritSlots,
    newlyDestroyedLocations: Array.from(newlyDestroyedLocations),
    pilotHit,
    // Useful for testing/verification in chat cards and logs
    critEvents: (critEvents ?? []).map(ev => ({
      loc: ev.loc,
      checkTotal: ev.checkTotal,
      critCount: ev.critCount,
      tac: Boolean(ev.tac),
      blownOff: Boolean(ev.blownOff),
      crits: (ev.crits ?? []).map(c => ({
        ok: Boolean(c.ok),
        idx: c.idx,
        rolls: c.rolls,
        label: c.label,
        wasDestroyed: Boolean(c.wasDestroyed),
        reason: c.reason
      }))
    }))
  };
}
