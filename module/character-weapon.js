// module/character-weapon.js
// AToW Battletech (Foundry VTT v13) — Character Weapon Item Sheet (ItemSheetV2)
//
// Expected item type: "characterWeapon" (adjust in registerATOWCharacterWeaponSheet if you use a different type key)

const SYSTEM_ID = "atow-battletech";
const TEMPLATE = `systems/${SYSTEM_ID}/templates/character-weapon.hbs`;

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ItemSheetV2 } = foundry.applications.sheets;

/**
 * Character Weapon item sheet.
 * Stores data under item.system.*
 */
export class ATOWCharacterWeaponSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(
    super.DEFAULT_OPTIONS,
    {
      classes: ["atow", "sheet", "item", "character-weapon"],
      position: { width: 760, height: 760 },
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

  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    context.item = this.item;
    context.system = this.item.system ?? {};

    // Safe defaults (keeps the template stable even if the system model isn't wired yet)
    const sys = context.system;
    sys.ratings ??= {};
    sys.damage ??= {};
    sys.mass ??= {};

    sys.ratings.tech ??= "";
    sys.ratings.legality ??= "";
    sys.ratings.availability ??= "";

    // AP/BD are often shown together on the canon sheet.
    // Keep them as strings to allow formats like "3M" etc.
    sys.damage.ap ??= "";
    sys.damage.bd ??= "";

    sys.range ??= "";
    sys.shots ??= "";
    sys.costReload ??= "";
    sys.affiliation ??= "";

    sys.mass.weaponKg ??= null;
    sys.mass.reloadKg ??= null;

    sys.notes ??= "";

    // Weapon skill (used for display now; used for scripted attacks later)
    sys.skillKey ??= "melee";
    context.skillChoices = WEAPON_SKILL_CHOICES;
    context.skillTied = WEAPON_SKILL_TIED[sys.skillKey] ?? "";

    return context;
  }
}

/**
 * Optional helper for your core init.
 * Call this from your system init once you have the item type registered.
 */
export function registerATOWCharacterWeaponSheet() {
  Items.registerSheet(SYSTEM_ID, ATOWCharacterWeaponSheet, {
    types: ["characterWeapon"],
    makeDefault: true
  });
}


// Weapon skill dropdown options (stored as system.skillKey)
const WEAPON_SKILL_CHOICES = {
  melee: "Melee",
  archery: "Archery",
  thrown: "Thrown",
  smallArms: "Small Arms",
  support: "Support"
};

// For future automation: which Skill item name this weapon should use when rolling attacks.
const WEAPON_SKILL_TIED = {
  melee: "Melee Weapons",
  archery: "Archery",
  thrown: "Thrown Weapons",
  smallArms: "Small Arms",
  support: "Support Weapons"
};
