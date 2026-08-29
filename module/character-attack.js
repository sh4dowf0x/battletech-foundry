// systems/atow-battletech/module/character-attack.js
// Centralized personal-scale character attack logic and automation.

import { canSpendCharacterAction, getCharacterActionState, refundCharacterAction, spendCharacterAction } from "./character-combat.js";
import { getCharacterWeaponResourceProfile } from "./character-weapon-types.js";
import { getCharacterPowerPackCapacity, getSelectedCharacterPowerPack } from "./character-power.js";
import { NATURAL_APTITUDE_DICE_FORMULA, getActiveNaturalAptitude } from "./natural-aptitude.js";

const SYSTEM_ID = "atow-battletech";
const CHARACTER_ATTACK_TEMPLATE = `systems/${SYSTEM_ID}/templates/character-attack.hbs`;

export const CHARACTER_DAMAGE_TYPES = Object.freeze({
  M: "Melee",
  B: "Ballistic",
  E: "Energy",
  X: "Explosive"
});

export const CHARACTER_ATTACK_TYPES = Object.freeze({
  RANGED: "ranged",
  MELEE: "melee"
});

// These alter the character's 2d6 result, not the target number.
export const CHARACTER_ATTACK_MOVEMENT_MODIFIERS = Object.freeze({
  stationary: 0,
  walk: -1,
  run: -2,
  crawl: -2,
  swim: -2,
  // Attack rules for these modes have not yet been supplied.
  sprint: 0,
  climb: 0
});

export const CHARACTER_ATTACK_RANGE_MODIFIERS = Object.freeze({
  pointBlank: 1,
  short: 0,
  medium: -2,
  long: -4,
  extreme: -6
});

export const CHARACTER_TARGET_MOVEMENT_MODIFIERS = Object.freeze([
  Object.freeze({ minimum: 151, modifier: -5 }),
  Object.freeze({ minimum: 106, modifier: -4 }),
  Object.freeze({ minimum: 76, modifier: -3 }),
  Object.freeze({ minimum: 46, modifier: -2 }),
  Object.freeze({ minimum: 10, modifier: -1 })
]);

export const CHARACTER_COVER_MODIFIERS = Object.freeze({
  "light-cover": Object.freeze({ label: "Light Cover", modifier: -1 }),
  "moderate-cover": Object.freeze({ label: "Moderate Cover", modifier: -2 }),
  "heavy-cover": Object.freeze({ label: "Heavy Cover", modifier: -3 }),
  "full-cover": Object.freeze({ label: "Full Cover", modifier: -4 })
});

const WEAPON_SKILLS = Object.freeze({
  melee: Object.freeze({ label: "Melee", tiedSkill: "Melee Weapons", attackType: CHARACTER_ATTACK_TYPES.MELEE }),
  archery: Object.freeze({ label: "Archery", tiedSkill: "Archery", attackType: CHARACTER_ATTACK_TYPES.RANGED }),
  thrown: Object.freeze({ label: "Thrown", tiedSkill: "Thrown Weapons", attackType: CHARACTER_ATTACK_TYPES.RANGED }),
  smallArms: Object.freeze({ label: "Small Arms", tiedSkill: "Small Arms", attackType: CHARACTER_ATTACK_TYPES.RANGED }),
  support: Object.freeze({ label: "Support", tiedSkill: "Support Weapons", attackType: CHARACTER_ATTACK_TYPES.RANGED })
});

const SKILL_XP_TO_RANK = Object.freeze([
  { xp: 20, rank: 0 }, { xp: 30, rank: 1 }, { xp: 50, rank: 2 },
  { xp: 80, rank: 3 }, { xp: 120, rank: 4 }, { xp: 170, rank: 5 },
  { xp: 230, rank: 6 }, { xp: 300, rank: 7 }, { xp: 380, rank: 8 },
  { xp: 470, rank: 9 }, { xp: 570, rank: 10 }
]);

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampTrackValue(value, maximum) {
  const next = Math.max(0, num(value, 0));
  const max = Math.max(0, num(maximum, 0));
  return max > 0 ? Math.min(max, next) : next;
}

/** Parse a personal-scale weapon's AP type and base Body Damage. */
export function parseCharacterWeaponDamage(weaponOrSystem = {}) {
  const system = weaponOrSystem?.system ?? weaponOrSystem;
  const combined = String(system.apbd ?? system.apBd ?? system.apBD ?? "").trim();
  const combinedParts = combined.includes("/") ? combined.split("/", 2) : [];
  const directAp = String(system?.damage?.ap ?? system.ap ?? "").trim();
  const directBd = String(system?.damage?.bd ?? system.bd ?? system.baseDamage ?? "").trim();
  const rawAp = directAp || String(combinedParts[0] ?? "").trim();
  const rawBd = directBd || String(combinedParts[1] ?? "").trim();
  const apMatch = rawAp.match(/^(\d+(?:\.\d+)?)\s*([MBEX])$/i);
  const bodyDamage = Number(rawBd);
  const armorPenetration = apMatch ? Number(apMatch[1]) : NaN;
  const damageType = apMatch?.[2]?.toUpperCase() ?? "";
  const valid = Number.isFinite(armorPenetration)
    && armorPenetration >= 0
    && Boolean(CHARACTER_DAMAGE_TYPES[damageType])
    && Number.isFinite(bodyDamage)
    && bodyDamage >= 0;
  return {
    valid,
    rawAp,
    rawBd,
    armorPenetration: valid ? armorPenetration : 0,
    damageType: valid ? damageType : "",
    damageTypeLabel: valid ? CHARACTER_DAMAGE_TYPES[damageType] : "Unknown",
    bodyDamage: valid ? bodyDamage : 0
  };
}

function getEquippedCharacterArmor(actor) {
  return Array.from(actor?.items?.contents ?? actor?.items ?? [])
    .filter(item => item?.type === "characterArmor" && Boolean(item?.system?.equipped));
}

/**
 * Until personal hit locations are implemented, use the best applicable BAR
 * among the target's equipped armor pieces.
 */
export function getCharacterArmorProtection(actor, damageType) {
  const key = String(damageType ?? "").trim().toLowerCase();
  const candidates = getEquippedCharacterArmor(actor).map(item => ({
    item,
    bar: Math.max(0, num(item?.system?.bar?.[key], 0))
  }));
  const maximum = candidates.reduce((highest, entry) => Math.max(highest, entry.bar), 0);
  const protecting = candidates.filter(entry => entry.bar === maximum && entry.bar > 0);
  return {
    bar: maximum,
    armorIds: protecting.map(entry => entry.item.id),
    armorNames: protecting.map(entry => entry.item.name),
    armorName: protecting.map(entry => entry.item.name).join(", ") || "Unarmored"
  };
}

/** Calculate standard (non-burst) Body Damage from base BD and Margin of Success. */
export function calculateCharacterBodyDamage(baseDamage, marginOfSuccess, { burstFire = false } = {}) {
  const base = Math.max(0, num(baseDamage, 0));
  if (burstFire) return Math.floor(base);
  const margin = Math.max(0, Math.floor(num(marginOfSuccess, 0)));
  return Math.floor(base * (1 + (margin * 0.25)));
}

async function resolveActorFromUuid(actorUuid) {
  if (!actorUuid) return null;
  try {
    const document = await fromUuid(actorUuid);
    return document?.documentName === "Actor" ? document : null;
  } catch (_) {
    return null;
  }
}

/**
 * SocketLib GM handler for personal-scale damage.
 * Armor penetration is binary: AP must equal or exceed the applicable BAR.
 */
export async function gmApplyCharacterAttackDamage(targetActorUuid, damageData = {}) {
  if (!game.user?.isGM) return { ok: false, reason: "Character damage resolution requires a GM." };
  const targetActor = await resolveActorFromUuid(targetActorUuid);
  if (!targetActor) return { ok: false, reason: "No target actor." };
  if (!targetActor.system?.health || !targetActor.system?.fatigue) {
    return { ok: false, reason: `${targetActor.name} does not use personal-scale Health and Fatigue tracks.` };
  }

  const armorPenetration = Math.max(0, num(damageData.armorPenetration, 0));
  const damageType = String(damageData.damageType ?? "").trim().toUpperCase();
  const baseDamage = Math.max(0, num(damageData.bodyDamage, 0));
  const marginOfSuccess = Math.max(0, Math.floor(num(damageData.marginOfSuccess, 0)));
  if (!CHARACTER_DAMAGE_TYPES[damageType]) return { ok: false, reason: "The weapon has no valid AP damage type." };
  if (baseDamage <= 0) return { ok: false, reason: "The weapon has no valid Body Damage value." };

  const armor = getCharacterArmorProtection(targetActor, damageType);
  const penetrated = armorPenetration >= armor.bar;
  if (!penetrated) {
    return {
      ok: true,
      penetrated: false,
      targetActorUuid,
      targetName: targetActor.name,
      armorPenetration,
      damageType,
      damageTypeLabel: CHARACTER_DAMAGE_TYPES[damageType],
      armor,
      bodyDamage: 0,
      fatigueDamage: 0,
      marginOfSuccess
    };
  }

  const requestedDamage = calculateCharacterBodyDamage(baseDamage, marginOfSuccess, {
    burstFire: Boolean(damageData.burstFire)
  });
  if (requestedDamage <= 0) {
    return {
      ok: true,
      penetrated: true,
      targetActorUuid,
      targetName: targetActor.name,
      armorPenetration,
      damageType,
      damageTypeLabel: CHARACTER_DAMAGE_TYPES[damageType],
      armor,
      bodyDamage: 0,
      fatigueDamage: 0,
      marginOfSuccess
    };
  }

  const healthBefore = Math.max(0, num(targetActor.system?.health?.value, 0));
  const fatigueBefore = Math.max(0, num(targetActor.system?.fatigue?.value, 0));
  const healthAfter = clampTrackValue(healthBefore + requestedDamage, targetActor.system?.health?.max);
  const fatigueAfter = clampTrackValue(fatigueBefore + 1, targetActor.system?.fatigue?.max);
  await targetActor.update({
    "system.health.value": healthAfter,
    "system.fatigue.value": fatigueAfter
  });

  return {
    ok: true,
    penetrated: true,
    targetActorUuid,
    targetName: targetActor.name,
    armorPenetration,
    damageType,
    damageTypeLabel: CHARACTER_DAMAGE_TYPES[damageType],
    armor,
    baseDamage,
    bodyDamage: Math.max(0, healthAfter - healthBefore),
    requestedBodyDamage: requestedDamage,
    fatigueDamage: Math.max(0, fatigueAfter - fatigueBefore),
    marginOfSuccess,
    healthBefore,
    healthAfter,
    fatigueBefore,
    fatigueAfter
  };
}

export function registerATOWCharacterAttackSockets(existingSocket = null) {
  const socketlibApi = globalThis.socketlib;
  if (!existingSocket && !socketlibApi?.registerSystem) {
    console.warn(`${SYSTEM_ID} | socketlib is not available; GM character damage automation is disabled.`);
    return null;
  }
  const socket = existingSocket ?? socketlibApi.registerSystem(SYSTEM_ID);
  if (!socket) return null;
  if (!socket.functions?.has?.("gmApplyCharacterAttackDamage")) {
    socket.register("gmApplyCharacterAttackDamage", gmApplyCharacterAttackDamage);
  }
  game[SYSTEM_ID] = game[SYSTEM_ID] ?? {};
  game[SYSTEM_ID].socket = socket;
  return socket;
}

async function applyCharacterAttackDamageAsGM(targetActor, damageData) {
  if (!targetActor) return { ok: false, reason: "No target actor." };
  if (game.user?.isGM) return gmApplyCharacterAttackDamage(targetActor.uuid, damageData);
  const socket = game?.[SYSTEM_ID]?.socket;
  if (!socket) return { ok: false, reason: "AToW SocketLib connection is not ready." };
  return socket.executeAsGM("gmApplyCharacterAttackDamage", targetActor.uuid, damageData);
}

export function getCharacterWeaponMagazine(weapon) {
  const sys = weapon?.system ?? {};
  const resources = getCharacterWeaponResourceProfile(weapon);
  if (!resources.usesAmmo) {
    return { tracked: false, current: 0, maximum: 0, display: "—" };
  }
  const storedCurrent = Number(sys.magazine?.current);
  const storedMax = Number(sys.magazine?.max);
  const hasStoredCurrent = sys.magazine?.current !== "" && sys.magazine?.current != null && Number.isFinite(storedCurrent);
  const hasStoredMax = sys.magazine?.max !== "" && sys.magazine?.max != null && Number.isFinite(storedMax);
  const raw = String(sys.shots ?? sys.ammo ?? "").trim();
  const pair = raw.match(/^\s*(\d+)\s*\/\s*(\d+)\s*$/);
  const single = raw.match(/^\s*(\d+)\s*$/);

  let maximum = hasStoredMax && storedMax > 0
    ? Math.floor(storedMax)
    : (pair ? Number(pair[2]) : (single ? Number(single[1]) : 0));
  maximum = Math.max(0, maximum);
  if (maximum <= 0) {
    return { tracked: false, current: 0, maximum: 0, display: raw || "--" };
  }

  const legacyCurrent = pair ? Number(pair[1]) : maximum;
  const current = Math.min(maximum, Math.max(0,
    hasStoredCurrent && storedCurrent >= 0 ? Math.floor(storedCurrent) : legacyCurrent
  ));
  return { tracked: true, current, maximum, display: `${current}/${maximum}` };
}

async function consumeCharacterWeaponAmmo(weapon, amount = 1) {
  const magazine = getCharacterWeaponMagazine(weapon);
  if (!magazine.tracked) return { ok: true, magazine, previousMagazine: magazine };
  const spent = Math.max(1, Math.floor(num(amount, 1)));
  if (magazine.current < spent) {
    return { ok: false, reason: `${weapon.name} is out of ammunition.`, magazine };
  }
  await weapon.update({
    "system.magazine.current": magazine.current - spent,
    "system.magazine.max": magazine.maximum
  });
  return { ok: true, magazine: getCharacterWeaponMagazine(weapon), previousMagazine: magazine };
}

export function getCharacterWeaponPowerState(actor, weapon) {
  const resources = getCharacterWeaponResourceProfile(weapon);
  const cost = Math.max(0, Math.floor(num(weapon?.system?.pps, 0)));
  if (!resources.usesPps) {
    return { required: false, ok: true, cost: 0, pack: null, capacity: null, display: "Not Required" };
  }
  const pack = getSelectedCharacterPowerPack(actor, weapon);
  if (!pack) {
    return { required: true, ok: false, cost, pack: null, capacity: null, display: "No Power Pack", reason: `${weapon.name} has no Power Pack selected.` };
  }
  const capacity = getCharacterPowerPackCapacity(pack);
  if (!capacity.tracked) {
    return { required: true, ok: false, cost, pack, capacity, display: `${pack.name} (capacity not set)`, reason: `${pack.name} has no Power Capacity configured.` };
  }
  if (capacity.current < cost) {
    return { required: true, ok: false, cost, pack, capacity, display: `${pack.name} (${capacity.display})`, reason: `${pack.name} needs ${cost} PP but only has ${capacity.current} PP remaining.` };
  }
  return { required: true, ok: true, cost, pack, capacity, display: `${pack.name} (${capacity.display})` };
}

async function consumeCharacterWeaponPower(actor, weapon) {
  const state = getCharacterWeaponPowerState(actor, weapon);
  if (!state.ok || !state.required || state.cost <= 0) return state;
  await state.pack.update({
    "system.powerCapacity.current": state.capacity.current - state.cost,
    "system.powerCapacity.max": state.capacity.maximum
  });
  return { ...state, capacity: getCharacterPowerPackCapacity(state.pack) };
}

export async function promptAndReloadCharacterWeapon(actor, weapon, { tokenDocument = null } = {}) {
  const magazine = getCharacterWeaponMagazine(weapon);
  if (!magazine.tracked) {
    ui.notifications?.warn?.(`${weapon.name} does not use a tracked magazine.`);
    return false;
  }
  if (magazine.current >= magazine.maximum) {
    ui.notifications?.info?.(`${weapon.name} is already fully loaded (${magazine.display}).`);
    return false;
  }

  const check = canSpendCharacterAction(actor, "simple", { tokenDocument });
  if (!check.ok) {
    ui.notifications?.warn?.(`Cannot reload ${weapon.name}: ${check.reason}`);
    return false;
  }

  return new Promise(resolve => {
    new Dialog({
      title: `Reload ${weapon.name}?`,
      content: `<p><strong>${weapon.name}</strong> is empty. Reload to ${magazine.maximum}/${magazine.maximum}?</p><p>Reloading uses 1 Simple Action.</p>`,
      buttons: {
        reload: {
          icon: '<i class="fas fa-rotate"></i>',
          label: "Reload",
          callback: async () => {
            const actionSpend = await spendCharacterAction(actor, "simple", {
              tokenDocument,
              label: `Reload: ${weapon.name}`
            });
            if (!actionSpend.ok) {
              ui.notifications?.warn?.(`Cannot reload ${weapon.name}: ${actionSpend.reason}`);
              resolve(false);
              return;
            }
            try {
              await weapon.update({
                "system.magazine.current": magazine.maximum,
                "system.magazine.max": magazine.maximum
              });
              ui.notifications?.info?.(`${weapon.name} reloaded (${magazine.maximum}/${magazine.maximum}).`);
              resolve(true);
            } catch (error) {
              await refundCharacterAction(actor, "simple", { tokenDocument }).catch(() => {});
              console.error(`${SYSTEM_ID} | Failed to reload character weapon`, error);
              ui.notifications?.error?.(`Could not reload ${weapon.name}.`);
              resolve(false);
            }
          }
        },
        cancel: { label: "Cancel", callback: () => resolve(false) }
      },
      default: "reload",
      close: () => resolve(false)
    }).render(true);
  });
}

function skillMinXpForRank(rank) {
  return SKILL_XP_TO_RANK.find(entry => entry.rank === Number(rank))?.xp ?? 0;
}

function skillRankFromXp(xp) {
  const value = num(xp, 0);
  let rank = -1;
  for (const row of SKILL_XP_TO_RANK) {
    if (value < row.xp) break;
    rank = row.rank;
  }
  return rank;
}

function attributeValue(actor, key) {
  const attribute = actor?.system?.attributes?.[key] ?? {};
  return Math.floor(num(attribute.xp, num(attribute.value, 0) * 100) / 100);
}

function attributeLink(value) {
  const v = num(value, 0);
  if (v <= 0) return -4;
  if (v === 1) return -2;
  if (v <= 3) return -1;
  if (v <= 6) return 0;
  if (v <= 9) return 1;
  return 2;
}

function findSkillByName(actor, name) {
  const needle = String(name ?? "").trim().toLowerCase();
  if (!needle) return null;
  const skills = Array.from(actor?.items?.contents ?? actor?.items ?? [])
    .filter(item => item?.type === "skill" || item?.type === "characterSkill");
  return skills.find(item => String(item.name ?? "").trim().toLowerCase() === needle)
    ?? skills.find(item => String(item.name ?? "").trim().toLowerCase().includes(needle))
    ?? null;
}

function getActorToken(actor) {
  const actorId = String(actor?.id ?? "");
  const controlled = canvas?.tokens?.controlled?.find(token => String(token?.actor?.id ?? "") === actorId);
  if (controlled) return controlled;
  const combatant = game.combat?.combatants?.find?.(entry =>
    String(entry?.actorId ?? entry?.actor?.id ?? entry?.token?.actor?.id ?? "") === actorId
  );
  if (combatant?.token) return combatant.token.object ?? combatant.token;
  return canvas?.tokens?.placeables?.find?.(token => String(token?.actor?.id ?? "") === actorId) ?? null;
}

function getSingleTargetToken() {
  const targets = Array.from(game.user?.targets ?? []);
  return targets.length === 1 ? targets[0] : null;
}

function getTokenCenter(token) {
  const center = token?.center ?? token?.object?.center;
  if (Number.isFinite(center?.x) && Number.isFinite(center?.y)) return center;

  const document = token?.document ?? token;
  const x = Number(document?.x);
  const y = Number(document?.y);
  const width = Number(document?.width);
  const height = Number(document?.height);
  const size = Number(canvas?.grid?.size ?? canvas?.dimensions?.size);
  if (![x, y, width, height, size].every(Number.isFinite)) return null;
  return { x: x + (width * size) / 2, y: y + (height * size) / 2 };
}

function measureTokenDistance(attackerToken, targetToken) {
  const from = getTokenCenter(attackerToken);
  const to = getTokenCenter(targetToken);
  if (!from || !to || !canvas?.grid) return null;

  try {
    const measured = canvas.grid.measurePath?.([from, to]);
    const distance = Number(measured?.distance);
    if (Number.isFinite(distance)) return distance;
  } catch (_) {}

  try {
    const distance = Number(canvas.grid.measureDistance?.(from, to));
    if (Number.isFinite(distance)) return distance;
  } catch (_) {}

  try {
    const ray = new Ray(from, to);
    const distances = canvas.grid.measureDistances?.([{ ray }], { gridSpaces: true });
    const distance = Number(distances?.[0]);
    if (Number.isFinite(distance)) return distance;
  } catch (_) {}
  return null;
}

function getTargetMovementMeters(targetToken) {
  const document = targetToken?.document ?? targetToken;
  if (!document) return 0;
  const moved = document.getFlag?.(SYSTEM_ID, "movedThisTurn")
    ?? document.getFlag?.(SYSTEM_ID, "spacesMovedThisTurn")
    ?? document.getFlag?.(SYSTEM_ID, "movedHexesThisTurn")
    ?? document.getFlag?.(SYSTEM_ID, "displacementThisTurn")
    ?? 0;
  return Math.max(0, num(moved, 0));
}

function formatMeters(distance) {
  if (!Number.isFinite(Number(distance))) return "--";
  const rounded = Math.round(Number(distance) * 10) / 10;
  return `${rounded} m`;
}

export function getCharacterAttackMovementModifier(mode) {
  const key = String(mode ?? "stationary").trim().toLowerCase();
  return num(CHARACTER_ATTACK_MOVEMENT_MODIFIERS[key], 0);
}

export function getCharacterTargetMovementModifier(metersMoved) {
  const meters = Math.max(0, num(metersMoved, 0));
  return CHARACTER_TARGET_MOVEMENT_MODIFIERS.find(row => meters >= row.minimum)?.modifier ?? 0;
}

export function getCharacterTargetEvasion(targetToken) {
  const document = targetToken?.document ?? targetToken;
  const actor = targetToken?.actor ?? document?.actor ?? null;
  const mode = String(document?.getFlag?.(SYSTEM_ID, "moveMode") ?? "").trim().toLowerCase();
  if (!actor || mode !== "evade") {
    return { active: false, skillName: "Acrobatics", rank: 0, modifier: 0 };
  }

  const acrobatics = findSkillByName(actor, "Acrobatics");
  if (!acrobatics) {
    return { active: true, skillName: "Acrobatics", rank: 0, modifier: 0 };
  }
  const xp = num(acrobatics.system?.xp, skillMinXpForRank(acrobatics.system?.rank));
  const rank = Math.max(0, skillRankFromXp(xp));
  return { active: true, skillName: acrobatics.name, rank, modifier: -rank };
}

function tokenHasCharacterStatus(targetToken, statusId) {
  const document = targetToken?.document ?? targetToken;
  const actor = targetToken?.actor ?? document?.actor ?? null;
  try { if (document?.hasStatusEffect?.(statusId)) return true; } catch (_) {}
  try { if (document?.statuses?.has?.(statusId)) return true; } catch (_) {}
  try { if (actor?.statuses?.has?.(statusId)) return true; } catch (_) {}
  return Array.from(actor?.effects ?? []).some(effect => {
    if (effect?.disabled) return false;
    const statuses = effect?.statuses;
    if (statuses?.has?.(statusId) || (Array.isArray(statuses) && statuses.includes(statusId))) return true;
    return String(effect?.getFlag?.("core", "statusId") ?? effect?.flags?.core?.statusId ?? "") === statusId;
  });
}

export function getCharacterTargetCover(targetToken) {
  const orderedIds = ["full-cover", "heavy-cover", "moderate-cover", "light-cover"];
  const statusId = orderedIds.find(id => tokenHasCharacterStatus(targetToken, id));
  const definition = statusId ? CHARACTER_COVER_MODIFIERS[statusId] : null;
  return definition
    ? { active: true, statusId, ...definition }
    : { active: false, statusId: "", label: "No Cover", modifier: 0 };
}

export function getCharacterWeaponAttackType(weapon) {
  const explicit = String(weapon?.system?.attackType ?? "").trim().toLowerCase();
  if (Object.values(CHARACTER_ATTACK_TYPES).includes(explicit)) return explicit;
  const skillKey = String(weapon?.system?.skillKey ?? "").trim();
  return WEAPON_SKILLS[skillKey]?.attackType ?? CHARACTER_ATTACK_TYPES.RANGED;
}

/** Parse Character Weapon range text such as 5/20/45/105. */
export function parseCharacterWeaponRanges(weaponOrRange) {
  const raw = typeof weaponOrRange === "string"
    ? weaponOrRange
    : weaponOrRange?.system?.range;

  if (raw && typeof raw === "object") {
    const bands = {
      short: num(raw.short, NaN),
      medium: num(raw.medium, NaN),
      long: num(raw.long, NaN),
      extreme: num(raw.extreme, NaN)
    };
    const values = Object.values(bands);
    const valid = values.every(Number.isFinite) && values.every(value => value > 0)
      && values.every((value, index) => index === 0 || value >= values[index - 1]);
    return { ...bands, pointBlank: 1, valid, raw };
  }

  const values = String(raw ?? "").match(/\d+(?:\.\d+)?/g)?.slice(0, 4).map(Number) ?? [];
  const [short, medium, long, extreme] = values;
  const valid = values.length === 4 && values.every(value => Number.isFinite(value) && value > 0)
    && values.every((value, index) => index === 0 || value >= values[index - 1]);
  return { pointBlank: 1, short, medium, long, extreme, valid, raw: String(raw ?? "") };
}

/** Resolve a measured distance against Point Blank/Short/Medium/Long/Extreme bands. */
export function resolveCharacterRangeBand(distance, weaponOrRange) {
  const meters = Number(distance);
  const ranges = parseCharacterWeaponRanges(weaponOrRange);
  if (!ranges.valid) {
    return { valid: false, inRange: false, distance: meters, distanceLabel: formatMeters(meters), ranges, key: "invalid", label: "Invalid Range Profile", modifier: 0 };
  }
  if (!Number.isFinite(meters) || meters < 0) {
    return { valid: false, inRange: false, distance: meters, distanceLabel: "--", ranges, key: "unknown", label: "Unknown Range", modifier: 0 };
  }

  const bands = [
    { key: "pointBlank", label: "Point Blank", maximum: ranges.pointBlank },
    { key: "short", label: "Short", maximum: ranges.short },
    { key: "medium", label: "Medium", maximum: ranges.medium },
    { key: "long", label: "Long", maximum: ranges.long },
    { key: "extreme", label: "Extreme", maximum: ranges.extreme }
  ];
  const band = bands.find(entry => meters <= entry.maximum);
  if (!band) {
    return { valid: true, inRange: false, distance: meters, distanceLabel: formatMeters(meters), ranges, key: "outOfRange", label: "Out of Range", modifier: 0, maximum: ranges.extreme };
  }
  return {
    valid: true,
    inRange: true,
    distance: meters,
    distanceLabel: formatMeters(meters),
    ranges,
    ...band,
    modifier: CHARACTER_ATTACK_RANGE_MODIFIERS[band.key]
  };
}

function buildWeaponProfile(weapon) {
  const sys = weapon?.system ?? {};
  const magazine = getCharacterWeaponMagazine(weapon);
  const resources = getCharacterWeaponResourceProfile(weapon);
  const pps = Math.max(0, Math.floor(num(sys.pps, 0)));
  const powerState = getCharacterWeaponPowerState(weapon?.parent, weapon);
  const resourceDisplay = [
    resources.usesAmmo ? magazine.display : "",
    resources.usesPps ? `${pps} PPS — ${powerState.display}` : ""
  ].filter(Boolean).join(" + ") || "--";
  const skillKey = String(sys.skillKey ?? sys.skill ?? sys.attackSkill ?? "").trim();
  const definition = WEAPON_SKILLS[skillKey] ?? null;
  const ap = String(sys?.damage?.ap ?? sys.ap ?? "").trim();
  const bd = String(sys?.damage?.bd ?? sys.bd ?? sys.baseDamage ?? "").trim();
  const damage = parseCharacterWeaponDamage(weapon);
  return {
    attackType: getCharacterWeaponAttackType(weapon),
    skillLabel: String(definition?.label ?? sys.skillLabel ?? sys.skill ?? "Unknown Skill"),
    tiedSkill: String(definition?.tiedSkill ?? sys.tiedSkill ?? sys.skillTied ?? "").trim(),
    apbd: String(sys.apbd ?? sys.apBd ?? "").trim() || ((ap || bd) ? `${ap}/${bd}` : "--"),
    range: String(sys.range ?? "").trim() || "--",
    shots: resourceDisplay,
    magazine,
    resources,
    pps,
    powerState,
    damage
  };
}

function buildSkillProfile(actor, skillItem) {
  const xp = num(skillItem?.system?.xp, skillMinXpForRank(skillItem?.system?.rank));
  const rank = skillRankFromXp(xp);
  const linked1 = String(skillItem?.system?.linkedAttribute1 ?? skillItem?.system?.linkedAttribute ?? "").trim();
  const linked2 = String(skillItem?.system?.linkedAttribute2 ?? "").trim();
  const linkedKeys = Array.from(new Set([linked1, linked2].filter(Boolean)));
  const linkModifier = linkedKeys.reduce((total, key) => total + attributeLink(attributeValue(actor, key)), 0);
  const rawTN = Number(skillItem?.system?.tn);
  return {
    rank,
    linkModifier,
    modifier: rank + linkModifier,
    tn: Number.isFinite(rawTN) ? rawTN : undefined
  };
}

function resolveMovementMode(form, autoMode) {
  const selected = String(form?.elements?.movementMode?.value ?? "auto").trim().toLowerCase();
  return selected === "auto" ? autoMode : selected;
}

function bindCharacterAttackDialog(html) {
  const form = (html?.[0] ?? html)?.querySelector?.("form.atow-character-attack-dialog");
  if (!form) return;
  const movement = form.elements?.movementMode;
  const targetMovement = form.elements?.targetMovementMeters;
  const other = form.elements?.otherModifier;
  const movementValue = form.querySelector("[data-character-movement-mod]");
  const targetMovementValues = form.querySelectorAll("[data-character-target-movement-mod]");
  const targetMovementMetersValues = form.querySelectorAll("[data-character-target-movement-meters]");
  const totalValue = form.querySelector("[data-character-total-mod]");
  const baseModifier = num(form.dataset.baseModifier, 0);
  const rangeModifier = num(form.dataset.rangeModifier, 0);
  const targetEvasionModifier = num(form.dataset.targetEvasionModifier, 0);
  const targetCoverModifier = num(form.dataset.targetCoverModifier, 0);
  const autoMode = String(form.dataset.autoMovementMode ?? "stationary");
  const update = () => {
    const movementModifier = getCharacterAttackMovementModifier(resolveMovementMode(form, autoMode));
    const targetMovementModifier = getCharacterTargetMovementModifier(targetMovement?.value);
    const total = baseModifier + movementModifier + rangeModifier + targetMovementModifier + targetEvasionModifier + targetCoverModifier + num(other?.value, 0);
    if (movementValue) movementValue.textContent = movementModifier > 0 ? `+${movementModifier}` : String(movementModifier);
    for (const value of targetMovementValues) value.textContent = targetMovementModifier > 0 ? `+${targetMovementModifier}` : String(targetMovementModifier);
    for (const value of targetMovementMetersValues) value.textContent = String(Math.max(0, num(targetMovement?.value, 0)));
    if (totalValue) totalValue.textContent = total > 0 ? `+${total}` : String(total);
  };
  movement?.addEventListener?.("change", update);
  targetMovement?.addEventListener?.("input", update);
  other?.addEventListener?.("input", update);
  update();
}

function escapeHtml(value) {
  const escape = foundry?.utils?.escapeHTML;
  return typeof escape === "function" ? escape(String(value ?? "")) : String(value ?? "");
}

async function postCharacterDamageResult(actor, weapon, result) {
  const targetName = escapeHtml(result?.targetName ?? "Target");
  const weaponName = escapeHtml(weapon?.name ?? "Weapon");
  let content;
  if (!result?.ok) {
    content = `<p><b>${weaponName} damage was not applied:</b> ${escapeHtml(result?.reason ?? "Unknown error")}</p>`;
  } else if (!result.penetrated) {
    content = `<p><b>${weaponName}</b> hit <b>${targetName}</b>, but AP ${result.armorPenetration}${escapeHtml(result.damageType)} did not overcome ${escapeHtml(result.armor?.armorName)} BAR ${result.armor?.bar ?? 0}. No Body Damage or Fatigue was applied.</p>`;
  } else {
    const capped = result.requestedBodyDamage > result.bodyDamage
      ? ` (${result.requestedBodyDamage} rolled before track maximum)`
      : "";
    content = [
      `<p><b>${weaponName}</b> damaged <b>${targetName}</b>.</p>`,
      `<p>AP ${result.armorPenetration}${escapeHtml(result.damageType)} vs ${escapeHtml(result.armor?.armorName)} BAR ${result.armor?.bar ?? 0}: <b>Penetrated</b></p>`,
      `<p>Base BD ${result.baseDamage}; MoS ${result.marginOfSuccess}; Body Damage <b>${result.bodyDamage}</b>${capped}; Fatigue <b>+${result.fatigueDamage}</b>.</p>`
    ].join("");
  }
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content,
    flags: { [SYSTEM_ID]: { characterDamageResolution: result } }
  });
}

async function rollCharacterAttack(actor, weapon, profile, skillItem, skill, form, autoMovementMode, rangeBand, targetEvasion, targetCover, targetToken) {
  const movementMode = resolveMovementMode(form, autoMovementMode);
  const movementModifier = getCharacterAttackMovementModifier(movementMode);
  const targetMovementMeters = Math.max(0, num(form?.elements?.targetMovementMeters?.value, 0));
  const targetMovementModifier = getCharacterTargetMovementModifier(targetMovementMeters);
  const otherModifier = num(form?.elements?.otherModifier?.value, 0);
  const rangeModifier = profile.attackType === CHARACTER_ATTACK_TYPES.RANGED ? num(rangeBand?.modifier, 0) : 0;
  const targetEvasionModifier = num(targetEvasion?.modifier, 0);
  const targetCoverModifier = profile.attackType === CHARACTER_ATTACK_TYPES.RANGED ? num(targetCover?.modifier, 0) : 0;
  const modifier = skill.modifier + movementModifier + rangeModifier + targetMovementModifier + targetEvasionModifier + targetCoverModifier + otherModifier;
  const naturalAptitude = getActiveNaturalAptitude(actor, skillItem);
  const diceFormula = naturalAptitude ? NATURAL_APTITUDE_DICE_FORMULA : "2d6";
  const movementLabel = movementMode ? movementMode[0].toUpperCase() + movementMode.slice(1) : "Stationary";
  const flavor = [
    `${weapon.name} | ${profile.attackType === CHARACTER_ATTACK_TYPES.MELEE ? "Melee" : "Ranged"} Attack`,
    `Skill: ${skillItem.name}`,
    `Movement: ${movementLabel} (${movementModifier > 0 ? "+" : ""}${movementModifier})`,
    `Target Movement: ${targetMovementMeters} m (${targetMovementModifier})`,
    targetEvasion?.active ? `Target Evading: ${targetEvasion.skillName} Rank ${targetEvasion.rank} (${targetEvasionModifier})` : "",
    targetCover?.active ? `Target Cover: ${targetCover.label} (${targetCoverModifier})` : "",
    profile.attackType === CHARACTER_ATTACK_TYPES.RANGED
      ? `Range: ${rangeBand.distanceLabel} — ${rangeBand.label} (${rangeModifier > 0 ? "+" : ""}${rangeModifier})`
      : "",
    profile.apbd !== "--" ? `AP/BD: ${profile.apbd}` : "",
    profile.attackType === CHARACTER_ATTACK_TYPES.RANGED && profile.range !== "--" ? `Range Profile: ${profile.range}` : "",
    otherModifier ? `Other: ${otherModifier > 0 ? "+" : ""}${otherModifier}` : "",
    naturalAptitude ? `Natural Aptitude (${naturalAptitude.name}): 3d6, keep highest 2` : ""
  ].filter(Boolean).join(" | ");

  const configuredTN = skill.tn ?? game.settings.get(SYSTEM_ID, "defaultTN");
  const api = game[SYSTEM_ID]?.api;
  let message;
  if (typeof api?.rollCheck === "function") {
    message = await api.rollCheck({ actor, label: `${weapon.name} Attack`, modifier, tn: configuredTN, flavor, diceFormula });
  } else {
    const roll = await new Roll(`${diceFormula} + ${modifier}`).evaluate();
    const total = num(roll.total, 0);
    const margin = total - num(configuredTN, 0);
    message = await roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor: `${flavor} | TN ${configuredTN} → <b>${margin >= 0 ? "SUCCESS" : "FAIL"}</b> (${margin >= 0 ? "+" : ""}${margin})`
    });
  }

  const rollTotal = num(message?.rolls?.[0]?.total ?? message?.roll?.total, NaN);
  const targetNumber = num(configuredTN, NaN);
  if (!Number.isFinite(rollTotal) || !Number.isFinite(targetNumber)) return message;
  const marginOfSuccess = rollTotal - targetNumber;
  if (marginOfSuccess < 0) return message;

  if (!profile.damage.valid) {
    ui.notifications?.warn?.(`${weapon.name} hit, but its AP/BD profile is invalid. Expected AP such as 3B and a numeric BD.`);
    return message;
  }
  const targetActor = targetToken?.actor ?? targetToken?.document?.actor ?? null;
  const damageResult = await applyCharacterAttackDamageAsGM(targetActor, {
    ...profile.damage,
    marginOfSuccess,
    burstFire: false,
    attackerActorUuid: actor.uuid,
    weaponUuid: weapon.uuid
  }).catch(error => ({ ok: false, reason: error?.message ?? "SocketLib damage request failed." }));
  await postCharacterDamageResult(actor, weapon, damageResult);
  if (!damageResult.ok) ui.notifications?.warn?.(damageResult.reason ?? "Character damage could not be applied.");
  return message;
}

/** Open the personal-scale attack dialog for an equipped Character Weapon. */
export async function promptAndRollCharacterWeaponAttack(actor, weapon) {
  if (!actor || !weapon || weapon.type !== "characterWeapon") return null;
  const initialMagazine = getCharacterWeaponMagazine(weapon);
  const initialToken = getActorToken(actor);
  const initialTokenDocument = initialToken?.document ?? initialToken ?? null;
  if (initialMagazine.tracked && initialMagazine.current <= 0) {
    return promptAndReloadCharacterWeapon(actor, weapon, { tokenDocument: initialTokenDocument });
  }
  const initialPowerState = getCharacterWeaponPowerState(actor, weapon);
  if (!initialPowerState.ok) {
    ui.notifications?.warn?.(initialPowerState.reason);
    return null;
  }
  const profile = buildWeaponProfile(weapon);
  const skillItem = findSkillByName(actor, profile.tiedSkill);
  if (!skillItem) {
    ui.notifications?.warn?.(`No matching Skill item found for ${weapon.name} (${profile.tiedSkill || profile.skillLabel}).`);
    return null;
  }

  const skill = buildSkillProfile(actor, skillItem);
  const attackerToken = getActorToken(actor);
  const tokenDocument = attackerToken?.document ?? attackerToken ?? null;
  const targetToken = getSingleTargetToken();
  if (!targetToken) {
    ui.notifications?.warn?.("Select exactly one target token before making an attack.");
    return null;
  }
  if (profile.attackType === CHARACTER_ATTACK_TYPES.RANGED && !attackerToken) {
    ui.notifications?.warn?.("Place or control this character's token before making a ranged attack.");
    return null;
  }

  const actionCheck = canSpendCharacterAction(actor, "simple", { tokenDocument });
  if (!actionCheck.ok) {
    ui.notifications?.warn?.(`Cannot make this attack: ${actionCheck.reason}`);
    return null;
  }
  const actionState = getCharacterActionState(actor, { tokenDocument });

  const distance = profile.attackType === CHARACTER_ATTACK_TYPES.RANGED
    ? measureTokenDistance(attackerToken, targetToken)
    : null;
  const rangeBand = profile.attackType === CHARACTER_ATTACK_TYPES.RANGED
    ? resolveCharacterRangeBand(distance, weapon)
    : { valid: true, inRange: true, distanceLabel: "Melee", label: "Melee", modifier: 0 };
  const targetMovementMeters = getTargetMovementMeters(targetToken);
  const targetMovementModifier = getCharacterTargetMovementModifier(targetMovementMeters);
  const targetEvasion = getCharacterTargetEvasion(targetToken);
  const targetCover = profile.attackType === CHARACTER_ATTACK_TYPES.RANGED
    ? getCharacterTargetCover(targetToken)
    : { active: false, label: "No Cover", modifier: 0 };
  let rangeWarning = "";
  if (profile.attackType === CHARACTER_ATTACK_TYPES.RANGED) {
    if (rangeBand.key === "invalid") {
      rangeWarning = "Range must contain four distances in Short/Medium/Long/Extreme order (for example, 5/20/45/105).";
    } else if (rangeBand.key === "unknown") {
      rangeWarning = "The distance between the attacker and target could not be measured on this scene.";
    } else if (!rangeBand.inRange) {
      rangeWarning = `Target is beyond this weapon's ${rangeBand.ranges.extreme} m Extreme range.`;
    }
  }
  const autoMovementMode = String(tokenDocument?.getFlag?.(SYSTEM_ID, "moveMode") ?? "stationary").trim().toLowerCase() || "stationary";
  const movementModifier = getCharacterAttackMovementModifier(autoMovementMode);
  let targetNumber = skill.tn ?? "System Default";
  try { targetNumber = skill.tn ?? game.settings.get(SYSTEM_ID, "defaultTN"); } catch (_) {}

  const dialogHtml = await renderTemplate(CHARACTER_ATTACK_TEMPLATE, {
    weaponName: weapon.name,
    attackerName: attackerToken?.name ?? tokenDocument?.name ?? actor.name,
    targetName: targetToken?.name ?? targetToken?.document?.name ?? "No target selected",
    attackTypeLabel: profile.attackType === CHARACTER_ATTACK_TYPES.MELEE ? "Melee" : "Ranged",
    isMelee: profile.attackType === CHARACTER_ATTACK_TYPES.MELEE,
    isRanged: profile.attackType === CHARACTER_ATTACK_TYPES.RANGED,
    skillName: skillItem.name,
    skillRank: skill.rank,
    skillModifier: skill.modifier,
    autoMovementMode,
    autoMovementLabel: autoMovementMode[0].toUpperCase() + autoMovementMode.slice(1),
    movementModifier,
    targetMovementMeters,
    targetMovementModifier,
    targetEvading: targetEvasion.active,
    targetEvasionSkill: targetEvasion.skillName,
    targetEvasionRank: targetEvasion.rank,
    targetEvasionModifier: targetEvasion.modifier,
    targetCoverActive: targetCover.active,
    targetCoverLabel: targetCover.label,
    targetCoverModifier: targetCover.modifier,
    simpleActionsUsed: actionState.used.simple,
    simpleActionsRemaining: actionState.remaining.simple,
    simpleActionLimit: actionState.limits.simple,
    rangeBandLabel: rangeBand.label,
    rangeModifier: rangeBand.modifier,
    distanceLabel: rangeBand.distanceLabel,
    hasRangeWarning: Boolean(rangeWarning),
    rangeWarning,
    totalModifier: skill.modifier + movementModifier + num(rangeBand.modifier, 0) + targetMovementModifier + targetEvasion.modifier + targetCover.modifier,
    targetNumber,
    apbd: profile.apbd,
    range: profile.range,
    shots: profile.shots
  });

  return new Promise(resolve => {
    new Dialog({
      title: `${weapon.name} - Personal-Scale Attack`,
      content: dialogHtml,
      buttons: {
        roll: {
          icon: '<i class="fas fa-dice"></i>',
          label: "Roll Attack",
          callback: async html => {
            const form = html?.[0]?.querySelector?.("form.atow-character-attack-dialog");
            if (!form) return resolve(null);
            if (profile.attackType === CHARACTER_ATTACK_TYPES.RANGED && (!rangeBand.valid || !rangeBand.inRange)) {
              ui.notifications?.warn?.(rangeWarning || "This ranged attack cannot be made at the measured distance.");
              return resolve(null);
            }
            const powerCheck = getCharacterWeaponPowerState(actor, weapon);
            if (!powerCheck.ok) {
              ui.notifications?.warn?.(powerCheck.reason);
              return resolve(null);
            }
            const actionSpend = await spendCharacterAction(actor, "simple", {
              tokenDocument,
              label: `${profile.attackType === CHARACTER_ATTACK_TYPES.MELEE ? "Melee" : "Ranged"} attack: ${weapon.name}`
            });
            if (!actionSpend.ok) {
              ui.notifications?.warn?.(`Cannot make this attack: ${actionSpend.reason}`);
              return resolve(null);
            }
            const ammoSpend = await consumeCharacterWeaponAmmo(weapon, 1).catch(error => ({ ok: false, error, reason: `Could not update ammunition for ${weapon.name}.` }));
            if (!ammoSpend.ok) {
              await refundCharacterAction(actor, "simple", { tokenDocument }).catch(() => {});
              if (ammoSpend.error) console.error(`${SYSTEM_ID} | Failed to consume character weapon ammunition`, ammoSpend.error);
              ui.notifications?.warn?.(ammoSpend.reason ?? `${weapon.name} cannot fire.`);
              return resolve(null);
            }
            const powerSpend = await consumeCharacterWeaponPower(actor, weapon).catch(error => ({ ok: false, error, reason: `Could not update the Power Pack for ${weapon.name}.` }));
            if (!powerSpend.ok) {
              if (ammoSpend.previousMagazine?.tracked) {
                await weapon.update({
                  "system.magazine.current": ammoSpend.previousMagazine.current,
                  "system.magazine.max": ammoSpend.previousMagazine.maximum
                }).catch(() => {});
              }
              await refundCharacterAction(actor, "simple", { tokenDocument }).catch(() => {});
              if (powerSpend.error) console.error(`${SYSTEM_ID} | Failed to consume character weapon power`, powerSpend.error);
              ui.notifications?.warn?.(powerSpend.reason ?? `${weapon.name} cannot draw power.`);
              return resolve(null);
            }
            resolve(await rollCharacterAttack(actor, weapon, profile, skillItem, skill, form, autoMovementMode, rangeBand, targetEvasion, targetCover, targetToken));
          }
        },
        cancel: { label: "Cancel", callback: () => resolve(null) }
      },
      default: "roll",
      render: bindCharacterAttackDialog
    }).render(true);
  });
}
