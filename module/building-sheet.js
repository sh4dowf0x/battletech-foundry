// Advanced Building actor sheet for AToW BattleTech.
// Steps 1-2: superstructure and building armor.

import { normalizeBuildingHexes } from "./building-combat.js";
import { promptAndRollWeaponAttack } from "./mech-attack.js";

const SYSTEM_ID = "atow-battletech";
const TEMPLATE = `systems/${SYSTEM_ID}/templates/building-sheet.hbs`;
const SHEET_CSS = `systems/${SYSTEM_ID}/styles/building-sheet.css`;
const SHEET_CSS_ID = "atow-building-sheet-css";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;

const TECH_BASES = Object.freeze([
  { value: "innerSphere", label: "Inner Sphere" },
  { value: "clan", label: "Clan" }
]);

const BUILDING_TYPES = Object.freeze([
  { value: "none", label: "Not Applicable" },
  { value: "light", label: "Light" },
  { value: "medium", label: "Medium" },
  { value: "heavy", label: "Heavy" },
  { value: "hardened", label: "Hardened" },
  { value: "rail", label: "Rail" }
]);

const CLASSIFICATIONS = Object.freeze([
  { value: "standard", label: "Standard Building" },
  { value: "hangar", label: "Hangar" },
  { value: "tent", label: "Tent" },
  { value: "wall", label: "Wall" },
  { value: "fence", label: "Fence" },
  { value: "bridge", label: "Bridge" },
  { value: "gunEmplacement", label: "Gun Emplacement" },
  { value: "fortress", label: "Fortress" },
  { value: "castlesBrian", label: "Castles Brian" },
  { value: "other", label: "Other" }
]);

const ARMORED_CLASSIFICATIONS = new Set(["wall", "gunEmplacement", "fortress", "castlesBrian"]);
const ZERO_INTERNAL_CAPACITY = new Set(["tent", "fence", "bridge"]);
const LIGHT_MEDIUM_WEAPON_CLASSES = new Set(["hangar", "standard", "wall"]);
const HEAVY_WEAPON_CLASSES = new Set(["gunEmplacement", "fortress", "castlesBrian"]);
const CAPITAL_WEAPON_CLASSES = new Set(["fortress", "castlesBrian"]);
const COMPONENT_ITEM_TYPES = new Set(["mechWeapon", "mechEquipment", "characterWeapon"]);

const POWER_SOURCES = Object.freeze([
  { value: "grid", label: "Local Grid / Indirect Power" },
  { value: "solar", label: "Solar / Power Collection" },
  { value: "nonFusion", label: "Non-Fusion Generator" },
  { value: "fusion", label: "Fusion Generator" },
  { value: "fission", label: "Fission Generator" }
]);

const WEAPON_CLASSES = Object.freeze([
  { value: "lightMedium", label: "Light / Medium" },
  { value: "heavy", label: "Heavy" },
  { value: "capital", label: "Capital" },
  { value: "equipment", label: "Equipment" }
]);

const BUILDING_CLASSIFICATION_RULES = Object.freeze({
  tent: Object.freeze({
    none: Object.freeze({ cfMin: 1, cfMax: 2, maxHexes: 1, maxLevels: 1, mpCost: 0, skillMod: null, damageBuilding: 1, damageUnits: 0 })
  }),
  hangar: Object.freeze({
    light: Object.freeze({ cfMin: 1, cfMax: 8, maxHexes: 10, maxLevels: 7, mpCost: 0, skillMod: 0, damageBuilding: 1, damageUnits: 0.5 }),
    medium: Object.freeze({ cfMin: 9, cfMax: 16, maxHexes: 14, maxLevels: 10, mpCost: 1, skillMod: 0, damageBuilding: 1, damageUnits: 0.5 }),
    heavy: Object.freeze({ cfMin: 17, cfMax: 45, maxHexes: 18, maxLevels: 13, mpCost: 2, skillMod: 1, damageBuilding: 1, damageUnits: 0.5 }),
    hardened: Object.freeze({ cfMin: 46, cfMax: 75, maxHexes: 20, maxLevels: 14, mpCost: 3, skillMod: 3, damageBuilding: 1, damageUnits: 0.5 })
  }),
  standard: Object.freeze({
    light: Object.freeze({ cfMin: 1, cfMax: 15, maxHexes: 6, maxLevels: 5, mpCost: 1, skillMod: 0, damageBuilding: 1, damageUnits: 1 }),
    medium: Object.freeze({ cfMin: 16, cfMax: 40, maxHexes: 8, maxLevels: 8, mpCost: 2, skillMod: 1, damageBuilding: 1, damageUnits: 1 }),
    heavy: Object.freeze({ cfMin: 41, cfMax: 90, maxHexes: 10, maxLevels: 10, mpCost: 3, skillMod: 2, damageBuilding: 1, damageUnits: 1 })
  }),
  fence: Object.freeze({
    none: Object.freeze({ cfMin: 1, cfMax: 1, maxHexes: null, maxLevels: 3, mpCost: 1, skillMod: null, damageBuilding: 1, damageUnits: 0 })
  }),
  wall: Object.freeze({
    light: Object.freeze({ cfMin: 1, cfMax: 15, maxHexes: null, maxLevels: 4, mpCost: 1, skillMod: 0, damageBuilding: 1, damageUnits: 0.5 }),
    medium: Object.freeze({ cfMin: 16, cfMax: 40, maxHexes: null, maxLevels: 6, mpCost: 2, skillMod: 0, damageBuilding: 1, damageUnits: 0.5 }),
    heavy: Object.freeze({ cfMin: 41, cfMax: 90, maxHexes: null, maxLevels: 8, mpCost: 3, skillMod: 1, damageBuilding: 1, damageUnits: 0.5 }),
    hardened: Object.freeze({ cfMin: 91, cfMax: 150, maxHexes: null, maxLevels: 10, mpCost: 4, skillMod: 3, damageBuilding: 1, damageUnits: 0.5 })
  }),
  bridge: Object.freeze({
    light: Object.freeze({ cfMin: 1, cfMax: 15, maxHexes: null, maxLevels: null, mpCost: null, skillMod: null, damageBuilding: 1, damageUnits: 1 }),
    medium: Object.freeze({ cfMin: 16, cfMax: 40, maxHexes: null, maxLevels: null, mpCost: null, skillMod: null, damageBuilding: 1, damageUnits: 1 }),
    heavy: Object.freeze({ cfMin: 41, cfMax: 90, maxHexes: null, maxLevels: null, mpCost: null, skillMod: null, damageBuilding: 1, damageUnits: 1 }),
    hardened: Object.freeze({ cfMin: 91, cfMax: 150, maxHexes: null, maxLevels: null, mpCost: null, skillMod: null, damageBuilding: 1, damageUnits: 1 }),
    rail: Object.freeze({ cfMin: 151, cfMax: 650, maxHexes: null, maxLevels: null, mpCost: null, skillMod: null, damageBuilding: 1, damageUnits: 1 })
  }),
  gunEmplacement: Object.freeze({
    light: Object.freeze({ cfMin: 1, cfMax: 15, maxHexes: 1, maxLevels: 1, mpCost: null, skillMod: null, damageBuilding: 0.5, damageUnits: 2 }),
    medium: Object.freeze({ cfMin: 16, cfMax: 40, maxHexes: 1, maxLevels: 1, mpCost: null, skillMod: null, damageBuilding: 0.5, damageUnits: 2 }),
    heavy: Object.freeze({ cfMin: 41, cfMax: 90, maxHexes: 1, maxLevels: 1, mpCost: null, skillMod: null, damageBuilding: 0.5, damageUnits: 2 }),
    hardened: Object.freeze({ cfMin: 91, cfMax: 150, maxHexes: 1, maxLevels: 1, mpCost: null, skillMod: null, damageBuilding: 0.5, damageUnits: 2 })
  }),
  fortress: Object.freeze({
    medium: Object.freeze({ cfMin: 16, cfMax: 40, maxHexes: 12, maxLevels: 15, mpCost: 3, skillMod: 2, damageBuilding: 0.5, damageUnits: 2 }),
    heavy: Object.freeze({ cfMin: 41, cfMax: 90, maxHexes: 15, maxLevels: 20, mpCost: 4, skillMod: 3, damageBuilding: 0.5, damageUnits: 2 }),
    hardened: Object.freeze({ cfMin: 91, cfMax: 150, maxHexes: 20, maxLevels: 30, mpCost: 5, skillMod: 4, damageBuilding: 0.5, damageUnits: 2 })
  }),
  castlesBrian: Object.freeze({
    heavy: Object.freeze({ cfMin: 35, cfMax: 90, maxHexes: 35, maxLevels: 10, mpCost: 4, skillMod: 4, damageBuilding: "Capital", damageUnits: "Capital" }),
    hardened: Object.freeze({ cfMin: 91, cfMax: 150, maxHexes: 70, maxLevels: 15, mpCost: 5, skillMod: 5, damageBuilding: "Capital", damageUnits: "Capital" })
  })
});

function clampInt(value, min, max, fallback = min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundUpTenth(value) {
  return Math.ceil((Math.max(0, finiteNumber(value, 0)) - 1e-9) * 10) / 10;
}

function itemTonnage(item) {
  const system = item?.system ?? {};
  if (item?.type === "characterWeapon") {
    return Math.max(0, finiteNumber(system?.mass?.weaponKg, 0) / 1000);
  }
  return Math.max(0, finiteNumber(system.tonnage ?? system.tons ?? system.weight, 0));
}

function defaultComponentClass(item) {
  if (item?.type === "characterWeapon") return "lightMedium";
  if (item?.type === "mechWeapon") return "heavy";
  return "equipment";
}

function componentClassOptionsForItem(item) {
  if (item?.type === "characterWeapon") return WEAPON_CLASSES.filter(option => option.value === "lightMedium");
  if (item?.type === "mechWeapon") return WEAPON_CLASSES.filter(option => ["heavy", "capital"].includes(option.value));
  return WEAPON_CLASSES.filter(option => option.value === "equipment");
}

function normalizedComponentClass(item) {
  const raw = String(item?.system?.buildingMount?.weaponClass ?? "").trim();
  const options = componentClassOptionsForItem(item);
  return options.some(option => option.value === raw) ? raw : defaultComponentClass(item);
}

function detectEnergyWeapon(item) {
  if (!item || !["mechWeapon", "characterWeapon"].includes(item.type)) return false;
  const mount = item.system?.buildingMount ?? {};
  if (Object.prototype.hasOwnProperty.call(mount, "energyWeapon")) return Boolean(mount.energyWeapon);
  const text = `${item.name ?? ""} ${item.system?.dmgType ?? ""} ${item.system?.weaponCategory ?? ""} ${item.system?.specialRules ?? ""}`.toLowerCase();
  return /\b(?:energy|laser|ppc|flamer|plasma)\b/.test(text);
}

function componentClassAllowed(classification, weaponClass) {
  if (weaponClass === "equipment") return true;
  if (weaponClass === "lightMedium") return LIGHT_MEDIUM_WEAPON_CLASSES.has(classification);
  if (weaponClass === "heavy") return HEAVY_WEAPON_CLASSES.has(classification);
  if (weaponClass === "capital") return CAPITAL_WEAPON_CLASSES.has(classification);
  return false;
}

function optionList(options, selected) {
  return options.map(option => ({ ...option, selected: option.value === selected }));
}

function normalizedClassification(value) {
  const raw = String(value ?? "standard").trim();
  return CLASSIFICATIONS.some(option => option.value === raw) ? raw : "other";
}

function availableTypesForClassification(classification) {
  const keys = Object.keys(BUILDING_CLASSIFICATION_RULES[classification] ?? {});
  if (!keys.length) return BUILDING_TYPES.filter(option => !["none", "rail"].includes(option.value));
  return keys.map(key => BUILDING_TYPES.find(option => option.value === key) ?? { value: key, label: key });
}

function multiplierLabel(value) {
  if (typeof value === "number") return `x${value}`;
  return String(value ?? "NA");
}

function calculateBuildingDesign(system) {
  const building = system?.building ?? {};
  const classification = normalizedClassification(building.classification);
  const availableTypes = availableTypesForClassification(classification);
  const requestedType = String(building.type ?? "medium").trim();
  const type = availableTypes.some(option => option.value === requestedType)
    ? requestedType
    : (availableTypes[0]?.value ?? requestedType);
  const classificationRule = BUILDING_CLASSIFICATION_RULES[classification]?.[type] ?? null;
  const techBase = String(building.techBase ?? "innerSphere") === "clan" ? "clan" : "innerSphere";
  const levels = clampInt(building.levels, 1, 100, 1);
  const hexCount = clampInt(building.size?.hexes, 1, 999, 1);
  const cf = Math.max(1, Math.floor(finiteNumber(building.cf, 1)));
  const canInstallArmor = ARMORED_CLASSIFICATIONS.has(classification);
  const requestedArmorTonsPerHex = Math.max(0, Math.floor(finiteNumber(building.armor?.tonsPerHex, 0)));
  const armorTonsPerHex = canInstallArmor ? requestedArmorTonsPerHex : 0;
  const armorPointsPerTon = techBase === "clan" ? 20 : 16;
  const standardArmorPointsPerHex = armorTonsPerHex * armorPointsPerTon;
  const capitalScale = classification === "castlesBrian";
  const rawArmorFactorPerHex = capitalScale ? Math.floor(standardArmorPointsPerHex / 10) : standardArmorPointsPerHex;
  const maxArmorFactorPerHex = canInstallArmor
    ? cf * (capitalScale ? 2 : 1)
    : 0;
  const armorFactorPerHex = Math.min(rawArmorFactorPerHex, maxArmorFactorPerHex);
  const maxArmorTonsPerHex = !canInstallArmor
    ? 0
    : capitalScale
      ? Math.ceil((maxArmorFactorPerHex * 10) / armorPointsPerTon)
      : Math.ceil(maxArmorFactorPerHex / armorPointsPerTon);
  const usedStandardArmorPoints = capitalScale ? armorFactorPerHex * 10 : armorFactorPerHex;
  const unusedArmorPointsPerHex = Math.max(0, standardArmorPointsPerHex - usedStandardArmorPoints);

  let internalCapacityPerHex;
  let capacityRule;
  if (ZERO_INTERNAL_CAPACITY.has(classification)) {
    internalCapacityPerHex = 0;
    capacityRule = "This classification has no internal equipment capacity.";
  } else if (classification === "hangar") {
    const structuralCapacity = cf * levels * 3;
    const openFrameCap = 600 * Math.ceil(levels / 4);
    internalCapacityPerHex = Math.min(structuralCapacity, openFrameCap);
    capacityRule = `Hangar capacity is triple CF x levels, capped at ${openFrameCap} tons for ${levels} level${levels === 1 ? "" : "s"}.`;
  } else if (classification === "castlesBrian") {
    internalCapacityPerHex = cf * 10 * levels;
    capacityRule = "Castles Brian use capital-scale CF: each CF supports 10 tons per level, per hex.";
  } else {
    internalCapacityPerHex = cf * levels;
    capacityRule = "Internal capacity equals CF x levels for each building hex.";
  }

  const equipmentCapacityAfterArmorPerHex = Math.max(0, internalCapacityPerHex - armorTonsPerHex);
  const validationIssues = [];
  if (!classificationRule) {
    validationIssues.push("No classification/type rules are available for this combination.");
  } else {
    if (requestedType !== type) {
      const label = availableTypes.find(option => option.value === type)?.label ?? type;
      validationIssues.push(`The selected building type is unavailable; use ${label}.`);
    }
    if (cf < classificationRule.cfMin || cf > classificationRule.cfMax) {
      validationIssues.push(`CF must be between ${classificationRule.cfMin} and ${classificationRule.cfMax}.`);
    }
    if (classificationRule.maxHexes !== null && hexCount > classificationRule.maxHexes) {
      validationIssues.push(`This design is limited to ${classificationRule.maxHexes} hex${classificationRule.maxHexes === 1 ? "" : "es"}.`);
    }
    if (classificationRule.maxLevels !== null && levels > classificationRule.maxLevels) {
      validationIssues.push(`This design is limited to ${classificationRule.maxLevels} level${classificationRule.maxLevels === 1 ? "" : "s"}.`);
    }
  }
  if (!canInstallArmor && requestedArmorTonsPerHex > 0) {
    validationIssues.push("This building classification may not install armor.");
  }
  if (armorTonsPerHex > maxArmorTonsPerHex) {
    validationIssues.push(`No more than ${maxArmorTonsPerHex} full ton${maxArmorTonsPerHex === 1 ? "" : "s"} of armor may be installed per hex.`);
  }
  if (armorTonsPerHex > internalCapacityPerHex) {
    validationIssues.push(`Armor tonnage exceeds the internal capacity of each hex.`);
  }

  return {
    classification,
    type,
    requestedType,
    availableTypes,
    classificationRule,
    techBase,
    levels,
    hexCount,
    cf,
    capitalScale,
    standardScaleCfPerHex: capitalScale ? cf * 10 : cf,
    canInstallArmor,
    requestedArmorTonsPerHex,
    armorTonsPerHex,
    armorPointsPerTon,
    standardArmorPointsPerHex,
    rawArmorFactorPerHex,
    armorFactorPerHex,
    maxArmorFactorPerHex,
    maxArmorTonsPerHex,
    unusedArmorPointsPerHex,
    armorTotalTonnage: armorTonsPerHex * hexCount,
    internalCapacityPerHex,
    internalCapacityTotal: internalCapacityPerHex * hexCount,
    equipmentCapacityAfterArmorPerHex,
    equipmentCapacityAfterArmorTotal: equipmentCapacityAfterArmorPerHex * hexCount,
    armorExceedsCapacity: armorTonsPerHex > internalCapacityPerHex,
    armorExceedsMaximum: armorTonsPerHex > maxArmorTonsPerHex,
    cfMin: classificationRule?.cfMin ?? 1,
    cfMax: classificationRule?.cfMax ?? 999,
    maxHexes: classificationRule?.maxHexes ?? null,
    maxLevels: classificationRule?.maxLevels ?? null,
    maxHexesLabel: classificationRule?.maxHexes == null ? "Unlimited" : String(classificationRule.maxHexes),
    maxLevelsLabel: classificationRule?.maxLevels == null ? "N/A" : String(classificationRule.maxLevels),
    mpCost: classificationRule?.mpCost ?? null,
    mpCostLabel: classificationRule?.mpCost == null ? "N/A" : `+${classificationRule.mpCost}`,
    skillMod: classificationRule?.skillMod ?? null,
    skillModLabel: classificationRule?.skillMod == null ? "N/A" : `+${classificationRule.skillMod}`,
    damageBuilding: classificationRule?.damageBuilding ?? null,
    damageUnits: classificationRule?.damageUnits ?? null,
    damageBuildingLabel: multiplierLabel(classificationRule?.damageBuilding),
    damageUnitsLabel: multiplierLabel(classificationRule?.damageUnits),
    validationIssues,
    valid: validationIssues.length === 0,
    capacityRule
  };
}

function normalizedHexes(building, count) {
  return normalizeBuildingHexes(building, count, building?.levels ?? 1);
}

function parseFormValue(input) {
  if (!input) return null;
  if (input.type === "checkbox") return Boolean(input.checked);
  if (input.type === "number") {
    const n = Number(input.value);
    return Number.isFinite(n) ? n : 0;
  }
  return input.value ?? "";
}

function buildDamagePips(max, damage) {
  const limit = Math.max(0, Math.floor(finiteNumber(max, 0)));
  const current = Math.min(limit, Math.max(0, Math.floor(finiteNumber(damage, 0))));
  const scale = Math.max(1, Math.ceil(limit / 200));
  const count = Math.ceil(limit / scale);
  return Array.from({ length: count }, (_, index) => {
    const start = (index * scale) + 1;
    const end = Math.min(limit, (index + 1) * scale);
    return {
      n: end,
      start,
      filled: current >= end,
      partial: current >= start && current < end,
      label: start === end ? String(end) : `${start}-${end}`
    };
  });
}

function damagePipScale(max) {
  return Math.max(1, Math.ceil(Math.max(0, finiteNumber(max, 0)) / 200));
}

function buildComponentContext(actor, design, hexes, building) {
  const source = String(building?.power?.source ?? "grid");
  const powerSource = POWER_SOURCES.some(option => option.value === source) ? source : "grid";
  const amplifiersRequired = !["fusion", "fission"].includes(powerSource);
  const usage = hexes.map((hex, index) => ({
    index,
    id: hex.id,
    componentTons: 0,
    heavyCapitalEnergyTons: 0,
    amplifierTons: 0,
    unspecifiedTons: Math.max(0, finiteNumber(hex.unspecifiedTons, 0)),
    lightMediumWeapons: 0,
    heavyCapitalWeaponTons: 0,
    heatDissipation: 0,
    issues: []
  }));

  const components = Array.from(actor?.items ?? [])
    .filter(item => COMPONENT_ITEM_TYPES.has(item?.type))
    .map(item => {
      const mount = item.system?.buildingMount ?? {};
      const rawIndex = Math.floor(finiteNumber(mount.hexIndex, 0));
      const hexIndex = Math.min(Math.max(0, rawIndex), Math.max(0, hexes.length - 1));
      const quantity = clampInt(mount.quantity, 1, 999, 1);
      const level = clampInt(mount.level, 1, design.levels, 1);
      const weaponClass = normalizedComponentClass(item);
      const storedWeaponClass = String(mount.weaponClass ?? "").trim();
      const classWasNormalized = Boolean(storedWeaponClass) && storedWeaponClass !== weaponClass;
      const tonsEach = itemTonnage(item);
      const totalTons = tonsEach * quantity;
      const energyWeapon = detectEnergyWeapon(item);
      const isWeapon = ["mechWeapon", "characterWeapon"].includes(item.type);
      const range = item.system?.range ?? {};
      const classAllowed = componentClassAllowed(design.classification, weaponClass);
      const rowIssues = [];
      if (classWasNormalized) rowIssues.push(`Invalid component class was treated as ${weaponClass}.`);
      if (!classAllowed) rowIssues.push(`${weaponClass === "lightMedium" ? "Light/Medium" : weaponClass} weapons are not permitted by this classification.`);
      if (weaponClass === "heavy" && tonsEach > 0 && tonsEach < 0.25) rowIssues.push("Heavy weapons must weigh at least 0.25 tons.");
      if (tonsEach <= 0) rowIssues.push("Component tonnage is 0; set its weight on the item sheet.");
      if (rawIndex !== hexIndex) rowIssues.push("Assigned hex no longer exists; reassigned to the nearest available hex.");

      const target = usage[hexIndex];
      target.componentTons += totalTons;
      if (weaponClass === "lightMedium") target.lightMediumWeapons += quantity;
      if (["heavy", "capital"].includes(weaponClass)) {
        target.heavyCapitalWeaponTons += totalTons;
        if (energyWeapon && amplifiersRequired) target.heavyCapitalEnergyTons += totalTons;
      }
      if (item.type === "mechEquipment") {
        target.heatDissipation += Math.max(0, finiteNumber(item.system?.heatDissipation, 0)) * quantity;
      }

      return {
        id: item.id,
        uuid: item.uuid,
        name: item.name,
        img: item.img,
        itemType: item.type,
        itemTypeLabel: item.type === "characterWeapon" ? "Infantry Weapon" : item.type === "mechWeapon" ? "Heavy Weapon" : "Equipment",
        hexIndex,
        hexLabel: hexes[hexIndex]?.id ?? `H${hexIndex + 1}`,
        level,
        turret: Boolean(mount.turret),
        destroyed: Boolean(mount.destroyed),
        malfunctioned: Boolean(mount.malfunctioned),
        quantity,
        weaponClass,
        weaponClassOptions: optionList(componentClassOptionsForItem(item), weaponClass),
        hexOptions: hexes.map((hex, index) => ({ value: index, label: hex.id, selected: index === hexIndex })),
        levelOptions: Array.from({ length: design.levels }, (_, index) => ({ value: index + 1, label: index + 1, selected: index + 1 === level })),
        tonsEach,
        totalTons,
        energyWeapon,
        isWeapon,
        damage: finiteNumber(item.system?.damage, 0),
        rangeLabel: isWeapon
          ? [range.min, range.short, range.medium, range.long].map(value => finiteNumber(value, 0)).join("/")
          : "",
        classAllowed,
        issues: rowIssues,
        hasIssues: rowIssues.length > 0
      };
    })
    .sort((left, right) => {
      const typeOrder = { mechEquipment: 0, mechWeapon: 1, characterWeapon: 2 };
      const leftOrder = typeOrder[left.itemType] ?? 99;
      const rightOrder = typeOrder[right.itemType] ?? 99;
      return (leftOrder - rightOrder)
        || left.itemTypeLabel.localeCompare(right.itemTypeLabel)
        || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
    });

  const componentIssues = [];
  for (const component of components) {
    for (const issue of component.issues) componentIssues.push(`${component.name}: ${issue}`);
  }

  let totalComponentTons = 0;
  let totalAmplifierTons = 0;
  let totalUnspecifiedTons = 0;
  let totalHeatDissipation = 0;
  const hexUsage = usage.map(entry => {
    entry.amplifierTons = amplifiersRequired ? roundUpTenth(entry.heavyCapitalEnergyTons * 0.1) : 0;
    const lightMediumLimit = 6 * design.levels;
    if (entry.lightMediumWeapons > lightMediumLimit) {
      entry.issues.push(`Light/Medium weapons ${entry.lightMediumWeapons}/${lightMediumLimit}.`);
    }

    let heavyWeaponLimit = null;
    let heavyWeaponLimitLabel = "Mobile Structure rule pending";
    if (design.classification === "gunEmplacement") {
      heavyWeaponLimit = Math.floor(design.cf / 3);
      heavyWeaponLimitLabel = `${heavyWeaponLimit} t (CF / 3)`;
    } else if (design.classification === "castlesBrian") {
      heavyWeaponLimit = design.cf;
      heavyWeaponLimitLabel = `${heavyWeaponLimit} t (CF, undivided)`;
    }
    if (heavyWeaponLimit !== null && entry.heavyCapitalWeaponTons > heavyWeaponLimit) {
      entry.issues.push(`Heavy/Capital weapon tonnage ${entry.heavyCapitalWeaponTons} exceeds the ${heavyWeaponLimit}-ton limit.`);
    }

    entry.usedTons = entry.componentTons + entry.amplifierTons + entry.unspecifiedTons;
    entry.capacity = design.equipmentCapacityAfterArmorPerHex;
    entry.remainingTons = entry.capacity - entry.usedTons;
    if (entry.remainingTons < 0) entry.issues.push(`Installed components exceed available capacity by ${Math.abs(entry.remainingTons)} tons.`);
    entry.lightMediumLimit = lightMediumLimit;
    entry.heavyWeaponLimit = heavyWeaponLimit;
    entry.heavyWeaponLimitLabel = heavyWeaponLimitLabel;
    entry.hasIssues = entry.issues.length > 0;
    for (const issue of entry.issues) componentIssues.push(`${entry.id}: ${issue}`);

    totalComponentTons += entry.componentTons;
    totalAmplifierTons += entry.amplifierTons;
    totalUnspecifiedTons += entry.unspecifiedTons;
    totalHeatDissipation += entry.heatDissipation;
    return entry;
  });

  return {
    powerSource,
    powerSources: optionList(POWER_SOURCES, powerSource),
    amplifiersRequired,
    components,
    hexUsage,
    componentIssues,
    hasComponentIssues: componentIssues.length > 0,
    totalComponentTons,
    totalAmplifierTons,
    totalUnspecifiedTons,
    totalHeatDissipation,
    totalUsedTons: totalComponentTons + totalAmplifierTons + totalUnspecifiedTons
  };
}

export class ATOWBuildingSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  static _ensureSheetStyles() {
    if (document.getElementById(SHEET_CSS_ID)) return;
    const link = document.createElement("link");
    link.id = SHEET_CSS_ID;
    link.rel = "stylesheet";
    link.type = "text/css";
    link.href = SHEET_CSS;
    document.head.appendChild(link);
  }

  static DEFAULT_OPTIONS = foundry.utils.mergeObject(
    super.DEFAULT_OPTIONS,
    {
      classes: ["atow", "sheet", "actor", "building", "battletech"],
      position: { width: 1200, height: 860 },
      window: { resizable: true },
      form: { submitOnChange: true, closeOnSubmit: false }
    },
    { inplace: false }
  );

  static PARTS = { form: { template: TEMPLATE } };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const system = this.actor.system ?? {};
    const building = system.building ?? {};
    const design = calculateBuildingDesign(system);
    const baseHexes = normalizedHexes(building, design.hexCount);
    const componentContext = buildComponentContext(this.actor, design, baseHexes, building);
    const hexes = baseHexes.map((hex, index) => {
      const cfDamage = Math.min(design.cf, hex.cfDamage);
      const armorDamage = Math.min(design.armorFactorPerHex, hex.armorDamage);
      const levelTracks = hex.levels.map(level => {
        const levelCfDamage = Math.min(design.cf, level.cfDamage);
        const levelArmorDamage = Math.min(design.armorFactorPerHex, level.armorDamage);
        return {
          ...level,
          index: Math.max(0, Number(level.level ?? 1) - 1),
          cfDamage: levelCfDamage,
          cfRemaining: Math.max(0, design.cf - levelCfDamage),
          armorDamage: levelArmorDamage,
          armorRemaining: Math.max(0, design.armorFactorPerHex - levelArmorDamage),
          armorPips: buildDamagePips(design.armorFactorPerHex, levelArmorDamage),
          cfPips: buildDamagePips(design.cf, levelCfDamage),
          armorPipScale: damagePipScale(design.armorFactorPerHex),
          cfPipScale: damagePipScale(design.cf),
          armorPipsGrouped: damagePipScale(design.armorFactorPerHex) > 1,
          cfPipsGrouped: damagePipScale(design.cf) > 1,
          armorDestroyed: design.armorFactorPerHex > 0 && levelArmorDamage >= design.armorFactorPerHex,
          collapsed: level.collapsed || levelCfDamage >= design.cf
        };
      });
      return {
        ...hex,
        index,
        number: index + 1,
        cfDamage,
        cfRemaining: Math.max(0, design.cf - cfDamage),
        armorDamage,
        armorRemaining: Math.max(0, design.armorFactorPerHex - armorDamage),
        armorPips: buildDamagePips(design.armorFactorPerHex, armorDamage),
        cfPips: buildDamagePips(design.cf, cfDamage),
        armorPipScale: damagePipScale(design.armorFactorPerHex),
        cfPipScale: damagePipScale(design.cf),
        armorPipsGrouped: damagePipScale(design.armorFactorPerHex) > 1,
        cfPipsGrouped: damagePipScale(design.cf) > 1,
        collapsed: hex.collapsed || cfDamage >= design.cf,
        armorDestroyed: design.armorFactorPerHex > 0 && armorDamage >= design.armorFactorPerHex,
        levels: levelTracks,
        usage: componentContext.hexUsage[index]
      };
    });

    context.actor = this.actor;
    context.system = system;
    context.building = building;
    context.expandedCF = Boolean(building.expandedCF);
    context.design = design;
    context.design.multipleHexes = design.hexCount !== 1;
    context.design.multipleLevels = design.levels !== 1;
    context.design.isClan = design.techBase === "clan";
    context.hexes = hexes;
    context.components = componentContext.components;
    context.combatWeapons = componentContext.components.filter(component => component.isWeapon);
    context.hasCombatWeapons = context.combatWeapons.length > 0;
    context.componentSummary = componentContext;
    context.powerSources = componentContext.powerSources;
    context.techBases = optionList(TECH_BASES, design.techBase);
    context.buildingTypes = optionList(design.availableTypes, design.type);
    context.classifications = optionList(CLASSIFICATIONS, design.classification);
    context.armorRestrictionNote = design.canInstallArmor
      ? `${CLASSIFICATIONS.find(option => option.value === design.classification)?.label ?? "This classification"} may install building armor.`
      : "Only Walls, Gun Emplacements, Fortresses, and Castles Brian may install armor.";
    context.validationIssues = design.validationIssues;
    context.hasValidationIssues = design.validationIssues.length > 0;
    context.capacityWarning = design.armorExceedsCapacity
      ? `Armor requires ${design.armorTonsPerHex} tons per hex, exceeding the ${design.internalCapacityPerHex}-ton internal capacity.`
      : "";
    const crewMaxHits = clampInt(building.crew?.maxHits, 1, 20, 6);
    const crewHits = clampInt(building.crew?.hits, 0, crewMaxHits, 0);
    context.crewHits = crewHits;
    context.crewMaxHits = crewMaxHits;
    context.crewHitTrack = Array.from({ length: crewMaxHits }, (_, index) => ({ n: index + 1, filled: index < crewHits }));
    return context;
  }

  _onRender(context, options) {
    super._onRender(context, options);
    ATOWBuildingSheet._ensureSheetStyles();
    const root = this.element;
    if (!root) return;

    const form = root.matches?.("form.building-sheet") ? root : root.querySelector?.("form.building-sheet");
    if (form && form.dataset.atowFormBound !== "1") {
      form.dataset.atowFormBound = "1";
      form.addEventListener("change", event => this._onFormValueChange(event));
    }

    const portrait = root.querySelector('[data-edit="img"]');
    if (portrait && portrait.dataset.atowImgBound !== "1") {
      portrait.dataset.atowImgBound = "1";
      portrait.addEventListener("click", event => this._onPortraitClick(event));
    }

    root.querySelectorAll(".building-crew-hit[data-value]").forEach(hit => {
      if (hit.dataset.atowBound === "1") return;
      hit.dataset.atowBound = "1";
      hit.addEventListener("click", event => this._onCrewHit(event));
    });

    root.querySelectorAll("[data-component-field][data-item-id]").forEach(input => {
      if (input.dataset.atowBound === "1") return;
      input.dataset.atowBound = "1";
      input.addEventListener("change", event => this._onComponentFieldChange(event));
    });

    root.querySelectorAll("[data-action='delete-component'][data-item-id]").forEach(button => {
      if (button.dataset.atowBound === "1") return;
      button.dataset.atowBound = "1";
      button.addEventListener("click", event => this._onDeleteComponent(event));
    });

    root.querySelectorAll("[data-action='clear-component-malfunction'][data-item-id]").forEach(button => {
      if (button.dataset.atowBound === "1") return;
      button.dataset.atowBound = "1";
      button.addEventListener("click", event => this._onClearComponentMalfunction(event));
    });

    root.querySelectorAll("[data-action='clear-turret-jam'][data-hex-index]").forEach(button => {
      if (button.dataset.atowBound === "1") return;
      button.dataset.atowBound = "1";
      button.addEventListener("click", event => this._onClearTurretJam(event));
    });

    root.querySelectorAll(".building-damage-pip[data-track][data-hex-index][data-pip]").forEach(pip => {
      if (pip.dataset.atowBound === "1") return;
      pip.dataset.atowBound = "1";
      pip.addEventListener("click", event => this._onDamagePip(event));
    });

    root.querySelectorAll(".building-component-row[data-item-id], .building-component-card[data-item-id]").forEach(row => {
      if (row.dataset.atowRowBound === "1") return;
      row.dataset.atowRowBound = "1";
      row.addEventListener("contextmenu", event => this._onOpenComponent(event));
      row.addEventListener("dragstart", event => this._onComponentDragStart(event));
    });

    root.querySelectorAll("[data-action='attack-component'][data-item-id]").forEach(button => {
      if (button.dataset.atowAttackBound === "1") return;
      button.dataset.atowAttackBound = "1";
      button.addEventListener("click", event => this._onComponentAttack(event));
    });

    const dropZone = root.querySelector("[data-drop-zone='building-components']");
    if (dropZone && dropZone.dataset.atowBound !== "1") {
      dropZone.dataset.atowBound = "1";
      dropZone.addEventListener("dragover", event => event.preventDefault());
      dropZone.addEventListener("drop", event => this._onComponentDrop(event));
    }
  }

  async _onComponentFieldChange(event) {
    event.stopPropagation();
    if (!this.isEditable) return;
    const input = event.currentTarget;
    const item = this.actor.items.get(input.dataset.itemId);
    const field = String(input.dataset.componentField ?? "");
    if (!item || !field) return;

    let value = input.type === "checkbox" ? Boolean(input.checked) : input.value;
    if (["hexIndex", "level", "quantity"].includes(field)) {
      value = Math.max(field === "quantity" ? 1 : 0, Math.floor(finiteNumber(value, field === "quantity" ? 1 : 0)));
    }
    await item.update({ [`system.buildingMount.${field}`]: value });
    this.render(false);
  }

  async _onPortraitClick(event) {
    if (!this.isEditable) return;
    event.preventDefault();
    const FilePickerCtor = globalThis.FilePicker
      ?? foundry?.applications?.forms?.FilePicker
      ?? foundry?.applications?.api?.FilePicker;
    if (!FilePickerCtor) {
      ui.notifications?.warn?.("FilePicker is not available.");
      return;
    }
    const picker = new FilePickerCtor({
      type: "imagevideo",
      current: this.actor?.img ?? "",
      callback: async path => {
        if (path) await this.actor.update({ img: path });
      }
    });
    try { picker.browse(); } catch (_) {}
    picker.render(true);
  }

  async _onCrewHit(event) {
    event.preventDefault();
    if (!this.isEditable) return;
    const value = Math.max(1, Math.floor(finiteNumber(event.currentTarget.dataset.value, 1)));
    const current = Math.max(0, finiteNumber(this.actor.system?.building?.crew?.hits, 0));
    await this.actor.update({ "system.building.crew.hits": value <= current ? value - 1 : value });
    this.render(false);
  }

  async _onDeleteComponent(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.isEditable) return;
    const itemId = event.currentTarget.dataset.itemId;
    if (!itemId) return;
    await this.actor.deleteEmbeddedDocuments("Item", [itemId]);
    this.render(false);
  }

  async _onClearComponentMalfunction(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.isEditable) return;
    const item = this.actor.items.get(event.currentTarget.dataset.itemId);
    if (!item || item.system?.buildingMount?.destroyed) return;
    await item.update({ "system.buildingMount.malfunctioned": false });
    this.render(false);
  }

  async _onClearTurretJam(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.isEditable) return;
    const hexIndex = Math.max(0, Math.floor(finiteNumber(event.currentTarget.dataset.hexIndex, 0)));
    const levelIndex = Math.floor(finiteNumber(event.currentTarget.dataset.levelIndex, -1));
    const path = levelIndex >= 0
      ? `system.building.hexes.${hexIndex}.levels.${levelIndex}.crit.turretJammed`
      : `system.building.hexes.${hexIndex}.crit.turretJammed`;
    await this.actor.update({ [path]: false });
    this.render(false);
  }

  async _onDamagePip(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!this.isEditable) return;
    const element = event.currentTarget;
    const track = String(element.dataset.track ?? "");
    const hexIndex = Math.max(0, Math.floor(finiteNumber(element.dataset.hexIndex, 0)));
    const levelIndex = Math.floor(finiteNumber(element.dataset.levelIndex, -1));
    const pip = Math.max(1, Math.floor(finiteNumber(element.dataset.pip, 1)));
    const pipStart = Math.max(1, Math.floor(finiteNumber(element.dataset.pipStart, pip)));
    if (!['armorDamage', 'cfDamage'].includes(track)) return;

    const basePath = levelIndex >= 0
      ? `system.building.hexes.${hexIndex}.levels.${levelIndex}`
      : `system.building.hexes.${hexIndex}`;
    const current = Math.max(0, finiteNumber(foundry.utils.getProperty(this.actor, `${basePath}.${track}`), 0));
    const next = current >= pipStart ? pipStart - 1 : pip;
    await this.actor.update({ [`${basePath}.${track}`]: next });
    this.render(false);
  }

  _onOpenComponent(event) {
    event.preventDefault();
    const item = this.actor.items.get(event.currentTarget.dataset.itemId);
    item?.sheet?.render?.(true);
  }

  async _onComponentAttack(event) {
    event.preventDefault();
    event.stopPropagation();
    const item = this.actor.items.get(event.currentTarget.dataset.itemId);
    if (!item || !["mechWeapon", "characterWeapon"].includes(item.type)) return;
    await promptAndRollWeaponAttack(this.actor, item, { weaponFireKey: item.uuid ?? `building:${item.id}` });
  }

  _onComponentDragStart(event) {
    const item = this.actor.items.get(event.currentTarget.dataset.itemId);
    if (!item?.uuid) return;
    event.dataTransfer?.setData("application/json", JSON.stringify({ type: "Item", uuid: item.uuid }));
  }

  async _onComponentDrop(event) {
    event.preventDefault();
    if (!this.isEditable) return;
    let data = null;
    try {
      data = TextEditor.getDragEventData(event);
    } catch (_) {
      const raw = event.dataTransfer?.getData("application/json") || event.dataTransfer?.getData("text/json");
      if (raw) {
        try { data = JSON.parse(raw); } catch (_) {}
      }
    }
    if (!data || data.type !== "Item") return;
    if (typeof data.uuid === "string" && data.uuid.startsWith(`${this.actor.uuid}.Item.`)) return;

    const document = data.uuid
      ? await fromUuid(data.uuid).catch(() => null)
      : (data.data ? new Item(data.data) : null);
    if (!document) return;
    if (!COMPONENT_ITEM_TYPES.has(document.type)) {
      ui.notifications?.warn?.("Buildings accept Mech Weapons, Mech Equipment, and Personal Weapons as installed components.");
      return;
    }

    const source = document.toObject();
    delete source._id;
    source.system = source.system ?? {};
    source.system.buildingMount = {
      hexIndex: 0,
      quantity: 1,
      weaponClass: defaultComponentClass(document),
      energyWeapon: detectEnergyWeapon(document),
      level: 1,
      turret: false,
      destroyed: false,
      malfunctioned: false
    };
    await this.actor.createEmbeddedDocuments("Item", [source]);
    this.render(false);
  }

  async _onFormValueChange(event) {
    const input = event.target;
    const name = String(input?.name ?? "").trim();
    if (!name || !this.isEditable) return;

    let value = parseFormValue(input);
    if ([
      "system.building.levels",
      "system.building.cf",
      "system.building.armor.tonsPerHex"
    ].includes(name)) {
      value = Math.max(name === "system.building.armor.tonsPerHex" ? 0 : 1, Math.floor(finiteNumber(value, 0)));
    }
    if (name === "system.building.size.hexes") {
      const count = clampInt(value, 1, 999, 1);
      const hexes = normalizedHexes(this.actor.system?.building, count);
      await this.actor.update({
        "system.building.size.hexes": count,
        "system.building.hexes": hexes
      });
      this.render(false);
      return;
    }

    if (name === "system.building.levels") {
      const levels = clampInt(value, 1, 999, 1);
      const current = foundry.utils.deepClone(this.actor.system?.building ?? {});
      current.levels = levels;
      const count = clampInt(current.size?.hexes, 1, 999, 1);
      await this.actor.update({
        "system.building.levels": levels,
        "system.building.hexes": normalizeBuildingHexes(current, count, levels)
      });
      this.render(false);
      return;
    }

    if (name === "system.building.classification") {
      const classification = normalizedClassification(value);
      const currentType = String(this.actor.system?.building?.type ?? "medium");
      const availableTypes = availableTypesForClassification(classification);
      const nextType = availableTypes.some(option => option.value === currentType)
        ? currentType
        : (availableTypes[0]?.value ?? currentType);
      await this.actor.update({
        "system.building.classification": classification,
        "system.building.type": nextType
      });
      this.render(false);
      return;
    }

    await this.actor.update({ [name]: value });

    if (
      name === "system.building.classification"
      || name === "system.building.techBase"
      || name === "system.building.levels"
      || name === "system.building.cf"
      || name === "system.building.armor.tonsPerHex"
      || name === "system.building.power.source"
      || name.startsWith("system.building.hexes.")
    ) {
      this.render(false);
    }
  }
}

export const BUILDING_DESIGN_RULES = Object.freeze({
  classifications: CLASSIFICATIONS,
  buildingTypes: BUILDING_TYPES,
  classificationTable: BUILDING_CLASSIFICATION_RULES,
  techBases: TECH_BASES,
  armoredClassifications: ARMORED_CLASSIFICATIONS,
  calculate: calculateBuildingDesign,
  calculateComponents: buildComponentContext
});
