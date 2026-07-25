// systems/atow-battletech/module/character-combat.js
// Personal-scale character combat rules and helpers.

const SYSTEM_ID = "atow-battletech";

export const CHARACTER_PERSONAL_SCALE = Object.freeze({
  metersPerHex: 1,
  secondsPerRound: 5,
  movementPointsPerMeter: 1
});

export const CHARACTER_ACTION_TYPES = Object.freeze({
  INCIDENTAL: "incidental",
  SIMPLE: "simple",
  COMPLEX: "complex",
  MOVEMENT: "movement"
});

export const CHARACTER_ACTION_LIMITS = Object.freeze({
  incidental: 5,
  simple: 2,
  complex: 1,
  movement: 1
});

export const CHARACTER_ACTION_DEFINITIONS = Object.freeze({
  incidental: Object.freeze({
    key: CHARACTER_ACTION_TYPES.INCIDENTAL,
    label: "Incidental Action",
    pluralLabel: "Incidental Actions",
    perTurn: 5,
    summary: "Brief actions requiring little movement or concentration.",
    examples: Object.freeze(["Short warning", "Defend against melee", "Drop prone"]),
    mayCombineWith: Object.freeze(["incidental", "simple", "movement"])
  }),
  simple: Object.freeze({
    key: CHARACTER_ACTION_TYPES.SIMPLE,
    label: "Simple Action",
    pluralLabel: "Simple Actions",
    perTurn: 2,
    summary: "Quick actions requiring some effort or concentration.",
    examples: Object.freeze(["Fire a weapon", "Melee attack", "Operate a vehicle", "Use a simple trained skill"]),
    mayCombineWith: Object.freeze(["incidental", "simple", "movement"])
  }),
  complex: Object.freeze({
    key: CHARACTER_ACTION_TYPES.COMPLEX,
    label: "Complex Action",
    pluralLabel: "Complex Actions",
    perTurn: 1,
    summary: "Demanding actions requiring full concentration.",
    examples: Object.freeze(["Use a complex skill", "Attempt an untrained skill", "Use a complex device"]),
    mayCombineWith: Object.freeze(["incidental"])
  }),
  movement: Object.freeze({
    key: CHARACTER_ACTION_TYPES.MOVEMENT,
    label: "Movement Action",
    pluralLabel: "Movement Actions",
    perTurn: 1,
    summary: "The character's declared movement mode for the turn.",
    examples: Object.freeze(["Stationary", "Walk", "Run", "Sprint", "Evade", "Crawl", "Climb", "Swim"]),
    mayCombineWith: Object.freeze(["incidental", "simple", "complex"])
  })
});

// A Time of War: Action Complexity Table. Keep this as the canonical rules
// reference for personal-scale automation as more individual actions are added.
export const CHARACTER_ACTION_COMPLEXITY_TABLE = Object.freeze({
  incidental: Object.freeze({
    nonMovement: Object.freeze([
      "Crouch",
      "Drop Object",
      "Drop Prone",
      "Gesture",
      "Leaping (Downward)",
      "Melee Defense (except Break Grapple)",
      "Observe Quickly (No Perception Skill)",
      "Sit Down",
      "Speak (Single Word)",
      "Stand Up"
    ]),
    movement: Object.freeze(["No Movement", "Walking"])
  }),
  simple: Object.freeze({
    nonMovement: Object.freeze([
      "Lead Team",
      "Leaping (Upward or Horizontally)",
      "Load Weapon",
      "Melee Attack",
      "Melee Defense (Break Grapple)",
      "Observe in Detail (Perception Skill)",
      "Pick Up/Put Down Object",
      "Ranged Attack (other than Suppression Fire)",
      "Ready/Draw Non-Crewed Weapon/Small Equipment",
      "Recover From Stun",
      "Speak (Brief Phrase)",
      "Stow/Sheath Equipment",
      "Use Simple Object",
      "Use Simple Skill (Trained)"
    ]),
    movement: Object.freeze([
      "Climbing (with Climbing Skill)",
      "Crawling",
      "Running",
      "Swimming (with Swimming Skill)"
    ])
  }),
  complex: Object.freeze({
    nonMovement: Object.freeze([
      "Careful Aim",
      "Extinguish Fire",
      "Ranged Attack (Suppression Fire)",
      "Ready Large Equipment/Crewed Weapon",
      "Recover Fatigue",
      "Speak (Conversation)",
      "Spot for Indirect Fire",
      "Use Complex Object",
      "Use Complex Skill",
      "Use Untrained Skill"
    ]),
    movement: Object.freeze([
      "Climbing (without Climbing Skill)",
      "Evading",
      "Sprinting",
      "Swimming (without Swimming Skill)"
    ])
  })
});

export const CHARACTER_MOVEMENT_MODES = Object.freeze({
  stationary: Object.freeze({
    key: "stationary",
    label: "Stationary",
    actionCost: null,
    mayMove: false,
    derivedMoveKey: null,
    summary: "Default if no movement is declared; the character may not willingly move this turn and spends no action."
  }),
  walk: Object.freeze({
    key: "walk",
    label: "Walk",
    actionCost: CHARACTER_ACTION_TYPES.INCIDENTAL,
    mayMove: true,
    derivedMoveKey: "walk"
  }),
  run: Object.freeze({
    key: "run",
    label: "Run",
    actionCost: CHARACTER_ACTION_TYPES.SIMPLE,
    mayMove: true,
    derivedMoveKey: "run"
  }),
  sprint: Object.freeze({
    key: "sprint",
    label: "Sprint",
    actionCost: CHARACTER_ACTION_TYPES.COMPLEX,
    mayMove: true,
    derivedMoveKey: "sprint"
  }),
  evade: Object.freeze({
    key: "evade",
    label: "Evade",
    actionCost: CHARACTER_ACTION_TYPES.COMPLEX,
    mayMove: true,
    derivedMoveKey: "evade"
  }),
  crawl: Object.freeze({
    key: "crawl",
    label: "Crawl",
    actionCost: CHARACTER_ACTION_TYPES.SIMPLE,
    mayMove: true,
    derivedMoveKey: "crawl"
  }),
  climb: Object.freeze({
    key: "climb",
    label: "Climb",
    actionCost: CHARACTER_ACTION_TYPES.COMPLEX,
    mayMove: true,
    derivedMoveKey: "climb",
    relatedSkill: "Climbing"
  }),
  swim: Object.freeze({
    key: "swim",
    label: "Swim",
    actionCost: CHARACTER_ACTION_TYPES.COMPLEX,
    mayMove: true,
    derivedMoveKey: "swim",
    relatedSkill: "Swimming"
  })
});

export const CHARACTER_MOVEMENT_MANEUVERS = Object.freeze({
  enterHex: Object.freeze({
    key: "enterHex",
    label: "Enter Hex",
    mp: 1,
    summary: "Move into an adjacent personal-scale hex."
  }),
  changeFacing: Object.freeze({
    key: "changeFacing",
    label: "Change Facing",
    mp: 0,
    rulesMpPer180Degrees: 1,
    automationOverride: true,
    summary: "Facing changes are currently free in personal-scale automation; the tabletop rule charges 1 MP per 180 degrees turned."
  }),
  aboutFace: Object.freeze({
    key: "aboutFace",
    label: "About Face",
    mp: 0,
    rulesMp: 1,
    automationOverride: true,
    summary: "A 180-degree facing change is currently free in personal-scale automation."
  }),
  goProne: Object.freeze({
    key: "goProne",
    label: "Go Prone",
    mp: 1,
    summary: "Drop to the ground."
  }),
  standFromProne: Object.freeze({
    key: "standFromProne",
    label: "Stand From Prone",
    mp: 2,
    summary: "Stand up from prone."
  })
});

export const CHARACTER_INITIATIVE_MODES = Object.freeze({
  basic: Object.freeze({
    key: "basic",
    label: "Basic Initiative",
    formula: "2d6",
    dice: 2,
    keep: "all"
  }),
  combatParalysis: Object.freeze({
    key: "combatParalysis",
    label: "Combat Paralysis",
    formula: "3d6kl2",
    dice: 3,
    keep: "worst2"
  }),
  combatSense: Object.freeze({
    key: "combatSense",
    label: "Combat Sense",
    formula: "3d6kh2",
    dice: 3,
    keep: "best2"
  })
});

export const CHARACTER_INITIATIVE_MODIFIERS = Object.freeze({
  tactics: Object.freeze({
    key: "tactics",
    label: "Tactics",
    sourceType: "skill",
    applies: "Requires an appropriate Tactics subskill.",
    value: "skillRank"
  }),
  leadership: Object.freeze({
    key: "leadership",
    label: "Leadership",
    sourceType: "skill",
    applies: "Squad or team initiative only; leader must be present, active, and able to communicate.",
    value: "skillRank"
  })
});

function normalizeInitiativeName(value) {
  return String(value ?? "").trim().toLowerCase();
}

function isSkillItem(item) {
  return item?.type === "skill" || item?.type === "characterSkill";
}

function isTraitItem(item) {
  return item?.type === "trait" || item?.type === "characterTrait";
}

function getSkillRank(item) {
  const rawRank = Number(item?.system?.rank);
  if (Number.isFinite(rawRank)) return Math.max(0, Math.floor(rawRank));

  const xp = Number(item?.system?.xp ?? 0) || 0;
  if (xp < 20) return 0;
  if (xp < 30) return 1;
  if (xp < 50) return 2;
  if (xp < 80) return 3;
  if (xp < 120) return 4;
  if (xp < 170) return 5;
  if (xp < 230) return 6;
  if (xp < 300) return 7;
  if (xp < 380) return 8;
  if (xp < 470) return 9;
  if (xp < 570) return 10;
  return 10;
}

function getInitiativeTacticsRank(actor) {
  const items = actor?.items?.contents ?? actor?.items ?? [];
  let bestRank = 0;

  for (const item of items) {
    if (!isSkillItem(item)) continue;
    const name = normalizeInitiativeName(item?.name);
    if (!name) continue;
    if (name !== "tactics" && !name.startsWith("tactics:") && !name.startsWith("tactics ") && !name.startsWith("tactics-")) continue;
    bestRank = Math.max(bestRank, getSkillRank(item));
  }

  return bestRank;
}

export function getCharacterInitiativeDetails(actor) {
  const details = {
    diceFormula: "2d6",
    bonus: 0,
    formula: "2d6",
    label: "Initiative",
    modifiers: [],
    combatSense: false,
    combatParalysis: false,
    tacticsRank: 0
  };

  const items = actor?.items?.contents ?? actor?.items ?? [];
  const hasCombatSense = items.some((item) => isTraitItem(item) && normalizeInitiativeName(item?.name) === "combat sense");
  const hasCombatParalysis = items.some((item) => isTraitItem(item) && normalizeInitiativeName(item?.name) === "combat paralysis");

  if (hasCombatSense) {
    details.diceFormula = "3d6kh2";
    details.combatSense = true;
    details.modifiers.push("Combat Sense");
  } else if (hasCombatParalysis) {
    details.diceFormula = "3d6kl2";
    details.combatParalysis = true;
    details.modifiers.push("Combat Paralysis");
  }

  const tacticsRank = getInitiativeTacticsRank(actor);
  if (tacticsRank > 0) {
    details.tacticsRank = tacticsRank;
    details.bonus += tacticsRank;
    details.modifiers.push(`Tactics +${tacticsRank}`);
  }

  details.formula = `${details.diceFormula}${details.bonus > 0 ? ` + ${details.bonus}` : ""}`;
  details.label = details.modifiers.length ? `Initiative (${details.modifiers.join(", ")})` : "Initiative";
  return details;
}

export function getCharacterInitiativeRollFormula(actor) {
  return getCharacterInitiativeDetails(actor).formula;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function wholeMp(value) {
  return Math.max(0, Math.floor(num(value)));
}

function movementCostCounts(modeKey) {
  const mode = CHARACTER_MOVEMENT_MODES[modeKey] ?? CHARACTER_MOVEMENT_MODES.stationary;
  const cost = mode.actionCost;

  return {
    incidental: cost === CHARACTER_ACTION_TYPES.INCIDENTAL ? 1 : 0,
    simple: cost === CHARACTER_ACTION_TYPES.SIMPLE ? 1 : 0,
    complex: cost === CHARACTER_ACTION_TYPES.COMPLEX ? 1 : 0,
    movement: 1
  };
}

function getCombatTurnStamp(combat = game.combat) {
  if (!combat?.started) return "no-combat";
  return `${combat.id ?? "combat"}:${combat.round ?? 0}:${combat.turn ?? 0}`;
}

function getCharacterTokenDocument(actor, explicitToken = null) {
  const explicit = explicitToken?.document ?? explicitToken;
  if (explicit) return explicit;
  const actorId = String(actor?.id ?? "");
  const controlled = canvas?.tokens?.controlled?.find?.(token => String(token?.actor?.id ?? "") === actorId);
  if (controlled?.document) return controlled.document;
  const combatant = game.combat?.combatants?.find?.(entry =>
    String(entry?.actorId ?? entry?.actor?.id ?? entry?.token?.actor?.id ?? "") === actorId
  );
  if (combatant?.token) return combatant.token;
  return canvas?.tokens?.placeables?.find?.(token => String(token?.actor?.id ?? "") === actorId)?.document ?? null;
}

function getActionTrackerDocument(actor, tokenDocument = null) {
  return getCharacterTokenDocument(actor, tokenDocument) ?? actor ?? null;
}

function getActionTrackerStamp(document) {
  return String(document?.getFlag?.(SYSTEM_ID, "turnStamp") ?? getCombatTurnStamp());
}

function emptyActionTracker(stamp) {
  return {
    stamp,
    counts: { incidental: 0, simple: 0, complex: 0 },
    entries: []
  };
}

function normalizeActionTracker(document) {
  const stamp = getActionTrackerStamp(document);
  const saved = document?.getFlag?.(SYSTEM_ID, "characterActionTracker") ?? document?.flags?.[SYSTEM_ID]?.characterActionTracker ?? null;
  if (!saved || String(saved.stamp ?? "") !== stamp) return emptyActionTracker(stamp);
  return {
    stamp,
    counts: {
      incidental: Math.max(0, wholeMp(saved?.counts?.incidental)),
      simple: Math.max(0, wholeMp(saved?.counts?.simple)),
      complex: Math.max(0, wholeMp(saved?.counts?.complex))
    },
    entries: Array.isArray(saved.entries) ? saved.entries.slice(-25) : []
  };
}

function getTrackedMovementMode(document) {
  const mode = String(document?.getFlag?.(SYSTEM_ID, "moveMode") ?? "stationary").trim().toLowerCase();
  return CHARACTER_MOVEMENT_MODES[mode] ? mode : "stationary";
}

export function getCharacterActionState(actor, { tokenDocument = null } = {}) {
  const document = getActionTrackerDocument(actor, tokenDocument);
  const tracker = normalizeActionTracker(document);
  const movement = getTrackedMovementMode(document);
  const validation = validateCharacterActionBudget({ movement, ...tracker.counts });
  const movementDefinition = CHARACTER_MOVEMENT_MODES[movement] ?? CHARACTER_MOVEMENT_MODES.stationary;
  return {
    document,
    stamp: tracker.stamp,
    counts: tracker.counts,
    entries: tracker.entries,
    movement,
    movementLabel: movementDefinition.label,
    movementActionCost: movementDefinition.actionCost,
    used: validation.used,
    limits: CHARACTER_ACTION_LIMITS,
    remaining: {
      incidental: Math.max(0, CHARACTER_ACTION_LIMITS.incidental - validation.used.incidental),
      simple: Math.max(0, CHARACTER_ACTION_LIMITS.simple - validation.used.simple),
      complex: Math.max(0, CHARACTER_ACTION_LIMITS.complex - validation.used.complex),
      movement: 0
    },
    valid: validation.valid,
    errors: validation.errors
  };
}

export function canSpendCharacterAction(actor, actionType, { count = 1, tokenDocument = null } = {}) {
  const type = String(actionType ?? "").trim().toLowerCase();
  if (![CHARACTER_ACTION_TYPES.INCIDENTAL, CHARACTER_ACTION_TYPES.SIMPLE, CHARACTER_ACTION_TYPES.COMPLEX].includes(type)) {
    return { ok: false, reason: `Unknown character action type: ${actionType}` };
  }
  const amount = Math.max(1, wholeMp(count));
  const state = getCharacterActionState(actor, { tokenDocument });
  const nextCounts = { ...state.counts, [type]: state.counts[type] + amount };
  const validation = validateCharacterActionBudget({ movement: state.movement, ...nextCounts });
  return {
    ok: validation.valid,
    reason: validation.errors[0] ?? "",
    errors: validation.errors,
    type,
    count: amount,
    state,
    nextCounts,
    nextUsed: validation.used
  };
}

export function canUseCharacterMovementMode(actor, movementMode, { tokenDocument = null } = {}) {
  const state = getCharacterActionState(actor, { tokenDocument });
  const movement = String(movementMode ?? "stationary").trim().toLowerCase();
  if (!CHARACTER_MOVEMENT_MODES[movement]) return { ok: false, reason: `Unknown movement type: ${movementMode}`, state };
  const validation = validateCharacterActionBudget({ movement, ...state.counts });
  return {
    ok: validation.valid,
    reason: validation.errors[0] ?? "",
    errors: validation.errors,
    movement,
    used: validation.used,
    state
  };
}

export async function spendCharacterAction(actor, actionType, { count = 1, label = "", tokenDocument = null } = {}) {
  const check = canSpendCharacterAction(actor, actionType, { count, tokenDocument });
  if (!check.ok) return check;
  const document = check.state.document;
  if (!document?.setFlag) return { ...check, ok: false, reason: "No actor or token document is available to track actions." };
  const entry = {
    type: check.type,
    count: check.count,
    label: String(label || CHARACTER_ACTION_DEFINITIONS[check.type]?.label || check.type),
    at: Date.now()
  };
  const tracker = {
    stamp: check.state.stamp,
    counts: check.nextCounts,
    entries: [...check.state.entries, entry].slice(-25)
  };
  await document.setFlag(SYSTEM_ID, "characterActionTracker", tracker);
  try { if (actor?.sheet?.rendered) actor.sheet.render(false); } catch (_) {}
  return { ...check, ok: true, tracker, state: getCharacterActionState(actor, { tokenDocument: document }) };
}

export async function refundCharacterAction(actor, actionType, { count = 1, tokenDocument = null } = {}) {
  const type = String(actionType ?? "").trim().toLowerCase();
  if (![CHARACTER_ACTION_TYPES.INCIDENTAL, CHARACTER_ACTION_TYPES.SIMPLE, CHARACTER_ACTION_TYPES.COMPLEX].includes(type)) {
    return { ok: false, reason: `Unknown character action type: ${actionType}` };
  }
  const state = getCharacterActionState(actor, { tokenDocument });
  if (!state.document?.setFlag) return { ok: false, reason: "No actor or token document is available to track actions." };
  const amount = Math.max(1, wholeMp(count));
  const counts = { ...state.counts, [type]: Math.max(0, state.counts[type] - amount) };
  const entries = state.entries.slice();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]?.type === type) {
      entries.splice(i, 1);
      break;
    }
  }
  await state.document.setFlag(SYSTEM_ID, "characterActionTracker", { stamp: state.stamp, counts, entries });
  try { if (actor?.sheet?.rendered) actor.sheet.render(false); } catch (_) {}
  return { ok: true, state: getCharacterActionState(actor, { tokenDocument: state.document }) };
}

export async function resetCharacterActions(actor, { tokenDocument = null } = {}) {
  const document = getActionTrackerDocument(actor, tokenDocument);
  if (!document?.setFlag) return { ok: false, reason: "No actor or token document is available to track actions." };
  const tracker = emptyActionTracker(getActionTrackerStamp(document));
  await document.setFlag(SYSTEM_ID, "characterActionTracker", tracker);
  try { if (actor?.sheet?.rendered) actor.sheet.render(false); } catch (_) {}
  return { ok: true, state: getCharacterActionState(actor, { tokenDocument: document }) };
}

export function registerCharacterActionHooks() {
  if (globalThis.__ATOW_CHARACTER_ACTION_HOOKS_REGISTERED__) return;
  globalThis.__ATOW_CHARACTER_ACTION_HOOKS_REGISTERED__ = true;
  Hooks.on("updateToken", (tokenDocument, changed) => {
    const actor = tokenDocument?.actor;
    if (String(actor?.type ?? "").toLowerCase() !== "character") return;
    const flattened = foundry.utils.flattenObject(changed ?? {});
    const relevant = Object.keys(flattened).some(key =>
      key.includes(`flags.${SYSTEM_ID}.characterActionTracker`)
      || key.endsWith(`flags.${SYSTEM_ID}.moveMode`)
      || key.endsWith(`flags.${SYSTEM_ID}.turnStamp`)
    );
    if (!relevant) return;
    try { if (actor?.sheet?.rendered) actor.sheet.render(false); } catch (_) {}
  });
}

export function getCharacterActionDefinitions() {
  return CHARACTER_ACTION_DEFINITIONS;
}

export function getCharacterMovementModes() {
  return CHARACTER_MOVEMENT_MODES;
}

export function getCharacterActionComplexityTable() {
  return CHARACTER_ACTION_COMPLEXITY_TABLE;
}

export function getCharacterMovementModeForMeters(metersMoved, movementRates = {}) {
  const meters = Math.max(0, num(metersMoved));
  const walk = Math.max(0, num(movementRates?.walk));
  const run = Math.max(walk, num(movementRates?.run));
  const sprint = Math.max(run, num(movementRates?.sprint));

  if (meters <= 0) return "stationary";
  if (walk > 0 && meters <= walk) return "walk";
  if (run > 0 && meters <= run) return "run";
  if (sprint > 0 && meters <= sprint) return "sprint";
  return sprint > 0 ? "sprint" : (run > 0 ? "run" : "walk");
}

export function getCharacterMovementManeuvers() {
  return CHARACTER_MOVEMENT_MANEUVERS;
}

export function getCharacterInitiativeModes() {
  return CHARACTER_INITIATIVE_MODES;
}

export function getCharacterInitiativeFormula(modeKey = "basic") {
  return CHARACTER_INITIATIVE_MODES[modeKey]?.formula ?? CHARACTER_INITIATIVE_MODES.basic.formula;
}

export function metersToCharacterMovementPoints(meters) {
  return wholeMp(num(meters) * CHARACTER_PERSONAL_SCALE.movementPointsPerMeter);
}

export function hexesToCharacterMovementPoints(hexes) {
  return metersToCharacterMovementPoints(num(hexes) * CHARACTER_PERSONAL_SCALE.metersPerHex);
}

export function getCharacterMovementModeBudget(movementRates = {}, modeKey = "stationary") {
  const mode = CHARACTER_MOVEMENT_MODES[modeKey] ?? CHARACTER_MOVEMENT_MODES.stationary;
  if (!mode.mayMove || !mode.derivedMoveKey) return 0;
  return metersToCharacterMovementPoints(movementRates?.[mode.derivedMoveKey] ?? 0);
}

export function getCharacterManeuverCost(maneuverKey, { facingSteps = 1, hexes = 1 } = {}) {
  const maneuver = CHARACTER_MOVEMENT_MANEUVERS[maneuverKey];
  if (!maneuver) return 0;
  if (maneuver.key === "enterHex") return hexesToCharacterMovementPoints(hexes);
  if (maneuver.perFacingStep) return wholeMp(maneuver.mp * Math.max(1, wholeMp(facingSteps)));
  return wholeMp(maneuver.mp);
}

export function summarizeCharacterMovementBudget({
  movement = "stationary",
  movementRates = {},
  mpSpent = 0,
  maneuvers = []
} = {}) {
  const maxMp = getCharacterMovementModeBudget(movementRates, movement);
  const maneuverMp = maneuvers.reduce((sum, maneuver) => {
    if (typeof maneuver === "string") return sum + getCharacterManeuverCost(maneuver);
    return sum + getCharacterManeuverCost(maneuver?.key, maneuver);
  }, 0);
  const spent = wholeMp(mpSpent) + maneuverMp;

  return {
    movement,
    scale: CHARACTER_PERSONAL_SCALE,
    maxMp,
    spent,
    maneuverMp,
    remaining: Math.max(0, maxMp - spent),
    overrun: Math.max(0, spent - maxMp),
    valid: spent <= maxMp
  };
}

export function validateCharacterMovementSpend(opts = {}) {
  const summary = summarizeCharacterMovementBudget(opts);
  const movementMode = CHARACTER_MOVEMENT_MODES[summary.movement] ?? CHARACTER_MOVEMENT_MODES.stationary;
  const errors = [];

  if (!movementMode.mayMove && summary.spent > 0) {
    errors.push("Stationary characters may not willingly spend movement points.");
  }
  if (summary.overrun > 0) {
    errors.push(`Not enough movement points: ${summary.spent} MP spent, ${summary.maxMp} MP available.`);
  }

  return {
    ...summary,
    movementMode,
    valid: errors.length === 0,
    errors
  };
}

export function summarizeCharacterActionBudget({ movement = "stationary", incidental = 0, simple = 0, complex = 0 } = {}) {
  const movementCounts = movementCostCounts(movement);
  const used = {
    incidental: num(incidental) + movementCounts.incidental,
    simple: num(simple) + movementCounts.simple,
    complex: num(complex) + movementCounts.complex,
    movement: movementCounts.movement
  };

  return {
    movement,
    limits: CHARACTER_ACTION_LIMITS,
    used,
    remaining: {
      incidental: Math.max(0, CHARACTER_ACTION_LIMITS.incidental - used.incidental),
      simple: Math.max(0, CHARACTER_ACTION_LIMITS.simple - used.simple),
      complex: Math.max(0, CHARACTER_ACTION_LIMITS.complex - used.complex),
      movement: Math.max(0, CHARACTER_ACTION_LIMITS.movement - used.movement)
    },
    valid: validateCharacterActionBudget({ movement, incidental, simple, complex }).valid
  };
}

export function validateCharacterActionBudget({ movement = "stationary", incidental = 0, simple = 0, complex = 0 } = {}) {
  const movementCounts = movementCostCounts(movement);
  const used = {
    incidental: num(incidental) + movementCounts.incidental,
    simple: num(simple) + movementCounts.simple,
    complex: num(complex) + movementCounts.complex,
    movement: movementCounts.movement
  };

  const errors = [];
  if (used.movement > CHARACTER_ACTION_LIMITS.movement) errors.push("A character may declare only one movement type per turn.");
  if (used.incidental > CHARACTER_ACTION_LIMITS.incidental) errors.push("A character may perform up to five Incidental Actions per turn.");
  if (used.simple > CHARACTER_ACTION_LIMITS.simple) errors.push("A character may perform up to two Simple Actions per turn.");
  if (used.complex > CHARACTER_ACTION_LIMITS.complex) errors.push("A character may perform only one Complex Action per turn.");
  if (used.complex > 0 && used.simple > 0) errors.push("Simple Actions and Complex Actions may not be combined in the same turn.");

  return {
    valid: errors.length === 0,
    errors,
    used,
    movementMode: CHARACTER_MOVEMENT_MODES[movement] ?? CHARACTER_MOVEMENT_MODES.stationary
  };
}

export function validateCharacterTurnActions({
  movement = "stationary",
  movementRates = {},
  movementManeuvers = [],
  incidentalActions = 0,
  simpleActions = 0,
  complexActions = 0
} = {}) {
  const movementSummary = validateCharacterMovementSpend({
    movement,
    movementRates,
    maneuvers: movementManeuvers
  });
  const movementCounts = movementCostCounts(movement);
  const actionSummary = validateCharacterActionBudget({
    movement,
    incidental: incidentalActions,
    simple: simpleActions,
    complex: complexActions
  });

  const errors = [...movementSummary.errors, ...actionSummary.errors];
  const extraActionSpend = {
    incidental: Math.max(0, actionSummary.used.incidental - movementCounts.incidental),
    simple: Math.max(0, actionSummary.used.simple - movementCounts.simple),
    complex: Math.max(0, actionSummary.used.complex - movementCounts.complex)
  };

  return {
    valid: errors.length === 0,
    errors,
    movement: movementSummary,
    actions: actionSummary,
    extraActionSpend,
    hasSimpleAction: extraActionSpend.simple > 0,
    hasComplexAction: extraActionSpend.complex > 0,
    canMixSimpleAndComplex: !(extraActionSpend.simple > 0 && extraActionSpend.complex > 0)
  };
}

export function registerCharacterCombatApi(namespace) {
  if (!namespace) return null;
  namespace.config = namespace.config ?? {};
  namespace.api = namespace.api ?? {};
  registerCharacterActionHooks();

  namespace.config.characterCombat = {
    scale: CHARACTER_PERSONAL_SCALE,
    actionTypes: CHARACTER_ACTION_TYPES,
    actionLimits: CHARACTER_ACTION_LIMITS,
    actions: CHARACTER_ACTION_DEFINITIONS,
    actionComplexityTable: CHARACTER_ACTION_COMPLEXITY_TABLE,
    movementModes: CHARACTER_MOVEMENT_MODES,
    movementManeuvers: CHARACTER_MOVEMENT_MANEUVERS,
    initiativeModes: CHARACTER_INITIATIVE_MODES,
    initiativeModifiers: CHARACTER_INITIATIVE_MODIFIERS
  };

  namespace.api.characterCombat = {
    getActionDefinitions: getCharacterActionDefinitions,
    getActionComplexityTable: getCharacterActionComplexityTable,
    getMovementModes: getCharacterMovementModes,
    getMovementManeuvers: getCharacterMovementManeuvers,
    getInitiativeModes: getCharacterInitiativeModes,
    getInitiativeFormula: getCharacterInitiativeRollFormula,
    getInitiativeDetails: getCharacterInitiativeDetails,
    metersToMovementPoints: metersToCharacterMovementPoints,
    hexesToMovementPoints: hexesToCharacterMovementPoints,
    getMovementModeBudget: getCharacterMovementModeBudget,
    getMovementModeForMeters: getCharacterMovementModeForMeters,
    getManeuverCost: getCharacterManeuverCost,
    summarizeMovementBudget: summarizeCharacterMovementBudget,
    validateMovementSpend: validateCharacterMovementSpend,
    summarizeActionBudget: summarizeCharacterActionBudget,
    validateActionBudget: validateCharacterActionBudget,
    validateTurnActions: validateCharacterTurnActions,
    getActionState: getCharacterActionState,
    canSpendAction: canSpendCharacterAction,
    canUseMovementMode: canUseCharacterMovementMode,
    spendAction: spendCharacterAction,
    refundAction: refundCharacterAction,
    resetActions: resetCharacterActions
  };

  console.log(`${SYSTEM_ID} | Registered character combat rules API`);
  return namespace.api.characterCombat;
}
