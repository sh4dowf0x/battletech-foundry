// systems/atow-battletech/mech-equipment.js

export class AToWMechEquipmentSheet extends ItemSheet {
  /** @override */
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["atow", "battletech", "sheet", "item", "mech-equipment"],
      template: "systems/atow-battletech/templates/mech-equipment.hbs",
      width: 520,
      height: "auto"
    });
  }

  /** @override */
  get title() {
    return `${this.item.name} — Equipment`;
  }

  /** @override */
  async getData(options) {
    const context = await super.getData(options);

    context.system = context.system ?? this.item.system ?? {};

    // Normalize numbers so the template can't break and drag/drop spans work reliably.
    context.system.critSlots = Number(context.system.critSlots ?? 1);
    if (Number.isNaN(context.system.critSlots) || context.system.critSlots < 1) context.system.critSlots = 1;

    context.system.ammoAmount = Number(context.system.ammoAmount ?? 0);
    if (Number.isNaN(context.system.ammoAmount) || context.system.ammoAmount < 0) context.system.ammoAmount = 0;

    context.system.heatDissipation = Number(context.system.heatDissipation ?? 0);
    if (Number.isNaN(context.system.heatDissipation) || context.system.heatDissipation < 0) context.system.heatDissipation = 0;

    // Tonnage (for mech weight calculations)
    context.system.tonnage = Number(context.system.tonnage ?? context.system.tons ?? context.system.weight ?? 0);
    if (Number.isNaN(context.system.tonnage) || context.system.tonnage < 0) context.system.tonnage = 0;

    // Dropdown options
    context.ammoTypeOptions = {
      "": "—",
      "AC-2": "AC-2",
      "AC-5": "AC-5",
      "AC-10": "AC-10",
      "AC-20": "AC-20",
      "LRM": "LRM",
      "SRM": "SRM",
      "Gauss": "Gauss"
    };

    return context;
  }

  /** @override */
  activateListeners(html) {
    super.activateListeners(html);
  }
}
