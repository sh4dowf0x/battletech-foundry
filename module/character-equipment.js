// module/character-equipment.js
// AToW Battletech (Foundry VTT v13) — Character Equipment Item Sheet
//
// Item type: "characterEquipment"
// Catch-all for non-weapon / non-armor gear (clothes, comms, computers, tools, etc.)
//
// system fields (template.json):
//  - equipped: boolean
//  - gearType: string
//  - ratings.tech / ratings.availability / ratings.legality: string
//  - costCbills: number
//  - massKg: number
//  - powerUsePph: number
//  - range: string
//  - notes: string

export class ATOWCharacterEquipmentSheet extends ItemSheet {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["atow", "sheet", "item", "character-equipment"],
      template: "systems/atow-battletech/templates/character-equipment.hbs",
      width: 560,
      height: 650,
      resizable: true
    });
  }

  getData(options) {
    const data = super.getData(options);
    // In legacy sheets, data.item exists; in newer, data.document exists.
    const item = data.item ?? data.document ?? this.item;

    data.system = item.system ?? {};
    data.gearTypeOptions = [{"value": "attire", "label": "Attire"}, {"value": "comms", "label": "Comms Equipment"}, {"value": "avt", "label": "AVT Equipment"}, {"value": "computers", "label": "Computers"}, {"value": "surveillance", "label": "Surveillance Gear"}, {"value": "optics", "label": "Optics"}, {"value": "sensors", "label": "Sensors"}, {"value": "powerPacks", "label": "Power Packs"}, {"value": "rechargers", "label": "Rechargers"}, {"value": "espionage", "label": "Espionage Gear"}, {"value": "repair", "label": "Repair/Salvage Gear"}, {"value": "medical", "label": "Medical Equipment"}, {"value": "misc", "label": "Miscellaneous Gear"}, {"value": "drugs", "label": "Drugs / Poisons"}, {"value": "other", "label": "Other"}];
    return data;
  }

  activateListeners(html) {
    super.activateListeners(html);

    // Sheet image picker
    html.find(".profile-img").on("click", (ev) => {
      ev.preventDefault();
      return this._onEditImage(ev);
    });
  }
}
