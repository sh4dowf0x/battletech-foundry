// module/character-equipment.js
// AToW Battletech (Foundry VTT v13) - Character Equipment Item Sheet (ItemSheetV2)

const SYSTEM_ID = "atow-battletech";
const TEMPLATE = `systems/${SYSTEM_ID}/templates/character-equipment.hbs`;

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ItemSheetV2 } = foundry.applications.sheets;

const GEAR_TYPE_OPTIONS = [
  { value: "attire", label: "Attire" },
  { value: "comms", label: "Comms Equipment" },
  { value: "avt", label: "AVT Equipment" },
  { value: "computers", label: "Computers" },
  { value: "surveillance", label: "Surveillance Gear" },
  { value: "optics", label: "Optics" },
  { value: "sensors", label: "Sensors" },
  { value: "powerPacks", label: "Power Packs" },
  { value: "rechargers", label: "Rechargers" },
  { value: "espionage", label: "Espionage Gear" },
  { value: "repair", label: "Repair / Salvage Gear" },
  { value: "medical", label: "Medical Equipment" },
  { value: "miscellaneous", label: "Miscellaneous Gear" },
  { value: "drugs", label: "Drugs / Poisons" },
  { value: "other", label: "Other" }
];

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export class ATOWCharacterEquipmentSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(
    super.DEFAULT_OPTIONS,
    {
      classes: ["atow", "sheet", "item", "atow-item-sheet", "character-equipment"],
      position: { width: 620, height: 520 },
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

  get title() {
    return `${this.item.name} - Character Equipment`;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    const item = this.item;
    const system = foundry.utils.deepClone(item.system ?? {});

    system.equipped = Boolean(system.equipped);
    system.gearType ||= "miscellaneous";
    system.ratings ??= {};
    system.ratings.tech ??= "";
    system.ratings.availability ??= "";
    system.ratings.legality ??= "";
    system.costCbills = Math.max(0, toNumber(system.costCbills, 0));
    system.massKg = Math.max(0, toNumber(system.massKg, 0));
    system.powerUsePph = Math.max(0, toNumber(system.powerUsePph, 0));
    system.range ??= "";
    system.notes ??= "";

    context.item = item;
    context.system = system;
    context.gearTypeOptions = GEAR_TYPE_OPTIONS;
    context.gearTypeLabel =
      GEAR_TYPE_OPTIONS.find((option) => option.value === system.gearType)?.label ?? "Equipment";

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
}
