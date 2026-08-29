const SYSTEM_ID = "atow-battletech";

const n = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clampInt = (value, min, max, fallback = min) => Math.min(max, Math.max(min, Math.floor(n(value, fallback))));
const deepClone = value => foundry.utils.deepClone(value ?? {});

export function isBuildingActor(actor) {
  return String(actor?.type ?? "").toLowerCase() === "building";
}

function combatStamp() {
  const combat = game.combat?.started ? game.combat : null;
  return combat ? `${combat.id}:${combat.round ?? 0}:${combat.turn ?? 0}` : "outside-combat";
}

function normalizedCrit(raw = {}) {
  return {
    gunnersKilled: Boolean(raw.gunnersKilled),
    gunnersStunnedTurns: Math.max(0, Math.floor(n(raw.gunnersStunnedTurns, 0))),
    gunnersStunnedAppliedStamp: String(raw.gunnersStunnedAppliedStamp ?? ""),
    turretJammed: Boolean(raw.turretJammed),
    turretLocked: Boolean(raw.turretLocked)
  };
}

function normalizedThreshold(raw = {}) {
  return { stamp: String(raw.stamp ?? ""), startCf: Math.max(0, n(raw.startCf, 0)) };
}

export function normalizeBuildingHexes(building = {}, count = 1, levels = 1) {
  const source = Array.isArray(building.hexes) ? building.hexes : [];
  const levelCount = clampInt(levels, 1, 999, 1);
  return Array.from({ length: clampInt(count, 1, 999, 1) }, (_, index) => {
    const existing = deepClone(source[index] ?? {});
    const existingLevels = Array.isArray(existing.levels) ? existing.levels : [];
    return {
      ...existing,
      id: String(existing.id ?? `H${String(index + 1).padStart(2, "0")}`),
      cfDamage: Math.max(0, n(existing.cfDamage, 0)),
      armorDamage: Math.max(0, n(existing.armorDamage, 0)),
      unspecifiedTons: Math.max(0, n(existing.unspecifiedTons, 0)),
      collapsed: Boolean(existing.collapsed),
      crit: normalizedCrit(existing.crit),
      threshold: normalizedThreshold(existing.threshold),
      levels: Array.from({ length: levelCount }, (_, levelIndex) => {
        const current = deepClone(existingLevels[levelIndex] ?? {});
        return {
          ...current,
          level: levelIndex + 1,
          cfDamage: Math.max(0, n(current.cfDamage, 0)),
          armorDamage: Math.max(0, n(current.armorDamage, 0)),
          collapsed: Boolean(current.collapsed),
          crit: normalizedCrit(current.crit),
          threshold: normalizedThreshold(current.threshold)
        };
      })
    };
  });
}

export function getBuildingTargetOptions(actor) {
  if (!isBuildingActor(actor)) return { hexes: [], levels: [], expanded: false };
  const building = actor.system?.building ?? {};
  const hexCount = clampInt(building.size?.hexes, 1, 999, 1);
  const levelCount = clampInt(building.levels, 1, 999, 1);
  const hexes = normalizeBuildingHexes(building, hexCount, levelCount);
  return {
    expanded: Boolean(building.expandedCF),
    hexes: hexes.map((hex, index) => ({ value: index, label: hex.id || `H${index + 1}` })),
    levels: Array.from({ length: levelCount }, (_, index) => ({ value: index + 1, label: `Level ${index + 1}` }))
  };
}

function buildingDamageMultiplier(building) {
  const classification = String(building?.classification ?? "standard");
  if (["gunEmplacement", "fortress"].includes(classification)) return 0.5;
  if (classification === "castlesBrian") return 0.1;
  return 1;
}

function scaledBuildingDamage(building, damage, sourceScale = "standard") {
  const raw = Math.max(0, n(damage, 0));
  if (String(building?.classification) === "castlesBrian" && String(sourceScale).toLowerCase() === "capital") return Math.floor(raw);
  return Math.floor(raw * buildingDamageMultiplier(building));
}

function buildingArmorFactor(building) {
  const tons = Math.max(0, Math.floor(n(building?.armor?.tonsPerHex, 0)));
  const points = tons * (String(building?.techBase) === "clan" ? 20 : 16);
  const capital = String(building?.classification) === "castlesBrian";
  const raw = capital ? Math.floor(points / 10) : points;
  const canArmor = ["wall", "gunEmplacement", "fortress", "castlesBrian"].includes(String(building?.classification));
  if (!canArmor) return 0;
  return Math.min(raw, Math.max(0, n(building?.cf, 0)) * (capital ? 2 : 1));
}

function mountFor(item) { return item?.system?.buildingMount ?? {}; }
function isWeapon(item) { return ["mechWeapon", "characterWeapon"].includes(item?.type); }
function isAmmo(item) {
  const name = String(item?.name ?? "");
  return item?.type === "mechEquipment" && (/^\s*Ammo\s*\(/i.test(name) || n(item.system?.shots, 0) > 0 || n(item.system?.ammoAmount, 0) > 0);
}
function isCASE(item) { return /(^|\b)CASE(?:\s*II)?(\b|$)/i.test(String(item?.name ?? "")); }
function operational(item) { return !mountFor(item).destroyed; }

function itemsAt(actor, hexIndex, level, { levelSpecific = false } = {}) {
  return Array.from(actor?.items ?? []).filter(item => {
    const mount = mountFor(item);
    if (clampInt(mount.hexIndex, 0, 999, 0) !== hexIndex) return false;
    if (levelSpecific && clampInt(mount.level, 1, 999, 1) !== level) return false;
    return true;
  });
}

function ammoKeyFromName(name) {
  const match = String(name ?? "").match(/^\s*Ammo\s*\(([^)]+)\)/i);
  return String(match?.[1] ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function ammoDamagePerShot(key) {
  const k = String(key ?? "").toLowerCase();
  if (!k || /gauss|hag|plasma/.test(k)) return 0;
  let match = k.match(/^(?:ac|lbx)-(\d+)/); if (match) return Number(match[1]);
  match = k.match(/^lrm-(\d+)/); if (match) return Number(match[1]);
  match = k.match(/^mrm-(\d+)/); if (match) return Number(match[1]);
  match = k.match(/^srm-(\d+)/); if (match) return Number(match[1]) * 2;
  match = k.match(/^mml-(\d+)(?:-(lrm|srm))?/); if (match) return Number(match[1]) * (match[2] === "srm" ? 2 : 1);
  match = k.match(/^atm-(\d+)(?:-(er|he))?/); if (match) return Number(match[1]) * (match[2] === "he" ? 3 : match[2] === "er" ? 1 : 2);
  if (/machine-gun|^mg$/.test(k)) return 2;
  if (k === "ams" || k === "narc") return 2;
  if (k.startsWith("arrow-iv")) return 20;
  return 0;
}

function remainingAmmo(item) {
  const sys = item?.system ?? {};
  for (const value of [sys.current, sys.shotsRemaining, sys.quantity, sys.ammoAmount, sys.shots]) {
    if (Number.isFinite(Number(value))) return Math.max(0, Number(value)) * Math.max(1, clampInt(mountFor(item).quantity, 1, 999, 1));
  }
  const nameShots = String(item?.name ?? "").match(/\)\s*(\d+)\s*$/)?.[1];
  return Math.max(0, n(nameShots, 0));
}

function weaponExplosionDamage(name) {
  const text = String(name ?? "").toLowerCase();
  if (/light\s+gauss\s+rifle/.test(text)) return 16;
  const hag = text.match(/\bhag\s*[-/]?\s*(20|30|40)\b/);
  if (hag) return Number(hag[1]) / 2;
  return /\bgauss\s+rifle\b/.test(text) ? 15 : 0;
}

async function postBuildingChat(actor, title, lines = [], rolls = []) {
  const content = `<div class="atow-bt building-critical"><h3>${title}</h3>${lines.map(line => `<p>${line}</p>`).join("")}</div>`;
  await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content, rolls, type: rolls.length ? CONST.CHAT_MESSAGE_TYPES.ROLL : CONST.CHAT_MESSAGE_TYPES.OTHER }).catch(() => {});
}

async function markBuildingDefeated(actor, reason) {
  await actor.update({ "system.building.defeated": true, "system.building.defeatReason": reason });
  await actor.toggleStatusEffect?.(CONFIG?.specialStatusEffects?.DEFEATED ?? "defeated", { active: true }).catch(() => {});
  for (const token of actor.getActiveTokens?.(true, true) ?? []) {
    const doc = token.document ?? token;
    const tintUpdate = doc?.texture !== undefined ? { "texture.tint": "#111111" } : { tint: "#111111" };
    await doc.update?.(tintUpdate).catch(() => {});
  }
}

function trackAt(hexes, hexIndex, level, expanded) {
  const hex = hexes[hexIndex];
  return expanded ? hex?.levels?.[level - 1] : hex;
}

function applyTrackDamage(track, cf, armor, damage, { bypassArmor = false } = {}) {
  let remaining = damage;
  let armorApplied = 0;
  let cfApplied = 0;
  if (!bypassArmor) {
    const armorRemaining = Math.max(0, armor - n(track.armorDamage, 0));
    armorApplied = Math.min(armorRemaining, remaining);
    track.armorDamage = Math.min(armor, n(track.armorDamage, 0) + armorApplied);
    remaining -= armorApplied;
  }
  const cfRemaining = Math.max(0, cf - n(track.cfDamage, 0));
  cfApplied = Math.min(cfRemaining, remaining);
  track.cfDamage = Math.min(cf, n(track.cfDamage, 0) + cfApplied);
  remaining -= cfApplied;
  if (track.cfDamage >= cf) track.collapsed = true;
  return { armorApplied, cfApplied, overflow: remaining };
}

function propagateCollapseDamage(hex, originLevel, cf, damage) {
  const events = [];
  const applyDirection = (start, step, amount) => {
    let remaining = amount;
    for (let index = start; index >= 0 && index < hex.levels.length && remaining > 0; index += step) {
      const level = hex.levels[index];
      const before = n(level.cfDamage, 0);
      const applied = Math.min(Math.max(0, cf - before), remaining);
      level.cfDamage = Math.min(cf, before + applied);
      remaining -= applied;
      if (level.cfDamage >= cf && !level.collapsed) {
        level.collapsed = true;
        events.push(`Level ${index + 1} collapsed`);
      }
      if (!level.collapsed) break;
    }
  };
  applyDirection(originLevel, 1, damage);
  applyDirection(originLevel - 2, -1, damage);
  return events;
}

function resolveExpandedCollapse(hex, level, cf) {
  const events = [];
  const index = level - 1;
  const track = hex.levels[index];
  if (!track?.collapsed) return events;
  if (index === 0) {
    for (const entry of hex.levels) { entry.cfDamage = cf; entry.collapsed = true; }
    hex.collapsed = true;
    events.push(`${hex.id} collapsed after its bottom level failed`);
    return events;
  }
  const upperLevels = hex.levels.slice(index + 1).filter(entry => !entry.collapsed).length;
  const collapseDamage = Math.floor((upperLevels * cf) / 3);
  if (collapseDamage > 0) events.push(...propagateCollapseDamage(hex, level, cf, collapseDamage));
  if (hex.levels[0]?.collapsed) hex.collapsed = true;
  return events;
}

async function applyDirectCFDamage(actor, hexIndex, level, damage, { expanded, reason }) {
  const building = deepClone(actor.system?.building ?? {});
  const cf = Math.max(1, n(building.cf, 1));
  const armor = buildingArmorFactor(building);
  const hexes = normalizeBuildingHexes(building, building.size?.hexes, building.levels);
  const track = trackAt(hexes, hexIndex, level, expanded);
  if (!track) return null;
  const applied = applyTrackDamage(track, cf, armor, Math.max(0, n(damage, 0)), { bypassArmor: true });
  const collapseEvents = expanded ? resolveExpandedCollapse(hexes[hexIndex], level, cf) : [];
  if (!expanded && track.collapsed) hexes[hexIndex].collapsed = true;
  await actor.update({ "system.building.hexes": hexes });
  return { ...applied, collapseEvents, reason };
}

export async function applyBuildingCritical(actor, { hexIndex = 0, level = 1, expanded = false, modifier = 0 } = {}) {
  if (!isBuildingActor(actor)) return { ok: false, reason: "Not a building actor" };
  const building = actor.system?.building ?? {};
  const hexes = normalizeBuildingHexes(building, building.size?.hexes, building.levels);
  const hex = hexes[hexIndex];
  const track = trackAt(hexes, hexIndex, level, expanded);
  if (!hex || !track) return { ok: false, reason: "Invalid building hex or level" };
  const locationItems = itemsAt(actor, hexIndex, level, { levelSpecific: expanded });
  const weapons = locationItems.filter(item => isWeapon(item) && operational(item));
  const ammunition = locationItems.filter(item => isAmmo(item) && operational(item));
  const otherEquipment = locationItems.filter(item =>
    !isWeapon(item) && !isAmmo(item) && !isCASE(item) && operational(item)
  );

  // Advanced-building critical results only damage an appropriate installed
  // system or its gunners. Empty/simple structural locations have no generic
  // early-collapse critical, so do not make a meaningless table roll.
  if (!weapons.length && !ammunition.length && !otherEquipment.length) {
    return {
      ok: true,
      skipped: true,
      reason: "noCriticalTargets",
      result: "none",
      applied: false,
      notes: ["No damageable components are installed at this location."]
    };
  }

  const roll = await (new Roll("2d6")).evaluate();
  const total = clampInt(n(roll.total, 2) + n(modifier, 0), 2, 12, 2);
  const result = total <= 5 ? "none" : ({ 6: "weaponMalfunction", 7: "gunnersStunned", 8: "weaponDestroyed", 9: "gunnersKilled", 10: "turret", 11: "ammunition", 12: "other" })[total];
  const notes = [];
  let applied = false;
  let secondaryDamage = null;
  const turretWeapons = weapons.filter(item => Boolean(mountFor(item).turret));

  if (result === "weaponMalfunction" || result === "weaponDestroyed") {
    if (!weapons.length) notes.push("No operational weapon exists at this location; no critical effect.");
    else {
      const weapon = weapons[Math.floor(Math.random() * weapons.length)];
      let chooser = "Random automation";
      if (result === "weaponDestroyed") {
        const choiceRoll = await (new Roll("1d6")).evaluate();
        chooser = n(choiceRoll.total, 1) <= 3 ? "target controller" : "attacking player";
        await weapon.update({ "system.buildingMount.destroyed": true });
        const explosion = weaponExplosionDamage(weapon.name);
        if (explosion > 0) secondaryDamage = await applyDirectCFDamage(actor, hexIndex, level, explosion, { expanded, reason: `${weapon.name} explosion` });
      } else await weapon.update({ "system.buildingMount.malfunctioned": true });
      notes.push(`${weapon.name} ${result === "weaponDestroyed" ? `destroyed (${chooser}; selected randomly)` : "malfunctioned"}.`);
      applied = true;
    }
  } else if (result === "gunnersStunned" || result === "gunnersKilled") {
    if (!weapons.length) notes.push("No weapon gunners exist at this location; no critical effect.");
    else {
      if (result === "gunnersKilled") track.crit.gunnersKilled = true;
      else {
        track.crit.gunnersStunnedTurns += 1;
        track.crit.gunnersStunnedAppliedStamp = combatStamp();
      }
      notes.push(result === "gunnersKilled" ? "Gunners killed; this location can no longer fire." : "Gunners stunned for the following turn.");
      applied = true;
    }
  } else if (result === "turret") {
    if (!turretWeapons.length) notes.push("No turret exists at this location; no critical effect.");
    else {
      const die = await (new Roll("1d6")).evaluate();
      if (n(die.total, 1) <= 3 && !track.crit.turretJammed && !track.crit.turretLocked) {
        track.crit.turretJammed = true;
        notes.push("Turret jammed.");
      } else {
        track.crit.turretJammed = false;
        track.crit.turretLocked = true;
        notes.push("Turret locked.");
      }
      applied = true;
    }
  } else if (result === "ammunition") {
    if (!ammunition.length) notes.push("No ammunition exists at this location; no critical effect.");
    else {
      let explosion = 0;
      for (const item of ammunition) {
        explosion += remainingAmmo(item) * ammoDamagePerShot(ammoKeyFromName(item.name));
        await item.update({ "system.buildingMount.destroyed": true, "system.current": 0, "system.shotsRemaining": 0, "system.ammoAmount": 0 });
      }
      const caseProtected = locationItems.some(item => isCASE(item) && operational(item));
      const finalDamage = caseProtected ? Math.floor(explosion / 10) : explosion;
      if (finalDamage > 0) secondaryDamage = await applyDirectCFDamage(actor, hexIndex, level, finalDamage, { expanded, reason: "Building ammunition explosion" });
      notes.push(`All ammunition destroyed; explosion ${explosion}${caseProtected ? `, reduced by CASE to ${finalDamage}` : ""} CF damage.`);
      applied = true;
    }
  } else if (result === "other") {
    if (!otherEquipment.length) notes.push("No other operational equipment exists at this location; no critical effect.");
    else {
      const item = otherEquipment[Math.floor(Math.random() * otherEquipment.length)];
      await item.update({ "system.buildingMount.destroyed": true });
      notes.push(`${item.name} rendered inoperative.`);
      applied = true;
    }
  } else notes.push("No critical hit.");

  if (["gunnersStunned", "gunnersKilled", "turret"].includes(result)) await actor.update({ "system.building.hexes": hexes });
  await postBuildingChat(actor, "Advanced Building Critical Hit", [`${hex.id}${expanded ? `, Level ${level}` : ""}: 2d6 ${roll.total}${modifier ? ` ${modifier > 0 ? "+" : ""}${modifier}` : ""} = ${total}`, ...notes], [roll]);
  return { ok: true, roll, total, result, applied, notes, secondaryDamage };
}

function checkTotalCollapse(hexes, originalLevels, expanded) {
  if (!expanded) return hexes.every(hex => hex.collapsed);
  const halfHeight = Math.floor(originalLevels / 2);
  const sufficientlyCollapsed = hexes.filter(hex => hex.levels.filter(level => !level.collapsed).length <= halfHeight).length;
  return sufficientlyCollapsed >= Math.ceil(hexes.length / 2);
}

export async function applyBuildingDamage(actor, damage, opts = {}) {
  if (!isBuildingActor(actor)) return { ok: false, reason: "Not a building actor" };
  const building = deepClone(actor.system?.building ?? {});
  const expanded = Boolean(building.expandedCF);
  const hexCount = clampInt(building.size?.hexes, 1, 999, 1);
  const levelCount = clampInt(building.levels, 1, 999, 1);
  const hexIndex = clampInt(opts.hexIndex, 0, hexCount - 1, 0);
  const level = clampInt(opts.level, 1, levelCount, 1);
  const cf = Math.max(1, n(building.cf, 1));
  const armorPerHex = Math.max(0, n(opts.armorPerHex, buildingArmorFactor(building)));
  const hexes = normalizeBuildingHexes(building, hexCount, levelCount);
  const hex = hexes[hexIndex];
  const track = trackAt(hexes, hexIndex, level, expanded);
  if (!track) return { ok: false, reason: "Invalid building hex or level" };

  const incomingDamage = Math.max(0, n(damage, 0));
  const effectiveDamage = scaledBuildingDamage(building, incomingDamage, opts.damageScale);
  const stamp = combatStamp();
  if (stamp === "outside-combat" || track.threshold.stamp !== stamp) {
    track.threshold.stamp = stamp;
    track.threshold.startCf = Math.max(0, cf - n(track.cfDamage, 0));
  }
  const threshold = Math.ceil(track.threshold.startCf / 10);
  const result = applyTrackDamage(track, cf, armorPerHex, effectiveDamage, { bypassArmor: Boolean(opts.fromInside) });
  let collapseEvents = [];
  if (expanded) collapseEvents = resolveExpandedCollapse(hex, level, cf);
  else if (track.collapsed) hex.collapsed = true;

  const totalCollapse = checkTotalCollapse(hexes, levelCount, expanded);
  if (totalCollapse) {
    for (const candidate of hexes) {
      candidate.collapsed = true;
      if (expanded) for (const entry of candidate.levels) { entry.collapsed = true; entry.cfDamage = cf; }
      else candidate.cfDamage = cf;
    }
    collapseEvents.push("The building suffered total collapse");
  }
  await actor.update({
    "system.building.hexes": hexes,
    "system.building.armor.factorPerHex": armorPerHex
  });
  if (totalCollapse) await markBuildingDefeated(actor, "Total structural collapse");

  let critical = null;
  if (result.cfApplied > 0 && effectiveDamage > threshold && !totalCollapse) {
    const resolvedCritical = await applyBuildingCritical(actor, { hexIndex, level, expanded, modifier: n(opts.criticalModifier, 0) });
    if (!resolvedCritical?.skipped) critical = resolvedCritical;
  }
  return {
    ok: true,
    hexIndex,
    hexId: hex.id,
    level: expanded ? level : null,
    incomingDamage,
    effectiveDamage,
    threshold,
    ...result,
    critical,
    collapseEvents,
    collapsed: Boolean(hex.collapsed),
    defeated: totalCollapse
  };
}

const BUILDING_TURN_STATE = globalThis.__ATOW_BUILDING_TURN_STATE__ ??= new Map();
Hooks.on("updateCombat", async (combat, changed) => {
  try {
    if (!game.user?.isGM || !("turn" in changed || "round" in changed) || !combat?.started) return;
    const previous = BUILDING_TURN_STATE.get(combat.id);
    if (previous?.actorUuid) {
      const actor = await fromUuid(previous.actorUuid).catch(() => null);
      if (isBuildingActor(actor)) {
        const building = deepClone(actor.system?.building ?? {});
        const hexes = normalizeBuildingHexes(building, building.size?.hexes, building.levels);
        let changedTracks = false;
        for (const hex of hexes) {
          const tracks = building.expandedCF ? hex.levels : [hex];
          for (const track of tracks) {
            const turns = Math.max(0, n(track.crit?.gunnersStunnedTurns, 0));
            if (turns > 0 && String(track.crit?.gunnersStunnedAppliedStamp ?? "") !== previous.stamp) {
              track.crit.gunnersStunnedTurns = turns - 1;
              changedTracks = true;
            }
          }
        }
        if (changedTracks) await actor.update({ "system.building.hexes": hexes });
      }
    }
    const currentActor = combat.combatant?.actor ?? null;
    BUILDING_TURN_STATE.set(combat.id, { actorUuid: currentActor?.uuid ?? "", stamp: `${combat.id}:${combat.round ?? 0}:${combat.turn ?? 0}` });
  } catch (error) {
    console.warn("AToW Battletech | Building gunner stun countdown failed", error);
  }
});
