// systems/atow-battletech/mech-sheet.js
// lets fix ferro fibrous armor

import { promptAndRollWeaponAttack, promptAndRollMeleeAttack, resolveAmmoExplosionEvent } from "./mech-attack.js";
import { ATOW_AUDIO_CUES, ATOW_AUDIO_EFFECTS, enqueueActorAudioCues, playActorMechExplosionEffect, playActorPowerRestoredAnnouncement, playActorShutdownAnnouncement } from "./audio-helper.js";

const SYSTEM_ID = "atow-battletech";
const TEMPLATE = `systems/${SYSTEM_ID}/templates/mech-sheet-v2.hbs`;
const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;

// Simple clamp helper (Math.clamp may not exist depending on Foundry / browser)
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

// Stored heat can exceed the 30-point bar maximum; we allow values up to this cap.
const HEAT_HARD_CAP = 100;
const getCurrentCombatTurnStamp = () => `${game.combat?.id ?? "no-combat"}:${game.combat?.round ?? 0}:${game.combat?.turn ?? 0}`;
const createCritMountId = () => foundry.utils.randomID();


// ------------------------------------------------------------
// Mech Tonnage / Structure (derived from tonnage)
// ------------------------------------------------------------
const TONNAGE_OPTIONS = Array.from({ length: 17 }, (_, i) => 20 + (i * 5));

/**
 * Structure table
 * Keys:
 *  - head: always 3 (included for completeness)
 *  - ct: center torso structure
 *  - lt/rt: left/right torso structure
 *  - arms: structure for each arm
 *  - legs: structure for each leg
 *  - maxArmor: maximum armor points (per the table provided)
 */
const STRUCTURE_TABLE = {
  20:  { head: 3, ct: 6,  lt: 5,  rt: 5,  arms: 3,  legs: 4,  maxArmor: 69  },
  25:  { head: 3, ct: 8,  lt: 6,  rt: 6,  arms: 4,  legs: 6,  maxArmor: 89  },
  30:  { head: 3, ct: 10, lt: 7,  rt: 7,  arms: 5,  legs: 7,  maxArmor: 105 },
  35:  { head: 3, ct: 11, lt: 8,  rt: 8,  arms: 6,  legs: 8,  maxArmor: 119 },
  40:  { head: 3, ct: 12, lt: 10, rt: 10, arms: 6,  legs: 10, maxArmor: 137 },
  45:  { head: 3, ct: 14, lt: 11, rt: 11, arms: 7,  legs: 11, maxArmor: 153 },
  50:  { head: 3, ct: 16, lt: 12, rt: 12, arms: 8,  legs: 12, maxArmor: 169 },
  55:  { head: 3, ct: 18, lt: 13, rt: 13, arms: 9,  legs: 13, maxArmor: 185 },
  60:  { head: 3, ct: 20, lt: 14, rt: 14, arms: 10, legs: 14, maxArmor: 201 },
  65:  { head: 3, ct: 21, lt: 15, rt: 15, arms: 10, legs: 15, maxArmor: 211 },
  70:  { head: 3, ct: 22, lt: 15, rt: 15, arms: 11, legs: 15, maxArmor: 217 },
  75:  { head: 3, ct: 23, lt: 16, rt: 16, arms: 12, legs: 16, maxArmor: 231 },
  80:  { head: 3, ct: 25, lt: 17, rt: 17, arms: 13, legs: 17, maxArmor: 247 },
  85:  { head: 3, ct: 27, lt: 18, rt: 18, arms: 14, legs: 18, maxArmor: 263 },
  90:  { head: 3, ct: 29, lt: 19, rt: 19, arms: 15, legs: 19, maxArmor: 279 },
  95:  { head: 3, ct: 30, lt: 20, rt: 20, arms: 16, legs: 20, maxArmor: 293 },
  100: { head: 3, ct: 31, lt: 21, rt: 21, arms: 17, legs: 21, maxArmor: 307 }
};

const roundTons = (n) => Math.round(Number(n) * 10) / 10;

function normalizeMechTonnage(value) {
  let n = Number(value);
  if (!Number.isFinite(n)) n = 50;

  // Snap to 5-ton increments, then clamp to allowed range.
  n = Math.round(n / 5) * 5;
  n = clamp(n, 20, 100);

  // Ensure we land on a defined entry.
  if (!STRUCTURE_TABLE[n]) {
    n = TONNAGE_OPTIONS.reduce((best, t) => {
      return (Math.abs(t - n) < Math.abs(best - n)) ? t : best;
    }, TONNAGE_OPTIONS[0]);
  }

  return n;
}

function getStructureProfileForTonnage(tonnage) {
  const t = normalizeMechTonnage(tonnage);
  const row = STRUCTURE_TABLE[t] ?? STRUCTURE_TABLE[50];

  return {
    tonnage: t,
    maxArmor: Number(row.maxArmor ?? 0),
    structure: {
      head: Number(row.head ?? 3),
      ct: Number(row.ct ?? 0),
      lt: Number(row.lt ?? 0),
      rt: Number(row.rt ?? 0),
      la: Number(row.arms ?? 0),
      ra: Number(row.arms ?? 0),
      ll: Number(row.legs ?? 0),
      rl: Number(row.legs ?? 0)
    }
  };
}

function getItemTonnage(doc, { useQuantity = true } = {}) {
  const sys = doc?.system ?? {};

  // Triple-Strength Myomer (TSM) always weighs 0 tons (Inner Sphere special equipment).
  if (String(doc?.name ?? "").trim().toLowerCase() === "triple-strength myomer") return 0;

  const parseNum = (v) => {
    if (v === null || v === undefined) return NaN;
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "string") {
      const s = v.trim().toLowerCase().replace(/,/g, "");
      if (!s) return NaN;
      // Strip common unit suffixes like "t", "ton", "tons", "tonnes"
      const cleaned = s.replace(/\b(tons?|tonnes?|t)\b/g, "").trim();
      const n = Number.parseFloat(cleaned);
      return Number.isFinite(n) ? n : NaN;
    }
    // Some items store weight as an object (e.g., { value: 0.5, unit: "t" })
    if (typeof v === "object") {
      const nested = v.tons ?? v.tonnage ?? v.value ?? v.weight ?? v.mass ?? v.amount;
      return parseNum(nested);
    }
    return NaN;
  };

  const qtyRaw = sys.quantity ?? sys.qty ?? sys.count ?? sys.amount ?? 1;

  let wRaw =
    sys.tonnage ??
    sys.tons ??
    sys.ton ??
    sys.weightTons ??
    sys.mass ??
    sys.weight ??
    0;

  // Handle nested weight objects
  if (wRaw && typeof wRaw === "object") {
    wRaw = wRaw.tons ?? wRaw.tonnage ?? wRaw.value ?? wRaw.weight ?? wRaw.mass ?? 0;
  }

  const qty = parseNum(qtyRaw);
  const w = parseNum(wRaw);

  const q = useQuantity ? (Number.isFinite(qty) ? qty : 1) : 1;
  const wt = Number.isFinite(w) ? w : 0;

  return wt * q;
}



// ------------------------------------------------------------
// Tonnage Breakdown Helpers
// ------------------------------------------------------------
const ENGINE_TONNAGE_TABLE = {
  10: 0.5,      15: 0.5,      20: 0.5,      25: 0.5,      30: 1,        35: 1,        40: 1,
  45: 1,        50: 1.5,      55: 1.5,      60: 1.5,      65: 2,        70: 2,        75: 2,
  80: 2.5,      85: 2.5,      90: 3,        95: 3,        100: 3,       105: 3.5,     110: 3.5,
  115: 4,       120: 4,       125: 4,       130: 4.5,     135: 4.5,     140: 5,       145: 5,
  150: 5.5,     155: 5.5,     160: 6,       165: 6,       170: 6,       175: 7,       180: 7,
  185: 7.5,     190: 7.5,     195: 8,       200: 8.5,     205: 8.5,     210: 9,       215: 9.5,
  220: 10,      225: 10,      230: 10.5,    235: 11,      240: 11.5,    245: 12,      250: 12.5,
  255: 13,      260: 13.5,    265: 14,      270: 14.5,    275: 15.5,    280: 16,      285: 16.5,
  290: 17.5,    295: 18,      300: 19,      305: 19.5,    310: 20.5,    315: 21.5,    320: 22.5,
  325: 23.5,    330: 24.5,    335: 25.5,    340: 27,      345: 28.5,    350: 29.5,    355: 31.5,
  360: 33,      365: 34.5,    370: 36.5,    375: 38.5,    380: 41,      385: 43.5,    390: 46,
  395: 49,      400: 52.5,
};

function parseEngineRating(engineText) {
  const m = String(engineText ?? "").match(/(\d+)/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) ? n : null;
}

function getEngineTonnageFromRating(rating) {
  if (!Number.isFinite(Number(rating))) return 0;
  return Number(ENGINE_TONNAGE_TABLE[String(rating)]) || 0;
}


function getEngineTonnageFromEngineText(engineText) {
  const rating = parseEngineRating(engineText);
  const standard = getEngineTonnageFromRating(rating);

  if (_isXLEngineText(engineText)) {
    // XL engines weigh half a standard engine, rounded up to the nearest 0.5 ton, minimum 0.5t.
    // Because standard engine weights are in 0.5t increments, this is equivalent to ceil(standard)/2.
    return Math.max(0.5, (Math.ceil(standard) / 2));
  }

  return standard;
}


function getStandardStructureTonnage(tonnage) {
  const t = normalizeMechTonnage(tonnage);
  if (!Number.isFinite(t) || t <= 0) return 0;
  // Standard internal structure weight: 10% of mech tonnage.
  return roundTons(t * 0.10);
}

function getEndoSteelStructureTonnage(tonnage) {
  const standard = getStandardStructureTonnage(tonnage);
  if (!Number.isFinite(standard) || standard <= 0) return 0;
  // Endo Steel weighs half a standard structure, rounded up to the nearest 0.5 ton.
  // (Standard structure weights are in 0.5t increments for normal mech tonnages.)
  return Math.max(0.5, (Math.ceil(standard) / 2));
}


function computeDerivedMovement(engineRatingRaw, tonnageRaw, opts = {}) {
  const tonnage = normalizeMechTonnage(tonnageRaw);
  const rating = parseEngineRating(engineRatingRaw);
  if (!Number.isFinite(tonnage) || tonnage <= 0 || !Number.isFinite(rating) || rating <= 0) return null;

  // Classic Battletech: Walking MP = Engine Rating / Mech Tonnage (round down).
  const walk = Math.floor(rating / tonnage);

  // Running MP is 1.5x walking MP (round up per standard BT rounding).
  const run = Math.ceil(walk * 1.5);

  // Jumping MP: only if jump jets are installed.
  // By default, we cap jump MP to the number of installed jump jets (1 jet = 1 MP).
  const jumpJetCount = Math.max(0, Math.floor(Number(opts?.jumpJetCount ?? 0) || 0));
  const hasJumpJets = Boolean(opts?.hasJumpJets ?? (jumpJetCount > 0));
  const jump = hasJumpJets ? (jumpJetCount > 0 ? Math.min(walk, jumpJetCount) : walk) : 0;

  return { walk, run, jump };
}


function isHeatSinkItemName(name) {
  const n = String(name ?? "").toLowerCase();
  if (n.includes("radical heat sink")) return false;
  return n.includes("heat sink") || n.includes("heatsink");
}

function isDoubleHeatSinkName(name) {
  const n = String(name ?? "").toLowerCase();
  return n.includes("double heat sink") || n.includes("double heatsink") || /\b(dhs)\b/.test(n);
}

function _getItemHeatDissipation(doc, { useQuantity = true } = {}) {
  const sys = doc?.system ?? {};
  const raw = sys.heatDissipation ?? sys.heatDiss ?? sys.dissipation ?? sys.heat?.dissipation ?? 0;
  const v = Number(raw);
  const d = Number.isFinite(v) ? v : 0;

  if (!useQuantity) return d;

  const qtyRaw = sys.quantity ?? sys.qty ?? sys.count ?? 1;
  const qty = Number(qtyRaw);
  const q = Number.isFinite(qty) ? qty : 1;
  return d * q;
}

function _isHeatSinkDoc(doc) {
  const sys = doc?.system ?? {};
  if (sys.isHeatSink === true) return true;
  return isHeatSinkItemName(doc?.name);
}

function _fallbackHeatDissipationFromLabel(label, { isDouble = false } = {}) {
  const t = String(label ?? "").toLowerCase();
  if (!t) return 0;
  // If the label strongly indicates a double sink, treat it as 2.
  if (isDoubleHeatSinkName(t) || t.includes("double")) return 2;
  // If it's a heat sink but doesn't specify, fall back to the mech-wide double toggle.
  if (isHeatSinkItemName(t)) return isDouble ? 2 : 1;
  return 0;
}

function collectCoolingFromEmbeddedDocs(docs, { isDouble = false } = {}) {
  let sinkCount = 0;
  let sinkDissipation = 0;
  let otherDissipation = 0;

  for (const it of (docs ?? [])) {
    if (!it) continue;
    const isSink = _isHeatSinkDoc(it);

    // Heat sinks should always count even if they don't declare a dissipation value.
    if (isSink) {
      const qty = Number(it?.system?.quantity ?? it?.system?.qty ?? 1) || 1;
      sinkCount += Math.max(0, qty);

      // If the item does not declare dissipation, fall back to label + mech toggle.
      const diss = _getItemHeatDissipation(it, { useQuantity: true });
      const used = (diss > 0) ? diss : (_fallbackHeatDissipationFromLabel(it?.name, { isDouble }) * qty);
      sinkDissipation += used;
    } else {
      const diss = _getItemHeatDissipation(it, { useQuantity: true });
      if (!(diss > 0)) continue;
      otherDissipation += diss;
    }
  }

  return {
    sinkCount: Math.max(0, sinkCount),
    sinkDissipation: Math.max(0, sinkDissipation),
    otherDissipation: Math.max(0, otherDissipation)
  };
}

async function collectCoolingFromCritSlots(actor, { isDouble = false } = {}) {
  const system = actor?.system ?? {};
  const locKeys = ["head", "ct", "lt", "rt", "la", "ra", "ll", "rl"];

  // Gather all start-slots with either a uuid or label.
  const starts = [];
  const uuidSet = new Set();

  for (const locKey of locKeys) {
    const slots = _getCritSlotsArray(system, locKey);
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i] ?? {};
      if (s?.partOf !== undefined && s?.partOf !== null) continue;

      const uuid = String(s?.uuid ?? "").trim();
      let label = String(s?.label ?? "").trim();
      if (!uuid && !label) continue;

      // Respect destroyed components (check across span)
      const span = clamp(Number(s?.span ?? 1) || 1, 1, slots.length - i);
      let destroyed = false;
      for (let j = 0; j < span; j++) destroyed ||= Boolean(slots[i + j]?.destroyed);
      if (destroyed) continue;

      if (!label) label = String(_defaultCritLabel(actor, locKey, i) ?? "").trim();

      if (uuid) uuidSet.add(uuid);
      starts.push({ uuid, label });
    }
  }

  // Resolve unique uuids once.
  const uuidToDoc = new Map();
  if (uuidSet.size) {
    const unique = Array.from(uuidSet);
    await Promise.all(unique.map(async (uuid) => {
      try {
        const doc = await fromUuid(uuid);
        if (doc) uuidToDoc.set(uuid, doc);
      } catch (_) {
        /* ignore */
      }
    }));
  }

  let sinkCount = 0;
  let sinkDissipation = 0;
  let otherDissipation = 0;

  for (const st of starts) {
    const doc = st.uuid ? uuidToDoc.get(st.uuid) : null;
    const label = st.label || doc?.name || "";

    // Dissipation: anything with a positive heatDissipation contributes.
    // Crit slots represent a single installed component; ignore any embedded quantity fields.
    const declaredDiss = doc ? _getItemHeatDissipation(doc, { useQuantity: false }) : 0;
    const fallbackDiss = _fallbackHeatDissipationFromLabel(label, { isDouble });
    const diss = (declaredDiss > 0) ? declaredDiss : fallbackDiss;
    if (!(diss > 0)) continue;

    // Count sinks only if the item/label indicates a heat sink.
    const isSink = doc ? _isHeatSinkDoc(doc) : isHeatSinkItemName(label);
    if (isSink) {
      sinkCount += 1;
      sinkDissipation += diss;
    } else {
      otherDissipation += diss;
    }
  }

  return {
    sinkCount: Math.max(0, sinkCount),
    sinkDissipation: Math.max(0, sinkDissipation),
    otherDissipation: Math.max(0, otherDissipation)
  };
}

function countHeatSinkComponents(docs) {
  let count = 0;
  for (const it of (docs ?? [])) {
    if (!isHeatSinkItemName(it?.name)) continue;
    const qty = Number(it?.system?.quantity ?? it?.system?.qty ?? 1) || 1;
    count += qty;
  }
  return Math.max(0, count);
}
async function countHeatSinkComponentsFromCritSlots(actor) {
  const system = actor?.system ?? {};
  const locKeys = ["head", "ct", "lt", "rt", "la", "ra", "ll", "rl"];
  let count = 0;
  const pending = [];

  for (const locKey of locKeys) {
    const slots = _getCritSlotsArray(system, locKey);
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i] ?? {};
      // Continuation slot
      if (s?.partOf !== undefined && s?.partOf !== null) continue;

      const uuid = String(s?.uuid ?? "").trim();
      let label = String(s?.label ?? "").trim();

      if (!uuid && !label) continue;

      // Respect destroyed components (check across span)
      const span = clamp(Number(s?.span ?? 1) || 1, 1, slots.length - i);
      let destroyed = false;
      for (let j = 0; j < span; j++) destroyed ||= Boolean(slots[i + j]?.destroyed);
      if (destroyed) continue;

      // If label is blank, fall back to default crit labels (some locations have defaults)
      if (!label) label = String(_defaultCritLabel(actor, locKey, i) ?? "").trim();

      // Fast path: label match
      if (isHeatSinkItemName(label)) {
        count += 1;
        continue;
      }

      // UUID match (best-effort)
      if (uuid) {
        pending.push(isHeatSinkUuid(uuid, actor).then(ok => ok ? 1 : 0).catch(() => 0));
      }
    }
  }

  if (pending.length) {
    const adds = await Promise.all(pending);
    count += adds.reduce((a, b) => a + (Number(b) || 0), 0);
  }

  return Math.max(0, count);
}

/**
 * Count installed Jump Jets from crit slots (1 jet = 1 crit slot).
 * We treat a slot as a jump jet if its stored label looks like a jump jet, or its UUID resolves to a Jump Jet item.
 */
async function countJumpJetComponentsFromCritSlots(actor) {
  const system = actor?.system ?? {};
  const locKeys = ["head", "ct", "lt", "rt", "la", "ra", "ll", "rl"];
  let count = 0;

  /** @type {Promise<void>[]} */
  const pending = [];

  for (const locKey of locKeys) {
    const slots = _getCritSlotsArray(system, locKey);
    for (const slot of slots) {
      if (!slot) continue;

      // Skip multi-slot continuations and destroyed components (they don't function / don't count).
      if (slot.partOf) continue;
      if (slot.destroyed) continue;

      const label = String(slot.label ?? "");
      if (_isJumpJetText(label)) {
        count += 1;
        continue;
      }

      const uuid = String(slot.uuid ?? "");
      if (uuid) {
        pending.push(
          isJumpJetUuid(uuid)
            .then((isJJ) => { if (isJJ) count += 1; })
            .catch(() => {}) // ignore resolution failures; just treat as not a jump jet
        );
      }
    }
  }

  if (pending.length) await Promise.all(pending);
  return count;
}


// ------------------------------------------------------------
// Triple-Strength Myomer (TSM) helpers
// ------------------------------------------------------------
const _TSM_LABEL_RE = /^triple\s*[-]?\s*strength\s*myomer$/i;
const _MASC_LABEL_RE = /\bmasc\b/i;

/**
 * Count occupied crit slots for a component that can span multiple slots.
 * - Matches on the *start slot* label, but counts every occupied slot (including continuations).
 * - If includeDestroyed=false, destroyed slots are excluded from the count (useful for "intact slots").
 */
function countComponentCritSlots(actorSystem, labelRegex, { includeDestroyed = false } = {}) {
  const sys = actorSystem ?? {};
  const crit = sys?.crit ?? {};
  let count = 0;

  for (const loc of Object.values(crit)) {
    const slotsRaw = loc?.slots;
    if (!slotsRaw) continue;

    // Build an index->slot map so we can resolve continuations to their start slot.
    const slotMap = new Map();
    for (const { idx, slot } of _iterCritSlots(slotsRaw)) slotMap.set(Number(idx), slot);

    for (const [idx, slot] of slotMap) {
      if (!slot) continue;
      if (!includeDestroyed && Boolean(slot.destroyed)) continue;

      const startIdx = (slot.partOf !== undefined && slot.partOf !== null) ? Number(slot.partOf) : idx;
      const startSlot = slotMap.get(startIdx) ?? slot;

      const label = String(startSlot?.label ?? "").trim();
      if (!label) continue;

      if (labelRegex.test(label)) count += 1;
    }
  }

  return Math.max(0, count);
}



function countAmmoCritSlots(actorSystem) {
  const crit = actorSystem?.crit ?? {};
  let slots = 0;

  for (const loc of Object.values(crit)) {
    const arr = loc?.slots;
    if (!arr) continue;

    const iter = Array.isArray(arr) ? arr : Object.values(arr);
    for (const s of iter) {
      if (!s) continue;
      // Ignore continuation slots if present
      if (s.partOf !== undefined && s.partOf !== null) continue;
      const label = String(s.label ?? "").trim();
      if (!label) continue;
      if (/^Ammo\s*\(/i.test(label)) slots += 1;
    }
  }
  


  return slots;
}



function countEndoSteelCritSlots(actorSystem) {
  const crit = actorSystem?.crit ?? {};
  let slots = 0;

  for (const loc of Object.values(crit)) {
    const arr = loc?.slots;
    if (!arr) continue;

    const iter = Array.isArray(arr) ? arr : Object.values(arr);
    for (const s of iter) {
      if (!s) continue;
      // Ignore continuation slots if present
      if (s.partOf !== undefined && s.partOf !== null) continue;

      const label = String(s.label ?? "").trim();
      if (!label) continue;

      if (/endo\s*steel/i.test(label)) slots += 1;
    }
  }

  return slots;
}


function countFerroFibrousCritSlots(actorSystem) {
  const crit = actorSystem?.crit ?? {};
  let standard = 0;
  let light = 0;

  for (const loc of Object.values(crit)) {
    const arr = loc?.slots;
    if (!arr) continue;

    const iter = Array.isArray(arr) ? arr : Object.values(arr);
    for (const s of iter) {
      if (!s) continue;
      // Ignore continuation slots if present
      if (s.partOf !== undefined && s.partOf !== null) continue;

      const label = String(s.label ?? "").trim();
      if (!label) continue;

      // Accept "Light Ferro Fibrous" as its own armor type first.
      if (/light\s+ferro\s*-?\s*fibrous/i.test(label)) {
        light += 1;
        continue;
      }

      // Accept "Ferro Fibrous", "Ferro-Fibrous", etc.
      if (/ferro\s*-?\s*fibrous/i.test(label)) standard += 1;
    }
  }

  return { standard, light };
}



// ------------------------------------------------------------
// Installed Crit-Slot Tonnage Helpers
// ------------------------------------------------------------
// We derive ammo + crit-slot equipment weight from the underlying Item's tonnage field whenever possible.
// This fixes cases like 0.5t Machine Gun ammo (1 crit slot) and crit-slot equipment (e.g., Command Module)
// that previously wasn’t counted in the tonnage breakdown.
async function collectInstalledCritSlotTonnage(actor) {
  const system = actor?.system ?? {};
  const crit = system?.crit ?? {};

  let ammoSlots = 0;
  let ammoTons = 0;
  let otherCritTons = 0;

  const startSlots = [];
  const uuids = new Set();

  for (const loc of Object.values(crit)) {
    const arr = loc?.slots;
    if (!arr) continue;
    const iter = Array.isArray(arr) ? arr : Object.values(arr);

    for (const s of iter) {
      if (!s) continue;
      // Ignore continuation slots if present
      if (s.partOf !== undefined && s.partOf !== null) continue;

      const label = String(s.label ?? "").trim();
      if (!label) continue;

      const uuid = s.uuid ?? s.itemUuid ?? null;
      startSlots.push({ label, uuid });

      if (uuid) uuids.add(uuid);
    }
  }

  // Resolve UUIDs once (avoid repeated fromUuid calls)
  const resolved = new Map();
  for (const uuid of uuids) {
    try {
      resolved.set(uuid, await fromUuid(uuid));
    } catch (_) {
      resolved.set(uuid, null);
    }
  }

  for (const st of startSlots) {
    const label = st.label;
    const doc = st.uuid ? resolved.get(st.uuid) : null;

    const docType = String(doc?.type ?? "").toLowerCase();
    const name = String(doc?.name ?? label ?? "");

    const techBase = _getMechTechBase(actor);
    const isCase = (/(^|\b)case(\b|$)/i.test(String(label ?? "")) || (/(^|\b)case(\b|$)/i.test(name)));
    if (isCase) {
      // Inner Sphere CASE weighs 0.5t (Clan CASE is free). Protection rules are handled elsewhere.
      otherCritTons += (techBase === "clan") ? 0 : 0.5;
      continue;
    }

    const isAmmo = /^Ammo\s*\(/i.test(label) || docType === "ammo";
    if (isAmmo) {
      ammoSlots += 1;

      let t = doc ? getItemTonnage(doc, { useQuantity: false }) : NaN;
      // Fallback to the legacy 1t-per-bin assumption if the item doesn’t declare tonnage.
      if (!Number.isFinite(t) || t <= 0) t = 1;

      ammoTons += t;
      continue;
    }

    // Weapons are tracked separately (autoWeapons)
    if (_WEAPON_TYPES.has(docType) || _looksLikeWeaponLabel(label)) continue;

    // Heat sinks are tracked separately
    if (isHeatSinkItemName(name) || isHeatSinkItemName(label)) continue;

    // Jump Jets are tracked separately via movement.jump
    if (_isJumpJetText(name) || _isJumpJetText(label)) continue;

    // Everything else: if it’s a real item with tonnage, count it under "Other"
    if (doc) {
      const t = getItemTonnage(doc, { useQuantity: false });
      if (Number.isFinite(t) && t > 0) otherCritTons += t;
    }
    else {
      // Fallback for equipment that may exist only as a label in crit slots.
      if (/^\s*artemis\s*iv\s*fcs\s*$/i.test(label) || /^\s*artemis\s*iv\s*fcs\s*$/i.test(name)) {
        otherCritTons += 1;
      }
    }
  }

  return {
    ammoSlots,
    ammoTons: roundTons(ammoTons),
    otherCritTons: roundTons(otherCritTons)
  };
}

// Register globally so sheet code can safely access it even across cache/version mismatches.
try {
  if (typeof globalThis !== "undefined") globalThis.collectInstalledCritSlotTonnage = collectInstalledCritSlotTonnage;
} catch (e) {}


function getJumpJetWeightPerJet(tonnage) {
  const t = Number(tonnage) || 0;

  // Classic BattleTech jump jet weights (tons per jump jet):
  // - 10–55 tons: 0.5
  // - 60–85 tons: 1
  // - 90–100 tons: 2
  // (Non-standard 86–89 ton customs are treated as Heavy-class.)
  if (t <= 55) return 0.5;
  if (t <= 89) return 1;
  return 2;
}

function sumArmorPoints(actorSystem) {
  const armor = actorSystem?.armor ?? {};
  let total = 0;
  for (const v of Object.values(armor)) {
    const n = Number(v?.max ?? 0);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}




// ------------------------------------------------------------
// Ammo bins (derived from installed ammo in crit slots)
// ------------------------------------------------------------
function _slugifyKey(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function _ammoKeyFromType(typeText) {
  const t = String(typeText ?? "").trim().toLowerCase();
  // Some ammo types (notably LB-X) have distinct munition variants, e.g. Cluster vs non-Cluster.
  // We must NOT merge these into a single bin key.
  const isCluster = /\bcluster\b/i.test(t);
  let m;

  // LB-X Autocannon ammo (various label styles):
  // - "LB 10-X AC"
  // - "LB10-X AC"
  // - "LBX AC/10"
  // - "LBX 10"
  m = t.match(/\blb\s*(\d+)\s*-\s*x\s*ac\b/i);
  if (m?.[1]) return _slugifyKey(`lbx-${m[1]}${isCluster ? "-cluster" : ""}`);
  m = t.match(/\blbx\b[^\d]*(\d+)\b/i); // "lbx 10", "lbx ac/10", etc.
  if (m?.[1]) return _slugifyKey(`lbx-${m[1]}${isCluster ? "-cluster" : ""}`);

  // Gauss Rifle ammo ("Gauss", "Gauss Rifle", etc.)
  if (t === "gauss" || t.includes("gauss")) return "gauss";

  // Standard Autocannon ammo: AC/20, AC 20
  m = t.match(/\bac\s*\/?\s*(\d+)\b/i);
  if (m?.[1]) return _slugifyKey(`ac-${m[1]}`);

  // LRM 20, SRM 6
  m = t.match(/\b(lrm|srm)\s*(\d+)\b/i);
  if (m?.[1] && m?.[2]) return _slugifyKey(`${m[1]}-${m[2]}`);

  // Machine Gun
  if (t.includes("machine gun") || t === "mg") return "mg";

  return null;
}

function buildAmmoBinsFromCritSlots(actorSystem) {
  const crit = actorSystem?.crit ?? {};
  const totals = new Map(); // key -> { name, total }

  const add = (name, key, amt) => {
    if (!key || !Number.isFinite(amt) || amt <= 0) return;
    const prev = totals.get(key);
    if (!prev) totals.set(key, { key, name, total: amt });
    else prev.total += amt;
  };

  for (const loc of Object.values(crit)) {
    const slots = loc?.slots;
    if (!slots) continue;

    const iter = Array.isArray(slots) ? slots : Object.values(slots);
    for (const slot of iter) {
      const label = String(slot?.label ?? "").trim();
      if (!label) continue;

      // Match: Ammo (LRM 20) 6
      const m = label.match(/^\s*Ammo\s*\(([^)]+)\)\s*(\d+)\s*$/i);
      if (!m) continue;

      const typeText = String(m[1] ?? "").trim();
      const amt = Number(m[2] ?? 0);
      const key = _ammoKeyFromType(typeText);

      add(typeText, key, amt);
    }
  }

  // Merge with saved currents (editable) from system.ammoBins
  const saved = actorSystem?.ammoBins ?? {};
  const bins = [];

  for (const [key, row] of totals.entries()) {
    const total = Number(row.total ?? 0) || 0;

    const savedCur = Number(saved?.[key]?.current);
    const cur = Number.isFinite(savedCur) ? clamp(savedCur, 0, total) : total;

    bins.push({
      key,
      name: row.name,
      total,
      current: cur
    });
  }

  bins.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return bins;
}

// ------------------------------------------------------------
// Auto Weapons (derived from installed crit-slot items)
// ------------------------------------------------------------
const _WEAPON_TYPES = new Set(["weapon", "mechWeapon"]);

function _looksLikeWeaponLabel(label) {
  if (!label) return false;
  const s = String(label);

  // LB-X Autocannons often appear as "LB 10-X AC" (or similar) and do not match the generic AC/10 pattern.
  // Accept a few common label styles:
  // - "LB 2-X AC", "LB 5-X AC", "LB 10-X AC", "LB 20-X AC"
  // - "LB2-X AC" / "LB10-X AC"
  // - "LBX AC/10" / "LBX 10"
  if (/\blb\s*\d+\s*-\s*x\s*ac\b/i.test(s)) return true;
  if (/\blbx\b[^\d]*(\d+)\b/i.test(s)) return true;

  return /(laser|ppc|\bac\s*\/?\s*\d+\b|\blrm\s*\d+\b|\bsrm\s*\d+\b|gauss|\bmg\b|machine gun|flamer|autocannon|rifle|plasma|pulse)/i.test(s);
}

function _critLocAbbr(locKey) {
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

function _getCritSlotsArray(system, locKey) {
  const locMax = (locKey === "head" || locKey === "ll" || locKey === "rl") ? 6 : 12;
  const stored = system?.crit?.[locKey]?.slots;
  const out = Array.from({ length: locMax }, () => ({}));

  if (Array.isArray(stored)) {
    for (let i = 0; i < Math.min(locMax, stored.length); i++) out[i] = stored[i] ?? {};
    return out;
  }

  if (stored && typeof stored === "object") {
    for (const [k, v] of Object.entries(stored)) {
      const i = Number(k);
      if (!Number.isNaN(i) && i >= 0 && i < locMax) out[i] = v ?? {};
    }
  }

  return out;
}

async function buildAutoWeaponsFromCritSlots(actor) {
  const system = actor?.system ?? {};
  const locKeys = ["head", "ct", "lt", "rt", "la", "ra", "ll", "rl"]; // standard crit locations

  // Gather candidates (start slots only)
  const candidates = [];
  for (const locKey of locKeys) {
    const slots = _getCritSlotsArray(system, locKey);
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i] ?? {};
      if (s?.partOf !== undefined && s?.partOf !== null) continue; // continuation slot

      const uuid = String(s?.uuid ?? "").trim();
      const label = String(s?.label ?? "").trim();
      if (!uuid && !label) continue;

      // span/destroyed are best-effort; destroyed can be on any occupied slot of the component
      const span = clamp(Number(s?.span ?? 1) || 1, 1, slots.length - i);
      let destroyed = false;
      for (let j = 0; j < span; j++) destroyed ||= Boolean(slots[i + j]?.destroyed);

      candidates.push({
        locKey,
        index: i,
        uuid,
        label,
        mountId: String(s?.mountId ?? "").trim(),
        span,
        destroyed,
        mountOrdinal: candidates.length
      });
    }
  }

  // Resolve UUIDs (dedupe) so we can confirm weapon types and pull stats.
  const uniqueUuids = Array.from(new Set(candidates.map(c => c.uuid).filter(Boolean)));
  const resolved = new Map(); // uuid -> Item|null

  await Promise.all(uniqueUuids.map(async (uuid) => {
    try {
      const doc = await fromUuid(uuid);
      resolved.set(uuid, doc ?? null);
    } catch {
      resolved.set(uuid, null);
    }
  }));

  const weapons = [];
  for (const c of candidates) {
    const doc = c.uuid ? (resolved.get(c.uuid) ?? null) : null;

    // Determine weapon-ness
    const isWeapon = doc
      ? _WEAPON_TYPES.has(doc.type)
      : _looksLikeWeaponLabel(c.label);
    if (!isWeapon) continue;

    const o = doc ? doc.toObject() : { name: c.label, system: {} };
    o.id = `crit-${c.locKey}-${c.index}`;
    o.itemUuid = c.uuid || "";
    o.mountId = c.mountId || "";
    o.weaponFireKey = c.mountId ? `mount:${c.mountId}` : `crit:${c.locKey}:${c.index}:${c.mountOrdinal}`;
    o.isWeapon = true;
    o.canDelete = false;
    o.canAttack = Boolean(c.uuid) && !c.destroyed;
    o.destroyed = Boolean(c.destroyed);

    o.system = o.system ?? {};
    // Display-only mount location. (We don't persist this onto the source item.)
    o.system.loc = _critLocAbbr(c.locKey);

    weapons.push(o);
  }

  // Stable sort: by location then by name
  const locOrder = new Map(["HD", "CT", "LT", "RT", "LA", "RA", "LL", "RL"].map((k, i) => [k, i]));
  weapons.sort((a, b) => {
    const ao = locOrder.get(String(a.system?.loc ?? "")) ?? 999;
    const bo = locOrder.get(String(b.system?.loc ?? "")) ?? 999;
    if (ao !== bo) return ao - bo;
    return String(a.name ?? "").localeCompare(String(b.name ?? ""));
  });

  return weapons;
}

/**
 * Synthetic melee attacks (always available on every mech).
 * These are not Items; they are virtual rows so the sheet always has Punch/Kick available.
 */
function buildMeleeAttackEntries(actor, { tsmActive = false } = {}) {
  const tonnage = Number(actor?.system?.mech?.tonnage ?? actor?.system?.tonnage ?? 50) || 50;

  let punchDamage = Math.max(1, Math.ceil(tonnage / 10));
  let kickDamage = Math.max(1, Math.ceil(tonnage / 5)); // shown for reference; kick automation comes next

  // TSM doubles physical attack damage (punch/kick/club). We implement punch + kick here.
  if (tsmActive) {
    punchDamage *= 2;
    kickDamage *= 2;
  }

  return [
    {
      id: "melee-punch",
      name: "Punch",
      system: {
        damage: punchDamage,
        heat: 0,
        rangeShort: 1,
        rangeMedium: 1,
        rangeLong: 1,
        location: "MELEE"
      },
      isWeapon: true,
      canAttack: true,
      canDelete: false,
      destroyed: false,
      _synthetic: true,
      _meleeType: "punch"
    },
    {
      id: "melee-kick",
      name: "Kick",
      system: {
        damage: kickDamage,
        heat: 0,
        rangeShort: 1,
        rangeMedium: 1,
        rangeLong: 1,
        location: "MELEE"
      },
      isWeapon: true,
      canAttack: true,
      canDelete: false,
      destroyed: false,
      _synthetic: true,
      _meleeType: "kick"
    }
  ];
}
// ------------------------------------------------------------
// Immersion SFX (Heat critical + Shutdown)
// ------------------------------------------------------------
const HEAT_CRITICAL_SFX = ATOW_AUDIO_CUES.heatCritical;
const HEAT_MODERATE_SFX = ATOW_AUDIO_CUES.heatModerate;
const SHUTDOWN_SFX = ATOW_AUDIO_CUES.shuttingDown;
const SYSTEMS_NOMINAL_SFX = ATOW_AUDIO_CUES.systemsNominal;
const STARTING_UP_SFX = ATOW_AUDIO_EFFECTS.powerUp;
const AMMO_EXPLOSION_SFX = `systems/${SYSTEM_ID}/assets/ammo-explosion.mp3`;
const ARMOR_BREACHED_SFX = `systems/${SYSTEM_ID}/assets/armor-breached.mp3`;
const WEAPON_DESTROYED_SFX = ATOW_AUDIO_CUES.weaponDestroyed;
const FOOTSTEPS_SFX = `systems/${SYSTEM_ID}/assets/footsteps.mp3`;
const JUMPJET_FAILURE_SFX = ATOW_AUDIO_CUES.jumpjetFailure;
const COOLANT_FAILURE_SFX = ATOW_AUDIO_CUES.coolantFailure;
const DAMAGE_CRITICAL_SFX = ATOW_AUDIO_CUES.damageCritical;
const REACTOR_BREACH_SFX = `systems/${SYSTEM_ID}/assets/reactor-breach.mp3`;
const COMMS_OFFLINE_SFX = `systems/${SYSTEM_ID}/assets/comms-offline.mp3`;
const EJECTION_EXPLOSION_SFX = `systems/${SYSTEM_ID}/assets/ejection-explosion.mp3`;
const DESTRUCTION_EXPLOSION_VFX = "jb2a.explosion.08";
const DESTRUCTION_SMOKE_VFX = "jb2a.smoke.plumes";
const DESTROYED_TOKEN_TINT = "#292929";
// Client-side, non-persistent throttling to avoid double-playing from multiple hooks
const _atowSfxState = globalThis.__ATOW_BT_SFX_STATE__ ?? (globalThis.__ATOW_BT_SFX_STATE__ = {
  last: new Map(),
  shutdownState: new Map(),
  ammoExplosionState: new Map(),
  structureDmg: new Map(),
  lastArmorBreachAt: new Map(),
  lastWeaponDestroyedAt: new Map(),
  lastFootstepsAt: new Map(),
  lastJumpjetFailureAt: new Map(),
  lastCoolantFailureAt: new Map(),
  lastDamageCriticalAt: new Map(),
  lastReactorBreachAt: new Map(),
  lastCommsOfflineAt: new Map(),
  lastEjectionExplosionAt: new Map(),
  destroyedState: new Map(),
  footstepsLockUntil: 0
});

// Back-compat: older clients may have created the shared state without newer keys.
if (!(_atowSfxState.lastFootstepsAt instanceof Map)) _atowSfxState.lastFootstepsAt = new Map();
if (typeof _atowSfxState.footstepsLockUntil !== "number") _atowSfxState.footstepsLockUntil = 0;

const _sfxKey = (actorId, kind) => `${actorId}:${kind}`;

async function playAtowSfx(src, { volume = 0.8 } = {}) {
  try {
    if (!src) return;
    const helper = foundry?.audio?.AudioHelper ?? globalThis.AudioHelper ?? null;
    if (!helper?.play) return;
    // AudioHelper.play signature varies slightly across Foundry versions; this works in v11+.
    await helper.play({ src, volume, autoplay: true, loop: false }, true);
  } catch (err) {
    console.warn("AToW Battletech | SFX failed", err);
  }
}

function getMechWeightClassLabel(tonnage) {
  const t = normalizeMechTonnage(tonnage);
  if (t <= 35) return "Light Mech";
  if (t <= 55) return "Medium Mech";
  if (t <= 75) return "Heavy Mech";
  return "Assault Mech";
}


// ------------------------------------------------------------
// Sequencer VFX (Mech Destruction)
// ------------------------------------------------------------
function _sequencerActive() {
  return Boolean(game?.modules?.get?.("sequencer")?.active) && typeof globalThis.Sequence === "function";
}

function _getActorTokens(actor) {
  try {
    return actor?.getActiveTokens?.(true, true) ?? actor?.getActiveTokens?.() ?? [];
  } catch (_) {
    return [];
  }
}

function _smokeEffectName(actorId, tokenId) {
  return `ATOW_BT_SMOKE_${actorId}_${tokenId}`;
}

async function _ensureSmokeForToken(actorId, token) {
  try {
    const tokenId = token?.id ?? token?.document?.id;
    const name = _smokeEffectName(actorId, tokenId);

    // Avoid duplicates
    const existing = globalThis.Sequencer?.EffectManager?.getEffects?.({ name }) ?? [];
    if (existing?.length) return;

    new Sequence()
      .effect()
      .file(DESTRUCTION_SMOKE_VFX)
      .attachTo(token)
      .persist()
      .name(name)
      .scaleToObject(1.6)
      .aboveLighting()
      .play();
  } catch (err) {
    console.warn("AToW Battletech | Failed to start smoke VFX", err);
  }
}

function _endSmokeForToken(actorId, tokenDocOrToken) {
  try {
    const tokenId = tokenDocOrToken?.id ?? tokenDocOrToken?.document?.id;
    const name = _smokeEffectName(actorId, tokenId);
    if (globalThis.Sequencer?.EffectManager?.endEffects) {
      globalThis.Sequencer.EffectManager.endEffects({ name });
    }
  } catch (err) {
    console.warn("AToW Battletech | Failed to end smoke VFX", err);
  }
}

async function playDestroyedVfx(actor, { withExplosion = true, withSmoke = true } = {}) {
  try {
    if (!_sequencerActive()) return;

    // Run from the GM to reduce duplicate triggers and improve visibility for all clients.
    if (!game.user?.isGM) return;

    const tokens = _getActorTokens(actor);
    if (!tokens.length) return;

    for (const token of tokens) {
      if (withExplosion) {
        new Sequence()
          .effect()
          .file(DESTRUCTION_EXPLOSION_VFX)
          .atLocation(token)
          .scaleToObject(2.0)
          .aboveLighting()
          .play();
      }

      if (withSmoke) {
        // Slightly after explosion so it reads better visually
        setTimeout(() => _ensureSmokeForToken(actor.id, token), withExplosion ? 250 : 0);
      }
    }
  } catch (err) {
    console.warn("AToW Battletech | playDestroyedVfx failed", err);
  }
}

async function clearDestroyedVfx(actor) {
  try {
    if (!_sequencerActive()) return;
    if (!game.user?.isGM) return;

    const tokens = _getActorTokens(actor);
    for (const token of tokens) {
      _endSmokeForToken(actor.id, token);
    }
  } catch (err) {
    console.warn("AToW Battletech | clearDestroyedVfx failed", err);
  }
}



// ------------------------------------------------------------
// Token Tint (Mech Destruction)
// ------------------------------------------------------------
async function applyDestroyedTint(actor, { tint = DESTROYED_TOKEN_TINT } = {}) {
  try {
    if (!actor) return;
    // Prefer GM to apply token visuals to avoid permission issues / duplicates.
    if (!game.user?.isGM) return;

    const tokens = _getActorTokens(actor);
    for (const token of tokens) {
      const doc = token?.document ?? token;
      if (!doc) continue;

      // Foundry v10+ uses texture.tint
      const update = {};
      if (doc.texture !== undefined) update["texture.tint"] = tint;
      else update["tint"] = tint;

      await doc.update(update).catch(() => {});
    }
  } catch (err) {
    console.warn("AToW Battletech | applyDestroyedTint failed", err);
  }
}

async function clearDestroyedTint(actor) {
  try {
    if (!actor) return;
    if (!game.user?.isGM) return;

    const tokens = _getActorTokens(actor);
    for (const token of tokens) {
      const doc = token?.document ?? token;
      if (!doc) continue;

      // Clear tint back to default (white/no tint).
      const update = {};
      if (doc.texture !== undefined) update["texture.tint"] = null;
      else update["tint"] = null;

      // Some Foundry versions prefer explicit white; if null doesn't take, this is harmless.
      await doc.update(update).catch(async () => {
        const fallback = {};
        if (doc.texture !== undefined) fallback["texture.tint"] = "#ffffff";
        else fallback["tint"] = "#ffffff";
        await doc.update(fallback).catch(() => {});
      });
    }
  } catch (err) {
    console.warn("AToW Battletech | clearDestroyedTint failed", err);
  }
}

function _computeTotalStructureDamage(actor) {
  const structure = actor?.system?.structure ?? {};
  let total = 0;
  for (const v of Object.values(structure)) {
    const n = Number(v?.dmg ?? 0);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

function _computeTotalStructureDamageFrom(structureObj) {
  const structure = structureObj ?? {};
  let total = 0;
  for (const v of Object.values(structure)) {
    const n = Number(v?.dmg ?? 0);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

function _computeArmorTotalsFrom(armorObj) {
  const armor = armorObj ?? {};
  let max = 0;
  let dmg = 0;
  for (const v of Object.values(armor)) {
    const m = Number(v?.max ?? 0);
    const d = Number(v?.dmg ?? 0);
    if (Number.isFinite(m)) max += m;
    if (Number.isFinite(d)) dmg += d;
  }
  dmg = clamp(dmg, 0, max);
  const current = Math.max(0, max - dmg);
  return { max, dmg, current };
}

function maybePlayArmorBreachedSfx(actor) {
  if (!actor) return;

  // Throttle per-actor so cluster/transfer doesn't spam.
  const now = Date.now();
  const last = _atowSfxState.lastArmorBreachAt.get(actor.id) ?? 0;
  if ((now - last) < 1200) return;
  _atowSfxState.lastArmorBreachAt.set(actor.id, now);

  enqueueActorAudioCues(actor, ["armorBreached"], { volume: 0.95 });
}

function maybePlayWeaponDestroyedSfx(actor) {
  if (!actor) return;

  const now = Date.now();
  const last = _atowSfxState.lastWeaponDestroyedAt.get(actor.id) ?? 0;
  if ((now - last) < 900) return;
  _atowSfxState.lastWeaponDestroyedAt.set(actor.id, now);

  enqueueActorAudioCues(actor, ["weaponDestroyed"], { volume: 1.0 });
}

function maybePlayJumpjetFailureSfx(actor) {
  if (!actor) return;

  const now = Date.now();
  const last = _atowSfxState.lastJumpjetFailureAt.get(actor.id) ?? 0;
  if ((now - last) < 900) return;
  _atowSfxState.lastJumpjetFailureAt.set(actor.id, now);

  enqueueActorAudioCues(actor, ["jumpjetFailure"], { volume: 1.0 });
}

function maybePlayCoolantFailureSfx(actor) {
  if (!actor) return;

  const now = Date.now();
  const last = _atowSfxState.lastCoolantFailureAt.get(actor.id) ?? 0;
  if ((now - last) < 900) return;
  _atowSfxState.lastCoolantFailureAt.set(actor.id, now);

  enqueueActorAudioCues(actor, ["coolantFailure"], { volume: 1.0 });
}

function maybePlayDamageCriticalSfx(actor) {
  if (!actor) return;

  const now = Date.now();
  const last = _atowSfxState.lastDamageCriticalAt.get(actor.id) ?? 0;
  if ((now - last) < 900) return;
  _atowSfxState.lastDamageCriticalAt.set(actor.id, now);

  enqueueActorAudioCues(actor, ["damageCritical"], { volume: 1.0 });
}

function maybePlayReactorBreachSfx(actor) {
  if (!actor) return;

  const now = Date.now();
  const last = _atowSfxState.lastReactorBreachAt.get(actor.id) ?? 0;
  if ((now - last) < 900) return;
  _atowSfxState.lastReactorBreachAt.set(actor.id, now);

  playAtowSfx(REACTOR_BREACH_SFX, { volume: 1.0 });
}

function maybePlayCommsOfflineSfx(actor) {
  if (!actor) return;

  const now = Date.now();
  const last = _atowSfxState.lastCommsOfflineAt.get(actor.id) ?? 0;
  if ((now - last) < 900) return;
  _atowSfxState.lastCommsOfflineAt.set(actor.id, now);

  playAtowSfx(COMMS_OFFLINE_SFX, { volume: 1.0 });
}

function maybePlayEjectionExplosionSfx(actor) {
  if (!actor) return;

  // Throttle per-actor to avoid double fire from multiple hook paths.
  const now = Date.now();
  const last = _atowSfxState.lastEjectionExplosionAt.get(actor.id) ?? 0;
  if ((now - last) < 2500) return;
  _atowSfxState.lastEjectionExplosionAt.set(actor.id, now);

  // Delay slightly so this doesn't overlap with reactor breach / other critical callouts.
  setTimeout(() => {
    // If the mech was "un-destroyed" before the delay expires, don't play.
    if (!isMechDestroyed(actor)) return;
    // Sequencer VFX (explosion + persistent smoke)
    playDestroyedVfx(actor, { withExplosion: true, withSmoke: true });
    playActorMechExplosionEffect(actor, { volume: 1.0 });

    let noEject = false;
    try {
      noEject =
        Boolean(actor.getFlag?.(SYSTEM_ID, "noEjection")) ||
        actor.getFlag?.(SYSTEM_ID, "destroyedBy") === "decapitation";
    } catch (_) {}
    if (!noEject) enqueueActorAudioCues(actor, ["ejecting"], { volume: 1.0 });
  }, 1500);
}



function _isJumpJetText(text) {
  const t = String(text ?? "").toLowerCase();
  return t.includes("jump jet") || t.includes("jumpjet");
}

function _isHeatSinkText(text) {
  const t = String(text ?? "").toLowerCase();
  if (t.includes("radical heat sink")) return false;
  return t.includes("heat sink") || t.includes("heatsink");
}

function _isEngineText(text) {
  const t = String(text ?? "").toLowerCase();
  // Covers "Engine", "XL Engine", "Fusion Engine", etc.
  return t.includes("engine") || t.includes("reactor");
}

function _isSensorsText(text) {
  const t = String(text ?? "").toLowerCase();
  // Covers "Sensors", "Sensors (Destroyed)", etc.
  return t.includes("sensor");
}


const DAMAGE_CRITICAL_COMPONENTS = new Set([
  "shoulder",
  "upper arm actuator",
  "lower arm actuator",
  "hand actuator",
  "life support",
  "cockpit",
  "hip",
  "upper leg actuator",
  "foot actuator",
  "gyro"
]);

// Default crit labels used by the sheet (for built-in components that may not be stored on the actor).
// This is used for SFX detection when a slot is toggled destroyed but has no stored label/uuid yet.
const DEFAULT_CRIT_LABELS = {
  head: ["Life Support", "Sensors", "Cockpit", "", "Sensors", "Life Support"],
  ll:   ["Hip", "Upper Leg Actuator", "Lower Leg Actuator", "Foot Actuator", "", ""],
  rl:   ["Hip", "Upper Leg Actuator", "Lower Leg Actuator", "Foot Actuator", "", ""],

  // 12-slot locations (0-11)
  la:   ["Shoulder", "Upper Arm Actuator", "Lower Arm Actuator", "Hand Actuator", "", "", "", "", "", "", "", ""],
  ra:   ["Shoulder", "Upper Arm Actuator", "Lower Arm Actuator", "Hand Actuator", "", "", "", "", "", "", "", ""],
  lt:   ["", "", "", "", "", "", "", "", "", "", "", ""],
  rt:   ["", "", "", "", "", "", "", "", "", "", "", ""],
  ct:   ["Engine", "Engine", "Engine", "Gyro", "Gyro", "Gyro", "Gyro", "Engine", "Engine", "Engine", "", ""]
};

const XL_GYRO_CT_LABELS = ["Engine", "Engine", "Engine", "XL Gyro", "XL Gyro", "XL Gyro", "XL Gyro", "XL Gyro", "XL Gyro", "Engine", "Engine", "Engine"];
const CRIT_AUTO_LABELS = new Set([
  "",
  ...Object.values(DEFAULT_CRIT_LABELS).flat(),
  ...XL_GYRO_CT_LABELS,
  "XL Engine"
]);

function _getEngineCritLabel(actor, engineTextOverride = null) {
  const engineText = engineTextOverride ?? actor?.system?.mech?.engine ?? "";
  return _isXLEngineText(engineText) ? "XL Engine" : "Engine";
}

function _isXLGyroEnabled(actor, enabledOverride = null) {
  if (enabledOverride !== null && enabledOverride !== undefined) return Boolean(enabledOverride);
  return Boolean(actor?.system?.mech?.xlGyro);
}

function _getCTDefaultCritLabels(actor, enabledOverride = null, engineTextOverride = null) {
  const engineLabel = _getEngineCritLabel(actor, engineTextOverride);
  const labels = _isXLGyroEnabled(actor, enabledOverride) ? XL_GYRO_CT_LABELS : DEFAULT_CRIT_LABELS.ct;
  return labels.map(label => String(label ?? "") === "Engine" ? engineLabel : label);
}

function _buildXLGyroCritLabelUpdates(actor, enabledOverride = null, engineTextOverride = null) {
  const enabled = _isXLGyroEnabled(actor, enabledOverride);
  const desired = _getCTDefaultCritLabels(actor, enabled, engineTextOverride);
  const updates = {};
  const blocked = [];

  if (!actor?.system?.crit?.ct?.slots) {
    updates["system.crit.ct.slots"] = Array.from({ length: desired.length }, (_, i) => ({
      label: desired[i] ?? "",
      uuid: "",
      mountId: null,
      span: 1,
      partOf: null,
      destroyed: false
    }));
    return { updates, blocked };
  }

  for (let i = 0; i < desired.length; i++) {
    const slot = actor?.system?.crit?.ct?.slots?.[i] ?? {};
    const uuid = String(slot?.uuid ?? "").trim();
    const label = String(slot?.label ?? "");
    const next = String(desired[i] ?? "");

    if (label === next) continue;

    if (uuid) {
      blocked.push(i + 1);
      continue;
    }

    if (!CRIT_AUTO_LABELS.has(label)) {
      blocked.push(i + 1);
      continue;
    }

    updates[`system.crit.ct.slots.${i}.label`] = next;
  }

  return { updates, blocked };
}


// ------------------------------------------------------------
// Engine destruction (3 hits) => mark mech as Destroyed ("dead" status)
// ------------------------------------------------------------
function getEngineHitCountFromCrit(actor) {
  const crit = actor?.system?.crit ?? {};
  let hits = 0;

  for (const [locKey, locVal] of Object.entries(crit)) {
    const slots = locVal?.slots;
    if (!slots) continue;

    const entries = Array.isArray(slots)
      ? slots.map((v, i) => [String(i), v])
      : Object.entries(slots);

    for (const [idxKey, slot] of entries) {
      const idx = Number(idxKey);
      if (Number.isNaN(idx)) continue;

      const destroyed = Boolean(slot?.destroyed);
      if (!destroyed) continue;

      let label = slot?.label ?? "";
      if (!String(label).trim()) {
        label = _defaultCritLabel(actor, locKey, idx) ?? "";
      }

      if (_isEngineText(label)) hits += 1;
    }
  }

  return clamp(hits, 0, 3);
}

function _isStructureLocationMaxed(actor, locKey) {
  const loc = actor?.system?.structure?.[locKey] ?? {};
  const max = Number(loc?.max ?? 0) || 0;
  const dmg = Number(loc?.dmg ?? 0) || 0;
  return max > 0 && dmg >= max;
}

// Some deaths are caused by structure destruction (CT/head) or other forced rules.
function shouldBeDeadFromStructureOrFlags(actor) {
  if (!actor) return false;
  if (_isStructureLocationMaxed(actor, "ct")) return true;
  if (_isStructureLocationMaxed(actor, "head")) return true;
  try {
    return Boolean(actor.getFlag?.(SYSTEM_ID, "forcedDead"));
  } catch (_) {
    return false;
  }
}

function isMechDestroyed(actor) {
  if (!actor) return false;

  // Prefer actual status if present
  try {
    if (actor.statuses?.has?.("dead")) return true;
    if (actor.statuses?.has?.("defeated")) return true;
  } catch (_) {}

  const engineHits = Number(actor.system?.critHits?.engine ?? 0) || 0;
  if (engineHits >= 3) return true;

  // Catastrophic structure destruction cases, or forced deaths.
  return shouldBeDeadFromStructureOrFlags(actor);
}

async function setDeadStatus(actor, active) {
  if (!actor) return;

  // Prefer the built-in condition toggles when available (best compatibility across Foundry versions).
  const statusId = "dead";
  let deadStatusHandled = false;

  // Foundry versions differ on whether this exists on Actor.
  try {
    if (typeof actor.toggleStatusEffect === "function") {
      await actor.toggleStatusEffect(statusId, { active });
      deadStatusHandled = true;
    }
  } catch (err) {
    console.warn("AToW Battletech | actor.toggleStatusEffect failed", err);
  }

  // TokenDocument.toggleStatusEffect exists in v11+ and is the most reliable way to apply a core status.
  try {
    const tokens = actor.getActiveTokens?.(true, true) ?? actor.getActiveTokens?.() ?? [];
    if (!deadStatusHandled && tokens?.length) {
      for (const tok of tokens) {
        const doc = tok?.document ?? tok;
        if (typeof doc?.toggleStatusEffect === "function") {
          await doc.toggleStatusEffect(statusId, { active });
          deadStatusHandled = true;
        }
      }
    }
  } catch (err) {
    console.warn("AToW Battletech | token.toggleStatusEffect failed", err);
  }

  // Final fallback: create/enable/disable an actor ActiveEffect with core.statusId = "dead".
  // (This is what Foundry's condition system uses under the hood for linked actors.)
  try {
    if (!deadStatusHandled) {
      const existing = actor.effects?.find?.(e =>
        (e?.getFlag?.("core", "statusId") === statusId) ||
        (Array.isArray(e?.statuses) ? e.statuses.includes(statusId) : e?.statuses?.has?.(statusId))
      ) ?? null;

      if (active) {
        if (existing) {
          if (existing.disabled) await existing.update({ disabled: false });
        } else {
          const se = (CONFIG?.statusEffects ?? []).find(s => s.id === statusId) ?? null;
          const icon = se?.icon ?? "icons/svg/skull.svg";

          await actor.createEmbeddedDocuments("ActiveEffect", [{
            name: "Dead",
            icon,
            disabled: false,
            statuses: [statusId],
            flags: { core: { statusId } }
          }]);
        }
      } else {
        if (existing && !existing.disabled) {
          await existing.update({ disabled: true });
        }
      }
      deadStatusHandled = true;
    }
  } catch (err) {
    console.warn("AToW Battletech | ActiveEffect fallback failed", err);
  }

  try {
    if (game.user?.isGM) {
      const actorIds = new Set();
      const tokenIds = new Set();

      const pushActorId = (value) => {
        const id = String(value ?? "").trim();
        if (id) actorIds.add(id);
      };
      const pushTokenId = (value) => {
        const id = String(value ?? "").trim();
        if (id) tokenIds.add(id);
      };

      pushActorId(actor?.id);
      pushActorId(actor?.baseActor?.id);
      pushTokenId(actor?.token?.id);
      pushTokenId(actor?.token?.document?.id);

      for (const tok of actor.getActiveTokens?.(true, true) ?? actor.getActiveTokens?.() ?? []) {
        const doc = tok?.document ?? tok;
        pushTokenId(doc?.id);
        pushActorId(doc?.actor?.id);
        pushActorId(doc?.baseActor?.id);
      }

      for (const combat of game.combats?.contents ?? []) {
        const updates = [];
        for (const combatant of combat?.combatants ?? []) {
          const combatantTokenId = String(combatant?.tokenId ?? combatant?.token?.id ?? "").trim();
          const combatantActorId = String(
            combatant?.actorId ??
            combatant?.actor?.id ??
            combatant?.token?.actor?.id ??
            combatant?.token?.baseActor?.id ??
            ""
          ).trim();

          const matchesToken = combatantTokenId && tokenIds.has(combatantTokenId);
          const matchesActor = combatantActorId && actorIds.has(combatantActorId);
          if (!matchesToken && !matchesActor) continue;
          if (Boolean(combatant?.defeated) === Boolean(active)) continue;
          updates.push({ _id: combatant.id, defeated: Boolean(active) });
        }
        if (updates.length) {
          await combat.updateEmbeddedDocuments("Combatant", updates).catch(err => {
            console.warn("AToW Battletech | Failed to sync combatant defeated state", err);
          });
        }
      }
    }
  } catch (err) {
    console.warn("AToW Battletech | Combatant defeated sync failed", err);
  }

  // Also mirror the standard Foundry defeated status so tracker modules and
  // combat UI that key off CONFIG.specialStatusEffects.DEFEATED behave normally.
  try {
    const defeatedStatusId = CONFIG?.specialStatusEffects?.DEFEATED ?? "defeated";
    if (typeof actor.toggleStatusEffect === "function") {
      await actor.toggleStatusEffect(defeatedStatusId, { active, overlay: true });
      return;
    }
  } catch (err) {
    console.warn("AToW Battletech | actor.toggleStatusEffect(defeated) failed", err);
  }

  try {
    const defeatedStatusId = CONFIG?.specialStatusEffects?.DEFEATED ?? "defeated";
    const tokens = actor.getActiveTokens?.(true, true) ?? actor.getActiveTokens?.() ?? [];
    for (const tok of tokens) {
      const doc = tok?.document ?? tok;
      if (typeof doc?.toggleStatusEffect === "function") {
        await doc.toggleStatusEffect(defeatedStatusId, { active, overlay: true });
      }
    }
  } catch (err) {
    console.warn("AToW Battletech | token.toggleStatusEffect(defeated) failed", err);
  }
}






// ------------------------------------------------------------
// Structure destruction => auto-destroy components in that location
// ------------------------------------------------------------
const _atowLocDestroyState = globalThis.__ATOW_BT_LOC_DESTROY_STATE__ ?? (globalThis.__ATOW_BT_LOC_DESTROY_STATE__ = new Map());

const LOC_DESTROY_STATUS = {
  head: { id: "head-destroyed", name: "Head Destroyed" },
  la: { id: "left-arm-destroyed",  name: "Left Arm Destroyed"  },
  ra: { id: "right-arm-destroyed", name: "Right Arm Destroyed" },
  lt: { id: "left-torso-destroyed",  name: "Left Torso Destroyed"  },
  rt: { id: "right-torso-destroyed", name: "Right Torso Destroyed" },
  ll: { id: "left-leg-destroyed",  name: "Left Leg Destroyed"  },
  rl: { id: "right-leg-destroyed", name: "Right Leg Destroyed" }
};

function _num0(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isStructureLocDestroyed(actor, locKey) {
  const loc = actor?.system?.structure?.[locKey] ?? {};
  const max = _num0(loc.max);
  const dmg = _num0(loc.dmg);
  return max > 0 && dmg >= max;
}

function _getStructureDestroyedSnapshot(actor) {
  return {
    head: isStructureLocDestroyed(actor, "head"),
    la: isStructureLocDestroyed(actor, "la"),
    ra: isStructureLocDestroyed(actor, "ra"),
    ll: isStructureLocDestroyed(actor, "ll"),
    rl: isStructureLocDestroyed(actor, "rl"),
    lt: isStructureLocDestroyed(actor, "lt"),
    rt: isStructureLocDestroyed(actor, "rt"),
    ct: isStructureLocDestroyed(actor, "ct")
  };
}

function _critSlotCount(locKey) {
  return (locKey === "head" || locKey === "ll" || locKey === "rl") ? 6 : 12;
}

function buildCritMountIdUpdates(actor) {
  const updates = {};
  let changed = false;
  const crit = actor?.system?.crit ?? {};

  for (const [locKey, locData] of Object.entries(crit)) {
    const slots = _getCritSlotsArray(actor?.system ?? {}, locKey);
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i] ?? {};
      if (slot?.partOf !== undefined && slot?.partOf !== null) continue;

      const uuid = String(slot?.uuid ?? "").trim();
      const label = String(slot?.label ?? "").trim();
      if (!uuid && !label) continue;

      const span = clamp(Number(slot?.span ?? 1) || 1, 1, slots.length - i);
      const mountId = String(slot?.mountId ?? "").trim() || createCritMountId();

      for (let j = 0; j < span; j++) {
        const idx = i + j;
        const current = String(slots[idx]?.mountId ?? "").trim();
        if (current === mountId) continue;
        updates[`system.crit.${locKey}.slots.${idx}.mountId`] = mountId;
        changed = true;
      }
    }
  }

  return changed ? updates : null;
}

export async function ensureActorCritMountIds(actor) {
  if (!actor || String(actor.type ?? "").toLowerCase() !== "mech") return false;
  const updates = buildCritMountIdUpdates(actor);
  if (!updates) return false;
  await actor.update(updates, { atowMountIdMigration: true });
  return true;
}

function _isXLEngineText(engineText) {
  const t = String(engineText ?? "").toLowerCase();

  // Exclude XXL (different component in some eras/rules)
  if (t.includes("xxl")) return false;

  // Accept common formats:
  //  - "XL", "XL Engine", "Clan XL"
  //  - "300XL" / "XL300"
  // We intentionally require that 'xl' is not part of a longer letter-only word.
  return (
    /\bxl\b/.test(t) ||
    /\d+xl\b/.test(t) ||
    /\bxl\d+/.test(t)
  );
}


function _getMechTechBase(actor, engineText = null) {
  const sys = actor?.system ?? {};
  const mech = sys?.mech ?? {};

  const raw =
    mech.techBase ?? mech.techbase ?? mech.tech ?? sys.techBase ?? sys.techbase ?? sys.tech ?? "";

  const t = String(raw ?? "").toLowerCase();
  if (t.includes("clan")) return "clan";
  if (t.includes("inner")) return "inner";
  if (t.includes("sphere")) return "inner";
  if (_isXLEngineText(engineText) && String(engineText ?? "").toLowerCase().includes("clan")) return "clan";
  return "inner";
}

function _xlSideEngineCritCount(actor) {
  const engineText = actor?.system?.mech?.engine ?? "";
  if (!_isXLEngineText(engineText)) return 0;

  const techBase = _getMechTechBase(actor, engineText);
  return (techBase === "clan") ? 2 : 3;
}


function _buildXLEngineCritLabelUpdates(actor, engineTextOverride = null) {
  const engineText = engineTextOverride ?? actor?.system?.mech?.engine ?? "";
  const isXL = _isXLEngineText(engineText);
  const desiredLabel = _getEngineCritLabel(actor, engineText);

  // Inner Sphere XL: 3 crits each side torso; Clan XL: 2 each side torso
  const desiredSide = isXL ? ((_getMechTechBase(actor, engineText) === "clan") ? 2 : 3) : 0;
  const maxPossible = 3; // we only ever reserve up to 3 slots in each side torso

  const updates = {};
  for (const locKey of ["lt", "rt"]) {
    // Ensure slots exist so we can label them
    const init = _ensureCritSlotsInitUpdates(actor, locKey);
    if (init) Object.assign(updates, init);

    for (let i = 0; i < maxPossible; i++) {
      const slot = actor?.system?.crit?.[locKey]?.slots?.[i] ?? {};
      const uuid = String(slot?.uuid ?? "");
      const label = String(slot?.label ?? "");

      if (i < desiredSide) {
        // Only overwrite labels on empty slots (avoid nuking installed components)
        if (!uuid) {
          if (label !== desiredLabel) updates[`system.crit.${locKey}.slots.${i}.label`] = desiredLabel;
        } else if (label !== desiredLabel) {
          console.warn(`AToWMechSheet | XL engine side crit slot ${locKey.toUpperCase()} ${i + 1} is occupied by an item; not overwriting.`);
        }
      } else {
        // If we're no longer reserving this slot, clear our auto label (only if empty).
        if (!uuid && (label === "Engine" || label === "XL Engine")) updates[`system.crit.${locKey}.slots.${i}.label`] = "";
      }
    }
  }

  return updates;
}

function _defaultCritLabel(actor, locKey, idx) {
  // Dynamic XL engine side-torso crits.
  const lk = String(locKey ?? "").toLowerCase();
  const i = Number(idx);
  if (lk === "ct" && Number.isFinite(i)) return (_getCTDefaultCritLabels(actor)?.[i] ?? "");
  if ((lk === "lt" || lk === "rt") && Number.isFinite(i)) {
    const side = _xlSideEngineCritCount(actor);
    if (side > 0 && i >= 0 && i < side) return _getEngineCritLabel(actor);
  }

  return (DEFAULT_CRIT_LABELS?.[lk]?.[i] ?? "");
}

function _ensureCritSlotsInitUpdates(actor, locKey) {
  const existing = actor?.system?.crit?.[locKey]?.slots;
  if (existing) return null;

  const count = _critSlotCount(locKey);
  const arr = Array.from({ length: count }, (_, i) => ({
    label: _defaultCritLabel(actor, locKey, i),
    uuid: "",
    mountId: null,
    span: 1,
    partOf: null,
    destroyed: false
  }));

  return { [`system.crit.${locKey}.slots`]: arr };
}

function buildCritDestroyUpdatesForLocation(actor, locKey) {
  const updates = {};

  // If the slots array doesn't exist yet on the actor, initialize it so we can mark defaults as destroyed.
  const init = _ensureCritSlotsInitUpdates(actor, locKey);
  if (init) Object.assign(updates, init);

  const count = _critSlotCount(locKey);
  for (let i = 0; i < count; i++) {
    const stored = actor?.system?.crit?.[locKey]?.slots?.[i] ?? {};
    const hasLabelProp = stored && Object.prototype.hasOwnProperty.call(stored, "label");

    const storedLabel = hasLabelProp ? stored.label : "";
    const defaultLabel = _defaultCritLabel(actor, locKey, i);

    const label = String((storedLabel && String(storedLabel).trim()) ? storedLabel : defaultLabel ?? "");
    const uuid = String(stored?.uuid ?? "");

    const occupied = Boolean(uuid) || Boolean(label.trim());
    if (!occupied) continue;

    updates[`system.crit.${locKey}.slots.${i}.destroyed`] = true;

    // If there's no stored label (or it's blank) but there IS a default component label,
    // set it so the sheet will show the destroyed component.
    if ((!hasLabelProp || !String(storedLabel ?? "").trim()) && String(defaultLabel ?? "").trim()) {
      updates[`system.crit.${locKey}.slots.${i}.label`] = defaultLabel;
    }
  }

  return updates;
}

function buildCritDestroyUpdatesForAllLocations(actor) {
  const updates = {};
  for (const locKey of ["head", "la", "ra", "lt", "rt", "ct", "ll", "rl"]) {
    Object.assign(updates, buildCritDestroyUpdatesForLocation(actor, locKey));
  }
  return updates;
}

async function setCustomStatus(actor, statusId, active, { name = null, icon = null } = {}) {
  if (!actor || !statusId) return;

  // Try core toggles first (works if the statusId is registered in CONFIG.statusEffects)
  try {
    if (typeof actor.toggleStatusEffect === "function") {
      await actor.toggleStatusEffect(statusId, { active });
      return;
    }
  } catch (_) {}

  try {
    const tokens = actor.getActiveTokens?.(true, true) ?? actor.getActiveTokens?.() ?? [];
    for (const tok of tokens) {
      const doc = tok?.document ?? tok;
      if (typeof doc?.toggleStatusEffect === "function") {
        await doc.toggleStatusEffect(statusId, { active });
      }
    }
    // If token toggles exist, we're done.
    if (tokens?.length) return;
  } catch (_) {}

  // Fallback: create/enable/disable an ActiveEffect with core.statusId
  try {
    const existing = actor.effects?.find?.(e =>
      (e?.getFlag?.("core", "statusId") === statusId) ||
      (Array.isArray(e?.statuses) ? e.statuses.includes(statusId) : e?.statuses?.has?.(statusId))
    ) ?? null;

    const se = (CONFIG?.statusEffects ?? []).find(s => s.id === statusId) ?? null;
    const effIcon = icon ?? se?.icon ?? "icons/svg/daze.svg";
    const effName = name ?? se?.label ?? statusId;

    if (active) {
      if (existing) {
        if (existing.disabled) await existing.update({ disabled: false });
      } else {
        await actor.createEmbeddedDocuments("ActiveEffect", [{
          name: effName,
          icon: effIcon,
          disabled: false,
          statuses: [statusId],
          flags: { core: { statusId } }
        }]);
      }
    } else {
      if (existing && !existing.disabled) await existing.update({ disabled: true });
    }
  } catch (err) {
    console.warn("AToW Battletech | setCustomStatus fallback failed", err);
  }
}

async function applyStructureLocationDestruction(actor, locKey) {
  if (!actor || !locKey) return;

  // Helper: force a location's armor/structure tracks to 0 remaining by setting dmg=max.
  const forceTrackDestroyed = (updates, key) => {
    try {
      const aNode = actor.system?.armor?.[key];
      const sNode = actor.system?.structure?.[key];
      if (aNode && Number.isFinite(Number(aNode.max))) {
        updates[`system.armor.${key}.dmg`] = Number(aNode.max);
      }
      if (sNode && Number.isFinite(Number(sNode.max))) {
        updates[`system.structure.${key}.dmg`] = Number(sNode.max);
      }
    } catch (_) {}
  };

  // Head destruction = decapitation: mech destroyed immediately, pilot dies (no ejection).
  if (locKey === "head") {
    const updates = buildCritDestroyUpdatesForLocation(actor, "head");
    forceTrackDestroyed(updates, "head");

    // Pilot death (no ejection normally).
    updates["system.pilot.consciousness"] = "Dead";
    updates["system.pilot.hitsTaken"] = 6;

    // Mark as destroyed by rule so engine-hit syncing won't clear the Dead status.
    updates[`flags.${SYSTEM_ID}.forcedDead`] = true;
    updates[`flags.${SYSTEM_ID}.noEjection`] = true;
    updates[`flags.${SYSTEM_ID}.destroyedBy`] = "decapitation";

    await actor.update(updates, { atowLocDestroy: true }).catch(() => {});

    // Apply the built-in "dead" condition.
    await setDeadStatus(actor, true);

    const st = LOC_DESTROY_STATUS?.head;
    if (st?.id) await setCustomStatus(actor, st.id, true, { name: st.name });

    return;
  }

  // CT destruction is catastrophic: destroy all components and "max" the engine hits (dead will follow).
  if (locKey === "ct") {
    const updates = buildCritDestroyUpdatesForAllLocations(actor);
    updates["system.critHits.engine"] = 3;
    await actor.update(updates, { atowLocDestroy: true }).catch(() => {});
    return;
  }

  // Torso loss also takes the attached arm with it.
  // LT -> LA, RT -> RA
  const chain = [];
  if (locKey === "lt") chain.push("lt", "la");
  else if (locKey === "rt") chain.push("rt", "ra");
  else chain.push(locKey);

  const updates = {};
  for (const k of chain) {
    Object.assign(updates, buildCritDestroyUpdatesForLocation(actor, k));
    // We generally don't track partial component hits; if a location is destroyed, max its tracks.
    // (This also ensures a torso-destroyed -> arm-destroyed cascade strips remaining armor/structure.)
    forceTrackDestroyed(updates, k);
  }

  await actor.update(updates, { atowLocDestroy: true }).catch(() => {});

  // Apply status effects for all destroyed locations in the chain.
  for (const k of chain) {
    const st = LOC_DESTROY_STATUS?.[k];
    if (st?.id) await setCustomStatus(actor, st.id, true, { name: st.name });
  }

  // Leg loss consequences:
  // - Losing 1 leg: mech immediately goes prone; Walk becomes 1 for the rest of the battle; +5 TN to all Pilot checks.
  // - Losing 2 legs: mech is immobile (Walk becomes 0).
  if (chain.includes("ll") || chain.includes("rl")) {
    await applyLegLossConsequences(actor);
  }


/**
 * Apply leg-loss battle consequences.
 * We keep this as a flag so other systems (movement clamp, rollCheck TN mods) can read it.
 */
async function applyLegLossConsequences(actor) {
  try {
    if (!actor) return;

    const count =
      (isStructureLocDestroyed(actor, "ll") ? 1 : 0) +
      (isStructureLocDestroyed(actor, "rl") ? 1 : 0);

    const prev = Number(actor.getFlag?.(SYSTEM_ID, "legLoss") ?? actor.flags?.[SYSTEM_ID]?.legLoss ?? 0) || 0;

    // Always keep the flag in sync (helps if a mech is imported with leg damage).
    if (count !== prev) {
      await actor.setFlag(SYSTEM_ID, "legLoss", clamp(count, 0, 2)).catch(() => {});
    }

    // Any leg loss = the mech falls prone (we keep it applied; GM can clear manually if needed).
    if (count >= 1) {
      await setCustomStatus(actor, "prone", true, { name: "Prone" });
    }
  } catch (err) {
    console.warn("AToW Battletech | applyLegLossConsequences failed", err);
  }
}
}
function _isDamageCriticalComponentText(text) {
  const t = String(text ?? "").trim().toLowerCase();
  return DAMAGE_CRITICAL_COMPONENTS.has(t);
}

function _isJumpJetItem(item) { return item && _isJumpJetText(item.name); }
function _isHeatSinkItem(item) { return item && _isHeatSinkText(item.name); }
function _isEngineItem(item) { return item && _isEngineText(item.name); }
function _isSensorsItem(item) { return item && _isSensorsText(item.name); }

// Best-effort weapon check from a stored UUID in a crit slot.
async function isWeaponUuid(uuid, actor) {
  const u = String(uuid ?? "");
  if (!u) return false;

  // Embedded item on this actor
  const embeddedMatch = u.match(/^Actor\.([^.]+)\.Item\.([^.]+)$/);
  if (embeddedMatch?.[1] === actor?.id && embeddedMatch?.[2]) {
    const it = actor.items?.get?.(embeddedMatch[2]);
    return Boolean(it && ["weapon", "mechWeapon"].includes(it.type));
  }

  // World item
  const worldMatch = u.match(/^Item\.([^.]+)$/);
  if (worldMatch?.[1]) {
    const it = game.items?.get?.(worldMatch[1]);
    return Boolean(it && ["weapon", "mechWeapon"].includes(it.type));
  }

  // Compendium or other UUID
  try {
    const doc = await fromUuid(u);
    const it = (doc?.documentName === "Item") ? doc : null;
    return Boolean(it && ["weapon", "mechWeapon"].includes(it.type));
  } catch (_) {
    return false;
  }
}

// Best-effort jump jet check from a stored UUID in a crit slot.
async function isJumpJetUuid(uuid, actor) {
  const u = String(uuid ?? "");
  if (!u) return false;

  const embeddedMatch = u.match(/^Actor\.([^.]+)\.Item\.([^.]+)$/);
  if (embeddedMatch?.[1] === actor?.id && embeddedMatch?.[2]) {
    const it = actor.items?.get?.(embeddedMatch[2]);
    return Boolean(it && _isJumpJetItem(it));
  }

  const worldMatch = u.match(/^Item\.([^.]+)$/);
  if (worldMatch?.[1]) {
    const it = game.items?.get?.(worldMatch[1]);
    return Boolean(it && _isJumpJetItem(it));
  }

  try {
    const doc = await fromUuid(u);
    const it = (doc?.documentName === "Item") ? doc : null;
    return Boolean(it && _isJumpJetItem(it));
  } catch (_) {
    return false;
  }
}

// Best-effort heat sink check from a stored UUID in a crit slot.
async function isHeatSinkUuid(uuid, actor) {
  const u = String(uuid ?? "");
  if (!u) return false;

  const embeddedMatch = u.match(/^Actor\.([^.]+)\.Item\.([^.]+)$/);
  if (embeddedMatch?.[1] === actor?.id && embeddedMatch?.[2]) {
    const it = actor.items?.get?.(embeddedMatch[2]);
    return Boolean(it && _isHeatSinkItem(it));
  }

  const worldMatch = u.match(/^Item\.([^.]+)$/);
  if (worldMatch?.[1]) {
    const it = game.items?.get?.(worldMatch[1]);
    return Boolean(it && _isHeatSinkItem(it));
  }

  try {
    const doc = await fromUuid(u);
    const it = (doc?.documentName === "Item") ? doc : null;
    return Boolean(it && _isHeatSinkItem(it));
  } catch (_) {
    return false;
  }
}

// Best-effort engine/reactor check from a stored UUID in a crit slot.
async function isEngineUuid(uuid, actor) {
  const u = String(uuid ?? "");
  if (!u) return false;

  const embeddedMatch = u.match(/^Actor\.([^.]+)\.Item\.([^.]+)$/);
  if (embeddedMatch?.[1] === actor?.id && embeddedMatch?.[2]) {
    const it = actor.items?.get?.(embeddedMatch[2]);
    return Boolean(it && _isEngineItem(it));
  }

  const worldMatch = u.match(/^Item\.([^.]+)$/);
  if (worldMatch?.[1]) {
    const it = game.items?.get?.(worldMatch[1]);
    return Boolean(it && _isEngineItem(it));
  }

  try {
    const doc = await fromUuid(u);
    const it = (doc?.documentName === "Item") ? doc : null;
    return Boolean(it && _isEngineItem(it));
  } catch (_) {
    return false;
  }
}


// Best-effort sensors/communications check from a stored UUID in a crit slot.
async function isSensorsUuid(uuid, actor) {
  const u = String(uuid ?? "");
  if (!u) return false;

  const embeddedMatch = u.match(/^Actor\.([^.]+)\.Item\.([^.]+)$/);
  if (embeddedMatch?.[1] === actor?.id && embeddedMatch?.[2]) {
    const it = actor.items?.get?.(embeddedMatch[2]);
    return Boolean(it && _isSensorsItem(it));
  }

  const worldMatch = u.match(/^Item\.([^.]+)$/);
  if (worldMatch?.[1]) {
    const it = game.items?.get?.(worldMatch[1]);
    return Boolean(it && _isSensorsItem(it));
  }

  try {
    const doc = await fromUuid(u);
    const it = (doc?.documentName === "Item") ? doc : null;
    return Boolean(it && _isSensorsItem(it));
  } catch (_) {
    return false;
  }
}


// Best-effort damage-critical component check from a stored UUID in a crit slot.
async function isDamageCriticalUuid(uuid, actor) {
  const u = String(uuid ?? "");
  if (!u) return false;

  const embeddedMatch = u.match(/^Actor\.([^.]+)\.Item\.([^.]+)$/);
  if (embeddedMatch?.[1] === actor?.id && embeddedMatch?.[2]) {
    const it = actor.items?.get?.(embeddedMatch[2]);
    return Boolean(it && _isDamageCriticalComponentText(it.name));
  }

  const worldMatch = u.match(/^Item\.([^.]+)$/);
  if (worldMatch?.[1]) {
    const it = game.items?.get?.(worldMatch[1]);
    return Boolean(it && _isDamageCriticalComponentText(it.name));
  }

  try {
    const doc = await fromUuid(u);
    const it = (doc?.documentName === "Item") ? doc : null;
    return Boolean(it && _isDamageCriticalComponentText(it.name));
  } catch (_) {
    return false;
  }
}

function getUnventedHeat(actor) {
  const heat = actor?.system?.heat ?? {};
  const effects = heat.effects ?? {};
  const v = (heat.unvented ?? effects.unvented ?? heat.value ?? heat.current ?? 0);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ------------------------------------------------------------
// Heat from Movement (walk/run) — first pass
// ------------------------------------------------------------
// We use token flags set by movement tracking:
// flags.atow-battletech.movedThisTurn (hexes moved) and flags.atow-battletech.moveMode ("walk"|"run").
// Heat generated: walk +1, run +2 total.
// Applied once per turn and can "upgrade" from walk->run (adds the extra +1).
function getMovementHeatForToken(tokenDoc) {
  const moved = Number(tokenDoc?.getFlag?.("atow-battletech", "movedThisTurn") ?? 0) || 0;
  const mode = String(tokenDoc?.getFlag?.("atow-battletech", "moveMode") ?? "").toLowerCase();

  if (moved <= 0) return 0;
  if (mode === "jump" || mode === "jumping") return Math.max(3, moved);
  if (mode === "run" || mode === "running") return 2;
  if (mode === "walk" || mode === "walking") return 1;

  // If moveMode isn't set but they've moved, treat as walking.
  return 1;
}

function getCombatStamp(combat) {
  const r = combat?.round ?? 0;
  const t = combat?.turn ?? 0;
  return `${r}:${t}`;
}


// ------------------------------------------------------------
// Ammo explosion (first pass)
// ------------------------------------------------------------
// Triggered on remaining (unvented) heat after venting.
// 19+: avoid on 4+, 23+: avoid on 6+, 28+: avoid on 8+ (2d6). If roll < TN, ammo explodes.
function computeAmmoExplosionTN(unventedHeat) {
  const h = Number(unventedHeat ?? 0) || 0;
  if (h >= 28) return 8;
  if (h >= 23) return 6;
  if (h >= 19) return 4;
  return null;
}

// Ammo priority (highest damage first) — matches the labels you listed.

// ------------------------------------------------------------
// CASE (Cellular Ammunition Storage Equipment)
// ------------------------------------------------------------
function _hasActiveCASEInLoc(actor, locKey) {
  const lk = String(locKey ?? "").toLowerCase();
  const slots = actor?.system?.crit?.[lk]?.slots;
  const iter = Array.isArray(slots) ? slots : Object.values(slots ?? {});
  for (const s of iter) {
    if (!s) continue;
    if (s.partOf !== undefined && s.partOf !== null) continue; // skip continuations
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

const AMMO_EXPLOSION_PRIORITY = [
  "Ammo (AC/20)",
  "Ammo (LRM 20)",
  "Ammo (LRM 15)",
  "Ammo (SRM 6)",
  "Ammo (AC/10)",
  "Ammo (LRM 10)",
  "Ammo (SRM 4)",
  "Ammo (AC/5)",
  "Ammo (LRM 5)",
  "Ammo (SRM 2)"
];


function _parseAmmoCritLabel(label) {
  const raw = String(label ?? "").trim();
  // Expected: Ammo (LRM 20) 6  OR  Ammo (AC/20) 5  OR  Ammo (Machine Gun) 100
  const m = raw.match(/^\s*Ammo\s*\(([^)]+)\)\s*(\d+)\s*$/i);
  if (!m) return null;

  const typeText = String(m[1] ?? "").trim();
  const shots = Number(m[2] ?? 0) || 0;

  const lower = typeText.toLowerCase();
  const noExplode = lower.includes("gauss"); // Gauss ammo does not explode when hit

  // Reuse existing key generator when possible
  const key = _ammoKeyFromType(typeText) ?? _slugifyKey(typeText);

  return { raw, typeText, shots, key, noExplode };
}

function _ammoExplosionDamageForType(typeText) {
  const t = String(typeText ?? "").trim().toLowerCase();

  // Machine Gun
  if (t.includes("machine gun") || t === "mg") return 400;

  // AC/20, AC/10, AC/5, AC/2
  let m = t.match(/\bac\s*\/\s*(\d+)\b/i) || t.match(/\bac\s*(\d+)\b/i);
  if (m?.[1]) {
    const n = Number(m[1]);
    if (n === 20) return 100;
    if (n === 10) return 100;
    if (n === 5) return 100;
    if (n === 2) return 90;
  }

  // LRM
  m = t.match(/\blrm\s*-?\s*(\d+)\b/i);
  if (m?.[1]) return 120;

  // SRM
  m = t.match(/\bsrm\s*-?\s*(\d+)\b/i);
  if (m?.[1]) {
    const n = Number(m[1]);
    if (n === 6) return 180;
    if (n === 4) return 200;
    if (n === 2) return 200;
    return 200;
  }

  // Unknown ammo type: no explosion damage
  return null;
}

function _iterCritSlots(slots) {
  if (!slots) return [];
  if (Array.isArray(slots)) return slots.map((v, i) => ({ idx: i, slot: v }));
  return Object.entries(slots).map(([k, v]) => ({ idx: Number(k), slot: v }));
}

function findAmmoSlots(actor, { locKey = null, includeDestroyed = false } = {}) {
  const crit = actor?.system?.crit ?? {};
  const out = [];

  for (const [lk, loc] of Object.entries(crit)) {
    if (locKey && lk !== locKey) continue;
    const slots = loc?.slots;
    for (const { idx, slot } of _iterCritSlots(slots)) {
      if (!Number.isFinite(idx)) continue;

      const label = String(slot?.label ?? "").trim();
      if (!label || !label.toLowerCase().startsWith("ammo")) continue;

      const parsed = _parseAmmoCritLabel(label);
      if (!parsed) continue;

      const destroyed = Boolean(slot?.destroyed);
      if (destroyed && !includeDestroyed) continue;

      out.push({
        locKey: lk,
        index: idx,
        label: parsed.raw,
        typeText: parsed.typeText,
        shots: parsed.shots,
        key: parsed.key,
        noExplode: parsed.noExplode
      });
    }
  }

  return out;
}

function findHighestPriorityAmmoInCritSlots(actor) {
  const ammoSlots = findAmmoSlots(actor, { includeDestroyed: false });
  if (!ammoSlots.length) return null;

  // Hierarchy match first (string includes)
  for (const key of AMMO_EXPLOSION_PRIORITY) {
    const keyLower = key.toLowerCase();
    const hit = ammoSlots.find(a => a.label.toLowerCase().includes(keyLower));
    if (hit) return hit;
  }

  return ammoSlots[0] ?? null;
}

// ------------------------------------------------------------
// Ammo explosion resolution (damage + crit-chain)
// ------------------------------------------------------------
const _atowAmmoExplState = globalThis.__ATOW_BT_AMMO_EXP_STATE__ ?? (globalThis.__ATOW_BT_AMMO_EXP_STATE__ = {
  processing: new Set(),               // actorId
  queue: new Map(),                    // actorId -> [{...}]
  recentlyQueued: new Map()            // key -> timestamp (ms)
});

function _ammoQueueKey(actorId, locKey, index, reason) {
  return `${actorId}:${locKey}:${index}:${reason}`;
}

function _ammoQueueRecently(actorId, locKey, index, reason, windowMs = 2000) {
  const k = _ammoQueueKey(actorId, locKey, index, reason);
  const now = Date.now();
  const last = _atowAmmoExplState.recentlyQueued.get(k) ?? 0;
  if ((now - last) < windowMs) return true;
  _atowAmmoExplState.recentlyQueued.set(k, now);
  return false;
}

function _transferTarget(locKey) {
  switch (String(locKey)) {
    case "la": return "lt";
    case "ra": return "rt";
    case "ll": return "lt";
    case "rl": return "rt";
    case "lt": return "ct";
    case "rt": return "ct";
    case "head": return "ct";
    default: return null;
  }
}

async function applyExplosionDamage(actor, originLocKey, totalDamage) {
  if (!actor || !originLocKey) return;

  let dmg = Number(totalDamage ?? 0) || 0;
  if (dmg <= 0) return;

  let locKey = String(originLocKey);
  let first = true;


  const caseProtected = isLocationProtectedByCASE(actor, locKey);
  // We may touch multiple locations; batch into as few updates as possible.
  const updates = {};

  // Safety cap to prevent pathological loops
  for (let steps = 0; steps < 20 && dmg > 0 && locKey; steps++) {
    const armorNode = actor.system?.armor?.[locKey];
    const structNode = actor.system?.structure?.[locKey];

    const aMax = Number(armorNode?.max ?? 0) || 0;
    const aCur = Number(armorNode?.dmg ?? 0) || 0;
    const sMax = Number(structNode?.max ?? 0) || 0;
    const sCur = Number(structNode?.dmg ?? 0) || 0;

    const aRem = Math.max(0, aMax - aCur);
    const sRem = Math.max(0, sMax - sCur);

    const applyStructFirst = first; // origin: structure-first, transfers: normal (armor-first)

    if (applyStructFirst) {
      const tookS = Math.min(dmg, sRem);
      if (tookS > 0) updates[`system.structure.${locKey}.dmg`] = clamp(sCur + tookS, 0, sMax);
      dmg -= tookS;

      const tookA = Math.min(dmg, aRem);
      if (tookA > 0) updates[`system.armor.${locKey}.dmg`] = clamp(aCur + tookA, 0, aMax);
      dmg -= tookA;
    } else {
      const tookA = Math.min(dmg, aRem);
      if (tookA > 0) updates[`system.armor.${locKey}.dmg`] = clamp(aCur + tookA, 0, aMax);
      dmg -= tookA;

      const tookS = Math.min(dmg, sRem);
      if (tookS > 0) updates[`system.structure.${locKey}.dmg`] = clamp(sCur + tookS, 0, sMax);
      dmg -= tookS;
    }

    if (dmg > 0) {
      if (first && caseProtected) break;
      locKey = _transferTarget(locKey);
      first = false;
    }
  }

  if (Object.keys(updates).length) {
    await actor.update(updates, { atowAmmoExplosion: true }).catch(() => {});
  }
}

async function rollExplosionCritCount(actor, { flavor = "Ammo Explosion Critical Check" } = {}) {
  const roll = await (new Roll("2d6")).evaluate({ async: true });
  const t = Number(roll.total ?? 0) || 0;

  let count = 0;
  if (t >= 12) count = 3;
  else if (t >= 10) count = 2;
  else if (t >= 8) count = 1;

  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: `${flavor}: <b>${count ? `${count} crit` + (count > 1 ? "s" : "") : "no crit"}</b>`
  });

  return count;
}

function _occupiedCritIndices(actor, locKey) {
  const slots = actor?.system?.crit?.[locKey]?.slots;
  const out = [];
  for (const { idx, slot } of _iterCritSlots(slots)) {
    if (!Number.isFinite(idx)) continue;
    const destroyed = Boolean(slot?.destroyed);
    if (destroyed) continue;

    let label = String(slot?.label ?? "").trim();
    if (!label) label = _defaultCritLabel(actor, locKey, idx);

    const uuid = String(slot?.uuid ?? "");
    const occupied = Boolean(uuid) || Boolean(label);
    if (!occupied) continue;

    out.push(idx);
  }
  return out;
}

async function applyRandomCritDestruction(actor, locKey, count) {
  if (!actor || !locKey) return;
  const n = Number(count ?? 0) || 0;
  if (n <= 0) return;

  const candidates = _occupiedCritIndices(actor, locKey);
  if (!candidates.length) return;

  const picks = [];
  const pool = candidates.slice();
  while (pool.length && picks.length < n) {
    const i = int(pool.length * Math.random());
    picks.push(pool.splice(i, 1)[0]);
  }

  if (!picks.length) return;

  const updates = {};
  for (const idx of picks) {
    updates[`system.crit.${locKey}.slots.${idx}.destroyed`] = true;
  }
  await actor.update(updates, { atowAmmoExplosion: true }).catch(() => {});
}

async function _processAmmoExplosionQueue(actor) {
  if (!actor) return;
  const actorId = actor.id;
  if (_atowAmmoExplState.processing.has(actorId)) return;

  _atowAmmoExplState.processing.add(actorId);
  try {
    const q = _atowAmmoExplState.queue.get(actorId) ?? [];
    let processed = 0;

    while (q.length) {
      const job = q.shift();
      processed += 1;
      if (processed > 50) {
        console.warn("AToW Battletech | Ammo explosion chain capped for", actorId);
        break;
      }

      const { locKey, label, typeText, reason } = job;

      // Play SFX once per explosion event
      playAtowSfx(AMMO_EXPLOSION_SFX, { volume: 1.0 });

      const dmg = _ammoExplosionDamageForType(typeText);
      if (!dmg) continue;

      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<b>${actor.name}</b> suffers an <b>AMMO EXPLOSION</b> in <b>${String(locKey).toUpperCase()}</b>!<br/>Exploding ammo: <b>${label}</b><br/>Damage: <b>${dmg}</b> (${reason})`
      });

      await applyExplosionDamage(actor, locKey, dmg);

      // Critical chain check (per your rule: every explosion triggers a crit roll)
      const crits = await rollExplosionCritCount(actor, { flavor: "Ammo Explosion Critical Check" });
      if (crits > 0) {
        await applyRandomCritDestruction(actor, locKey, crits);
      }

      // Merge any newly queued jobs
      const curQ = _atowAmmoExplState.queue.get(actorId);
      if (curQ && curQ !== q) {
        q.push(...curQ);
        _atowAmmoExplState.queue.set(actorId, q);
      }
    }

    _atowAmmoExplState.queue.set(actorId, q);
  } finally {
    _atowAmmoExplState.processing.delete(actorId);
  }
}

function queueAmmoExplosion(actor, ammoSlotInfo, { reason = "critical hit", delayMs = 0 } = {}) {
  try {
    if (!actor || !ammoSlotInfo) return;
    if (!game.user?.isGM) return; // resolve once

    const { locKey, index, label, typeText, noExplode } = ammoSlotInfo;
    if (noExplode) return;

    if (_ammoQueueRecently(actor.id, locKey, index, reason)) return;

    const dmg = _ammoExplosionDamageForType(typeText);
    if (!dmg) return;

    const job = { ...ammoSlotInfo, reason, damage: dmg };

    const enqueue = () => {
      const q = _atowAmmoExplState.queue.get(actor.id) ?? [];
      q.push(job);
      _atowAmmoExplState.queue.set(actor.id, q);
      _processAmmoExplosionQueue(actor);
    };

    if (delayMs > 0) setTimeout(enqueue, delayMs);
    else enqueue();
  } catch (err) {
    console.warn("AToW Battletech | queueAmmoExplosion failed", err);
  }
}



async function maybeResolveAmmoExplosionForActor(actor, combat) {
  if (!actor) return;
  if (!game.user?.isGM) return; // resolve once

  const round = combat?.round ?? 0;
  const turn = combat?.turn ?? 0;
  const stamp = `${round}:${turn}`;

  const existing = actor.system?.heat?.effects?.ammoExplosion;
  if (existing?.stamp === stamp) return; // already resolved this turn

  const unvented = getUnventedHeat(actor);
  const tn = computeAmmoExplosionTN(unvented);

  if (tn === null) {
    // Clear old info if it exists
    if (existing) await actor.update({ "system.heat.effects.ammoExplosion": null }).catch(() => {});
    return;
  }

  const roll = await (new Roll("2d6")).evaluate({ async: true });
  const total = roll.total ?? 0;
  const avoided = total >= tn;

  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: avoided
      ? `Heat Ammo Explosion Check (avoid on ${tn}+): <b>AVOIDED</b>`
      : `Heat Ammo Explosion Check (avoid on ${tn}+): <b>AMMO EXPLOSION</b>`
  });

  if (avoided) {
    await actor.update({ "system.heat.effects.ammoExplosion": { active: false, tn, roll: total, stamp } }).catch(() => {});
    return;
  }

  const ammoInfo = findHighestPriorityAmmoInCritSlots(actor);
  const ammo = ammoInfo?.label ?? "Unknown Ammo";
  await actor.update({ "system.heat.effects.ammoExplosion": { active: true, tn, roll: total, ammo, stamp, locKey: ammoInfo?.locKey ?? null, index: ammoInfo?.index ?? null, typeText: ammoInfo?.typeText ?? null } }).catch(() => {});

  // Schedule the actual explosion resolution (sound + damage) after the heat callout timing.
  if (ammoInfo) queueAmmoExplosion(actor, ammoInfo, { reason: "heat", delayMs: 2500 });

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<b>${actor.name}</b> suffers an <b>AMMO EXPLOSION</b>!<br/>Exploding ammo detected: <b>${ammo}</b>.`
  });
}

function maybeHandleAmmoExplosionForActor(actor, combat) {
  if (!actor) return;

  const round = combat?.round ?? 0;
  const turn = combat?.turn ?? 0;
  const stamp = `${round}:${turn}`;

  const eff = actor.system?.heat?.effects?.ammoExplosion;
  if (!eff || !eff.active) return;

  const effStamp = eff.stamp ?? stamp;
  const prev = _atowSfxState.ammoExplosionState.get(actor.id);
  if (prev === effStamp) return;
  _atowSfxState.ammoExplosionState.set(actor.id, effStamp);

  const ammo = eff.ammo ?? "Unknown Ammo";
  try { ui.notifications?.error?.(`AMMO EXPLOSION! ${actor.name}: ${ammo}`); } catch (_) {}


// Damage + SFX are handled by queueAmmoExplosion scheduled in maybeResolveAmmoExplosionForActor.
// If we are resuming mid-combat (e.g. after a reload), re-queue once based on the stored effect payload.
if (eff.locKey != null && eff.index != null && eff.typeText) {
  queueAmmoExplosion(actor, {
    locKey: String(eff.locKey),
    index: Number(eff.index),
    label: String(eff.ammo ?? "Unknown Ammo"),
    typeText: String(eff.typeText),
    shots: 0,
    key: _ammoKeyFromType(String(eff.typeText)) ?? _slugifyKey(String(eff.typeText)),
    noExplode: false
  }, { reason: "heat", delayMs: 2500 });
}
}


function isActorShutdown(actor) {
  const heat = actor?.system?.heat ?? {};
  const effects = heat.effects ?? {};

  // Primary source of truth: our consolidated status effect ID.
  // We also treat a manual shutdown flag as shutdown.
  let hasShutdownStatus = false;
  try {
    if (actor?.statuses?.has) hasShutdownStatus = actor.statuses.has("atow-shutdown") || actor.statuses.has("atow.shutdown");
    else if (Array.isArray(actor?.statuses)) hasShutdownStatus = actor.statuses.includes("atow-shutdown") || actor.statuses.includes("atow.shutdown");
  } catch (_) {}

  let manualShutdown = false;
  try { manualShutdown = !!actor?.getFlag?.(SYSTEM_ID, "shutdownManual"); } catch (_) {}

  // Fallback: legacy/system heat flags if present.
  const heatShutdown = Boolean(heat.shutdown) || Boolean(effects.shutdown?.active);

  return Boolean(hasShutdownStatus || manualShutdown || heatShutdown);
}


async function clearActorShutdown(actor, tokenDoc) {
  if (!actor) return;

  const updates = {
    "system.heat.shutdown": false,
    "system.heat.effects.shutdown.active": false
  };

  try {
    await actor.update(updates);
  } catch (err) {
    console.warn("AToW Battletech | Failed to clear shutdown", err);
  }

  try {
    // If shutdown was purely heat-based, we've cleared it above. However, Shutdown can also be manual
    // (atow.shutdown / flags.shutdownManual). Keep the token "shutdown" flag in sync with any manual shutdown.
    let desiredShutdown = false;
    try { desiredShutdown = !!actor?.getFlag?.(SYSTEM_ID, "shutdownManual"); } catch (_) {}
    try {
      if (!desiredShutdown && actor?.statuses?.has) desiredShutdown = actor.statuses.has("atow-shutdown") || actor.statuses.has("atow.shutdown");
      if (!desiredShutdown && Array.isArray(actor?.statuses)) desiredShutdown = actor.statuses.includes("atow-shutdown") || actor.statuses.includes("atow.shutdown");
    } catch (_) {}
    if (tokenDoc?.setFlag) await tokenDoc.setFlag(SYSTEM_ID, "shutdown", desiredShutdown);

  } catch (_) {}
// Update local transition state so we don't immediately re-play shutdown SFX
  try { _atowSfxState.shutdownState.set(actor.id, false); } catch (_) {}
  playActorPowerRestoredAnnouncement(actor, { volume: 0.9 });
}


function maybePlayHeatSfxForActor(actor, combat) {
  if (!actor) return;

  const round = combat?.round ?? 0;
  const turn = combat?.turn ?? 0;
  const stamp = `${round}:${turn}`;


  // Heat status SFX (post-vent unvented heat)
  // 0-4: systems nominal, 5-13: moderate, 14+: critical
  const unvented = getUnventedHeat(actor);

  let heatKind = "systemsNominal";
  let heatSrc = SYSTEMS_NOMINAL_SFX;
  let heatVol = 0.75;

  if (unvented >= 14) {
    heatKind = "heatCritical";
    heatSrc = HEAT_CRITICAL_SFX;
    heatVol = 0.9;
  } else if (unvented >= 5) {
    heatKind = "heatModerate";
    heatSrc = HEAT_MODERATE_SFX;
    heatVol = 0.85;
  }

  const heatKey = _sfxKey(actor.id, heatKind);
  if (_atowSfxState.last.get(heatKey) !== stamp) {
    _atowSfxState.last.set(heatKey, stamp);

    // Delay so startup sound plays first
    setTimeout(() => {
      if (_atowSfxState.last.get(heatKey) !== stamp) return;
      playAtowSfx(heatSrc, { volume: heatVol });
    }, 2000);
  }



  // Shutdown sound only when shutdown transitions OFF -> ON
  const nowShutdown = isActorShutdown(actor);
  const prevShutdown = _atowSfxState.shutdownState.get(actor.id) ?? false;
  _atowSfxState.shutdownState.set(actor.id, nowShutdown);

  if (nowShutdown && !prevShutdown) {
    const key = _sfxKey(actor.id, "shutdown");
    if (_atowSfxState.last.get(key) !== stamp) {
      _atowSfxState.last.set(key, stamp);
      setTimeout(() => {
        // Only play if we haven't advanced turns since scheduling
        if (_atowSfxState.last.get(key) !== stamp) return;
        playAtowSfx(SHUTDOWN_SFX, { volume: 1.0 });
      }, 5000);
    }
  }

  else if (!nowShutdown && prevShutdown) {
    const key = _sfxKey(actor.id, "startup");
    if (_atowSfxState.last.get(key) !== stamp) {
      _atowSfxState.last.set(key, stamp);
      // Small delay so any shutdown SFX doesn't overlap on rapid toggles
      setTimeout(() => {
        if (_atowSfxState.last.get(key) !== stamp) return;
        playAtowSfx(STARTING_UP_SFX, { volume: 0.9 });
      }, 1500);
    }
  }
}

function _getCombatStamp(combat) {
  return `${combat?.id ?? "no-combat"}:${combat?.round ?? 0}:${combat?.turn ?? 0}`;
}

async function _waitForTurnHeatResolution(actor, combat) {
  const tokenDoc = combat?.combatant?.token ?? null;
  if (!tokenDoc?.getFlag) return;
  if (actor?.id && tokenDoc.actor?.id && actor.id !== tokenDoc.actor.id) return;
  const stamp = _getCombatStamp(combat);
  for (let i = 0; i < 20; i += 1) {
    const resolvedStamp = String(tokenDoc.getFlag(SYSTEM_ID, "heatResolvedStamp") ?? "");
    if (resolvedStamp === stamp) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

// Register hooks once (module-scope)
if (!globalThis.__ATOW_BT_SFX_REGISTERED__) {
  globalThis.__ATOW_BT_SFX_REGISTERED__ = true;

  // NOTE: Removed auto-clearing of Shutdown at turn start.
  // Shutdown is controlled by heat rules and manual toggling.


  // Turn-start announcement audio is now centralized in module/audio-helper.js.
  // Keep this hook only for mech-side ammo explosion follow-up.
  Hooks.on("updateCombat", (combat, changed) => {
    if (!("turn" in changed || "round" in changed)) return;
    if (!combat?.started) return;

    const actor = combat?.combatant?.actor;
    if (!actor) return;
    if (actor.type && actor.type !== "mech") return;

    setTimeout(async () => {
      await _waitForTurnHeatResolution(actor, combat);
      await maybeResolveAmmoExplosionForActor(actor, combat);
      maybeHandleAmmoExplosionForActor(actor, combat);
    }, 50);
  });


  // Apply heat from movement (walk/run) during the active combatant's turn.
  // GM-only to avoid duplicate updates in multiplayer.
  Hooks.on("updateToken", async (tokenDoc, changed) => {
    try {
      if (!game.user?.isGM) return;
      if (game?.[SYSTEM_ID]?.config?._moveHookRegistered) return;

      const sysChanged = changed?.flags?.["atow-battletech"];
      if (!sysChanged) return;

      // Only react to movement-tracking changes (ignore our own bookkeeping flags).
      const relevant =
        Object.prototype.hasOwnProperty.call(sysChanged, "movedThisTurn") ||
        Object.prototype.hasOwnProperty.call(sysChanged, "moveMode");
      if (!relevant) return;

      const combat = game.combat;
      if (!combat?.started) return;

      const activeTokenId = combat?.combatant?.tokenId;
      if (!activeTokenId || tokenDoc?.id !== activeTokenId) return;

      const actor = tokenDoc?.actor;
      if (!actor) return;
      if (actor.type && actor.type !== "mech") return;

if (isMechDestroyed(actor)) return;


      const stamp = getCombatStamp(combat);

      const priorStamp = (await tokenDoc.getFlag("atow-battletech", "moveHeatStamp")) ?? null;
      let applied = Number((await tokenDoc.getFlag("atow-battletech", "moveHeatApplied")) ?? 0) || 0;

      // New turn => reset applied tracking
      if (priorStamp !== stamp) applied = 0;

      const desired = getMovementHeatForToken(tokenDoc);

      // Only add heat when desired increases (walk->run upgrade adds +1).
      const delta = Math.max(0, desired - applied);
      if (delta > 0) {
        const cur = Number((actor.system?.heat?.value ?? actor.system?.heat?.current) ?? 0) || 0;
        const barMax = Number(actor.system?.heat?.max ?? 30) || 30;
        const next = clamp(cur + delta, 0, HEAT_HARD_CAP);
        await actor.update({
          "system.heat.value": next,
          "system.heat.current": next,
          "system.heat.max": barMax
        });
      }

      // Store bookkeeping flags on the token (so reloads don't double-apply).
      await tokenDoc.update({
        [`flags.atow-battletech.moveHeatStamp`]: stamp,
        [`flags.atow-battletech.moveHeatApplied`]: Math.max(applied, desired)
      });
    } catch (err) {
      console.warn("AToW Battletech | movement heat hook failed", err);
    }
  });


  // Footsteps SFX: play a stompy sound when a mech changes facing (60° increments).
  // Runs client-side (no GM gating) so everyone hears it.
  Hooks.on("preUpdateToken", (tokenDoc, changed) => {
    try {
      if (!tokenDoc) return;
      if (!changed || !Object.prototype.hasOwnProperty.call(changed, "rotation")) return;

      const actor = tokenDoc.actor;
      if (!actor) return;
      if (actor.type && actor.type !== "mech") return;
      if (isMechDestroyed(actor)) return;

      const oldRot = Number(tokenDoc.rotation ?? tokenDoc._source?.rotation ?? 0) || 0;
      const newRot = Number(changed.rotation ?? 0) || 0;

      // Compute minimal signed angular difference (wrap-safe).
      const norm = (d) => ((d % 360) + 360) % 360;
      let diff = norm(newRot) - norm(oldRot);
      diff = ((diff + 540) % 360) - 180; // [-180, 180)
      const ad = Math.abs(diff);

      if (ad < 0.5) return;

      // Only trigger on 60° facings (hex grid). Allow a tiny tolerance.
      const steps = ad / 60;
      const stepCountRaw = Math.round(steps);
      if (stepCountRaw < 1) return;
      if (Math.abs(steps - stepCountRaw) > 0.02) return;

      // Don't overlap / spam: global lock + per-token debounce.
      const now = Date.now();
      const lockUntil = Number(_atowSfxState.footstepsLockUntil ?? 0) || 0;
      if (lockUntil > now) return;

      const key = tokenDoc.id ?? tokenDoc._id ?? actor.id;
      const lastAt = Number(_atowSfxState.lastFootstepsAt.get(key) ?? 0) || 0;
      if ((now - lastAt) < 200) return;

      // If the user spins multiple facings at once, play up to 3 "stomps" sequentially.
      const stepCount = Math.min(3, stepCountRaw);
      const intervalMs = 350;

      _atowSfxState.lastFootstepsAt.set(key, now);
      _atowSfxState.footstepsLockUntil = now + (stepCount * intervalMs);

      for (let i = 0; i < stepCount; i += 1) {
        setTimeout(() => playAtowSfx(FOOTSTEPS_SFX, { volume: 0.5 }), i * intervalMs);
      }
    } catch (err) {
      console.warn("AToW Battletech | footsteps rotation SFX failed", err);
    }
  });

  

// Prevent moving destroyed mechs (non-GM). This blocks token position updates.
Hooks.on("preUpdateToken", (tokenDoc, changed, options, userId) => {
  try {
    if (!tokenDoc) return;
    const actor = tokenDoc.actor;
    if (!actor) return;
    if (actor.type && actor.type !== "mech") return;

    if (!isMechDestroyed(actor)) return;

    // Only block non-GM users
    const user = game.users?.get?.(userId);
    if (user?.isGM) return;

    const moving = Object.prototype.hasOwnProperty.call(changed ?? {}, "x") ||
                   Object.prototype.hasOwnProperty.call(changed ?? {}, "y");
    if (!moving) return;

    ui.notifications?.warn?.(`${actor.name} is DESTROYED and cannot move.`);
    return false;
  } catch (err) {
    console.warn("AToW Battletech | preUpdateToken destroy lock failed", err);
  }
});


// ------------------------------------------------------------
// Armor total tracker (system.armorTrack) for token resource bars
// ------------------------------------------------------------

// One-time bootstrap for existing mechs (GM-only).
Hooks.once("ready", async () => {
  try {
    if (!game.user?.isGM) return;
    const actors = game.actors?.contents ?? [];
    for (const actor of actors) {
      if (actor?.type && actor.type !== "mech") continue;

      const totals = _computeArmorTotalsFrom(actor.system?.armor);
      const curV = Number(actor.system?.armorTrack?.value);
      const curM = Number(actor.system?.armorTrack?.max);

      const needsInit = !Number.isFinite(curV) || !Number.isFinite(curM) || curV !== totals.current || curM !== totals.max;
      if (!needsInit) continue;

      await actor.update({
        "system.armorTrack.value": totals.current,
        "system.armorTrack.min": 0,
        "system.armorTrack.max": totals.max
      }, { atowArmorSync: true, render: false }).catch(() => {});
    }
  } catch (err) {
    console.warn("AToW Battletech | armorTrack bootstrap failed", err);
  }
});

// Keep armorTrack in sync whenever any location armor changes.
Hooks.on("updateActor", async (actor, changed, options) => {
  try {
    if (options?.atowArmorSync) return;
    if (actor?.type && actor.type !== "mech") return;

    const flat = foundry.utils.flattenObject(changed ?? {});
    const keys = Object.keys(flat);
    const armorTouched = keys.some(k => k.startsWith("system.armor."));
    if (!armorTouched) return;

    const totals = _computeArmorTotalsFrom(actor.system?.armor);
    const curV = Number(actor.system?.armorTrack?.value);
    const curM = Number(actor.system?.armorTrack?.max);

    if (curV !== totals.current || curM !== totals.max || !Number.isFinite(curV) || !Number.isFinite(curM)) {
      await actor.update({
        "system.armorTrack.value": totals.current,
        "system.armorTrack.min": 0,
        "system.armorTrack.max": totals.max
      }, { atowArmorSync: true }).catch(() => {});
    }
  } catch (err) {
    console.warn("AToW Battletech | updateActor armorTrack sync failed", err);
  }
});

// Sync engine hit tracker (3 hits) and apply the "dead" status when it reaches 3.
// Important: Foundry's `changed` payload is often sparse and may not include `changed.system.crit` as a fully-expanded object
// when updates are applied via dotted paths (e.g. "system.crit.ct.slots.0.destroyed").
Hooks.on("updateActor", async (actor, changed, options) => {
  try {
    if (options?.atowEngineSync) return;
    if (actor?.type && actor.type !== "mech") return;

    const flat = foundry.utils.flattenObject(changed ?? {});
    const keys = Object.keys(flat);
    const critTouched = keys.some(k => k.startsWith("system.crit."));
    const engineTrackTouched = keys.includes("system.critHits.engine");

    if (!critTouched && !engineTrackTouched) return;

    // If crit slots changed, recompute engine hits from crit-slot destruction.
    if (critTouched) {
      const hits = getEngineHitCountFromCrit(actor);
      const cur = Number(actor.system?.critHits?.engine ?? 0) || 0;

      if (hits !== cur) {
        await actor.update({ "system.critHits.engine": hits }, { atowEngineSync: true }).catch(() => {});
      }

      await setDeadStatus(actor, (hits >= 3) || shouldBeDeadFromStructureOrFlags(actor));
      return;
    }

    // Otherwise, the user may have clicked the engine hit dots directly.
    if (engineTrackTouched) {
      const hits = clamp(Number(actor.system?.critHits?.engine ?? 0) || 0, 0, 3);
      if (hits !== Number(actor.system?.critHits?.engine ?? 0)) {
        await actor.update({ "system.critHits.engine": hits }, { atowEngineSync: true }).catch(() => {});
      }
      await setDeadStatus(actor, (hits >= 3) || shouldBeDeadFromStructureOrFlags(actor));
    }
  } catch (err) {
    console.warn("AToW Battletech | updateActor engine-destruction sync failed", err);
  }
});



// Structure destruction: when a location's structure reaches 0 (dmg >= max),
// auto-destroy all components in that location's crit slots. CT destruction destroys ALL components and kills the mech.
Hooks.on("updateActor", async (actor, changed, options) => {
  try {
    if (options?.atowLocDestroy) return;
    if (actor?.type && actor.type !== "mech") return;

    const flat = foundry.utils.flattenObject(changed ?? {});
    const keys = Object.keys(flat);
    const structureTouched = keys.some(k => k.startsWith("system.structure."));
    if (!structureTouched) return;

    const now = _getStructureDestroyedSnapshot(actor);
    const prev = _atowLocDestroyState.get(actor.id);

    // Seed snapshot on first sight.
    if (!prev) {
      _atowLocDestroyState.set(actor.id, now);
      return;
    }

    const becameDestroyed = [];
    for (const k of Object.keys(now)) {
      if (now[k] && !prev[k]) becameDestroyed.push(k);
    }

    if (!becameDestroyed.length) {
      _atowLocDestroyState.set(actor.id, now);
      return;
    }

    for (const locKey of becameDestroyed) {
      await applyStructureLocationDestruction(actor, locKey);
    }

    _atowLocDestroyState.set(actor.id, now);
  } catch (err) {
    console.warn("AToW Battletech | structure destruction hook failed", err);
  }
});

// Play the "ejection explosion" SFX (and destruction VFX) when a mech transitions to Destroyed/Dead.
// We key off our mech-destroyed predicate (engine hits >= 3 OR dead status), and only fire on false -> true.
Hooks.on("updateActor", async (actor, changed) => {
  try {
    if (actor?.type && actor.type !== "mech") return;

    const nowDestroyed = isMechDestroyed(actor);
    const prevDestroyed = _atowSfxState.destroyedState.get(actor.id);

    // Seed state on first sight.
    // If already destroyed, ensure the persistent smoke is present (but don't play the explosion by default).
    if (prevDestroyed === undefined) {
      if (nowDestroyed) {
        const flat = foundry.utils.flattenObject(changed ?? {});
        const keys = Object.keys(flat);
        const engineTouched = keys.includes("system.critHits.engine") || keys.some(k => k.startsWith("system.crit."));
        if (engineTouched) {
          maybePlayEjectionExplosionSfx(actor);
        } else {
          await playDestroyedVfx(actor, { withExplosion: false, withSmoke: true });
        }
              await applyDestroyedTint(actor);
}
      _atowSfxState.destroyedState.set(actor.id, nowDestroyed);
      return;
    }

    // False -> True : destruction event
    if (!prevDestroyed && nowDestroyed) {
            await applyDestroyedTint(actor);
      maybePlayEjectionExplosionSfx(actor);
    }

    // True -> False : mech restored, clear persistent smoke
    if (prevDestroyed && !nowDestroyed) {
      await clearDestroyedVfx(actor);
          await clearDestroyedTint(actor);
      // Clear any one-off destruction flags (e.g., decapitation/no-ejection) once the mech is restored.
      if (game.user?.isGM) {
        try {
          await actor.unsetFlag(SYSTEM_ID, "noEjection");
          await actor.unsetFlag(SYSTEM_ID, "destroyedBy");
          await actor.unsetFlag(SYSTEM_ID, "forcedDead");
        } catch (_) {}
      }
    }

    _atowSfxState.destroyedState.set(actor.id, nowDestroyed);
  } catch (err) {
    console.warn("AToW Battletech | updateActor destroyed SFX/VFX hook failed", err);
  }
});



// Bootstrap smoke for already-destroyed mechs when the canvas loads (GM-only).
Hooks.on("canvasReady", async () => {
  try {
    if (!game.user?.isGM) return;
    if (!_sequencerActive()) return;

    const tokens = canvas?.tokens?.placeables ?? [];
    for (const tok of tokens) {
      const actor = tok?.actor;
      if (!actor) continue;
      if (actor.type && actor.type !== "mech") continue;

      if (isMechDestroyed(actor)) {
        await playDestroyedVfx(actor, { withExplosion: false, withSmoke: true });
              await applyDestroyedTint(actor);
      }
    }
  } catch (err) {
    console.warn("AToW Battletech | canvasReady destroyed smoke bootstrap failed", err);
  }
});

// Backup: if shutdown is applied via some other future workflow
  
  // Detect structure damage and crit-slot destruction reliably (pre-update so we can compare old -> new).
  Hooks.on("preUpdateActor", (actor, changed, options) => {
    try {
      if (actor?.type && actor.type !== "mech") return;

      // --- Structure (internal) damage: play "armor breached" when total structure dmg increases ---
      const structDelta = changed?.system?.structure;
      if (structDelta) {
        const oldTotal = _computeTotalStructureDamage(actor);
        const base = foundry.utils.deepClone(actor.system?.structure ?? {});
        const merged = foundry.utils.mergeObject(base, structDelta, { inplace: false });
        const newTotal = _computeTotalStructureDamageFrom(merged);

        // Update snapshot baseline
        _atowSfxState.structureDmg.set(actor.id, newTotal);

        if (newTotal > oldTotal) {
          maybePlayArmorBreachedSfx(actor);
        }
      }

      // --- Crit-slot destruction SFX ---
      const critDelta = changed?.system?.crit;
      if (critDelta) {
        for (const [locKey, locVal] of Object.entries(critDelta ?? {})) {
          const slotsDelta = locVal?.slots;
          if (!slotsDelta) continue;

          const entries = Array.isArray(slotsDelta)
            ? slotsDelta.map((v, i) => [String(i), v])
            : Object.entries(slotsDelta);

          for (const [idxKey, slotChange] of entries) {
            if (!slotChange || !Object.prototype.hasOwnProperty.call(slotChange, "destroyed")) continue;

            const index = Number(idxKey);
            if (Number.isNaN(index)) continue;

            const nextDestroyed = Boolean(slotChange.destroyed);
            if (!nextDestroyed) continue;

            const prevDestroyed = Boolean(actor.system?.crit?.[locKey]?.slots?.[index]?.destroyed);
            if (prevDestroyed) continue; // only on false -> true

            const uuid = actor.system?.crit?.[locKey]?.slots?.[index]?.uuid;
            let label = actor.system?.crit?.[locKey]?.slots?.[index]?.label ?? "";
            if (!String(label).trim()) {
              label = _defaultCritLabel(actor, locKey, index) ?? "";
            }


// Ammo explosion on crit: if an ammo slot is destroyed, it detonates (but NOT when a whole location is destroyed).
const ammoInfo = _parseAmmoCritLabel(label);
if (ammoInfo && !ammoInfo.noExplode) {
  // If this crit-slot destruction is coming from a location-destruction cascade, do NOT detonate ammo.
  if (!options?.atowLocDestroy) {
    queueAmmoExplosion(actor, { locKey, index, label: ammoInfo.raw, typeText: ammoInfo.typeText, shots: ammoInfo.shots, key: ammoInfo.key, noExplode: ammoInfo.noExplode }, { reason: "critical hit", delayMs: 0 });
  }
  continue;
}

// Gauss Rifle detonation: the weapon itself explodes for 15 internal-first damage (gauss ammo does not).
if (!options?.atowLocDestroy && String(label).toLowerCase().includes("gauss") && String(label).toLowerCase().includes("rifle")) {
  if (game.user?.isGM) {
    setTimeout(async () => {
      try {
        playAtowSfx(AMMO_EXPLOSION_SFX, { volume: 1.0 });
        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor }),
          content: `<b>${actor.name}</b> suffers a <b>GAUSS RIFLE DETONATION</b> in <b>${String(locKey).toUpperCase()}</b>!<br/>Damage: <b>15</b>`
        });
        await applyExplosionDamage(actor, locKey, 15);
        const crits = await rollExplosionCritCount(actor, { flavor: "Gauss Detonation Critical Check" });
        if (crits > 0) await applyRandomCritDestruction(actor, locKey, crits);
      } catch (e) {
        console.warn("AToW Battletech | Gauss detonation failed", e);
      }
    }, 0);
  }
  continue;
}

            // Fast path: label indicates component type even if no uuid is present
            if (_isJumpJetText(label)) {
              maybePlayJumpjetFailureSfx(actor);
              continue;
            }
            if (_isHeatSinkText(label)) {
              maybePlayCoolantFailureSfx(actor);
              continue;
            }
            if (_isEngineText(label)) {
              maybePlayReactorBreachSfx(actor);
              continue;
            }
            if (_isSensorsText(label)) {
              maybePlayCommsOfflineSfx(actor);
              continue;
            }
            if (_isDamageCriticalComponentText(label)) {
              maybePlayDamageCriticalSfx(actor);
              continue;
            }

            // Fast path: label match against embedded items by name (helps if uuid is missing)
            const exactNameMatch = actor.items?.find?.(it => it?.name === label);
            if (exactNameMatch) {
              if (["weapon", "mechWeapon"].includes(exactNameMatch.type)) {
                maybePlayWeaponDestroyedSfx(actor);
                continue;
              }
              if (_isJumpJetItem(exactNameMatch)) {
                maybePlayJumpjetFailureSfx(actor);
                continue;
              }
              if (_isHeatSinkItem(exactNameMatch)) {
                maybePlayCoolantFailureSfx(actor);
                continue;
              }
              if (_isEngineItem(exactNameMatch)) {
                maybePlayReactorBreachSfx(actor);
                continue;
              }
              if (_isSensorsItem(exactNameMatch)) {
                maybePlayCommsOfflineSfx(actor);
                continue;
              }
              if (_isDamageCriticalComponentText(exactNameMatch.name)) {
                maybePlayDamageCriticalSfx(actor);
                continue;
              }
            }

            // UUID check (async)
            if (uuid) {
              Promise.all([
                isWeaponUuid(uuid, actor),
                isJumpJetUuid(uuid, actor),
                isHeatSinkUuid(uuid, actor),
                isEngineUuid(uuid, actor),
                isSensorsUuid(uuid, actor),
                isDamageCriticalUuid(uuid, actor)
              ]).then(([isWep, isJj, isHs, isEng, isSens, isDc]) => {
                if (isWep) return maybePlayWeaponDestroyedSfx(actor);
                if (isJj) return maybePlayJumpjetFailureSfx(actor);
                if (isHs) return maybePlayCoolantFailureSfx(actor);
                if (isEng) return maybePlayReactorBreachSfx(actor);
                if (isSens) return maybePlayCommsOfflineSfx(actor);
                if (isDc) return maybePlayDamageCriticalSfx(actor);
              });
            }
          }
        }
      }
    } catch (err) {
      console.warn("AToW Battletech | preUpdateActor SFX hook failed", err);
    }
  });

Hooks.on("updateActor", (actor, changed) => {
    if (actor?.type && actor.type !== "mech") return;



    const heatChanged = changed?.system?.heat;
    if (!heatChanged) return;

    const combat = game.combat;
    if (!combat?.started) return;

    // Only consider the active combatant, to avoid noise
    const activeActor = combat?.combatant?.actor;
    if (activeActor?.id !== actor.id) return;

    const round = combat?.round ?? 0;
    const turn = combat?.turn ?? 0;
    const stamp = `${round}:${turn}`;

    // If shutdown transitions OFF -> ON, play immediately (throttled)
    const nowShutdown = isActorShutdown(actor);
    const prevShutdown = _atowSfxState.shutdownState.get(actor.id) ?? false;
    _atowSfxState.shutdownState.set(actor.id, nowShutdown);

    if (nowShutdown && !prevShutdown) {
      const key = _sfxKey(actor.id, "shutdown");
      if (_atowSfxState.last.get(key) !== stamp) {
        _atowSfxState.last.set(key, stamp);
        setTimeout(() => {
          if (_atowSfxState.last.get(key) !== stamp) return;
          playActorShutdownAnnouncement(actor, { volume: 1.0 });
        }, 250);
      }
    }
  });
}

export class AToWMechSheetV2 extends HandlebarsApplicationMixin(ActorSheetV2) {
  constructor(...args) {
    super(...args);
    this._hideThirdColumn = false;
  }

  static DEFAULT_OPTIONS = foundry.utils.mergeObject(
    super.DEFAULT_OPTIONS,
    {
      classes: ["atow", "battletech", "sheet", "actor", "mech", "mech-sheet-v2"],
      position: { width: 1200, height: 900 },
      window: { resizable: true },
      form: {
        submitOnChange: true,
        closeOnSubmit: false
      }
    },
    { inplace: false }
  );

  static PARTS = {
    form: { template: TEMPLATE }
  };

  /** @override */
  get title() {
    return `${this.actor.name} — Mech`;
  }

  /** @override */
  _getHeaderButtons() {
    return super._getHeaderButtons?.() ?? [];
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    await ensureActorCritMountIds(this.actor).catch(() => {});

    const system = this.actor.system ?? {};
    const items = (this.actor.items ?? []).map(i => i);
    const profileImage = this.actor?.img || system?.mech?.profileMedia || this.actor?.prototypeToken?.texture?.src || "";

    context.actor = this.actor;
    context.system = system;
    context.profileImage = profileImage;
    context.isProfileVideo = /\.webm(?:$|[?#])/i.test(profileImage);
    context.hideThirdColumn = this._hideThirdColumn === true;
    context.isManualShutdown = Boolean(this.actor?.getFlag?.(SYSTEM_ID, "shutdownManual"));
    context.isDazzleMode = Boolean(this.actor?.getFlag?.(SYSTEM_ID, "dazzleMode"));


    // --- Mech tonnage (dropdown) + structure profile ---
    const mechTonnage = normalizeMechTonnage(system?.mech?.tonnage);
    const mechStructureProfile = getStructureProfileForTonnage(mechTonnage);

    // IMPORTANT: Foundry's {{selectOptions}} treats a bare Array as [index -> label],
    // which makes the submitted value 0..N and causes tonnage to normalize back to 20.
    // Provide an object map so the option VALUE is the actual tonnage number.
    context.tonnageOptions = TONNAGE_OPTIONS.reduce((acc, t) => {
      acc[String(t)] = String(t);
      return acc;
    }, {});
    context.mechTonnage = mechTonnage;
    context.mechStructureProfile = mechStructureProfile;
    context.mechHeaderMeta = [
      getMechWeightClassLabel(mechTonnage),
      `${mechTonnage} Tons`,
      String(system?.mech?.role ?? "").trim()
    ].filter(Boolean);

    // --- Derived movement (auto-calculated from Engine Rating + Tonnage) ---
    // Jump MP is only calculated if jump jets are installed in crit slots.
    const jumpJetInstalledCount = await countJumpJetComponentsFromCritSlots(this.actor);

    const derivedMoveBase = computeDerivedMovement(system?.mech?.engine, mechTonnage, {
      jumpJetCount: jumpJetInstalledCount
    });

    // --- Triple-Strength Myomer (TSM) ---
    const mechTechBase = _getMechTechBase(this.actor, system?.mech?.engine ?? null);

    const tsmSlotsTotal = countComponentCritSlots(system, _TSM_LABEL_RE, { includeDestroyed: true });
    const tsmSlotsIntact = countComponentCritSlots(system, _TSM_LABEL_RE, { includeDestroyed: false });
    const mascSlotsIntact = countComponentCritSlots(system, _MASC_LABEL_RE, { includeDestroyed: false });

    const tsmNeeded = 6;
    const hasTSM = tsmSlotsTotal > 0;

    const tsmTechOk = (mechTechBase === "inner");
    const mascPresent = mascSlotsIntact > 0;
    const tsmMascOk = !mascPresent;
    const tsmInstalledOk = tsmSlotsIntact >= tsmNeeded;

    // Heat threshold is based on "unvented" heat (heat after venting).
    const tsmHeat = getUnventedHeat(this.actor);
    const tsmHeatThreshold = 9;
    const tsmHeatReady = tsmHeat >= tsmHeatThreshold;

    // NOTE: RAW says TSM activates NEXT turn after ending a turn at heat 9+.
    // We approximate by marking it active whenever current unvented heat is 9+.
    const tsmActive = hasTSM && tsmTechOk && tsmMascOk && tsmInstalledOk && tsmHeatReady;

    // Apply TSM movement bonus BEFORE movement penalties (heat/damage).
    // We currently apply only the heat movement penalty (system.heat.effects.movePenalty) here.
    const heatMovePenalty = Number(system?.heat?.effects?.movePenalty ?? 0) || 0;

    let tsmWalk = derivedMoveBase?.walk ?? 0;
    let tsmRun = derivedMoveBase?.run ?? 0;
    const baseJump = derivedMoveBase?.jump ?? 0;

    if (tsmActive) {
      tsmWalk = Math.max(0, tsmWalk + 2);
      tsmRun = Math.ceil(tsmWalk * 1.5);
    }

    const derivedMove = {
      walk: Math.max(0, tsmWalk - heatMovePenalty),
      run: Math.max(0, tsmRun - heatMovePenalty),
      jump: Math.max(0, baseJump - heatMovePenalty)
    };

    context.derivedMove = derivedMove;

    if (derivedMove) {
      system.movement = system.movement ?? {};
      system.movement.walk = derivedMove.walk;
      system.movement.run = derivedMove.run;
      system.movement.jump = derivedMove.jump;
      system.movement._base = derivedMoveBase;
      system.movement._heatMovePenalty = heatMovePenalty;
      system.movement._tsmActive = tsmActive;
    }

    // Jump jet bookkeeping: installed vs "full jump" requirement.
    // In classic BT, to achieve Jump MP equal to Walk MP, you must install Jump Jets equal to Walk MP.
    const jumpJetsInstalled = Math.max(0, Math.floor(Number(jumpJetInstalledCount ?? 0) || 0));
    const jumpJetsRequired = (jumpJetsInstalled > 0 && derivedMoveBase?.walk) ? derivedMoveBase.walk : 0;
    const jumpJetsDelta = jumpJetsInstalled - jumpJetsRequired;

    const jumpJetStatus = {
      installed: jumpJetsInstalled,
      required: jumpJetsRequired,
      delta: jumpJetsDelta,
      ok: (jumpJetsRequired === 0 ? jumpJetsInstalled === 0 : jumpJetsInstalled === jumpJetsRequired)
    };

    // Expose for templates/status readouts (derived; not persisted).
    system.movement = system.movement ?? {};
    system.movement.jumpJets = jumpJetStatus;





    // Weapons are derived from crit-slot installs (no more double-listing).
    const meleeEntries = buildMeleeAttackEntries(this.actor, { tsmActive });
    const autoWeapons = [...meleeEntries, ...(await buildAutoWeaponsFromCritSlots(this.actor))];

    // Equipment is still embedded items (drag/drop into the loadout zone).
    const equipmentDocs = items.filter(i => i.type === "equipment" || i.type === "gear");
    const other = items.filter(i => !["weapon", "mechWeapon", "equipment", "gear", "ammo"].includes(i.type));
    const equipment = equipmentDocs
      .map((i) => {
        const o = i.toObject();
        o.id = i.id;
        o.itemUuid = i.uuid ?? "";
        o.isWeapon = false;
        o.canDelete = true;
        o.canAttack = false;
        o.destroyed = false;
        return o;
      })
      .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));

    // Combined “loadout” table (crit-derived weapons + embedded equipment)
    const loadoutDisplay = [...autoWeapons, ...equipment];

    const combatantToken =
      game.combat?.started && String(game.combat?.combatant?.actor?.id ?? "") === String(this.actor?.id ?? "")
        ? (game.combat?.combatant?.token ?? null)
        : null;
    const trackerSource =
      combatantToken ??
      this.token?.document ??
      this.actor?.getActiveTokens?.(true, true)?.[0]?.document ??
      this.actor?.getActiveTokens?.()?.[0]?.document ??
      this.actor;
    const fireTracker = trackerSource?.getFlag?.(SYSTEM_ID, "weaponFireTracker") ?? trackerSource?.flags?.[SYSTEM_ID]?.weaponFireTracker ?? null;
    const fireStamp = String(fireTracker?.stamp ?? "");
    const trackerTurnStamp = String(trackerSource?.getFlag?.(SYSTEM_ID, "turnStamp") ?? "");
    const consumedThisTurn = trackerSource?.getFlag?.(SYSTEM_ID, "weaponFireConsumedThisTurn");
    const isFreshTurn = (trackerTurnStamp !== getCurrentCombatTurnStamp()) || (consumedThisTurn !== true);
    const activeFireKeys = (fireStamp === getCurrentCombatTurnStamp())
      && !isFreshTurn
      ? new Set([
          ...(Array.isArray(fireTracker?.keys) ? fireTracker.keys : []),
        ].map(v => String(v ?? "").trim()).filter(Boolean))
      : new Set();

    for (const entry of loadoutDisplay) {
      const fireKey = String(entry?.weaponFireKey ?? "").trim();
      entry.firedThisTurn = fireKey ? activeFireKeys.has(fireKey) : false;
    }

    context.system = system;

    // Warrior / pilot tracking helpers
    const pilot = system.pilot ?? {};
    const hitsTaken = Number(pilot.hitsTaken ?? 0);
    context.pilot = pilot;
    context.pilotTracks = {
      hitsTaken,
      hits: [1, 2, 3, 4, 5, 6].map(n => ({ n, filled: n <= hitsTaken })),
      consciousness: ["3", "5", "7", "10", "11", "Dead"].map(v => ({
        v,
        active: String(pilot.consciousness ?? "") === String(v)
      }))
    };

    context.loadout = loadoutDisplay;

    // --- Tonnage Breakdown (informational; also drives current weight) ---
    const techBase = mechTechBase;
    const endoSlots = countEndoSteelCritSlots(system);
    const endoNeeded = (techBase === "clan") ? 7 : 14;
    const hasEndoSteel = endoSlots >= endoNeeded;

const structureTonsStd = getStandardStructureTonnage(context.mechTonnage);
const structureTonsEndo = getEndoSteelStructureTonnage(context.mechTonnage);
const structureTons = hasEndoSteel ? structureTonsEndo : structureTonsStd;

const structureNote = hasEndoSteel
  ? `Endo Steel (${endoSlots}/${endoNeeded} slots)`
  : `Standard (${endoSlots}/${endoNeeded} slots)`;

// Armor:
// Standard armor: every 16 armor points = 1 ton.
// Ferro-Fibrous: uses your points-per-ton rule (16 armor pts/ton × multiplier, then rounded)
// once enough "Ferro Fibrous" crit slots are installed.
const armorPoints = sumArmorPoints(system);
const ferroSlots = countFerroFibrousCritSlots(system);
// Clan Ferro-Fibrous: 7 crit slots, 1.20 multiplier.
// Inner Sphere Ferro-Fibrous: 14 crit slots, 1.12 multiplier.
// Inner Sphere Light Ferro-Fibrous: 7 crit slots, 1.06 multiplier.
const ferroNeeded = (techBase === "clan") ? 7 : 14;
const lightFerroNeeded = 7;
const hasLightFerro = (techBase === "inner") && (Number(ferroSlots.light ?? 0) >= lightFerroNeeded);
const hasFerro = !hasLightFerro && (Number(ferroSlots.standard ?? 0) >= ferroNeeded);

const armorTonsStd = armorPoints / 16;
// Ferro-Fibrous math (per our rule): 1 ton = 16 armor points × multiplier (then rounded)
// -> derive tonnage from points as points / (16 * multiplier). Avoid per-ton rounding.
const armorMultiplier = hasLightFerro
  ? 1.06
  : hasFerro
    ? ((techBase === "clan") ? 1.20 : 1.12)
    : 1.0;
const armorTons = roundTons(
  armorMultiplier > 1
    ? (armorPoints / (16 * armorMultiplier))
    : armorTonsStd
);


const armorNote = hasLightFerro
  ? `Light Ferro-Fibrous (${Number(ferroSlots.light ?? 0)}/${lightFerroNeeded} slots)`
  : hasFerro
    ? `Ferro-Fibrous (${Number(ferroSlots.standard ?? 0)}/${ferroNeeded} slots)`
    : `Standard (${Number(ferroSlots.standard ?? 0)}/${ferroNeeded} slots)`;
// Engine + Gyro (best-effort from the engine text field)
const engineText = system?.mech?.engine ?? "";
const engineRating = parseEngineRating(engineText);
const engineTons = roundTons(getEngineTonnageFromEngineText(engineText));
const standardGyroTons = engineRating ? Math.ceil(engineRating / 100) : 0;
const xlGyroEnabled = _isXLGyroEnabled(this.actor);
const gyroTons = xlGyroEnabled ? roundTons(standardGyroTons / 2) : standardGyroTons;

// Ammo + installed crit-slot equipment tonnage:
// - Ammo bins: use the underlying ammo Item's tonnage when available (fixes 0.5t bins, etc.)
// - Crit-slot equipment: anything with a tonnage field that isn't a weapon/ammo/heat sink/jump jet counts as "Other"
// Use global registration to avoid scope/caching issues (and never crash the sheet if helper is missing).
const __collectInstalledCritSlotTonnage = globalThis?.collectInstalledCritSlotTonnage;
const { ammoSlots, ammoTons, otherCritTons } = (typeof __collectInstalledCritSlotTonnage === "function")
  ? await __collectInstalledCritSlotTonnage(this.actor)
  : { ammoSlots: 0, ammoTons: 0, otherCritTons: 0 };

// Heat sinks / cooling:
// - Weight still uses *count* of heat sinks (first 10 are "free"; each sink over 10 weighs 1 ton).
// - Cooling uses heat dissipation values from installed components.
//   * Crit-slot items are preferred for sink *count* to avoid double-counting.
//   * Any component with system.heatDissipation contributes to cooling; sinks also contribute to the sink count.
const sinkTypeRaw = String(system?.heat?.sinkType ?? "single").toLowerCase();
const mechIsDouble = Boolean(system?.heat?.isDouble) || (sinkTypeRaw === "double");
const sinkType = mechIsDouble ? "double" : "single";

// Back-compat: older actors may store sink type as system.heat.sinkType without the isDouble checkbox.
// We mirror the computed value into the rendered system data so the checkbox reflects reality.
try {
  system.heat = system.heat ?? {};
  if (system.heat.isDouble === undefined || system.heat.isDouble === null) {
    system.heat.isDouble = mechIsDouble;
  }
} catch (_) {
  /* ignore */
}

const engineMountedSinksAuto = engineRating ? Math.floor(engineRating / 25) : Number(system?.heat?.baseSinks ?? 10);

// Allow variants to uninstall some of the engine's extra (over-10) heat sinks to avoid the added tonnage.
// Stored as system.heat.engineSinks (engine-mounted sinks actually used).
try {
  system.heat = system.heat ?? {};
  if (system.heat.engineSinks === undefined || system.heat.engineSinks === null || system.heat.engineSinks === "") {
    system.heat.engineSinks = engineMountedSinksAuto;
  }
} catch (_) { /* ignore */ }

const _requestedEngineSinksRaw = system?.heat?.engineSinks;
const _hasConcreteEngineSinks =
  _requestedEngineSinksRaw !== null &&
  _requestedEngineSinksRaw !== undefined &&
  String(_requestedEngineSinksRaw).trim() !== "" &&
  String(_requestedEngineSinksRaw).trim().toLowerCase() !== "auto";
let _requestedEngineSinks = _hasConcreteEngineSinks ? Number(_requestedEngineSinksRaw) : NaN;
if (!Number.isFinite(_requestedEngineSinks)) {
  const legacyRaw = system?.heat?.engineSinksUsed;
  const legacyNum = Number(legacyRaw);
  if (Number.isFinite(legacyNum)) {
    _requestedEngineSinks = (engineMountedSinksAuto > 10 && legacyNum <= (engineMountedSinksAuto - 10))
      ? (10 + legacyNum)
      : legacyNum;
  }
}
const engineMountedSinks = (engineMountedSinksAuto > 10)
  ? clamp(Number.isFinite(_requestedEngineSinks) ? _requestedEngineSinks : engineMountedSinksAuto, 10, engineMountedSinksAuto)
  : clamp(Number.isFinite(_requestedEngineSinks) ? _requestedEngineSinks : engineMountedSinksAuto, 0, engineMountedSinksAuto);

const critCooling = await collectCoolingFromCritSlots(this.actor, { isDouble: mechIsDouble });
const embeddedCooling = collectCoolingFromEmbeddedDocs(equipmentDocs, { isDouble: mechIsDouble });

// If we have crit-slot sinks, prefer that *sink count* (and sink dissipation) to avoid double-counting.
const installedSinks = (critCooling.sinkCount > 0) ? critCooling.sinkCount : embeddedCooling.sinkCount;
const installedSinkDissipation = (critCooling.sinkCount > 0) ? critCooling.sinkDissipation : embeddedCooling.sinkDissipation;

// Non-sink cooling always contributes (best-effort).
const otherCoolingDissipation = (Number(critCooling.otherDissipation) || 0) + (Number(embeddedCooling.otherDissipation) || 0);

const totalHeatSinks = Math.max(0, (Number(engineMountedSinks) || 0) + (Number(installedSinks) || 0));
const heatSinkTons = Math.max(0, totalHeatSinks - 10);

// Base (engine-mounted) sink dissipation is controlled by the mech-wide double toggle.
const baseSinkDissipation = (mechIsDouble ? 2 : 1) * (Number(engineMountedSinks) || 0);
const heatDissipation = Math.max(0, baseSinkDissipation + (Number(installedSinkDissipation) || 0) + (Number(otherCoolingDissipation) || 0));

// Jump jets: count installed jets from crit slots (1 jet = 1 crit slot).
// If none are installed, tonnage is 0.
const jumpJetCount = Math.max(0, Math.floor(Number(jumpJetInstalledCount ?? 0) || 0));
const jumpJetPer = getJumpJetWeightPerJet(context.mechTonnage);
const jumpJetTons = roundTons(jumpJetCount * jumpJetPer);

// Cockpit is always 3 tons
const cockpitTons = 3;

// Weapons: we can’t reliably compute until weapon items define tonnage; we still sum if present.
let weaponsTons = 0;
for (const w of autoWeapons) weaponsTons += getItemTonnage(w);
weaponsTons = roundTons(weaponsTons);

// Other: sum any embedded equipment that declares tonnage, excluding heat sinks (listed separately).
let otherTons = 0;
for (const d of equipmentDocs) {
  if (isHeatSinkItemName(d?.name)) continue;
  otherTons += getItemTonnage(d);
}
// Exclude "ammo" items here; ammo tonnage is derived from crit slots above.
for (const d of other) otherTons += getItemTonnage(d);
// Add any additional crit-slot installed equipment (e.g., Command Module) that declares tonnage.
otherTons += otherCritTons;
otherTons = roundTons(otherTons);

const totalTons = roundTons(
  structureTons +
  armorTons +
  engineTons +
  weaponsTons +
  ammoTons +
  heatSinkTons +
  gyroTons +
  cockpitTons +
  jumpJetTons +
  otherTons
);

const maxTons = Number(context.mechTonnage);
const remaining = roundTons(maxTons - totalTons);
const over = totalTons > maxTons;

context.mechWeight = {
  max: maxTons,
  structure: structureTons,
  current: totalTons,
  remaining,
  over,
  overBy: over ? roundTons(totalTons - maxTons) : 0
};

context.specialOptions = {
  xlGyro: xlGyroEnabled,
  gyroTons,
  standardGyroTons
};

context.tonnageBreakdown = [
  { key: "structure",  label: "Structure",   tons: structureTons, display: `${structureTons}t`, note: structureNote },
  { key: "armor",      label: "Armor",       tons: armorTons,     display: `${armorTons}t`,     note: `${armorNote}; ${armorPoints} pts` },
  { key: "engine",     label: "Engine",      tons: engineTons,    display: `${engineTons}t`,    note: engineRating ? `Rating ${engineRating}${_isXLEngineText(engineText) ? " (XL)" : ""}` : "—" },
  { key: "weapons",    label: "Weapons",     tons: weaponsTons,   display: `${weaponsTons}t`,   note: "Total weapon weight" },
  { key: "ammo",       label: "Ammo",        tons: ammoTons,      display: `${ammoTons}t`,      note: `${ammoSlots} bins (from item tonnage)` },
  { key: "heatsinks",  label: "Heat Sinks",  tons: heatSinkTons,  display: `${heatSinkTons}t`,  note: `${totalHeatSinks} total (${engineMountedSinks} engine used / ${engineMountedSinksAuto} auto + ${installedSinks} installed), ${sinkType.toUpperCase()} cooling ${heatDissipation}` },
  { key: "gyro",       label: "Gyroscope",  tons: gyroTons,      display: `${gyroTons}t`,      note: engineRating ? (xlGyroEnabled ? `XL Gyro, half of ${standardGyroTons}t` : `ceil(${engineRating}/100)`) : "—" },
  { key: "cockpit",    label: "Cockpit",     tons: cockpitTons,   display: `${cockpitTons}t`,   note: "Fixed" },
  { key: "jumpjets",   label: "Jump Jets",   tons: jumpJetTons,   display: `${jumpJetTons}t`,   note: `${jumpJetCount} @ ${jumpJetPer}t` },
  { key: "other",      label: "Other",       tons: otherTons,     display: `${otherTons}t`,     note: "Equipment w/ tonnage fields (incl. crit-slot gear)" }
];

// ---- Ammunition (derived from installed ammo in crit slots) ----
context.ammoBins = buildAmmoBinsFromCritSlots(system);
context.hasAmmoBins = (context.ammoBins?.length ?? 0) > 0;

// Armor diagram helpers (Column 3)
const DEFAULT_ARMOR = {
  head:  { label: "Head",         max: 0, dmg: 0 },
  lt:    { label: "Left Torso",   max: 0, dmg: 0 },
  ct:    { label: "Center Torso", max: 0, dmg: 0 },
  rt:    { label: "Right Torso",  max: 0, dmg: 0 },
  la:    { label: "Left Arm",     max: 0, dmg: 0 },
  ra:    { label: "Right Arm",    max: 0, dmg: 0 },
  ll:    { label: "Left Leg",     max: 0, dmg: 0 },
  rl:    { label: "Right Leg",    max: 0, dmg: 0 },
  back:  { label: "Back",         max: 0, dmg: 0 },
  lback: { label: "Left Back",    max: 0, dmg: 0 },
  rback: { label: "Right Back",   max: 0, dmg: 0 }
};

const armor = foundry.utils.mergeObject(DEFAULT_ARMOR, system.armor ?? {}, { inplace: false });

for (const [k, v] of Object.entries(armor)) {
  v.max = Number(v.max ?? 0);
  v.dmg = Number(v.dmg ?? 0);
  if (Number.isNaN(v.max)) v.max = 0;
  if (Number.isNaN(v.dmg)) v.dmg = 0;
  v.dmg = clamp(v.dmg, 0, v.max);
  armor[k] = v;
}

const ORDER = ["head","lt","ct","rt","la","ra","ll","rl","lback","back","rback"];

context.armorLocList = ORDER
  .filter(k => armor[k] !== undefined)
  .map(key => {
    const loc = armor[key];
    return {
      key,
      label: loc.label ?? key,
      max: loc.max,
      dmg: loc.dmg,
      pips: Array.from({ length: loc.max }, (_, i) => {
        const n = i + 1;
        return { n, filled: n <= loc.dmg };
      })
    };
  });

// Armor totals (for display + token bar resource)
const armorTotals = _computeArmorTotalsFrom(armor);
context.armorSummary = {
  current: armorTotals.current,
  max: armorTotals.max,
  allowed: Number(context.mechStructureProfile?.maxArmor ?? 0) || 0
};





// Structure diagram helpers (Column 3)
const DEFAULT_STRUCTURE = {
  head: { label: "Head", max: 0, dmg: 0 },
  lt:   { label: "Left Torso", max: 0, dmg: 0 },
  ct:   { label: "Center Torso", max: 0, dmg: 0 },
  rt:   { label: "Right Torso", max: 0, dmg: 0 },
  la:   { label: "Left Arm", max: 0, dmg: 0 },
  ra:   { label: "Right Arm", max: 0, dmg: 0 },
  ll:   { label: "Left Leg", max: 0, dmg: 0 },
  rl:   { label: "Right Leg", max: 0, dmg: 0 }
};

const structure = foundry.utils.mergeObject(DEFAULT_STRUCTURE, system.structure ?? {}, { inplace: false });

// Structure max values are derived from the tonnage table (not user-editable).
const expectedStructure = context.mechStructureProfile?.structure ?? {};

for (const [k, v] of Object.entries(structure)) {
  const expectedMax = Number(expectedStructure?.[k] ?? 0);

  v.max = expectedMax;
  v.dmg = Number(v.dmg ?? 0);

  if (Number.isNaN(v.dmg)) v.dmg = 0;
  v.dmg = clamp(v.dmg, 0, v.max);

  structure[k] = v;
}

const STRUCT_ORDER = ["head","lt","ct","rt","la","ra","ll","rl"];

context.structureLocList = STRUCT_ORDER
  .filter(k => structure[k] !== undefined)
  .map(key => {
    const loc = structure[key];
    return {
      key,
      label: loc.label ?? key,
      max: loc.max,
      dmg: loc.dmg,
      pips: Array.from({ length: loc.max }, (_, i) => {
        const n = i + 1;
        return { n, filled: n <= loc.dmg };
      })
    };
  });

// Critical hit table helpers (Bottom Section)
const DEFAULT_CRIT = {
  // 6-slot locations
  head: { label: "Head", simple: true, slots: ["Life Support", "Sensors", "Cockpit", "", "Sensors", "Life Support"] },
  ll:   { label: "Left Leg",  simple: true, slots: ["Hip", "Upper Leg Actuator", "Lower Leg Actuator", "Foot Actuator", "", ""] },
  rl:   { label: "Right Leg", simple: true, slots: ["Hip", "Upper Leg Actuator", "Lower Leg Actuator", "Foot Actuator", "", ""] },

  // 12-slot locations (two 6-slot bands)
  la:   { label: "Left Arm",  slots13: ["Shoulder", "Upper Arm Actuator", "Lower Arm Actuator", "Hand Actuator", "", ""], slots46: ["", "", "", "", "", ""] },
  ra:   { label: "Right Arm", slots13: ["Shoulder", "Upper Arm Actuator", "Lower Arm Actuator", "Hand Actuator", "", ""], slots46: ["", "", "", "", "", ""] },
  lt:   { label: "Left Torso",  slots13: ["", "", "", "", "", ""], slots46: ["", "", "", "", "", ""] },
  rt:   { label: "Right Torso", slots13: ["", "", "", "", "", ""], slots46: ["", "", "", "", "", ""] },
  ct:   { label: "Center Torso", slots13: ["Engine", "Engine", "Engine", "Gyro", "Gyro", "Gyro"], slots46: ["Gyro", "Engine", "Engine", "Engine", "", ""] }
};


// Dynamic defaults for XL engines: reserve extra Engine crits in side torsos.
try {
  const ctLabels = _getCTDefaultCritLabels(this.actor);
  DEFAULT_CRIT.ct.slots13 = ctLabels.slice(0, 6);
  DEFAULT_CRIT.ct.slots46 = ctLabels.slice(6, 12);

  const side = _xlSideEngineCritCount(this.actor);
  if (side > 0) {
    for (let i = 0; i < side; i++) {
      DEFAULT_CRIT.lt.slots13[i] = "Engine";
      DEFAULT_CRIT.rt.slots13[i] = "Engine";
    }
  }
} catch (_) {}

const crit = foundry.utils.mergeObject(DEFAULT_CRIT, system.crit ?? {}, { inplace: false });

const SIX_SLOT_LOCS = new Set(["head", "ll", "rl"]);

// If older actor data overwrote these keys without the 'simple' flag (or stored slots as an object map),
// force them back to 6-slot mode and ensure slots is a real array.
for (const k of SIX_SLOT_LOCS) {
  crit[k] = crit[k] ?? {};
  crit[k].simple = true;

  const fallback = DEFAULT_CRIT[k]?.slots ?? ["", "", "", "", "", ""];
  const slots = crit[k].slots;

  crit[k].slots = Array.isArray(slots) ? slots : fallback;
}

const getStoredSlot = (locKey, idx) => system.crit?.[locKey]?.slots?.[idx] ?? {};

// ---- Crit Slot Presentation Helpers ----
// We keep slot.label as the durable stored value (used for ammo parsing / defaults),
// but render a nicer UI with icons and categories.
function _classifyCritLabel(label) {
  const t = String(label ?? "").trim().toLowerCase();

  // Empty slot
  if (!t) return { category: "empty", iconClass: "far fa-square" };

  // Ammo
  if (t.startsWith("ammo") || t.includes(" ammo")) {
    return { category: "ammo", iconClass: "fas fa-box" };
  }

  // Heat sinks
  if (t.includes("heat sink") || t.includes("heatsink")) {
    return { category: "heatsink", iconClass: "fas fa-snowflake" };
  }

  // CASE (Cellular Ammunition Storage Equipment)
  if (/(^|\b)case(\b|$)/i.test(t)) {
    return { category: "case", iconClass: "fas fa-shield-alt" };
  }

  // Artemis IV FCS
  if (t === "artemis iv fcs" || t === "artemis 4 fcs" || t.includes("artemis iv fcs") || t.includes("artemis 4 fcs")) {
    return { category: "artemis", iconClass: "fas fa-crosshairs" };
  }


  // Jump jets
  if (t.includes("jump jet") || t.includes("jumpjet")) {
    return { category: "jumpjet", iconClass: "fas fa-rocket" };
  }

  // Engine / Gyro / cockpit systems
  if (t.includes("engine")) return { category: "engine", iconClass: "fas fa-cogs" };
  if (t.includes("gyro")) return { category: "gyro", iconClass: "fas fa-sync-alt" };
  if (t.includes("cockpit")) return { category: "cockpit", iconClass: "fas fa-user-astronaut" };
  if (t.includes("life support")) return { category: "lifesupport", iconClass: "fas fa-heartbeat" };
  if (t.includes("sensor")) return { category: "sensors", iconClass: "fas fa-satellite-dish" };

  // Actuators / limbs
  if (t.includes("actuator") || t.includes("hip") || t.includes("shoulder") || t.includes("upper") || t.includes("lower") || t.includes("hand") || t.includes("foot")) {
    return { category: "actuator", iconClass: "fas fa-hand-paper" };
  }

  // Weapon-ish keywords (best-effort; we don't want to async resolve fromUuid for every slot)
  if (
    // Include LB-X autocannon label styles (e.g., "LB 10-X AC") so they don't fall into "system/other".
    /(laser|ppc|ac\s*\/?\s*\d+|lrm\s*\d+|srm\s*\d+|\blb\s*\d+\s*-\s*x\s*ac\b|\blbx\b|gauss|mg\b|machine gun|flamer|autocannon|rifle|plasma|pulse)/i.test(label)
  ) {
    return { category: "weapon", iconClass: "fas fa-crosshairs" };
  }

  // Default fallback
  return { category: "system", iconClass: "fas fa-microchip" };
}

// Build renderable slot arrays, supporting multi-slot "span" (start slot only)
const buildSlots = (locKey, labels, offset = 0) => {
  const out = [];
  labels = Array.isArray(labels) ? labels : [];
  const total = labels.length;
  const locSlots = _getCritSlotsArray(system, locKey);

  for (let i = 0; i < total; i++) {
    const index = offset + i;
    const stored = getStoredSlot(locKey, index);

    const partOf = stored?.partOf ?? null;
    const storedSpan = Number(stored?.span ?? 1);

    // Use stored label even if it's an empty string (so defaults don't reappear)
    const label = (stored && ("label" in stored)) ? stored.label : (labels[i] ?? "");
    const uuid = stored?.uuid ?? "";

    const continuation = partOf !== null && partOf !== undefined;
    const componentStart = continuation ? Number(partOf) : index;
    const componentStartSlot = Number.isFinite(componentStart) ? (locSlots[componentStart] ?? {}) : {};
    const componentSpanRaw = continuation
      ? Number(componentStartSlot?.span ?? 1)
      : storedSpan;
    const componentSpan = clamp(componentSpanRaw > 1 ? componentSpanRaw : 1, 1, locSlots.length - componentStart);
    const span = (!continuation && storedSpan > 1) ? clamp(storedSpan, 1, total - i) : 1;

    // Treat destruction as applying to the entire mounted component span, not only the struck slot.
    let destroyed = false;
    if (Number.isFinite(componentStart) && componentStart >= 0) {
      for (let j = 0; j < componentSpan; j++) {
        destroyed ||= Boolean(locSlots[componentStart + j]?.destroyed);
      }
    }

    // Presentation helpers for the template
    const { category, iconClass } = _classifyCritLabel(label);
    const isEmpty = !label && !uuid;
    const displayName = continuation
      ? ""
      : (isEmpty ? "EMPTY" : String(label ?? "").trim());
    let slotTag = (!continuation && span > 1) ? `${span} slots` : "";
    if (!continuation && category === "case") slotTag = "CASE";
    if (!continuation && destroyed && !isEmpty) slotTag = "DESTROYED";

    out.push({
      index,
      num: i + 1,
      label,
      uuid,
      destroyed,
      category,
      iconClass,
      displayName,
      slotTag,
      isEmpty,
      span,
      partOf: continuation ? partOf : null,
      continuation,
      isStart: (!continuation),
      spanStart: (!continuation && span > 1),
      hasItem: Boolean(uuid) || Boolean(label)
    });
  }

  return out;
};

const buildLoc = (key, cfg) => {
  const allowCASE = (techBase !== "clan") && (key === "lt" || key === "rt");
  if (cfg.simple || SIX_SLOT_LOCS.has(key)) {
    const raw = cfg.slots ?? DEFAULT_CRIT[key]?.slots ?? ["", "", "", "", "", ""];
    const labels = Array.isArray(raw) ? raw : (DEFAULT_CRIT[key]?.slots ?? ["", "", "", "", "", ""]);
    return { key, label: cfg.label ?? key, allowCASE, simple: true, slots: buildSlots(key, labels, 0) };
  }

  const band13 = buildSlots(key, cfg.slots13 ?? ["", "", "", "", "", ""], 0);
  const band46 = buildSlots(key, cfg.slots46 ?? ["", "", "", "", "", ""], 6);
  return { key, label: cfg.label ?? key, allowCASE, simple: false, band13, band46 };
};

context.crit = {
  left: [buildLoc("la", crit.la), buildLoc("lt", crit.lt), buildLoc("ll", crit.ll)],
  center: [buildLoc("head", crit.head), buildLoc("ct", crit.ct)],
  right: [buildLoc("ra", crit.ra), buildLoc("rt", crit.rt), buildLoc("rl", crit.rl)]
};

// Engine/Gyro/Sensor/Life Support hit trackers (dots)
const critHits = system.critHits ?? {};
const dots = (count, filled) => Array.from({ length: count }, (_, i) => ({ n: i + 1, filled: i + 1 <= Number(filled ?? 0) }));

context.critHits = {
  engine: dots(3, critHits.engine),
  gyro: dots(2, critHits.gyro),
  sensor: dots(2, critHits.sensor),
  lifeSupport: dots(1, critHits.lifeSupport)
};

    // ---- Heat Data (scale + sinks) ----
    const heat = system.heat ?? {};
    const heatRaw = Number((heat.value ?? heat.current) ?? 0);
    const heatBarMax = Number(heat.max ?? 30);

    
// Heat sinks / cooling:
// - Sink *count* is still shown for weight purposes.
// - Total cooling uses heat dissipation values from installed components (see tonnage section above).
const baseSinks = Math.max(0, Number(engineMountedSinks) || 0);
const extraSinks = Math.max(0, Number(installedSinks) || 0);
const totalSinks = Math.max(0, baseSinks + extraSinks);

const dissipation = Number(heatDissipation) || 0;
const sinkDissipation = Math.max(0, (Number(baseSinkDissipation) || 0) + (Number(installedSinkDissipation) || 0));
const otherDissipation = Math.max(0, Number(otherCoolingDissipation) || 0);
    const barMax = Number.isFinite(heatBarMax) ? heatBarMax : 30;
    const rawHeat = Number.isFinite(heatRaw) ? heatRaw : 0;
    // Clamp for the pip UI only (heat can exceed barMax)
    const clampedHeat = clamp(rawHeat, 0, barMax);

    const heatEffects = heat.effects ?? {};
    const unvented = Number((heat.unvented ?? heatEffects.unvented ?? rawHeat) ?? rawHeat);
    const movePenalty = Number(heatEffects.movePenalty ?? 0) || 0;
    const fireMod = Number(heatEffects.fireMod ?? 0) || 0;
    const shutdown = Boolean(heat.shutdown) || Boolean(heatEffects.shutdown?.active);
    const shutdownInfo = heatEffects.shutdown ?? {};

    context.heatData = {
      current: rawHeat,
      displayCurrent: clampedHeat,
      max: barMax,
engineSinksAuto: Math.max(0, Number(engineMountedSinksAuto) || 0),
engineSinksUsed: Math.max(0, Number(engineMountedSinks) || 0),
engineSinksMin: (Number(engineMountedSinksAuto) || 0) > 10 ? 10 : 0,
engineSinksAdjustable: (Number(engineMountedSinksAuto) || 0) > 10,
engineSinksRemoved: Math.max(0, (Number(engineMountedSinksAuto) || 0) - (Number(engineMountedSinks) || 0)),
      baseSinks,
      extraSinks,
      totalSinks,
      sinkType,
      dissipation,
      sinkDissipation,
      otherDissipation,
      unvented: (Number.isFinite(unvented) ? unvented : rawHeat),
      displayUnvented: clamp((Number.isFinite(unvented) ? unvented : rawHeat), 0, barMax),
      movePenalty,
      fireMod,
      shutdown,
      shutdownInfo,
      scale: Array.from({ length: barMax }, (_, i) => {
        const n = i + 1;
        return { n, filled: n <= clampedHeat };
      })
    };

    // ---- Movement Status (from token flags set by movement automation) ----
    const getMechToken = () => {
      const controlled = canvas?.tokens?.controlled ?? [];
      const match = controlled.find(t => t?.actor?.id === this.actor.id);
      if (match) return match;

      const active = this.actor.getActiveTokens?.(true, true) ?? this.actor.getActiveTokens?.() ?? [];
      return active?.[0] ?? null;
    };

    const tok = getMechToken();
    const moved = tok?.document?.getFlag?.(SYSTEM_ID, "movedThisTurn");
    const mpSpent = tok?.document?.getFlag?.(SYSTEM_ID, "mpSpentThisTurn");
    const modeFlag = tok?.document?.getFlag?.(SYSTEM_ID, "moveMode");

    context.movementStatus = {
      moved: (moved === undefined || moved === null) ? "—" : String(Number(moved)),
      mpSpent: (mpSpent === undefined || mpSpent === null) ? "—" : String(Number(mpSpent)),
      mode: modeFlag ? String(modeFlag).toUpperCase() : "—"
    };


    // ---- Status Window (Bottom Section) ----
    // A compact, at-a-glance summary of current mech conditions.
    const statusEntries = [];
    const addStatus = (level, icon, text, detail = "") => {
      statusEntries.push({ level, icon, text, detail: detail ?? "" });
    };

    const LOC_LABELS = {
      head: "Head",
      ct: "Center Torso",
      lt: "Left Torso",
      rt: "Right Torso",
      la: "Left Arm",
      ra: "Right Arm",
      ll: "Left Leg",
      rl: "Right Leg",
      back: "Back",
      lback: "Left Back",
      rback: "Right Back"
    };

    // Mech Status: Operational / Shut Down / Destroyed
    const mechDestroyed = isStructureLocDestroyed(this.actor, "ct") || isStructureLocDestroyed(this.actor, "head");
    const mechShutdown = isActorShutdown(this.actor);
    if (mechDestroyed) {
      addStatus("critical", "💥", "Mech Status: DESTROYED", "Center Torso / Head destroyed");
    } else if (mechShutdown) {
      addStatus("warning", "⛔", "Mech Status: SHUT DOWN", "Actions limited until restarted");
    } else {
      addStatus("info", "✅", "Mech Status: Operational");
    }

    // Heat banding (use unvented heat for severity)
    try {
      const h = Number(context?.heatData?.unvented ?? context?.heatData?.current ?? 0) || 0;
      const cooling = Number(context?.heatData?.dissipation ?? 0) || 0;
      let heatBand = "Nominal";
      let level = "info";
      if (h >= 14) { heatBand = "Critical"; level = "critical"; }
      else if (h >= 5) { heatBand = "Moderate"; level = "warning"; }
      addStatus(level, "🌡️", `Heat: ${heatBand}`, `Heat ${h} • Cooling ${cooling}`);
    } catch (_) { /* ignore */ }


    // Triple-Strength Myomer status (only show if installed)
    try {
      const tsm = context?.tsm ?? {};
      if (tsm.present) {
        const heatNow = Number(context?.heatData?.unvented ?? tsm.heat ?? 0) || 0;
        const thr = Number(tsm.heatThreshold ?? 9) || 9;

        if (!tsm.techOk) {
          addStatus("critical", "💪", "Triple-Strength Myomer: INVALID", "Inner Sphere 'Mechs only");
                } else if (tsm.mascPresent) {
          addStatus("warning", "💪", "Triple-Strength Myomer: CONFLICT", "Cannot be installed alongside MASC");
        } else if (Number(tsm.slotsIntact ?? 0) < Number(tsm.needed ?? 6)) {
          addStatus("warning", "💪", "Triple-Strength Myomer: INCOMPLETE", `${tsm.slotsIntact ?? 0}/${tsm.needed ?? 6} slots intact`);
        } else if (heatNow >= thr) {
          addStatus("info", "💪", "Triple-Strength Myomer: ACTIVE", `Heat ${heatNow} (≥ ${thr})`);
        } else {
          addStatus("info", "💪", "Triple-Strength Myomer: Inactive", `Heat ${heatNow} (needs ≥ ${thr})`);
        }
      }
    } catch (_) { /* ignore */ }

    // Missing / destroyed locations (structure)
    const destroyedLocKeys = ["la", "ra", "ll", "rl", "lt", "rt"].filter(k => isStructureLocDestroyed(this.actor, k));
    for (const k of destroyedLocKeys) {
      const label = LOC_LABELS[k] ?? k;
      const lvl = (k === "ll" || k === "rl") ? "critical" : "warning";
      addStatus(lvl, "⚠️", `Warning: Missing ${label}`);
    }

    // Armor depleted locations
    try {
      const depleted = Object.entries(armor ?? {})
        .filter(([k, v]) => (Number(v?.max ?? 0) || 0) > 0 && (Number(v?.dmg ?? 0) || 0) >= (Number(v?.max ?? 0) || 0))
        .map(([k]) => LOC_LABELS[k] ?? k);
      if (depleted.length) {
        const text = depleted.length === 1
          ? `Armor depleted: ${depleted[0]}`
          : `Armor depleted: ${depleted.slice(0, 4).join(", ")}${depleted.length > 4 ? ` (+${depleted.length - 4} more)` : ""}`;
        addStatus("warning", "🛡️", text);
      }
    } catch (_) { /* ignore */ }

    // Crit-slot systems: find targeting computer + other damaged/offline components
    const iterCritStarts = () => {
      const locs = ["head", "ct", "lt", "rt", "la", "ra", "ll", "rl"];
      const out = [];
      for (const locKey of locs) {
        const slots = _getCritSlotsArray(system, locKey);
        const max = _critSlotCount(locKey);
        for (let i = 0; i < Math.min(slots.length, max); i++) {
          const s = slots[i] ?? {};
          if (s.partOf !== undefined && s.partOf !== null) continue; // continuation

          const baseLabel = String(s.label ?? "").trim();
          const fallbackLabel = String(_defaultCritLabel(this.actor, locKey, i) ?? "").trim();
          const label = baseLabel || fallbackLabel;
          if (!label) continue;

          const spanRaw = Number(s.span ?? 1);
          const span = clamp(Number.isFinite(spanRaw) ? spanRaw : 1, 1, max - i);
          let destroyed = false;
          for (let j = 0; j < span; j++) destroyed = destroyed || !!(slots[i + j]?.destroyed);

          out.push({ locKey, index: i, label, destroyed, uuid: s.uuid ?? "", span });
        }
      }
      return out;
    };

    const critStarts = (() => {
      try { return iterCritStarts(); } catch (_) { return []; }
    })();

    // Targeting Computer status (only show if present)
    const tc = critStarts.find(s => /targeting\s*computer/i.test(s.label));
    if (tc) {
      const tcLoc = LOC_LABELS[tc.locKey] ?? tc.locKey;
      if (tc.destroyed) addStatus("critical", "🎯", "Targeting Computer: OFFLINE", `Damaged in ${tcLoc}`);
      else addStatus("info", "🎯", "Targeting Computer: ONLINE", `Mounted in ${tcLoc}`);
    }


    // Artemis IV FCS status (only show if any Artemis is installed)
    const isArtemisLabel = (lbl) => /^artemis\s*(iv|4)\s*fcs$/i.test(String(lbl ?? "").trim());
    const isEligibleLauncher = (lbl) => {
      const t = String(lbl ?? "").trim();
      if (!t) return false;
      if (/\bammo\b/i.test(t)) return false;
      if (/\bstreak\s*srm\b/i.test(t)) return false;
      return /\b(lrm|srm|mrm)\s*[-]?\s*(\d+)\b/i.test(t);
    };

    const artemisByLoc = {};
    let artemisTotal = 0;
    let launcherTotal = 0;

    for (const s of critStarts) {
      if (s.destroyed) continue;
      if (isArtemisLabel(s.label)) {
        artemisByLoc[s.locKey] ??= { artemis: 0, launchers: 0 };
        artemisByLoc[s.locKey].artemis += 1;
        artemisTotal += 1;
        continue;
      }
      if (isEligibleLauncher(s.label)) {
        artemisByLoc[s.locKey] ??= { artemis: 0, launchers: 0 };
        artemisByLoc[s.locKey].launchers += 1;
        launcherTotal += 1;
      }
    }

    const artemisInstalled = artemisTotal > 0;
    const artemisFullyLinked =
      launcherTotal > 0 &&
      artemisInstalled &&
      artemisTotal === launcherTotal &&
      Object.values(artemisByLoc).every(v => Number(v.artemis ?? 0) === Number(v.launchers ?? 0));

    if (artemisInstalled) {
      if (launcherTotal <= 0) {
        addStatus("warning", "🎯", "Artemis IV FCS: Installed (no eligible launchers)", "Applies only to LRM/SRM/MRM launchers");
      } else if (artemisFullyLinked) {
        addStatus("info", "🎯", "Artemis IV FCS: LINKED", "+2 to cluster rolls (LRM/SRM/MRM) • Max roll 12");
      } else {
        addStatus("warning", "🎯", "Artemis IV FCS: NOT FULLY LINKED", `Artemis ${artemisTotal} • Launchers ${launcherTotal} (must match)`);
      }
    }

    // Other damaged/offline systems (prefer actual installed items; also include major defaults)
    const majorDefaultRe = /(engine|gyro|sensor|sensors|life support|cockpit|jump jet|heat sink|ecm|beagle|c3|case|ammo)/i;
    const damaged = critStarts
      .filter(s => s.destroyed)
      .filter(s => !!s.uuid || majorDefaultRe.test(String(s.label)))
      // Don't spam targeting computer twice
      .filter(s => !/targeting\s*computer/i.test(String(s.label)))
      .map(s => {
        const label = String(s.label);
        const loc = LOC_LABELS[s.locKey] ?? s.locKey;
        const severe = /(engine|gyro|cockpit)/i.test(label);
        return { label, loc, severe };
      });

    if (damaged.length) {
      // De-dupe by label+loc (multi-slot items)
      const seen = new Set();
      const uniq = [];
      for (const d of damaged) {
        const key = `${d.label}@@${d.loc}`;
        if (seen.has(key)) continue;
        seen.add(key);
        uniq.push(d);
      }

      // Show up to 6, then summarize
      const shown = uniq.slice(0, 6);
      for (const d of shown) {
        addStatus(d.severe ? "critical" : "warning", "🧰", `System Damaged: ${d.label}`, d.loc);
      }
      if (uniq.length > shown.length) {
        addStatus("warning", "…", `Additional damaged systems: ${uniq.length - shown.length} more`);
      }
    }

    // Nearby enemy detection (token-based, best-effort)
    try {
      const myTok = tok;
      if (canvas?.ready && myTok && canvas?.tokens?.placeables?.length) {
        const myDisp = Number(myTok.document?.disposition ?? 0);
        const range = 10; // hexes (approx) – tweak later via setting if desired

        const enemies = [];
        for (const t of canvas.tokens.placeables) {
          if (!t || t.id === myTok.id) continue;
          const otherDisp = Number(t.document?.disposition ?? 0);
          const hostile = (myDisp > 0 && otherDisp < 0) || (myDisp < 0 && otherDisp > 0) || (myDisp === 0 && otherDisp !== 0);
          if (!hostile) continue;

          // Prefer mechs, but don't hard-fail if types differ
          const otherType = t.actor?.type;
          if (otherType && otherType !== this.actor.type && otherType !== "mech") continue;

          let dist = null;
          try {
            dist = canvas.grid.measureDistance(myTok.center, t.center);
          } catch (_) {
            dist = null;
          }
          if (dist === null || dist === undefined) continue;
          if (dist > range) continue;
          enemies.push({ name: t.name ?? t.actor?.name ?? "Unknown", dist });
        }

        enemies.sort((a, b) => (a.dist - b.dist));
        if (enemies.length) {
          const list = enemies.slice(0, 3).map(e => `${e.name} (${Math.round(e.dist)})`).join(", ");
          addStatus("warning", "📡", "Enemy mechs detected nearby", list);
        }
      }
    } catch (_) { /* ignore */ }

    context.statusEntries = statusEntries;



    return context;
  }

  /** @override */
  _onRender(context, options) {
    super._onRender(context, options);

    const root = this.element;
    if (!root) return;
    this._syncDerivedHeatDissipation(context).catch(err => {
      console.warn("AToWMechSheetV2 | Failed to sync derived heat dissipation", err);
    });
    this._injectWindowColumnToggle(root);

    const html = globalThis.jQuery?.(root) ?? globalThis.$?.(root) ?? null;
    if (html) this.activateListeners(html);
  }

  async _syncDerivedHeatDissipation(context) {
    const next = Number(context?.heatData?.dissipation ?? NaN);
    if (!Number.isFinite(next)) return;
    const current = Number(this.actor?.system?.heat?.dissipation ?? NaN);
    if (Math.abs((Number.isFinite(current) ? current : 0) - next) < 0.001) return;
    await this.actor.update({ "system.heat.dissipation": next }, { atowSyncHeatDissipation: true });
  }

  _injectWindowColumnToggle(root) {
    const app = root?.closest?.(".window-app, .application");
    const header = app?.querySelector?.(".window-header");
    const controls = app?.querySelector?.(".window-header .window-controls, .window-header .header-controls");
    const host = controls ?? header;
    if (!host) return;

    app?.querySelector?.(".atow-toggle-third-column")?.remove?.();

    const button = document.createElement("button");
    button.type = "button";
    button.className = "header-control atow-toggle-third-column";
    button.title = this._hideThirdColumn ? "Show Right Column" : "Hide Right Column";
    button.setAttribute("aria-label", button.title);
    button.innerHTML = '<i class="fas fa-columns"></i>';
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this._hideThirdColumn = !this._hideThirdColumn;
      this.render(false);
    });

    const anchor = header?.querySelector?.(".close, .header-control.close, .window-control.close, [data-action='close']");
    if (anchor?.parentElement) anchor.parentElement.insertBefore(button, anchor);
    else host.prepend(button);
  }

  activateListeners(html) {
    if (!this.isEditable) return;

    // Item controls (no “add” buttons; drag/drop only)
    const portrait = html.find(".mech-portrait-media");
    if (portrait.length) {
      portrait.on("click", async (event) => {
        event.preventDefault();

        const FilePickerCtor =
          globalThis.FilePicker ??
          foundry?.applications?.forms?.FilePicker ??
          foundry?.applications?.api?.FilePicker;

        if (!FilePickerCtor) {
          ui.notifications?.warn?.("FilePicker is not available.");
          return;
        }

        const fp = new FilePickerCtor({
          type: "imagevideo",
          current: this.actor?.img || this.actor?.prototypeToken?.texture?.src || this.actor?.system?.mech?.profileMedia || "",
          callback: async (path) => {
            if (!path) return;
            await this.actor.update({
              img: path,
              "system.mech.profileMedia": path,
              "prototypeToken.texture.src": path
            });
          }
        });

        fp.render(true);
      });
    }

    html.find(".header-action-btn[data-header-action]").on("click", this._onHeaderActionClick.bind(this));
    html.find(".header-action-btn[data-header-action][draggable='true']").on("dragstart", this._onHeaderActionDragStart.bind(this));
    this._primeHeaderActionMacros(html).catch(err => {
      console.warn("AToWMechSheetV2 | Failed to prime header action macros", err);
    });

    html.find(".item-delete").on("click", this._onItemDelete.bind(this));
    html.find(".we-attack").on("click", this._onWeaponAttack.bind(this));
    html.find(".we-row").on("click", this._onWeaponRowClick.bind(this));
    html.find(".we-row").on("contextmenu", this._onWeaponRowContext.bind(this));
    html.find(".we-row[draggable='true']").on("dragstart", this._onLoadoutDragStart.bind(this));
    html.find(".ammo-table input[name^='system.ammoBins.'][name$='.current']").on("change", this._onAmmoBinCurrentChange.bind(this));
    html.find('input[name="system.pilot.gunnery"], input[name="system.pilot.piloting"]').on("change", this._onPilotSkillChange.bind(this));
    html.find('input[name="system.heat.value"]').on("change", this._onHeatValueChange.bind(this));
    html.find('input[name="system.heat.isDouble"]').on("change", this._onHeatSinkModeChange.bind(this));
    html.find('.armor-max[name^="system.armor."][name$=".max"]').on("change", this._onArmorMaxChange.bind(this));
    html.find([
      'input[name="system.mech.chassis"]',
      'input[name="system.mech.model"]',
      'input[name="system.mech.bv"]',
      'input[name="system.mech.yearProduced"]',
      'input[name="system.mech.techBase"]',
      'input[name="system.mech.rulesLevel"]',
      'input[name="system.mech.role"]',
      'input[name="system.mech.engine"]'
    ].join(", ")).on("change", this._onBattleMechDataFieldChange.bind(this));
    this._primeLoadoutAttackMacros(html).catch(err => {
      console.warn("AToWMechSheetV2 | Failed to prime loadout attack macros", err);
    });

    // Tonnage dropdown -> auto-sync structure maxima
    html.find('select[name="system.mech.tonnage"]').on("change", this._onTonnageChange.bind(this));

    // Engine rating -> auto-sync movement (walk/run/jump)
    html.find('input[name="system.mech.engine"]').on("change", this._onEngineChange.bind(this));

    // Tech base can change how many XL engine side-torso crits are reserved.
    html.find('select[name="system.mech.techBase"], select[name="system.techBase"], input[name="system.mech.techBase"], input[name="system.techBase"]').on("change", this._onTechBaseChange.bind(this));
    html.find('input[name="system.mech.xlGyro"]').on("change", this._onXLGyroChange.bind(this));


// Engine-mounted sinks slider <-> number sync
const $engSlider = html.find("[data-engine-sinks-slider]");
const $engNumber = html.find("[data-engine-sinks-number]");
if ($engSlider.length && $engNumber.length) {
  $engSlider.on("input", (ev) => {
    const v = ev.currentTarget.value;
    $engNumber.val(v);
    // Trigger a change so Foundry persists immediately (submitOnChange)
    $engNumber.trigger("change");
  });
  $engNumber.on("input change", (ev) => {
    const v = ev.currentTarget.value;
    $engSlider.val(v);
  });
}

    // On open/render, ensure structure matches current tonnage (one-time, best-effort)
    this._ensureStructureFromTonnage().catch(() => {});
    this._ensureMovementFromEngine().catch(() => {});
    this._ensureXLEngineCrits().catch(() => {});
    this._syncCTCritLabels().catch(() => {});



    // Rolls + tracks
    html.find(".rollable").on("click", this._onRoll.bind(this));
    html.find(".track-box").on("click", this._onTrackBox.bind(this));
    html.find(".armor-pip").on("click", this._onArmorPip.bind(this));
    html.find(".structure-pip").on("click", this._onStructurePip.bind(this));
    html.find(".heat-pip").on("click", this._onHeatPip.bind(this));
    html.find(".crit-dot").on("click", this._onCritDot.bind(this));
    html.find(".crit-clear").on("click", this._onCritClear.bind(this));
    html.find(".crit-slot").on("contextmenu", this._onCritClear.bind(this));
    html.find(".crit-destroy").on("click", this._onCritDestroyToggle.bind(this));
    html.find(".crit-add-case").on("click", this._onAddCase.bind(this));
    // Make drop-zones feel responsive
    html.find(".drop-zone").on("dragover", (ev) => ev.preventDefault());
    html.find(".drop-zone").on("drop", (ev) => {
      ev.preventDefault();
      this._onDrop(ev.originalEvent ?? ev);
    });
  }

  async _onAddCase(event) {
    event.preventDefault();
    event.stopPropagation();

    const el = event.currentTarget;
    const loc = String(el?.dataset?.loc ?? "").toLowerCase();
    if (!loc) return;

    const techBase = mechTechBase;
    if (techBase === "clan") {
      ui?.notifications?.info?.("Clan CASE is automatic (no crit slots or tonnage).");
      return;
    }

    if (loc !== "lt" && loc !== "rt") {
      ui?.notifications?.warn?.("Inner Sphere CASE can only be installed in Left/Right Torso (LT/RT).");
      return;
    }

    // Ensure the location has an initialized crit slot array
    const init = _ensureCritSlotsInitUpdates(this.actor, loc);
    if (init) await this.actor.update(init);

    const slots = this.actor.system?.crit?.[loc]?.slots;
    const arr = Array.isArray(slots) ? slots : Object.values(slots ?? {});

    // Find first truly empty slot (no label and no uuid)
    let idx = -1;
    for (let i = 0; i < arr.length; i++) {
      const s = arr[i] ?? {};
      const label = String(s.label ?? "").trim();
      const uuid = String(s.uuid ?? s.itemUuid ?? "").trim();
      if (!label && !uuid) { idx = i; break; }
    }

    if (idx < 0) {
      ui?.notifications?.warn?.(`No empty crit slots in ${loc.toUpperCase()} for CASE.`);
      return;
    }

    await this.actor.update({
      [`system.crit.${loc}.slots.${idx}.label`]: "CASE",
      [`system.crit.${loc}.slots.${idx}.uuid`]: "",
      [`system.crit.${loc}.slots.${idx}.itemUuid`]: "",
      [`system.crit.${loc}.slots.${idx}.destroyed`]: false
    });
  }

  _onLoadoutDragStart(event) {
    try {
      const row = event.currentTarget;
      const ev = event?.originalEvent ?? event;
      const dt = ev?.dataTransfer ?? null;
      if (!dt) return;

      const macroUuid = String(row?.dataset?.macroUuid ?? "").trim();
      if (macroUuid) {
        const macroPayload = {
          type: "Macro",
          uuid: macroUuid
        };
        const macroData = JSON.stringify(macroPayload);
        dt.setData("text/plain", macroData);
        dt.setData("text/uri-list", macroUuid);
        dt.setData("application/json", macroData);
        dt.setData("text/json", macroData);
        dt.effectAllowed = "copyMove";
        return;
      }

      const uuid = String(row?.dataset?.itemUuid ?? "").trim();
      if (!uuid) return;

      const payload = {
        type: "Item",
        uuid
      };

      const data = JSON.stringify(payload);
      dt.setData("text/plain", data);
      dt.setData("application/json", data);
      // Foundry/BG3 HUD may prefer explicit JSON MIME types.
      dt.setData("text/json", data);
      // BG3 HUD sets dropEffect="move" on dragover; allow both to avoid a "no-drop" cursor.
      dt.effectAllowed = "copyMove";
    } catch (err) {
      console.warn("AToWMechSheet | Loadout drag start failed", err);
    }
  }

  async _primeLoadoutAttackMacros(html) {
    const ensureMacro = game?.[SYSTEM_ID]?.api?.ensureWeaponAttackMacro ?? null;
    if (typeof ensureMacro !== "function") return;

    const tokenDoc =
      this.token?.document ??
      this.actor?.getActiveTokens?.(true, true)?.[0]?.document ??
      this.actor?.getActiveTokens?.()?.[0]?.document ??
      null;

    const rows = Array.from(html.find(".we-row[data-item-uuid][data-weapon-fire-key]") ?? []);
    for (const row of rows) {
      const itemUuid = String(row?.dataset?.itemUuid ?? "").trim();
      const weaponFireKey = String(row?.dataset?.weaponFireKey ?? "").trim();
      if (!itemUuid || !weaponFireKey) continue;

      const name = String(row.querySelector?.(".we-name")?.textContent ?? "").trim() || "Weapon";
      const loc = String(row.querySelector?.(".we-col.loc")?.textContent ?? "").trim();
      const label = loc ? `${name} (${loc})` : name;
      let macroImg = "icons/svg/dice-target.svg";
      try {
        const weaponDoc = await fromUuid(itemUuid);
        const resolvedImg = String(weaponDoc?.img ?? weaponDoc?.texture?.src ?? "").trim();
        if (resolvedImg) macroImg = resolvedImg;
      } catch (_) {}

      const macro = await ensureMacro({
        label,
        img: macroImg,
        actorId: this.actor?.id ?? null,
        tokenId: tokenDoc?.id ?? null,
        itemUuid,
        weaponFireKey,
        defaultSide: "front"
      });

      if (macro?.uuid) {
        row.dataset.macroUuid = macro.uuid;
      }
    }
  }

  async _onHeaderActionClick(event) {
    event?.preventDefault?.();
    const action = String(event?.currentTarget?.dataset?.headerAction ?? "").trim();
    if (!action) return;

    await this._executeHeaderAction(action);
  }

  _onHeaderActionDragStart(event) {
    try {
      const button = event.currentTarget;
      const action = String(button?.dataset?.headerAction ?? "").trim();
      if (!action) return;

      const ev = event?.originalEvent ?? event;
      const dt = ev?.dataTransfer ?? null;
      if (!dt) return;

      const macroUuid = String(button?.dataset?.macroUuid ?? "").trim();
      const payload = macroUuid
        ? {
            type: "Macro",
            uuid: macroUuid
          }
        : {
            type: "ATOWHeaderAction",
            action,
            label: String(button?.dataset?.macroLabel ?? button?.textContent ?? action).trim(),
            img: String(button?.dataset?.macroImg ?? "icons/svg/dice-target.svg").trim(),
            actorId: this.actor?.id ?? null,
            tokenId:
              this.token?.document?.id ??
              this.token?.id ??
              this.actor?.getActiveTokens?.(true, true)?.[0]?.document?.id ??
              this.actor?.getActiveTokens?.()?.[0]?.document?.id ??
              null
          };

      const data = JSON.stringify(payload);
      dt.setData("text/plain", data);
      dt.setData("application/json", data);
      dt.setData("text/json", data);
      dt.effectAllowed = "copyMove";
    } catch (err) {
      console.warn("AToWMechSheetV2 | Header action drag start failed", err);
    }
  }

  async _primeHeaderActionMacros(html) {
    const ensureMacro = game?.[SYSTEM_ID]?.api?.ensureHeaderActionMacro ?? null;
    if (typeof ensureMacro !== "function") return;

    const tokenDoc =
      this.token?.document ??
      this.actor?.getActiveTokens?.(true, true)?.[0]?.document ??
      this.actor?.getActiveTokens?.()?.[0]?.document ??
      null;

    const buttons = Array.from(html.find(".header-action-btn[data-header-action]") ?? []);
    for (const button of buttons) {
      const action = String(button?.dataset?.headerAction ?? "").trim();
      if (!action) continue;

      const macro = await ensureMacro({
        action,
        label: String(button?.dataset?.macroLabel ?? button?.textContent ?? action).trim(),
        img: String(button?.dataset?.macroImg ?? "icons/svg/dice-target.svg").trim(),
        actorId: this.actor?.id ?? null,
        tokenId: tokenDoc?.id ?? null
      });

      if (macro?.uuid) {
        button.dataset.macroUuid = macro.uuid;
      }
    }
  }

  async _executeHeaderAction(action) {
    const execute =
      game?.[SYSTEM_ID]?.api?.executeHeaderAction ??
      game?.[SYSTEM_ID]?.api?.runHeaderActionMacro ??
      null;

    if (typeof execute !== "function") {
      ui.notifications?.warn?.("This header action is not available right now.");
      return false;
    }

    const tokenDoc =
      this.token?.document ??
      this.actor?.getActiveTokens?.(true, true)?.[0]?.document ??
      this.actor?.getActiveTokens?.()?.[0]?.document ??
      null;

    const ok = await execute({
      action,
      actorId: this.actor?.id ?? null,
      tokenId: tokenDoc?.id ?? null
    });

    if (ok) this.render(false);
    return ok;
  }

  /** @override */
  async _onDrop(event) {
  const zone = event.target.closest(".drop-zone")?.dataset?.dropZone;

  // If it’s not one of our zones, let Foundry handle it normally.
  if (zone !== "loadout" && zone !== "crit") return super._onDrop(event);

  const data = TextEditor.getDragEventData(event);
  if (data?.type !== "Item") return;

  // Resolve the dropped Item document
  let dropped = null;
  try {
    if (data.uuid) dropped = await fromUuid(data.uuid);
    else if (data.data) dropped = new Item(data.data);
  } catch (err) {
    console.warn("AToWMechSheet | Drop resolve failed", err);
    return;
  }
  if (!dropped) return;

  
// Crit-slot drop: store a reference + label.
// If the item declares a crit slot size (e.g. system.critSlots), fill adjacent slots as a single component.
if (zone === "crit") {
  const slotEl = event.target.closest(".crit-slot");
  const loc = slotEl?.dataset?.critLoc;
  const index = Number(slotEl?.dataset?.critIndex);
  if (!loc || Number.isNaN(index)) return;

  const droppedName = String(dropped?.name ?? "").trim();
  const isArtemis = /^artemis\s*iv\s*fcs$/i.test(droppedName);
  const isTSM = _TSM_LABEL_RE.test(droppedName);
  const isMASC = _MASC_LABEL_RE.test(droppedName);

  // Triple-Strength Myomer is Inner Sphere only
  if (isTSM) {
    const techBase = _getMechTechBase(this.actor, this.actor.system?.mech?.engine ?? null);
    if (techBase !== "inner") {
      ui?.notifications?.warn?.("Triple-Strength Myomer can only be installed on Inner Sphere 'Mechs.");
      return;
    }
  }

  const _countStartSlotsInLoc = (testFn) => {
    const locData = this.actor.system?.crit?.[loc]?.slots ?? [];
    const slots = Array.isArray(locData) ? locData : Object.values(locData);
    let n = 0;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i] ?? {};
      if (s.partOf !== undefined && s.partOf !== null) continue;
      if (Boolean(s.destroyed)) continue;
      const label = String(s.label ?? "").trim();
      if (!label) continue;
      if (testFn(label)) n += 1;
    }
    return n;
  };

  const launcherCount = _countStartSlotsInLoc((lbl) => /\b(lrm|srm|mrm)\s*[-]?\s*\d+\b/i.test(lbl) && !/\bstreak\s*srm\b/i.test(lbl) && !/\bammo\b/i.test(lbl));
  const artemisCount = _countStartSlotsInLoc((lbl) => /^artemis\s*iv\s*fcs$/i.test(lbl));

  if (isArtemis && launcherCount <= 0) {
    ui?.notifications?.warn?.("Artemis IV FCS must be installed in the same location as an LRM/SRM/MRM launcher.");
    return;
  }

  // If installing Artemis here, prevent exceeding the number of eligible launchers in this location.
  const storedHere = this.actor.system?.crit?.[loc]?.slots?.[index] ?? {};
  const startIndexCandidate = (storedHere?.partOf !== undefined && storedHere.partOf !== null) ? Number(storedHere.partOf) : index;
  const startSlot = this.actor.system?.crit?.[loc]?.slots?.[startIndexCandidate] ?? {};
  const replacingArtemis = /^artemis\s*iv\s*fcs$/i.test(String(startSlot?.label ?? "").trim());
  const projectedArtemis = isArtemis ? (artemisCount + (replacingArtemis ? 0 : 1)) : artemisCount;

  if (isArtemis && projectedArtemis > launcherCount) {
    ui?.notifications?.warn?.("This location already has enough Artemis IV FCS units for its missile launchers.");
    return;
  }

  let requested = Number(
    dropped.system?.critSlots ??
    dropped.system?.slots ??
    dropped.system?.crit?.slots ??
    dropped.system?.crit?.slotCount ??
    1
  );
  if (isArtemis) requested = 1;
  if (isTSM) requested = 1; // TSM is installed as six separate 1-slot components, distributed anywhere.

  // TSM and MASC are mutually exclusive.
  if (isTSM) {
    const mascPresent = countComponentCritSlots(this.actor.system, _MASC_LABEL_RE, { includeDestroyed: false }) > 0;
    if (mascPresent) {
      ui?.notifications?.warn?.("Triple-Strength Myomer cannot be installed alongside MASC.");
      return;
    }
  }

  if (isMASC) {
    const tsmPresent = countComponentCritSlots(this.actor.system, _TSM_LABEL_RE, { includeDestroyed: false }) > 0;
    if (tsmPresent) {
      ui?.notifications?.warn?.("MASC cannot be installed alongside Triple-Strength Myomer.");
      return;
    }
  }


  // Head + Legs have 6 crits. Most other locations have 12 (0-11).
  const locMax = (loc === "head" || loc === "ll" || loc === "rl") ? 6 : 12;

  // If dropping onto a continuation slot, redirect to the start slot.
  const existing = this.actor.system?.crit?.[loc]?.slots?.[index] ?? {};
  const startIndex = (existing?.partOf !== undefined && existing.partOf !== null) ? Number(existing.partOf) : index;

  const maxSpan = Math.max(1, locMax - startIndex);
  const span = clamp(Number.isNaN(requested) ? 1 : requested, 1, maxSpan);

  const updates = {};
  const mountId = createCritMountId();

  // Clear any existing component starting at startIndex (best-effort)
  const startExisting = this.actor.system?.crit?.[loc]?.slots?.[startIndex] ?? {};
  const existingSpan = clamp(Number(startExisting?.span ?? 1), 1, locMax - startIndex);
  for (let j = 0; j < existingSpan; j++) {
    const i = startIndex + j;
    updates[`system.crit.${loc}.slots.${i}.label`] = "";
    updates[`system.crit.${loc}.slots.${i}.uuid`] = "";
    updates[`system.crit.${loc}.slots.${i}.mountId`] = null;
    updates[`system.crit.${loc}.slots.${i}.span`] = 1;
    updates[`system.crit.${loc}.slots.${i}.partOf`] = null;
    updates[`system.crit.${loc}.slots.${i}.destroyed`] = false;
  }

  // Start slot
  updates[`system.crit.${loc}.slots.${startIndex}.label`] = dropped.name;
  updates[`system.crit.${loc}.slots.${startIndex}.uuid`] = dropped.uuid ?? data.uuid ?? "";
  updates[`system.crit.${loc}.slots.${startIndex}.mountId`] = mountId;
  updates[`system.crit.${loc}.slots.${startIndex}.span`] = span;
  updates[`system.crit.${loc}.slots.${startIndex}.partOf`] = null;
  updates[`system.crit.${loc}.slots.${startIndex}.destroyed`] = false;

  // Continuation slots (rendered, disabled)
  for (let j = 1; j < span; j++) {
    const i = startIndex + j;
    updates[`system.crit.${loc}.slots.${i}.label`] = dropped.name;
    updates[`system.crit.${loc}.slots.${i}.uuid`] = dropped.uuid ?? data.uuid ?? "";
    updates[`system.crit.${loc}.slots.${i}.mountId`] = mountId;
    updates[`system.crit.${loc}.slots.${i}.span`] = 1;
    updates[`system.crit.${loc}.slots.${i}.partOf`] = startIndex;
    updates[`system.crit.${loc}.slots.${i}.destroyed`] = false;
  }

  await this.actor.update(updates);
  return;
}
  // Loadout zone: only accept equipment/gear, and embed them on the mech.
  // Weapons should be installed via crit slots (they will auto-appear in the list).
  if (dropped.parent?.id === this.actor.id) return;

  if (_WEAPON_TYPES.has(dropped.type)) {
    ui.notifications?.info?.("Install weapons by dragging them into a crit slot.");
    return;
  }

  const allowed = new Set(["equipment", "gear"]);
  if (!allowed.has(dropped.type)) return;

  const obj = dropped.toObject();
  delete obj._id;
  await this.actor.createEmbeddedDocuments("Item", [obj]);
}


  // ------------------------------------------------------------
  // Tonnage -> derived structure + weight baselines
  // ------------------------------------------------------------
  async _ensureStructureFromTonnage() {
    if (this._atowTonnageSyncing) return;
    this._atowTonnageSyncing = true;
    try {
      await this._syncStructureFromTonnage();
    } finally {
      this._atowTonnageSyncing = false;
    }
  }

  async _ensureMovementFromEngine() {
    if (this._atowMoveSyncing) return;
    this._atowMoveSyncing = true;
    try {
      await this._syncMovementFromEngine();
    } finally {
      this._atowMoveSyncing = false;
    }
  }

  // Ensure XL engine side-torso crit slots are reserved (LT/RT 1-3 for IS XL, 1-2 for Clan XL).
  async _ensureXLEngineCrits(engineOverride = null) {
    if (this._atowXLSyncing) return;
    this._atowXLSyncing = true;
    try {
      await this._syncXLEngineCrits(engineOverride);
    } finally {
      this._atowXLSyncing = false;
    }
  }

  async _syncXLEngineCrits(engineOverride = null) {
    const updates = _buildXLEngineCritLabelUpdates(this.actor, engineOverride);
    if (updates && Object.keys(updates).length) {
      await this.actor.update(updates);
    }
  }

  async _syncCTCritLabels(enabledOverride = null, engineOverride = null, { warn = false } = {}) {
    await this._syncXLGyroCrits(enabledOverride, engineOverride, { warn });
  }

  async _syncXLGyroCrits(enabledOverride = null, engineOverride = null, { warn = true } = {}) {
    const { updates, blocked } = _buildXLGyroCritLabelUpdates(this.actor, enabledOverride, engineOverride);
    if (Object.keys(updates).length) await this.actor.update(updates);

    if (warn && blocked.length) {
      const slots = blocked.join(", ");
      ui.notifications?.warn?.(`Could not update occupied/custom CT crit slot(s): ${slots}.`);
      console.warn(`AToWMechSheetV2 | CT crit label update blocked for ${this.actor?.name ?? "actor"}: ${slots}`);
    }
  }

  async _onXLGyroChange(event) {
    event?.preventDefault?.();
    const input = event?.currentTarget;
    const enabled = Boolean(input?.checked);

    await this.actor.update({ "system.mech.xlGyro": enabled });
    await this._syncXLGyroCrits(enabled);
  }

  async _onTechBaseChange(event) {
    event?.preventDefault?.();
    await this._ensureXLEngineCrits();
  }


  async _onEngineChange(event) {
    event?.preventDefault?.();
    const raw = event?.currentTarget?.value;
    await this._syncMovementFromEngine(null, raw);
    await this._ensureXLEngineCrits(raw);
    await this._syncCTCritLabels(null, raw, { warn: true });
  }

  async _syncMovementFromEngine(tonnageOverride = null, engineOverride = null) {
    const current = this.actor.system ?? {};
    const tonnage = normalizeMechTonnage(tonnageOverride ?? current?.mech?.tonnage);
    const engine = engineOverride ?? current?.mech?.engine;

    const jumpJetInstalledCount = await countJumpJetComponentsFromCritSlots(this.actor);

    const derived = computeDerivedMovement(engine, tonnage, { jumpJetCount: jumpJetInstalledCount });
    if (!derived) return;

    const updates = {};
    if (Number(current?.movement?.walk) !== Number(derived.walk)) updates["system.movement.walk"] = Number(derived.walk);
    if (Number(current?.movement?.run) !== Number(derived.run)) updates["system.movement.run"] = Number(derived.run);
    if (Number(current?.movement?.jump) !== Number(derived.jump)) updates["system.movement.jump"] = Number(derived.jump);

    if (Object.keys(updates).length) {
      await this.actor.update(updates);
    }
  }


  async _onTonnageChange(event) {
    event?.preventDefault?.();

    const raw = event?.currentTarget?.value;
    const tonnage = normalizeMechTonnage(raw);

    // Update immediately so structure max pips are correct, without needing a manual sheet save.
    await this._syncStructureFromTonnage(tonnage);
  }

  async _syncStructureFromTonnage(tonnageOverride = null) {
    const current = this.actor.system ?? {};
    const tonnage = normalizeMechTonnage(tonnageOverride ?? current?.mech?.tonnage);
    const profile = getStructureProfileForTonnage(tonnage);

    const updates = {};

    // Store normalized tonnage + max armor (so other places can read it)
    if (Number(current?.mech?.tonnage) !== tonnage) updates["system.mech.tonnage"] = tonnage;
    if (Number(current?.mech?.maxArmor) !== Number(profile.maxArmor)) updates["system.mech.maxArmor"] = Number(profile.maxArmor);

    // Weight baselines
    const techBase = _getMechTechBase(this.actor, current?.mech?.engine ?? null);
    const endoSlots = countEndoSteelCritSlots(this.actor?.system ?? {});
    const endoNeeded = (techBase === "clan") ? 7 : 14;

    const structureTonsStd = getStandardStructureTonnage(tonnage);
    const structureTonsEndo = getEndoSteelStructureTonnage(tonnage);
    const structureTons = (endoSlots >= endoNeeded) ? structureTonsEndo : structureTonsStd;
    if (Number(current?.weight?.max) !== tonnage) updates["system.weight.max"] = tonnage;
    if (Number(current?.weight?.structure) !== structureTons) updates["system.weight.structure"] = structureTons;

    // Structure maxima + clamp dmg if needed
    for (const [loc, max] of Object.entries(profile.structure)) {
      const curMax = Number(current?.structure?.[loc]?.max ?? 0);
      const curDmg = Number(current?.structure?.[loc]?.dmg ?? 0);

      if (curMax !== Number(max)) updates[`system.structure.${loc}.max`] = Number(max);
      if (curDmg > Number(max)) updates[`system.structure.${loc}.dmg`] = Number(max);
    }

    
    // Movement derived from engine rating + (possibly changed) tonnage.
    const jumpJetInstalledCount = await countJumpJetComponentsFromCritSlots(this.actor);
    const derivedMove = computeDerivedMovement(current?.mech?.engine, tonnage, { jumpJetCount: jumpJetInstalledCount });
    if (derivedMove) {
      if (Number(current?.movement?.walk) !== Number(derivedMove.walk)) updates["system.movement.walk"] = Number(derivedMove.walk);
      if (Number(current?.movement?.run) !== Number(derivedMove.run)) updates["system.movement.run"] = Number(derivedMove.run);
      if (Number(current?.movement?.jump) !== Number(derivedMove.jump)) updates["system.movement.jump"] = Number(derivedMove.jump);
    }

if (Object.keys(updates).length) {
      await this.actor.update(updates);
    }
  }

  _onWeaponRowClick(event) {
    // Left click launches attack; ignore clicks on controls.
    if (event?.button === 2) return;
    if (event.target?.closest?.(".we-attack, .item-delete")) return;
    return this._onWeaponAttack(event);
  }

  _onWeaponRowContext(event) {
    // Right click opens sheet (if any); ignore if clicking controls.
    if (event.target?.closest?.(".we-attack, .item-delete")) return;
    event.preventDefault();
    const row = event.currentTarget;
    const uuid = String(row?.dataset?.itemUuid ?? "").trim();
    if (uuid) {
      fromUuid(uuid).then((doc) => doc?.sheet?.render(true)).catch(() => {});
      return;
    }
    const itemId = String(row?.dataset?.itemId ?? "").trim();
    if (!itemId) return;
    const item = this.actor.items.get(itemId);
    if (item) item.sheet.render(true);
  }

  async _onAmmoBinCurrentChange(event) {
    event?.preventDefault?.();

    const input = event?.currentTarget;
    const rawName = String(input?.name ?? "").trim();
    const match = rawName.match(/^system\.ammoBins\.([^.]+)\.current$/);
    if (!match?.[1]) return;

    const key = String(match[1]);
    const total = Number(input?.max ?? this.actor?.system?.ammoBins?.[key]?.total ?? 0) || 0;
    const rawValue = Number(input?.value ?? 0);
    const next = Math.max(0, Math.min(total > 0 ? total : rawValue, Number.isFinite(rawValue) ? rawValue : 0));

    if (input) input.value = String(next);

    await this.actor.update({
      [`system.ammoBins.${key}.current`]: next
    });
  }

  async _onPilotSkillChange(event) {
    event?.preventDefault?.();

    const input = event?.currentTarget;
    const rawName = String(input?.name ?? "").trim();
    if (!["system.pilot.gunnery", "system.pilot.piloting"].includes(rawName)) return;

    const rawValue = Number(input?.value ?? 0);
    const next = Number.isFinite(rawValue) ? rawValue : 0;
    if (input) input.value = String(next);

    await this.actor.update({
      [rawName]: next
    });
  }

  async _onHeatValueChange(event) {
    event?.preventDefault?.();

    const input = event?.currentTarget;
    const rawValue = Number(input?.value ?? 0);
    const next = Math.max(0, Number.isFinite(rawValue) ? rawValue : 0);
    const max = Number(this.actor?.system?.heat?.max ?? 30) || 30;
    const computeHeatEffects = game?.[SYSTEM_ID]?.api?.computeHeatEffects ?? null;
    const priorShutdownInfo = this.actor?.system?.heat?.effects?.shutdown ?? {};
    const effects = (typeof computeHeatEffects === "function")
      ? computeHeatEffects(next)
      : {
          unvented: next,
          movePenalty: 0,
          fireMod: 0,
          shutdownAuto: false,
          shutdownAvoidTN: null
        };

    if (input) input.value = String(next);

    await this.actor.update({
      "system.heat.value": next,
      "system.heat.current": next,
      "system.heat.max": max,
      "system.heat.unvented": next,
      "system.heat.dissipation": Number(this.actor?.system?.heat?.dissipation ?? 0) || 0,
      "system.heat.effects.unvented": next,
      "system.heat.effects.movePenalty": Number(effects.movePenalty ?? 0) || 0,
      "system.heat.effects.fireMod": Number(effects.fireMod ?? 0) || 0,
      "system.heat.effects.shutdown": {
        ...priorShutdownInfo,
        heat: next,
        active: Boolean(this.actor?.system?.heat?.shutdown)
      }
    });
  }

  async _onBattleMechDataFieldChange(event) {
    event?.preventDefault?.();

    const input = event?.currentTarget;
    const rawName = String(input?.name ?? "").trim();
    const allowed = new Set([
      "system.mech.chassis",
      "system.mech.model",
      "system.mech.bv",
      "system.mech.yearProduced",
      "system.mech.techBase",
      "system.mech.rulesLevel",
      "system.mech.role",
      "system.mech.engine"
    ]);
    if (!allowed.has(rawName)) return;

    if (rawName === "system.mech.bv" || rawName === "system.mech.yearProduced") {
      const numeric = Number(input?.value ?? 0);
      const next = Math.max(0, Number.isFinite(numeric) ? Math.floor(numeric) : 0);
      if (input) input.value = String(next);
      await this.actor.update({
        [rawName]: next
      });
      return;
    }

    await this.actor.update({
      [rawName]: String(input?.value ?? "")
    });
  }

  async _onHeatSinkModeChange(event) {
    event?.preventDefault?.();

    const input = event?.currentTarget;
    const next = Boolean(input?.checked);
    await this.actor.update({
      "system.heat.isDouble": next
    });
  }

  async _onArmorMaxChange(event) {
    event?.preventDefault?.();

    const input = event?.currentTarget;
    const rawName = String(input?.name ?? "").trim();
    const match = rawName.match(/^system\.armor\.([^.]+)\.max$/);
    if (!match?.[1]) return;

    const loc = String(match[1]);
    const rawValue = Number(input?.value ?? 0);
    const nextMax = Math.max(0, Number.isFinite(rawValue) ? rawValue : 0);
    const currentDmg = Number(this.actor?.system?.armor?.[loc]?.dmg ?? 0) || 0;
    const nextDmg = Math.min(currentDmg, nextMax);

    if (input) input.value = String(nextMax);

    await this.actor.update({
      [`system.armor.${loc}.max`]: nextMax,
      [`system.armor.${loc}.dmg`]: nextDmg
    });
  }

  async _onItemDelete(event) {
    event.preventDefault();
    const li = event.currentTarget.closest("[data-item-id]");
    const itemId = li?.dataset?.itemId;
    if (!itemId) return;
    await this.actor.deleteEmbeddedDocuments("Item", [itemId]);
  }



  async _onWeaponAttack(event) {
    if (isMechDestroyed(this.actor)) {
      ui.notifications?.warn?.(`${this.actor.name} is DESTROYED and cannot attack.`);
      return;
    }

    event.preventDefault();
    const li = event.currentTarget.closest(".we-row") ?? event.currentTarget.closest("[data-item-id]");
    const destroyed = String(li?.dataset?.destroyed ?? "").toLowerCase() === "true";
    if (destroyed) {
      ui.notifications?.warn?.("That weapon is destroyed.");
      return;
    }

    // --- Synthetic melee entries (Punch/Kick) ---
    // These appear in the weapons list but are not embedded Items, so they won't have a resolvable UUID.
    const itemId = String(li?.dataset?.itemId ?? "").trim();
    const meleeType = String(li?.dataset?.meleeType ?? "").trim().toLowerCase()
      || (itemId.startsWith("melee-") ? itemId.replace(/^melee-/, "") : "");
    if (meleeType === "punch" || meleeType === "kick") {
      await promptAndRollMeleeAttack(this.actor, meleeType, { defaultSide: "front" });
      return;
    }

    const weaponFireKey = String(li?.dataset?.weaponFireKey ?? "").trim() || itemId;
    const uuid = String(li?.dataset?.itemUuid ?? "").trim();
    if (uuid) {
      const weapon = await fromUuid(uuid);
      if (!weapon) return;
      if (!_WEAPON_TYPES.has(weapon.type)) return;
      await promptAndRollWeaponAttack(this.actor, weapon, { defaultSide: "front", weaponFireKey });
      return;
    }

    if (!itemId) return;
    const weapon = this.actor.items.get(itemId);
    if (!weapon) return;
    if (!_WEAPON_TYPES.has(weapon.type)) return;
    await promptAndRollWeaponAttack(this.actor, weapon, { defaultSide: "front", weaponFireKey });
  }


  async _onRoll(event) {
if (isMechDestroyed(this.actor)) {
  ui.notifications?.warn?.(`${this.actor.name} is DESTROYED and cannot act.`);
  return;
}

    event.preventDefault();
    const el = event.currentTarget;
    const formula = el.dataset.formula;
    const label = el.dataset.label ?? "Roll";
    if (!formula) return;

    // Roll data: expose pilot and system for @pilot.* lookups
    const rollData = {
      pilot: this.actor.system?.pilot ?? {},
      system: this.actor.system ?? {}
    };

    const roll = await (new Roll(formula, rollData)).evaluate();
    roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: this.actor }),
      flavor: label
    });
  }

  async _onTrackBox(event) {
    event.preventDefault();
    const el = event.currentTarget;
    const track = el.dataset.track;
    const value = el.dataset.value;
    if (!track) return;

    if (track === "hitsTaken") {
      const v = Number(value);
      if (Number.isNaN(v)) return;
      await this.actor.update({ "system.pilot.hitsTaken": v });
      return;
    }

    if (track === "consciousness") {
      // store as string or number; keep string for "Dead"
      const v = value;
      await this.actor.update({ "system.pilot.consciousness": v });
      return;
    }
  }

  async _onArmorPip(event) {
  event.preventDefault();
  const el = event.currentTarget;
  const loc = el.dataset.loc;
  const pip = Number(el.dataset.pip);
  if (!loc || Number.isNaN(pip)) return;

  const armorLoc = this.actor.system?.armor?.[loc] ?? {};
  const max = Number(armorLoc.max ?? 0);
  const current = Number(armorLoc.dmg ?? 0);

  let next = pip;
  if (pip <= current) next = Math.max(0, pip - 1);
  next = clamp(next, 0, max);

  await this.actor.update({ [`system.armor.${loc}.dmg`]: next });
}

  async _onStructurePip(event) {
    event.preventDefault();
    const el = event.currentTarget;
    const loc = el.dataset.loc;
    const pip = Number(el.dataset.pip);
    if (!loc || Number.isNaN(pip)) return;

    const structLoc = this.actor.system?.structure?.[loc] ?? {};
    const max = Number(structLoc.max ?? 0);
    const current = Number(structLoc.dmg ?? 0);

    let next = pip;
    if (pip <= current) next = Math.max(0, pip - 1);
    next = clamp(next, 0, max);

    await this.actor.update({ [`system.structure.${loc}.dmg`]: next });
  }


  async _onHeatPip(event) {
    event.preventDefault();
    const el = event.currentTarget;
    const pip = Number(el.dataset.pip);
    if (Number.isNaN(pip)) return;

    const heat = this.actor.system?.heat ?? {};
    const max = Number(heat.max ?? 30);
    const current = Number((heat.value ?? heat.current) ?? 0);

    let next = pip;
    if (pip <= current) next = Math.max(0, pip - 1);
    next = clamp(next, 0, max);

    await this.actor.update({ "system.heat.value": next, "system.heat.current": next, "system.heat.max": max });
  }

  async _onCritDot(event) {
  event.preventDefault();
  const el = event.currentTarget;
  const track = el.dataset.critHit;
  const value = Number(el.dataset.critValue);
  if (!track || Number.isNaN(value)) return;

  const current = Number(this.actor.system?.critHits?.[track] ?? 0);
  let next = value;
  if (value <= current) next = Math.max(0, value - 1);

  await this.actor.update({ [`system.critHits.${track}`]: next });
}




async _onCritDestroyToggle(event) {
  event.preventDefault();
  event.stopPropagation();

  const slotEl = event.target.closest(".crit-slot");
  if (!slotEl) return;

  const loc = slotEl.dataset.critLoc;
  const index = Number(slotEl.dataset.critIndex);
  if (!loc || Number.isNaN(index)) return;

  // Toggle destroyed on THIS slot only.
  // This allows multi-slot components to be crit on any occupied crit location,
  // and crit locations remain valid targets even if other slots are already destroyed.
  const cur = Boolean(this.actor.system?.crit?.[loc]?.slots?.[index]?.destroyed);
  const next = !cur;

  await this.actor.update({ [`system.crit.${loc}.slots.${index}.destroyed`]: next });
}

async _onCritClear(event) {
  event.preventDefault();

  const slotEl = event.target.closest(".crit-slot");
  if (!slotEl) return;

  const loc = slotEl.dataset.critLoc;
  const index = Number(slotEl.dataset.critIndex);
  if (!loc || Number.isNaN(index)) return;

  const slots = this.actor.system?.crit?.[loc]?.slots ?? {};
  const stored = slots?.[index] ?? {};
  const startIndex = (stored?.partOf !== undefined && stored.partOf !== null) ? Number(stored.partOf) : index;

  const start = slots?.[startIndex] ?? {};
  const hasUuid = Boolean(start.uuid);
  // Don't allow clearing default lines unless something was actually installed (uuid is present)
  if (!hasUuid) return;

  const locMax = (loc === "head" || loc === "ll" || loc === "rl") ? 6 : 12;
  const span = clamp(Number(start.span ?? 1), 1, locMax - startIndex);

  const updates = {};
  for (let j = 0; j < span; j++) {
    const i = startIndex + j;
    updates[`system.crit.${loc}.slots.${i}.label`] = "";
    updates[`system.crit.${loc}.slots.${i}.uuid`] = "";
    updates[`system.crit.${loc}.slots.${i}.mountId`] = null;
    updates[`system.crit.${loc}.slots.${i}.span`] = 1;
    updates[`system.crit.${loc}.slots.${i}.partOf`] = null;
    updates[`system.crit.${loc}.slots.${i}.destroyed`] = false;
  }

  await this.actor.update(updates);
}
}
