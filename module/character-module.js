// character-module.js
// version: 0.1.0

import { SYSTEM_ID } from "../atow-battletech.js";

/**
 * Character Module Item Sheet
 * - Read-only for non-GMs (players can view)
 */
export class ATOWCharacterModuleSheet extends ItemSheet {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      classes: ["atow", "sheet", "item", "atow-module-sheet"],
      template: `systems/${SYSTEM_ID}/templates/character-module.hbs`,
      width: 720,
      height: 760,
      resizable: true
    });
  }

  // Force read-only for non-GMs even if they own the Actor/item.
  get isEditable() {
    return game.user.isGM;
  }

  getData(options = {}) {
    const data = super.getData(options);
    data.system = this.item.system ?? {};
    data.isGM = game.user.isGM;
    return data;
  }

  // Block updates from non-GMs (extra guard).
  async _updateObject(event, formData) {
    if (!game.user.isGM) {
      ui.notifications?.warn?.("Only the GM can edit Character Modules.");
      return;
    }
    return super._updateObject(event, formData);
  }
}
