// systems/atow-battletech/mech-weapon.js

export class AToWMechWeaponSheet extends ItemSheet {
  /** @override */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["atow", "battletech", "sheet", "item", "mech-weapon"],
      template: "systems/atow-battletech/templates/mech-weapon.hbs",
      width: 560,
      height: "auto"
    });
  }

  /** @override */
  get title() {
    return `${this.item.name} — Weapon`;
  }

  /** @override */
  async getData(options) {
    const context = await super.getData(options);

    context.dmgTypeOptions = {
      DE: "DE",
      DB: "DB",
      MCS: "MCS"
    };

    // Ensure the nested objects exist so the template never explodes.
    context.system = context.system ?? this.item.system ?? {};
    context.system.range = context.system.range ?? {};
    context.system.critSlots = Number(context.system.critSlots ?? 1);
    if (Number.isNaN(context.system.critSlots) || context.system.critSlots < 1) context.system.critSlots = 1;

    // Tonnage (for mech weight calculations)
    context.system.tonnage = Number(context.system.tonnage ?? context.system.tons ?? context.system.weight ?? 0);
    if (Number.isNaN(context.system.tonnage) || context.system.tonnage < 0) context.system.tonnage = 0;

    // Normalize some common number fields (safe defaults)
    context.system.heat = Number(context.system.heat ?? 0);
    if (Number.isNaN(context.system.heat)) context.system.heat = 0;
    context.system.damage = Number(context.system.damage ?? 0);
    if (Number.isNaN(context.system.damage)) context.system.damage = 0;

    // Rapid Fire rating (how many shots this weapon can fire in a single attack; 1 = normal)
    context.system.rapidFire = Number(context.system.rapidFire ?? 1);
    if (Number.isNaN(context.system.rapidFire) || context.system.rapidFire < 1) context.system.rapidFire = 1;
    context.system.rapidFire = Math.min(20, Math.floor(context.system.rapidFire));

    for (const k of ["min", "short", "medium", "long"]) {
      context.system.range[k] = Number(context.system.range[k] ?? 0);
      if (Number.isNaN(context.system.range[k])) context.system.range[k] = 0;
    }

    return context;
  }
}