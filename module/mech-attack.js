// systems/atow-battletech/module/mech-attack.js
// Version 0.1.3
// Centralized mech attack logic (to-hit, range bands, chat card).
// UI-agnostic core, with an optional UI prompt helper at the bottom.

const SYSTEM_ID = "atow-battletech";// ------------------------------------------------------------


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
  "srm-6": 180,
  "srm-4": 200,
  "srm-2": 200,
  "mg": 400
};

function _ammoKeyFromType(typeText) {
  const t = String(typeText ?? "").trim().toLowerCase();

  // AC/20, AC 20
  let m = t.match(/\bac\s*\/\s*(\d+)\b/i) || t.match(/\bac\s*(\d+)\b/i);
  if (m?.[1]) return `ac-${Number(m[1])}`;

  // LRM 20, LRM-20
  m = t.match(/\blrm\s*[- ]?\s*(\d+)\b/i);
  if (m?.[1]) return `lrm-${Number(m[1])}`;

  // SRM 6, SRM-6
  m = t.match(/\bsrm\s*[- ]?\s*(\d+)\b/i);
  if (m?.[1]) return `srm-${Number(m[1])}`;

  // Machine Gun / MG
  if (t.includes("machine gun") || /^mg\b/.test(t)) return "mg";

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

  const damage = AMMO_EXPLOSION_DAMAGE[key];
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

async function _postAmmoExplosionChat({ actor, loc, label, damage, caseProtected = null }) {
  try {
    const locName = String(loc ?? "").toUpperCase();
    const nice = String(label ?? "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const protectedByCase = (caseProtected === null) ? isLocationProtectedByCASE(actor, loc) : Boolean(caseProtected);
    const caseLine = `<p style="margin:0.25rem 0 0 0;">CASE: <b>${protectedByCase ? "Yes" : "No"}</b>${protectedByCase ? " (contained)" : ""}</p>`;
    const content = `
      <div class="atow-bt ammo-explosion">
        <h2 style="margin:0 0 0.25rem 0;">AMMO EXPLOSION!</h2>
        <p style="margin:0;"><b>${actor?.name ?? "Unknown"}</b> — <b>${locName}</b>: ${nice}</p>
        <p style="margin:0.25rem 0 0 0;">Damage: <b>${damage}</b> (internal first)</p>
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
    const key = `${targetActor.id}|${loc}|${ev.idx ?? ""}|${String(label)}`;
    if (processed.has(key)) continue;
    processed.add(key);

    await _playAtowSfx(AMMO_EXPLOSION_SFX, { volume: 1.0 });
    await _postAmmoExplosionChat({ actor: targetActor, loc, label, damage, caseProtected });

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
    const res = await applyDamageToTargetActor(targetActor, loc, damage, { side, internalFirstStartLoc: true, preventTransfer: caseProtected });

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
export async function resolveAmmoExplosionEvent(targetActor, event = {}) {
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
 * Rapid Fire rating (R#). Stored on weapons as a number (e.g. 2 or 6) but older sheets may store
 * it under different keys or as a string like "R6". This helper normalizes to an integer >= 1.
 */
function getRapidFireRating(weaponItem) {
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
  const t = roll?.dice?.[0]?.total;
  if (Number.isFinite(t)) return t;
  // Fallback: attempt to find the first dice term with a total
  const terms = roll?.terms ?? [];
  const diceTerm = terms.find(x => x && typeof x === "object" && Number.isFinite(x.total) && (x.faces || x.dice || x.number));
  const tt = diceTerm?.total;
  if (Number.isFinite(tt)) return tt;
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

/**
 * Try to extract a "facing" angle in degrees from the token.
 * - Default: token.document.rotation (Foundry standard).
 * - If you use a facing module that stores flags, this tries a few common patterns.
 *   If a flag value looks like 0..5 (hex side), it converts to degrees (side*60).
 */
function getTokenFacingDeg(token) {
  if (!token?.document) return null;

  // 0) Prefer the system's native facing flag when present.
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
  // If About Face (or another module) stores a snapped direction index, use it directly.
  // This avoids 0°-reference mismatches that can cause "rear/side" to trigger too often.
  const snapped = _extractSnappedFacingDir(token);
  if (Number.isFinite(snapped)) return snapped;

  const deg = getTokenFacingDeg(token);
  if (deg === null) return null;

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

  // If we have a hex grid, use direction indices for exact BattleTech hex-side arcs.
  // Arc mapping (per your screenshot):
  // - FRONT: 3 hex sides (180°) => delta 0, 1, 5
  // - REAR:  1 hex side (centered behind) => delta 3
  // - RIGHT: 1 hex side (rear-right) => delta 2
  // - LEFT:  1 hex side (rear-left) => delta 4
  try {
    const grid = canvas?.grid;
    const origin = targetToken?.center;
    const attackerPt = attackerToken?.center;
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

  const dx = attackerToken.center.x - targetToken.center.x;
  const dy = attackerToken.center.y - targetToken.center.y;
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
    name.includes("lrm") || name.includes("srm") ||
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
  const t = String(typeText ?? "").trim().toLowerCase();

  // If already looks like our key, keep it stable
  if (/^(ac|lrm|srm)-\d+$/.test(t)) return t;

  // Autocannons: "AC/20", "AC 20"
  let m = t.match(/\bac\s*\/?\s*(\d+)\b/i);
  if (m?.[1]) return slugifyAmmoKey(`ac-${m[1]}`);

  // LRMs / SRMs
  m = t.match(/\b(lrm|srm)\s*-?\s*(\d+)\b/i);
  if (m?.[1] && m?.[2]) return slugifyAmmoKey(`${m[1]}-${m[2]}`);

  // Machine guns / other common ammo users (optional)
  if (t.includes("machine gun") || t === "mg") return "mg";

  return slugifyAmmoKey(t);
}

function getAmmoKeyForWeapon(weaponItem) {
  const sys = weaponItem?.system ?? {};

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

  if (explicit) return ammoKeyFromTypeLabel(explicit);

  const name = String(weaponItem?.name ?? "").toLowerCase();

  // Autocannons: "AC/20", "AC 20"
  let m = name.match(/\bac\s*\/?\s*(\d+)\b/i);
  if (m?.[1]) return slugifyAmmoKey(`ac-${m[1]}`);

  // LRMs / SRMs
  m = name.match(/\b(lrm|srm)\s*-?\s*(\d+)\b/i);
  if (m?.[1] && m?.[2]) return slugifyAmmoKey(`${m[1]}-${m[2]}`);

  // Machine guns
  if (name.includes("machine gun") || name.includes("mg")) return "mg";

  return null;
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

function weaponConsumesAmmo(weaponItem, actor) {
  const sys = weaponItem?.system ?? {};

  // Explicit override
  if (sys.usesAmmo === false) return false;
  if (sys.usesAmmo === true) return true;

  const key = getAmmoKeyForWeapon(weaponItem);
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
async function spendAmmoIfApplicable(actor, weaponItem, amount = 1) {
  if (!actor || !weaponItem) return { ok: true, spent: 0, key: null };

  const key = getAmmoKeyForWeapon(weaponItem);
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
    return { ok: true, spent: 0, key: null };
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


function getWeaponRanges(item) {
  const sys = item?.system ?? {};
  const r = sys.range ?? {};
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
  const moved = num(tokenDoc?.getFlag?.(SYSTEM_ID, "movedThisTurn"), 0);
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

function getMissileRack(itemOrName) {
  const rawName = (typeof itemOrName === "string" ? itemOrName : itemOrName?.name) ?? "";
  const name = String(rawName).toUpperCase();

  // Streak SRMs don't use the normal cluster table in tabletop; treat as non-cluster here.
  if (/\BSTREAK\s*SRM\b/i.test(name)) return null;

  // Accept common formats: "LRM 15", "LRM-15", "MRM 30", etc.
  const m = name.match(/\b(LRM|SRM|MRM)\s*[-]?\s*(\d+)\b/i);
  if (!m) return null;

  const type = String(m[1]).toUpperCase();
  const size = Number(m[2]);
  if (!Number.isFinite(size) || size <= 0) return null;

  return { type, size };
}

async function rollClusterHits(rackSize, bonus = 0) {
  const roll = await (new Roll("2d6")).evaluate();
  const baseTotal = num(roll?.total, 0);

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
// ------------------------------------------------------------
const ARTEMIS_LABEL = "artemis iv fcs";

function _isArtemisLabel(label) {
  return String(label ?? "").trim().toLowerCase() === ARTEMIS_LABEL;
}

function _isEligibleLauncherLabel(label) {
  const t = String(label ?? "").trim();
  if (!t) return false;
  // Use the same detection as getMissileRack (but from a string label)
  if (/\bstreak\s*srm\b/i.test(t)) return false;
  if (/\bammo\b/i.test(t)) return false;
  return /\b(lrm|srm|mrm)\s*[-]?\s*(\d+)\b/i.test(t);
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

function _countArtemisAndLaunchers(actor) {
  const byLoc = {};
  let totalLaunchers = 0;
  let totalArtemis = 0;

  for (const s of _iterCritStartSlots(actor)) {
    if (s.destroyed) continue;

    if (_isArtemisLabel(s.label)) {
      byLoc[s.locKey] ??= { launchers: 0, artemis: 0 };
      byLoc[s.locKey].artemis += 1;
      totalArtemis += 1;
      continue;
    }

    if (_isEligibleLauncherLabel(s.label)) {
      byLoc[s.locKey] ??= { launchers: 0, artemis: 0 };
      byLoc[s.locKey].launchers += 1;
      totalLaunchers += 1;
    }
  }

  return { byLoc, totalLaunchers, totalArtemis };
}

function _isArtemisFullyLinked(actor) {
  const { byLoc, totalLaunchers, totalArtemis } = _countArtemisAndLaunchers(actor);

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

function _weaponHasArtemisLink(actor, weaponItem, pre = null) {
  const fullyLinked = Boolean(pre?.fullyLinked ?? _isArtemisFullyLinked(actor));
  if (!fullyLinked) return false;

  const locKey = _findWeaponCritLoc(actor, weaponItem);
  if (!locKey) return false;

  const byLoc = pre?.byLoc ?? _countArtemisAndLaunchers(actor).byLoc;
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
      const slots = locData?.slots;
      if (!Array.isArray(slots)) continue;

      for (const slot of slots) {
        // Slot can be a plain string (legacy) or an object {label, uuid, destroyed}
        const destroyed = (typeof slot === "object") ? Boolean(slot?.destroyed) : false;
        if (!destroyed) continue;

        const slotUuid = String(
          (slot?.uuid ?? slot?.itemUuid ?? slot?.sourceUuid ?? slot?.documentUuid ?? "")
        ).trim();

        const slotItemId = String(slot?.itemId ?? "").trim();

        if (weaponUuid && slotUuid && slotUuid === weaponUuid) return true;
        if (weaponId) {
          if (slotItemId && slotItemId === weaponId) return true;
          // Common UUID formats end with ".Item.<id>"
          if (slotUuid && (slotUuid.endsWith(`.Item.${weaponId}`) || slotUuid.endsWith(weaponId))) return true;
        }

        const label = (typeof slot === "string") ? slot : (slot?.label ?? slot?.name ?? "");
        const slotLabel = norm(label);

        // If we have no better identifier, fall back to label containment.
        if (weaponName && slotLabel && (slotLabel === weaponName || slotLabel.includes(weaponName))) return true;
      }
    }
  } catch (_) {
    // ignore and treat as not destroyed
  }
  return false;
}

export function calcRangeBandAndMod(item, distance) {
  const d = num(distance, 0);
  const { min, short, medium, long } = getWeaponRanges(item);

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

/**
 * Core roll: 2d6 + Gunnery vs TN (>= TN hits)
 */
export async function rollWeaponAttack(actor, weaponItem, opts = {}) {
  if (!actor || !weaponItem) return null;
  // Resolve to an actual embedded Item when possible (module compatibility)
  weaponItem = await _resolveWeaponItem(actor, weaponItem);
  const isAbomChat = opts?.chatMode === "abomination";

// Rapid-fire jam: if this weapon jammed previously, it cannot be fired again.
if (!isAbomChat && weaponItem?.system?.jammed) {
  ui?.notifications?.warn?.(`${weaponItem.name} is jammed and cannot be fired.`);
  return null;
}



  const pilot = actor.system?.pilot ?? {};
  const hasSkillOverride = Number.isFinite(Number(opts.skillValue));
  const gunnery = hasSkillOverride ? num(opts.skillValue, 0) : num(pilot.gunnery, 0);
  const skillLabel = (opts.skillLabel && String(opts.skillLabel).trim()) ? String(opts.skillLabel).trim() : "Gunnery";

  const baseTN = (opts.tn ?? getDefaultTN(8));
  const attackerToken = opts.attackerToken ?? getAttackerToken(actor);
  const targetToken = opts.targetToken ?? getSingleTargetToken();
  const targetActor = targetToken?.actor;
  const isAbomTarget = isAbominationActor(targetActor);
  const isVehicleTarget = isVehicleActor(targetActor);
  const hasVehicleTurret = isVehicleTarget && (num(targetActor?.system?.armor?.turret?.max, 0) > 0);
  const isVehicleAttacker = isVehicleActor(actor);

  if (!targetToken) {
    ui?.notifications?.warn?.("Select exactly 1 target token before making an attack.");
    return null;
  }
  if (!attackerToken) {
    ui?.notifications?.warn?.("Place/control your mech token on the scene before making an attack.");
    return null;
  }

  const distance = Number.isFinite(opts.distance) ? num(opts.distance, 0) : measureTokenDistance(attackerToken, targetToken);
  if (distance === null) {
    ui?.notifications?.warn?.("Couldn't measure distance (no canvas/grid?).");
    return null;
  }

  const { band, mod: rangeMod, minPenalty } = calcRangeBandAndMod(weaponItem, distance);

  // Heat-based fire modifier and shutdown (computed at turn start)
  const heatFireMod = isVehicleAttacker ? 0 : num(actor.system?.heat?.effects?.fireMod, 0);
  const isShutdown = !isVehicleAttacker && (Boolean(actor.system?.heat?.shutdown) || Boolean(attackerToken?.document?.getFlag?.(SYSTEM_ID, "shutdown")));

  if (isShutdown) {
    ui?.notifications?.warn?.("This mech is shut down due to heat and cannot attack.");
    return null;
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
  if (isVehicleTarget && aimedEnabled) {
    aimedEnabled = false;
    aimedDisabledReason = "Aimed shots are not supported against vehicles.";
  }
  let aimedLocRaw = String(aimed.location ?? "").trim().toLowerCase();
  let useTCForAim = Boolean(aimed.useTC);
  const indirectFire = Boolean(opts.indirectFire);
  const rapidFireRating = getRapidFireRating(weaponItem);
  const clusterShotsOverride = num(opts.clusterShots, null);
  const hasClusterShotsOverride = Number.isFinite(clusterShotsOverride);
  const rapidShots = hasClusterShotsOverride
    ? clamp(Math.max(1, clusterShotsOverride), 1, Math.max(1, Math.floor(clusterShotsOverride)))
    : clamp(Math.max(1, num(opts.rapidShots ?? 1, 1)), 1, rapidFireRating);

  const targetImmobile = tokenHasStatus(targetToken, "atow-immobile") || tokenHasStatus(targetToken, "immobile");
  const targetPartialCover = tokenHasStatus(targetToken, "partial-cover");

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
      coverCancelMod -= 1; // cancels the +1 from statusTNMods
      aimedDetails.push("Ignore Partial Cover");
    }
  }

  const aimedNetMod = aimedTNMod + coverCancelMod + immobileCancelMod;
  const tcModStr = (tcMod >= 0) ? `+${tcMod}` : `${tcMod}`;
  const aimedModStr = (aimedNetMod >= 0) ? `+${aimedNetMod}` : `${aimedNetMod}`;

  const tn = num(baseTN, 8) + rangeMod + attackerMoveMod + targetMoveMod + heatFireMod + statusTNMods.total + envTNMods.mod + terrainMod + otherMod + tcMod + aimedNetMod;

  const toHit = await (new Roll(`2d6 + ${gunnery}`)).evaluate();
  // Missile rack size (LRM/SRM/MRM etc). Used to distinguish missile cluster weapons vs rapid-fire cluster.
  const rack = getMissileRack(weaponItem);
  // Streak missile launchers: if the attack misses, the launcher does not fire (no ammo/heat).
  // If the attack hits, the Cluster Hits Table result is treated as 12 (i.e., all missiles in the rack hit).
  const isStreakLauncher = Boolean(rack) && ["LRM", "SRM"].includes(String(rack.type ?? "").toUpperCase()) && /streak/i.test(String(weaponItem.name ?? ""));

  // For Streak launchers, ensure there is at least 1 ammo available before allowing an attack.
  if (isStreakLauncher && weaponConsumesAmmo(weaponItem, actor)) {
    const key = getAmmoKeyForWeapon(weaponItem);
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
  }

  jam = { rollTotal, threshold, jammed };
}

const hit = (toHit.total ?? 0) >= tn;

  let heat = isVehicleAttacker ? 0 : num(weaponItem.system?.heat, 0);
  const baseDamage = num(weaponItem.system?.damage, 0);

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

  // Artemis IV FCS: +2 to cluster roll (max modified roll of 12) when fully linked.
  const artemisCounts = Boolean(rack) ? _countArtemisAndLaunchers(actor) : { byLoc: {}, totalLaunchers: 0, totalArtemis: 0 };
  const artemisInstalled = Boolean(rack) ? (num(artemisCounts.totalArtemis, 0) > 0) : false;
  const artemisFullyLinked = Boolean(rack) ? _isArtemisFullyLinked(actor) : false;
  const artemisLinked = Boolean(rack) ? _weaponHasArtemisLink(actor, weaponItem, { fullyLinked: artemisFullyLinked, byLoc: artemisCounts.byLoc }) : false;
  const clusterBonus = (artemisLinked && !isStreakLauncher) ? 2 : 0;

  if (hit && rack && hasClusterShotsOverride) {
    const volleyRoll = await rollClusterHits(rapidShots, 0);
    const volleyHits = clamp(Math.min(rapidShots, num(volleyRoll.hits, 0)), 0, rapidShots);

    const perHitDamage = (rack.type === "SRM") ? 2 : 1;
    const groupSize = (rack.type === "SRM") ? 1 : 5;

    const subclusters = [];
    const packets = [];

    for (let i = 0; i < volleyHits; i++) {
      let clusterRoll;
      let missilesHit;
      if (isStreakLauncher) {
        clusterRoll = { roll: { total: 12 }, baseTotal: 12, mod: 0, modifiedTotal: 12, hits: rack.size };
        missilesHit = rack.size;
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

      for (const packetHits of splitIntoNs(missilesHit, groupSize)) {
        if (isAbomTarget) {
          packets.push({
            hits: packetHits,
            loc: "abom",
            roll: { total: null },
            tacFrom2: false,
            damage: packetHits * perHitDamage,
            floating: null
          });
          continue;
        }
        if (isVehicleTarget) {
          const locRes = await rollVehicleHitLocation(side, { hasTurret: hasVehicleTurret });
          packets.push({
            hits: packetHits,
            loc: locRes.loc,
            roll: locRes.roll,
            tacFrom2: false,
            vehicleCrit: locRes.critTrigger ? { trigger: true, tableLoc: locRes.critTableLoc } : null,
            damage: packetHits * perHitDamage,
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

        packets.push({
          hits: packetHits,
          loc: locRes.loc,
          roll: locRes.roll,
          tacFrom2,
          damage: packetHits * perHitDamage,
          floating: locRes.floating
        });
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
      artemisLinked,
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
      clusterRoll = { roll: { total: 12 }, baseTotal: 12, mod: 0, modifiedTotal: 12, hits: rack.size };
      missilesHit = rack.size;
    } else {
      clusterRoll = await rollClusterHits(rack.size, clusterBonus);
      missilesHit = Math.min(rack.size, num(clusterRoll.hits, 0));
    }

    const perHitDamage = (rack.type === "SRM") ? 2 : 1;
    const groupSize = (rack.type === "SRM") ? 1 : 5;

    const packets = [];
      for (const packetHits of splitIntoNs(missilesHit, groupSize)) {
        if (isAbomTarget) {
          packets.push({
            hits: packetHits,
            loc: "abom",
            roll: { total: null },
            tacFrom2: false,
            damage: packetHits * perHitDamage,
            floating: null
          });
          continue;
        }
        if (isVehicleTarget) {
          const locRes = await rollVehicleHitLocation(side, { hasTurret: hasVehicleTurret });
          packets.push({
            hits: packetHits,
            loc: locRes.loc,
            roll: locRes.roll,
            tacFrom2: false,
            vehicleCrit: locRes.critTrigger ? { trigger: true, tableLoc: locRes.critTableLoc } : null,
            damage: packetHits * perHitDamage,
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
          hits: packetHits,
          loc: locRes.loc,
          roll: locRes.roll,
          tacFrom2,
          damage: packetHits * perHitDamage,
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
      artemisLinked,
      streakUsed: isStreakLauncher,
      missilesHit,
      perHitDamage,
      groupSize,
      side,
      packets
    };

    damage = missilesHit * perHitDamage;

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

      let locRes = await rollHitLocation(side);
      const tacFrom2 = (locRes?.roll?.total ?? 0) === 2;

      // Optional floating TAC rule: if the *original* hit-location roll is 2, reroll location for where the shot actually hits.
      // Any criticals (including the TAC check) are then applied to the rerolled location.
      if (tacFrom2 && floatingCrits) {
        const reroll = await rollHitLocation(side);
        locRes = { ...reroll, floating: { original: { loc: locRes.loc, rollTotal: 2 }, reroll: { loc: reroll.loc, rollTotal: reroll?.roll?.total ?? 0 } } };
      }

      packets.push({
        hits: 1,
        loc: locRes.loc,
        roll: locRes.roll,
        tacFrom2,
        damage: baseDamage,
        floating: locRes.floating
      });
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

    damage = shotsHit * baseDamage;
  }


  let locResult = null;
  let tacSingle = false;
  if (hit && (opts.showLocation || opts.applyDamage) && !cluster && !isAbomTarget) {
    if (isVehicleTarget) {
      locResult = await rollVehicleHitLocation(side, { hasTurret: hasVehicleTurret });
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
        const fallback = (targetPartialCover ? await rollHitLocationNoLeg(side) : await rollHitLocation(side));
        locResult = {
          roll: fallback.roll,
          loc: fallback.loc,
          aim: { designated, roll: aimRoll, rollTotal: aimTotal, used: false, partialCoverReroll: !!targetPartialCover }
        };
      }
    } else {
      locResult = await rollHitLocation(side);
    }
  }

  // TAC + optional Floating Criticals (non-cluster):
  // - Standard TAC: if the hit-location table roll was 2, we make an extra TAC critical check on that location.
  // - Floating Criticals (optional): if TAC is possible (original roll was 2), reroll location; apply TAC/criticals to the rerolled location.
  if (hit && locResult && !cluster && !isVehicleTarget) {
    const fromHitLocationTable = !locResult.aim || locResult.aim.used === false;
    if (fromHitLocationTable && (locResult.roll?.total ?? 0) === 2) {
      tacSingle = true;

      if (floatingCrits) {
        const reroll = (targetPartialCover ? await rollHitLocationNoLeg(side) : await rollHitLocation(side));
        locResult = {
          roll: reroll.roll,
          loc: reroll.loc,
          aim: locResult.aim,
          floating: {
            original: { loc: locResult.loc, rollTotal: 2 },
            reroll: { loc: reroll.loc, rollTotal: reroll?.roll?.total ?? 0 }
          }
        };
      }
    }
  }



  if (!isVehicleAttacker && opts.applyHeat && heat && weaponFired) {
    const cur = num((actor.system?.heat?.value ?? actor.system?.heat?.current), 0);
    const barMax = num(actor.system?.heat?.max, 30);
    const next = clamp(cur + heat, 0, HEAT_HARD_CAP);
    await actor.update({ "system.heat.value": next, "system.heat.current": next, "system.heat.max": barMax });
  }


// Spend ammo (1 per firing) if an ammo bin exists for this weapon.
// This happens whether the shot hits or misses (ammo is expended when fired).
let ammoSpend = null;
if (weaponFired && opts.spendAmmo !== false && weaponConsumesAmmo(weaponItem, actor)) {
  ammoSpend = await spendAmmoIfApplicable(actor, weaponItem, rapidShots);

  // Abort if out of ammo
  if (ammoSpend && ammoSpend.ok === false) {
    if (ui && ui.notifications && typeof ui.notifications.error === "function") ui.notifications.error(ammoSpend.reason || `No ammo remaining for ${ammoSpend.name || "this weapon"}.`);
    return null;
  }

  if (ammoSpend?.key && ammoSpend?.after === 0) {
    { const n = (ammoSpend && (ammoSpend.name ?? ammoSpend.key)) ? String(ammoSpend.name ?? ammoSpend.key) : String(ammoSpend && ammoSpend.key ? ammoSpend.key : ""); if (ui && ui.notifications && typeof ui.notifications.warn === "function") ui.notifications.warn(`${actor.name}: ${n.toUpperCase()} ammo depleted!`); }
  }
}

// ---- Automatic Damage Application (first pass) ----
// If enabled, apply damage to the targeted mech immediately after resolving the hit location.
  let damageApplied = null;
  if (hit && opts.applyDamage) {
    if (!targetActor) {
      ui?.notifications?.warn?.("No target actor found to apply damage.");
    } else {
      try {
        if (cluster?.packets?.length) {
          const results = [];
          for (const p of cluster.packets) {
            let r;
            if (isAbomTarget) {
              r = await applyDamageToAbominationActor(targetActor, p.damage);
              if (r?.ok) p.abomIndex = r.hitAbomination;
            } else if (isVehicleTarget) {
              r = await applyDamageToVehicleActor(targetActor, p.loc, p.damage, { attackSide: side, crit: p.vehicleCrit });
            } else {
              r = await applyDamageToTargetActor(targetActor, p.loc, p.damage, { side, tac: Boolean(p.tacFrom2), tacLoc: p.loc });
              await _triggerAmmoExplosionsForDamageResult(targetActor, r, { side });
            }
            results.push({ packet: p, result: r });
            // If we lack permissions, stop spamming updates
            if (r && r.ok === false && r.reason?.includes("permission")) break;
          }
          damageApplied = { type: "cluster", results };
        } else {
          let r;
          if (isAbomTarget) {
            r = await applyDamageToAbominationActor(targetActor, damage);
          } else if (isVehicleTarget) {
            let loc = locResult?.loc ?? null;
            let crit = locResult?.critTrigger ? { trigger: true, tableLoc: locResult.critTableLoc } : null;
            if (!loc) {
              const fallback = await rollVehicleHitLocation(side, { hasTurret: hasVehicleTurret });
              loc = fallback.loc;
              if (fallback.critTrigger) crit = { trigger: true, tableLoc: fallback.critTableLoc };
            }
            r = await applyDamageToVehicleActor(targetActor, loc, damage, { attackSide: side, crit });
          } else {
            const loc = locResult?.loc ?? (await rollHitLocation(side))?.loc;
            r = await applyDamageToTargetActor(targetActor, loc, damage, { side, tac: tacSingle, tacLoc: loc });
            await _triggerAmmoExplosionsForDamageResult(targetActor, r, { side });
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



  const targetName = targetToken?.name ?? "Target";
  const attackerName = attackerToken?.name ?? actor.name;

const clusterNote = cluster
  ? (cluster.mode === "missile"
      ? (cluster.type === "SRM"
          ? "SRM damage is 2 per missile; each missile rolls its own location (group size 1)."
          : "LRM damage is 1 per missile; packets are grouped in 5s.")
      : (cluster.mode === "volley"
          ? `${cluster.label ?? "Volley"}: roll to see how many attackers hit, then resolve missile clusters per hit.`
          : `${cluster.label ?? "Rapid Fire"} damage is applied per hit; each hit is resolved as its own packet.`))
  : "";

  const facingLine = arc
    ? `<div><b>Target Facing:</b> ${Math.round(arc.facingDeg)}° | <b>Attack Arc:</b> ${side.toUpperCase()}</div>`
    : `<div><b>Attack Arc:</b> ${side.toUpperCase()} (no facing data found)</div>`;

  const weaponMeta = _getWeaponAutomationMeta(weaponItem);

  // Display whether Artemis IV FCS is installed/active for this attack (cluster weapons only).
  const artemisInfoLine = (rack && artemisInstalled)
    ? (artemisLinked
        ? `<div><b>Artemis IV FCS:</b> Active (+2 to cluster roll)</div>`
        : (artemisFullyLinked
            ? `<div><b>Artemis IV FCS:</b> Installed but not linked to this launcher (no bonus)</div>`
            : `<div><b>Artemis IV FCS:</b> Installed but NOT fully linked (no +2)</div>`))
    : "";

  const streakInfoLine = isStreakLauncher
    ? (hit
        ? `<div><b>Streak:</b> HIT — Cluster result is automatically 12 (all missiles hit)</div>`
        : `<div><b>Streak:</b> MISS — launcher did not fire (no ammo/heat)</div>`)
    : "";

const rapidFireInfoLine = (!rack && rapidFireRating > 1)
  ? `<div><b>Rapid Fire:</b> R${rapidFireRating} — Fired ${rapidShots} shot(s)${rapidShots > 1 ? " (uses Cluster Hits table)" : ""}</div>`
  : "";

const jamInfoLine = (jam && !isAbomChat && !rack && rapidShots > 1)
  ? `<div><b>Jam Check:</b> Rolled ${jam.rollTotal ?? "?"} (2d6); jams on ${jam.threshold} or less → <b>${jam.jammed ? "JAMMED" : "OK"}</b></div>`
  : "";

  const weaponSummary = cluster
    ? (cluster.mode === "missile"
        ? `${cluster.type}-${cluster.rackSize} (cluster) — Missiles Hit ${cluster.missilesHit}, Total Damage ${damage}`
        : (cluster.mode === "volley"
            ? `${cluster.label ?? "Volley"} (${cluster.type}-${cluster.rackSize}) — Hits ${cluster.volleyHits}/${cluster.volleySize}, Total Damage ${damage}`
            : `${cluster.label ?? "Rapid Fire"} (cluster) — Shots Hit ${cluster.missilesHit}/${cluster.rackSize}, Total Damage ${damage}`))
    : `Damage ${damage}`;

  const weaponLine = `<div><b>Weapon</b>: ${weaponSummary}${(!isAbomChat && heat ? `, Heat ${heat}` : "")}</div>`;

  const clusterPacketsHtml = cluster ? (() => {
    const isMissile = cluster.mode === "missile";
    const isVolley = cluster.mode === "volley";
    const projWord = (isMissile || isVolley) ? "missiles" : "shots";
    const streakTag = (isMissile && cluster.streakUsed)
      ? ` (Streak: auto 12)`
      : "";
    const artemisTag = (isMissile && !cluster.streakUsed)
      ? (cluster.clusterRollMod
          ? ` +${cluster.clusterRollMod} Artemis = ${cluster.clusterRollModifiedTotal}`
          : (artemisInstalled ? " (Artemis not applied)" : ""))
      : "";

    const volleySummary = isVolley
      ? `<div>${cluster.label ?? "Volley"} Roll: ${cluster.volleyRoll.total} (2d6) — Hits ${cluster.volleyHits}/${cluster.volleySize}</div>`
      : "";

    const volleySubLines = isVolley
      ? (cluster.subclusters ?? []).map((sc, idx) => {
          const modTag = sc.clusterRollMod ? ` +${sc.clusterRollMod} Artemis = ${sc.clusterRollModifiedTotal}` : "";
          return `<div>Attack ${idx + 1}: Cluster Roll ${sc.clusterRoll.total} (2d6)${modTag} — Missiles Hit ${sc.missilesHit}</div>`;
        }).join("")
      : "";

    const extraLine = (!isMissile && !isVolley)
      ? `<div>${cluster.label ?? "Rapid Fire"}: Fired ${cluster.rackSize} shot(s) — Hits ${cluster.missilesHit}</div>`
      : "";

    const list = (cluster.packets ?? []).map(p => {
      const tacTag = (p?.tacFrom2 && p?.roll?.total === 2) ? " — <b>TAC check</b>" : "";
      const floatTag = p?.floating ? ` — Floating: 2 → ${String(p.floating.reroll.loc).toUpperCase()} (rolled ${p.floating.reroll.rollTotal})` : "";
      const vehicleCritTag = (isVehicleTarget && p?.vehicleCrit?.trigger) ? " — <b>Vehicle Critical</b>" : "";
      const qty = isMissile ? `${p.hits} ${projWord}` : `${p.hits} shot(s)`;
      const locLabel = Number.isFinite(p?.abomIndex) ? `ABOM ${p.abomIndex}` : String(p.loc).toUpperCase();
      const rollText = Number.isFinite(p?.abomIndex)
        ? ` (${qty})`
        : (isVehicleTarget
            ? ` (location roll ${p.roll.total}; ${qty}${vehicleCritTag})`
            : ` (location roll ${p.roll.total}; ${qty}${tacTag}${floatTag})`);
      return `<li>${p.damage} dmg to ${locLabel}${rollText}</li>`;
    }).join("");

    return `<div><b>Cluster Packets</b></div>` +
      (isMissile ? `<div>Cluster Roll: ${cluster.clusterRoll.total} (2d6)${artemisTag}${streakTag}</div>` : "") +
      volleySummary +
      volleySubLines +
      extraLine +
      `<ul>${list}</ul>` +
      `<div><i>${clusterNote}</i></div>`;
  })() : "";

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
    `<div><b>Distance:</b> ${distance} (${band})</div>`,
    `<div><b>Roll:</b> ${toHit.total} (2d6 + ${skillLabel} ${gunnery}) vs <b>TN:</b> ${tn} → <b>${hit ? "HIT" : "MISS"}</b></div>`,
    buildAttackDetailsOpen(),
    `<hr/>`,
    `<div><b>Breakdown</b></div>`,
    `<ul>`,
    `<li>Base TN: ${baseTN}</li>`,
    `<li>Range (${band}${minPenalty ? `, min +${minPenalty}` : ""}): +${rangeMod}</li>`,
    `<li>Attacker movement: +${attackerMoveMod}${(String(opts.attackerMoveMode ?? 'auto').toLowerCase() === 'auto') ? ` (auto: ${autoMove.mode.toUpperCase()}, moved ${autoMove.moved})` : ''}</li>`,
    `<li>Target movement: +${targetMoveMod}${Number.isFinite(opts.targetHexes) ? ` (entered: ${opts.targetHexes})` : ` (auto: moved ${autoTargetMove.moved})`}</li>`,
    `<li>Heat: +${heatFireMod}</li>`,
    `<li>Targeting Computer: ${tcModStr}</li>`,
    `<li>Aimed Shot: ${aimedEnabled ? aimedModStr : "+0"}${(aimedDetails.length) ? ` (${aimedDetails.join('; ')})` : ``}${(!aimedEnabled && aimedDisabledReason) ? ` (${aimedDisabledReason})` : ""}</li>`,
    `<li>Statuses: +${statusTNMods.total}${statusTNMods.details?.length ? ` (${statusTNMods.details.join('; ')})` : ''}</li>`,
    `<li>Environment: +${envTNMods.mod}${envTNMods.details?.length ? ` (${envTNMods.details.join('; ')})` : ''}</li>`,
    `<li>Terrain: +${terrainMod}</li>`,
    `<li>Other: +${otherMod}</li>`,
    `</ul>`,
    `${weaponLine}`,
    `${rapidFireInfoLine}`,
    `${jamInfoLine}`,
    `${artemisInfoLine}`,
    `${streakInfoLine}`,
    `${ammoSpend?.key ? `<div><b>Ammo</b>: ${ammoSpend.after}/${ammoSpend.total} (${ammoSpend.key.toUpperCase()})</div>` : ""}`,
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
        if (isAbomTarget) {
          const hitIdx = Number.isFinite(r.hitAbomination) ? r.hitAbomination : "?";
          parts.push(`<div><b>Damage Applied:</b> ${r.damage} to Abomination ${hitIdx}</div>`);
        } else if (isVehicleTarget) {
          parts.push(`<div><b>Damage Applied:</b> ${damage} to ${String(r.loc).toUpperCase()} — Armor ${r.armorApplied}, Structure ${r.structureApplied}${r.overflow ? ` (Overflow ${r.overflow})` : ""}</div>`);
          const vehicleCritHtml = renderVehicleCrit(r.vehicleCrit);
          if (vehicleCritHtml) parts.push(vehicleCritHtml);
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
        } else {
          const allCritEvents = (damageApplied.results ?? []).flatMap(p => p?.result?.critEvents ?? []);
          const critHtml = renderCritEvents(allCritEvents);
          if (critHtml) parts.push(critHtml);
        }
      }
    }
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
    terrainMod,
    otherMod,
    gunnery,
    heat,
    damage,
    baseDamage,
    side,
    arc,
    locResult,
    cluster,
    ammoSpend,
    damageApplied,
    attackerTokenId: attackerToken?.id,
    targetTokenId: targetToken?.id
  };
}


// ------------------------------------------------------------
// Melee Weapons (Hatchet, Sword, etc.)
// ------------------------------------------------------------

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

  let damage = num(weaponItem.system?.damage, 0);
  if (isTSMActive(actor)) damage = damage * 2;

  let locResult = null;
  let tacMelee = false;
  let damageApplied = null;

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
        r = await applyDamageToVehicleActor(targetActor, locResult.loc, damage, { attackSide: side, crit });
      } else {
        r = await applyDamageToTargetActor(targetActor, locResult.loc, damage, { side, tac: tacMelee, tacLoc: locResult.loc });
        await _triggerAmmoExplosionsForDamageResult(targetActor, r, { side });
      }
      damageApplied = r;
    } catch (err) {
      console.warn("AToW Battletech | Melee weapon damage application threw", err);
      damageApplied = { ok: false, reason: String(err?.message ?? err) };
    }
  }

  // Chat card
  try {
    const attackerName = attackerToken?.name ?? actor.name;
    const targetName = targetToken?.name ?? "Target";
    const weaponMeta = _getWeaponAutomationMeta(weaponItem);

  // Display whether Artemis IV FCS is installed/active for this attack (cluster weapons only).
  const artemisInfoLine = (rack && artemisInstalled)
    ? (artemisLinked
        ? `<div><b>Artemis IV FCS:</b> Active (+2 to cluster roll)</div>`
        : (artemisFullyLinked
            ? `<div><b>Artemis IV FCS:</b> Installed but not linked to this launcher (no bonus)</div>`
            : `<div><b>Artemis IV FCS:</b> Installed but NOT fully linked (no +2)</div>`))
    : "";
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

  const rapidFireRating = getRapidFireRating(weaponItem);
  const rapidFireHtml = (rapidFireRating > 1)
    ? `
    <div class="form-group">
      <label>Rapid-Fire Shots (R${rapidFireRating})</label>
      <input type="number" name="rapidShots" value="1" min="1" max="${rapidFireRating}"/>
      <small>If &gt; 1, this attack cannot be an aimed shot.</small>
    </div>`
    : `<input type="hidden" name="rapidShots" value="1"/>`;

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
      <small>Auto-filled from target movement tracking (movedThisTurn). Override if needed.</small>
    </div>

    <div class="form-group">
      <label>Terrain Mod</label>
      <input type="number" name="terrainMod" value="0"/>
    </div>

    <div class="form-group">
      <label>Other Mod</label>
      <input type="number" name="otherMod" value="0"/>
    </div>


    
    ${rapidFireHtml}
<hr/>

    <div class="form-group">
      <label><input type="checkbox" name="aimedShot"/> Aimed Shot</label>
      <small>
        Aimed shots require an <b>Immobile</b> target, unless you have a <b>Targeting Computer</b> installed.
        Cluster/Area-Effect/Flak weapons cannot be aimed; indirect fire and multi-shot rapid-fire cannot be aimed.
      </small>
    </div>

    <div class="form-group">
      <label>Aimed Location</label>
      <select name="aimedLoc">
        ${caseLine}
</select>
      <small>
        ${caseLine}
</small>
    </div>

    ${caseLine}
<div class="form-group">
      <label><input type="checkbox" name="indirectFire"/> Indirect Fire</label>
      <small>If checked, this attack cannot be an aimed shot.</small>
    </div>
    ${rapidFireHtml}
    ${rapidFireHtml}

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
              showLocation: fd.get("showLocation") === "on",
              indirectFire: fd.get("indirectFire") === "on",
              rapidShots: num(fd.get("rapidShots"), 1),
              aimedShot: {
                enabled: fd.get("aimedShot") === "on",
                location: String(fd.get("aimedLoc") ?? "").trim(),
                useTC: (fd.get("useTC") === "on") || (fd.get("useTC") === null) // null when checkbox is disabled in HTML
              }
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
export async function promptAndRollWeaponAttack(actor, weaponItem, { defaultSide = "front", attackerToken = null } = {}) {
  // If this weapon is a melee weapon (hatchet/sword/etc.), use the melee weapon workflow.
  if (isMeleeWeaponItem(weaponItem)) {
    return promptAndRollMeleeWeaponAttack(actor, weaponItem, { defaultSide });
  }

  const attackerTok = attackerToken ?? getAttackerToken(actor);
  const targetToken = getSingleTargetToken();

  if (!targetToken) {
    ui?.notifications?.warn?.("Select exactly 1 target token before making an attack.");
    return null;
  }
  if (!attackerTok) {
    ui?.notifications?.warn?.("Place/control your mech token on the scene before making an attack.");
    return null;
  }

  const distance = measureTokenDistance(attackerTok, targetToken);
  if (distance === null) {
    ui?.notifications?.warn?.("Couldn't measure distance (no canvas/grid?).");
    return null;
  }

  const { band } = calcRangeBandAndMod(weaponItem, distance);

  const arc = getTargetSideFromFacing(attackerTok, targetToken);
  const computedSide = arc?.side ?? defaultSide;

  const autoTargetMove = getAutoTargetMoveData(targetToken);

  const rapidFireRating = getRapidFireRating(weaponItem);
  const rapidFireHtml = (rapidFireRating > 1)
    ? `
    <div class="form-group">
      <label>Rapid-Fire Shots (R${rapidFireRating})</label>
      <input type="number" name="rapidShots" value="1" min="1" max="${rapidFireRating}"/>
      <small>Each shot spends 1 ammo and adds +${num(weaponItem.system?.heat, 0)} Heat (damage scales per shot too).</small>
    </div>`
    : `<input type="hidden" name="rapidShots" value="1"/>`;

  const dialogHtml = `
  <form class="atow-attack-dialog">
    <div class="form-group">
      <label>Target</label>
      <div><b>${targetToken.name}</b></div>
    </div>

    <div class="form-group">
      <label>Distance</label>
      <div>${distance} (${band})</div>
      <input type="hidden" name="distance" value="${distance}"/>
    </div>

    <div class="form-group">
      <label>Auto status mods</label>
      <div><small>Applied automatically: +${getStatusTNMods(attackerToken, targetToken).total} (${getStatusTNMods(attackerToken, targetToken).details.join("; ") || "none"})</small></div>
    </div>

    <div class="form-group">
      <label>Auto environment mods</label>
      <div><small>Applied automatically: +${getEnvironmentTNMods(weaponItem).mod} (${getEnvironmentTNMods(weaponItem).details.join("; ") || "none"})</small></div>
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
      <small>Auto-filled from target movement tracking (movedThisTurn). Override if needed.</small>
    </div>

    <div class="form-group">
      <label>Terrain Mod</label>
      <input type="number" name="terrainMod" value="0"/>
    </div>

    <div class="form-group">
      <label>Other Mod</label>
      <input type="number" name="otherMod" value="0"/>
    </div>

    ${rapidFireHtml}

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
    <div class="form-group">
      <label><input type="checkbox" name="applyDamage" checked/> Apply Damage (auto)</label>
      <small>Automatically applies damage to the targeted mech if you have permission.</small>
    </div>

      <label><input type="checkbox" name="applyHeat" checked/> Apply Heat on Fire</label>
    </div>

    <div class="form-group">
      <label><input type="checkbox" name="showLocation" checked/> Roll Hit Location on Hit</label>
    </div>
  </form>`;

  return new Promise((resolve) => {
    new Dialog({
      title: `${weaponItem.name} — Attack`,
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
              applyDamage: fd.get("applyDamage") === "on",
              applyHeat: fd.get("applyHeat") === "on",
              showLocation: fd.get("showLocation") === "on",
              rapidShots: num(fd.get("rapidShots"), 1)
            };
            const result = await rollWeaponAttack(actor, weaponItem, { ...opts, attackerToken: attackerTok, targetToken });
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
          r = await applyDamageToVehicleActor(targetActor, locResult.loc, damage, { attackSide: side, crit });
        } else {
          r = await applyDamageToTargetActor(targetActor, locResult.loc, damage, { side });
          await _triggerAmmoExplosionsForDamageResult(targetActor, r, { side });
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

  const { damage, actuator, base } = calcKickDamageForLeg(actor, kickLegLoc);

    // TN: 8 + kick modifier (-2) + standard mods
  const tnBase = baseTN + kickTNMod;
  const tn = tnBase + attackerMoveMod + targetMoveMod + statusTNMods.total + terrainMod + otherMod;

  let toHit = null;
  let hit = false;
  let locResult = null;
  let damageApplied = null;

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
          r = await applyDamageToVehicleActor(targetActor, locResult.loc, damage, { attackSide: side, crit });
        } else {
          r = await applyDamageToTargetActor(targetActor, locResult.loc, damage, { side });
          await _triggerAmmoExplosionsForDamageResult(targetActor, r, { side });
        }
        damageApplied = r;
      } catch (err) {
        console.warn("AToW Battletech | Kick damage application threw", err);
        damageApplied = { ok: false, reason: String(err?.message ?? err) };
      }
    }
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
    damageApplied
  };
}

export async function promptAndRollMeleeAttack(actor, meleeType = "punch", { defaultSide = "front" } = {}) {
  const type = String(meleeType ?? "punch").toLowerCase();

  if (type !== "punch" && type !== "kick") {
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
    ui?.notifications?.warn?.(`${type === "kick" ? "Kick" : "Punch"} attacks require the target to be adjacent (range 1).`);
    return null;
  }

  const arc = getTargetSideFromFacing(attackerToken, targetToken);
  const computedSide = arc?.side ?? defaultSide;

  const autoTargetMove = getAutoTargetMoveData(targetToken);
  const statusTNMods = getStatusTNMods(attackerToken, targetToken);

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
      <small>Auto-filled from target movement tracking (movedThisTurn). Override if needed.</small>
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

  const dialogHtml = `
  <form class="atow-attack-dialog">
    ${commonFields}
    ${type === "punch" ? punchFields : kickFields}
  </form>`;

  const title = (type === "kick") ? `Kick — Physical Attack` : `Punch — Physical Attack`;

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

            opts.leg = String(fd.get("leg") ?? "right");
            const result = await rollKickAttack(actor, opts);
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

async function _rollCritSlotIndex(targetActor, structLoc) {
  const slots = targetActor.system?.crit?.[structLoc]?.slots;
  const maxSlots = Array.isArray(slots) ? slots.length : Number(targetActor.system?.crit?.[structLoc]?.maxSlots ?? 0) || 0;

  // Best-effort inference: torsos are 12 slots (upper/lower), everything else is 6
  const isTorsoLoc = ["ct", "lt", "rt"].includes(structLoc);
  const size = isTorsoLoc ? 12 : 6;

  // If we don't have a crit table for this location, abort.
  if (!slots || (Array.isArray(slots) && slots.length === 0) || (!Array.isArray(slots) && Object.keys(slots).length === 0)) {
    return { ok: false, reason: "No crit table" };
  }

  // Try up to N times to avoid infinite loops if everything is empty
  const MAX_TRIES = 50;

  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    if (size === 6) {
      const r = await (new Roll("1d6")).evaluate();
      const idx = (r.total ?? 1) - 1;
      const slot = slots?.[idx];
      if (_isOccupiedCritSlot(slot)) return { ok: true, idx, rolls: { slot: r.total }, label: slot?.label ?? slot };
      continue;
    }

    // 12-slot locations: roll upper/lower first (1-3 upper, 4-6 lower), then roll within that band
    const bandRoll = await (new Roll("1d6")).evaluate();
    const upper = (bandRoll.total ?? 1) <= 3;
    const offset = upper ? 0 : 6;

    const slotRoll = await (new Roll("1d6")).evaluate();
    const idx = offset + ((slotRoll.total ?? 1) - 1);

    const slot = slots?.[idx];
    if (_isOccupiedCritSlot(slot)) {
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
