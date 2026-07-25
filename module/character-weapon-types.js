// Personal-scale weapon categories and their ammunition/power requirements.

export const CHARACTER_WEAPON_RESOURCE_MODES = Object.freeze({
  none: Object.freeze({ key: "none", label: "None", usesAmmo: false, usesPps: false }),
  ammo: Object.freeze({ key: "ammo", label: "Ammo", usesAmmo: true, usesPps: false }),
  pps: Object.freeze({ key: "pps", label: "PPS", usesAmmo: false, usesPps: true }),
  both: Object.freeze({ key: "both", label: "Ammo + PPS", usesAmmo: true, usesPps: true })
});

const category = (key, label, resourceMode, { flexible = false } = {}) => Object.freeze({
  key,
  label,
  resourceMode,
  flexible
});

export const CHARACTER_WEAPON_CATEGORIES = Object.freeze({
  archaicMelee: category("archaicMelee", "Archaic Melee", "none"),
  archaicRanged: category("archaicRanged", "Archaic Ranged", "ammo"),
  modernMelee: category("modernMelee", "Modern Melee", "pps"),
  ballisticPistol: category("ballisticPistol", "Ballistic Pistol", "ammo"),
  ballisticSmg: category("ballisticSmg", "Ballistic SMG", "ammo"),
  ballisticRifle: category("ballisticRifle", "Ballistic Rifle", "ammo"),
  energyPistol: category("energyPistol", "Energy Pistol", "pps"),
  energyRifle: category("energyRifle", "Energy Rifle", "pps"),
  flechettePistol: category("flechettePistol", "Flechette Pistol", "ammo"),
  flechetteRifle: category("flechetteRifle", "Flechette Rifle", "ammo"),
  gaussPistol: category("gaussPistol", "Gauss Pistol", "both"),
  gaussRifle: category("gaussRifle", "Gauss Rifle", "both"),
  gyrojetPistol: category("gyrojetPistol", "Gyrojet Pistol", "ammo"),
  gyrojetRifle: category("gyrojetRifle", "Gyrojet Rifle", "ammo"),
  miscellaneousPistol: category("miscellaneousPistol", "Miscellaneous Pistol", "both", { flexible: true }),
  miscellaneousRifle: category("miscellaneousRifle", "Miscellaneous Rifle", "both", { flexible: true }),
  machineGun: category("machineGun", "Machine Gun", "ammo"),
  grenadeLauncher: category("grenadeLauncher", "Grenade Launcher", "ammo"),
  artillery: category("artillery", "Artillery", "ammo"),
  missileLauncher: category("missileLauncher", "Missile Launcher", "ammo"),
  recoillessRifle: category("recoillessRifle", "Recoilless Rifle", "ammo"),
  supportEnergyWeapon: category("supportEnergyWeapon", "Support Energy Weapon", "both", { flexible: true })
});

export const CHARACTER_WEAPON_CATEGORY_CHOICES = Object.freeze(
  Object.fromEntries(Object.values(CHARACTER_WEAPON_CATEGORIES).map(entry => [entry.key, entry.label]))
);

export const FLEXIBLE_RESOURCE_MODE_CHOICES = Object.freeze({
  ammo: "Ammo",
  pps: "PPS",
  both: "Ammo + PPS"
});

export function getCharacterWeaponResourceProfile(weaponOrSystem = {}) {
  const system = weaponOrSystem?.system ?? weaponOrSystem;
  const categoryKey = String(system.weaponCategory ?? system.category ?? "").trim();
  const definition = CHARACTER_WEAPON_CATEGORIES[categoryKey] ?? null;

  // Existing uncategorized weapons retain the magazine behavior they had
  // before weapon categories were introduced.
  if (!definition) {
    return {
      categoryKey: "",
      categoryLabel: "Uncategorized",
      flexible: false,
      canUseAmmo: true,
      canUsePps: false,
      resourceMode: "ammo",
      resourceLabel: "Ammo",
      usesAmmo: true,
      usesPps: false
    };
  }

  const selectedMode = definition.flexible
    ? String(system.resourceMode ?? definition.resourceMode).trim()
    : definition.resourceMode;
  const mode = CHARACTER_WEAPON_RESOURCE_MODES[selectedMode] ?? CHARACTER_WEAPON_RESOURCE_MODES[definition.resourceMode];
  const categoryMode = CHARACTER_WEAPON_RESOURCE_MODES[definition.resourceMode];
  return {
    categoryKey: definition.key,
    categoryLabel: definition.label,
    flexible: definition.flexible,
    canUseAmmo: Boolean(categoryMode?.usesAmmo),
    canUsePps: Boolean(categoryMode?.usesPps),
    resourceMode: mode.key,
    resourceLabel: mode.label,
    usesAmmo: mode.usesAmmo,
    usesPps: mode.usesPps
  };
}
