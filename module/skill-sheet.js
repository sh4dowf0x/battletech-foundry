// module/skill-sheet.js
// Item sheet for Skill items (type: "skill")

const SYSTEM_ID = "atow-battletech";
const TEMPLATE = `systems/${SYSTEM_ID}/templates/skill-sheet.hbs`;

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ItemSheetV2 } = foundry.applications.sheets;

export class ATOWSkillSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  /** @inheritDoc */
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(
    super.DEFAULT_OPTIONS,
    {
      classes: ["atow", "sheet", "item", "skill"],
      position: { width: 460, height: 520 },
      window: { resizable: true },
      form: {
        submitOnChange: true,
        closeOnSubmit: false
      }
    },
    { inplace: false }
  );

  /** @inheritDoc */
  static PARTS = {
    form: { template: TEMPLATE }
  };

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    const item = this.item;
    const sys = item.system ?? {};

    const tnOptions = [7, 8, 9];

    const attributeOptions = [
      { value: "", label: "—" },
      { value: "str", label: "STR" },
      { value: "bod", label: "BOD" },
      { value: "rfl", label: "REF" },
      { value: "dex", label: "DEX" },
      { value: "int", label: "INT" },
      { value: "wil", label: "WIL" },
      { value: "cha", label: "CHA" }
    ];

    // Back-compat: older skills used a single field system.linkedAttribute
    const legacy = String(sys.linkedAttribute ?? "").trim();

    // New fields (preferred)
    const attr1 = String(sys.linkedAttribute1 ?? legacy ?? "").trim();
    const attr2 = String(sys.linkedAttribute2 ?? "").trim();

    const tn = Number(sys.tn ?? 8) || 8;

    context.item = item;
    context.system = sys;

    context.tnOptions = tnOptions;
    context.attributeOptions = attributeOptions;

    context.selected = {
      tn,
      linkedAttribute1: attr1,
      linkedAttribute2: attr2
    };

    return context;
  }

  /** @inheritDoc */
  async _onSubmit(formConfig = {}, event) {
    const result = await super._onSubmit(formConfig, event);

    // Keep legacy system.linkedAttribute synced to attribute #1 for compatibility
    const sys = this.item.system ?? {};
    const a1 = String(sys.linkedAttribute1 ?? "").trim();
    const legacy = String(sys.linkedAttribute ?? "").trim();

    if (a1 !== legacy) {
      await this.item.update({ "system.linkedAttribute": a1 });
    }

    return result;
  }
}
