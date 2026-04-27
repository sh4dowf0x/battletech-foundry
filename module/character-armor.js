// module/character-armor.js
// AToW Battletech (Foundry VTT v13) — Character Armor Item Sheet (ItemSheetV2)
//
// Expected item type: "characterArmor" (adjust in registerATOWCharacterArmorSheet if you use a different type key)

const SYSTEM_ID = "atow-battletech";
const TEMPLATE = `systems/${SYSTEM_ID}/templates/character-armor.hbs`;

// Armor Type dropdown options (A Time of War — Personal Armor)
const ARMOR_TYPES = [
  "Flak",
  "Ablative",
  "AB/Flak",
  "Ballistic Plate",
  "Neo-Chainmail",
  "Myomer",
  "Concealed",
  "Other"
];

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ItemSheetV2 } = foundry.applications.sheets;

/**
 * Character Armor item sheet.
 * Stores data under item.system.*
 */
export class ATOWCharacterArmorSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(
    super.DEFAULT_OPTIONS,
    {
      classes: ["atow", "sheet", "item", "atow-item-sheet", "character-armor"],
      position: { width: 720, height: 620 },
      window: { resizable: true },
      form: {
        submitOnChange: true,
        submitOnClose: true,
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
    context.armorTypes = ARMOR_TYPES;

    sys.ratings ??= {};
    sys.bar ??= {};
    sys.coverage ??= {};

    // Type dropdown
    sys.type ??= "Other";

    sys.ratings.tech ??= "";
    sys.ratings.legality ??= "";
    sys.ratings.availability ??= "";

    // BAR: Melee / Ballistic / Energy / Explosive
    sys.bar.m ??= "";
    sys.bar.b ??= "";
    sys.bar.e ??= "";
    sys.bar.x ??= "";

    sys.costPatch ??= "";
    sys.affiliation ??= "";
    sys.massKg ??= null;

    // Coverage checkboxes (extend as you like)
    sys.coverage.head ??= false;
    sys.coverage.torso ??= false;
    sys.coverage.arms ??= false;
    sys.coverage.legs ??= false;
    sys.coverage.hands ??= false;
    sys.coverage.feet ??= false;

    sys.notes ??= "";

    return context;
  }

  _onRender(context, options) {
    super._onRender(context, options);

    const root = this.element;
    const portrait = root?.querySelector?.('[data-edit="img"]');
    if (!portrait || portrait.dataset.atowImgBound === "1") return;

    portrait.dataset.atowImgBound = "1";
    portrait.addEventListener("click", async (event) => {
      if (!this.isEditable) return;
      event.preventDefault();

      const FilePickerCtor =
        globalThis.FilePicker ??
        foundry?.applications?.forms?.FilePicker ??
        foundry?.applications?.api?.FilePicker;

      if (!FilePickerCtor) {
        ui.notifications?.warn?.("FilePicker is not available.");
        return;
      }

      const fp = new FilePickerCtor({
        type: "image",
        current: this.item?.img ?? "",
        callback: async (path) => {
          if (!path) return;
          await this.item.update({ img: path });
        }
      });

      try { fp.browse(); } catch (_) {}
      fp.render(true);
    });
  }

  /**
   * Ensure we persist any in-progress edits when the sheet is closed.
   * This prevents losing text that hasn't triggered a native "change" event yet.
   */
  async close(options = {}) {
    // Only attempt to save if the user can edit this item.
    if (this.isEditable) {
      try {
        // In v13, the sheet form is rendered by the base Application and our HBS is the inner content.
        const form = this.element?.querySelector("form");
        if (form) {
          const fd = new FormDataExtended(form);
          const updateData = foundry.utils.expandObject(fd.object);
          await this.item.update(updateData, { diff: true });
        }
      } catch (err) {
        console.error("AToW Character Armor | Failed to save item on close", err);
      }
    }
    return super.close(options);
  }

}

/**
 * Optional helper for your core init.
 * Call this from your system init once you have the item type registered.
 */
export function registerATOWCharacterArmorSheet() {
  Items.registerSheet(SYSTEM_ID, ATOWCharacterArmorSheet, {
    types: ["characterArmor"],
    makeDefault: true
  });
}
