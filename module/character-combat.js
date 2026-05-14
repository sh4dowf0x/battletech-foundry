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
    examples: Object.freeze(["Stationary", "Walk", "Run", "Sprint", "Crawl", "Climb", "Swim"]),
    mayCombineWith: Object.freeze(["incidental", "simple", "complex"])
  })
});

export const CHARACTER_MOVEMENT_MODES = Object.freeze({
  stationary: Object.freeze({
    key: "stationary",
    label: "Stationary",
    actionCost: CHARACTER_ACTION_TYPES.INCIDENTAL,
    mayMove: false,
    derivedMoveKey: null,
    summary: "Default if no movement is declared; the character may not willingly move this turn."
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
    mp: 1,
    perFacingStep: true,
    summary: "Turn one hexside/facing step."
  }),
  aboutFace: Object.freeze({
    key: "aboutFace",
    label: "About Face",
    mp: 3,
    summary: "Turn three hexsides/facing steps."
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

export function getCharacterActionDefinitions() {
  return CHARACTER_ACTION_DEFINITIONS;
}

export function getCharacterMovementModes() {
  return CHARACTER_MOVEMENT_MODES;
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

  namespace.config.characterCombat = {
    scale: CHARACTER_PERSONAL_SCALE,
    actionTypes: CHARACTER_ACTION_TYPES,
    actionLimits: CHARACTER_ACTION_LIMITS,
    actions: CHARACTER_ACTION_DEFINITIONS,
    movementModes: CHARACTER_MOVEMENT_MODES,
    movementManeuvers: CHARACTER_MOVEMENT_MANEUVERS,
    initiativeModes: CHARACTER_INITIATIVE_MODES,
    initiativeModifiers: CHARACTER_INITIATIVE_MODIFIERS
  };

  namespace.api.characterCombat = {
    getActionDefinitions: getCharacterActionDefinitions,
    getMovementModes: getCharacterMovementModes,
    getMovementManeuvers: getCharacterMovementManeuvers,
    getInitiativeModes: getCharacterInitiativeModes,
    getInitiativeFormula: getCharacterInitiativeFormula,
    metersToMovementPoints: metersToCharacterMovementPoints,
    hexesToMovementPoints: hexesToCharacterMovementPoints,
    getMovementModeBudget: getCharacterMovementModeBudget,
    getManeuverCost: getCharacterManeuverCost,
    summarizeMovementBudget: summarizeCharacterMovementBudget,
    validateMovementSpend: validateCharacterMovementSpend,
    summarizeActionBudget: summarizeCharacterActionBudget,
    validateActionBudget: validateCharacterActionBudget,
    validateTurnActions: validateCharacterTurnActions
  };

  console.log(`${SYSTEM_ID} | Registered character combat rules API`);
  return namespace.api.characterCombat;
}
