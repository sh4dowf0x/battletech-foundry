// module/mech-weapon.js
// AToW Battletech (Foundry VTT v13) - Mech Weapon Item Sheet (ItemSheetV2)

const SYSTEM_ID = "atow-battletech";
const TEMPLATE = `systems/${SYSTEM_ID}/templates/mech-weapon.hbs`;

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ItemSheetV2 } = foundry.applications.sheets;

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export class AToWMechWeaponSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(
    super.DEFAULT_OPTIONS,
    {
      classes: ["atow", "sheet", "item", "atow-item-sheet", "mech-weapon"],
      position: { width: 640, height: 560 },
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
    return `${this.item.name} - Mech Weapon`;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    const item = this.item;
    const system = foundry.utils.deepClone(item.system ?? {});

    system.range ??= {};
    system.loc ??= "";
    system.manufacturer ??= "";
    system.ammoType ??= "";
    system.specialRules ??= "";
    system.notes ??= "";
    system.dmgType ??= "DE";

    system.critSlots = Math.max(1, Math.floor(toNumber(system.critSlots, 1)));
    system.tonnage = Math.max(0, toNumber(system.tonnage ?? system.tons ?? system.weight, 0));
    system.heat = Math.max(0, toNumber(system.heat, 0));
    system.damage = Math.max(0, toNumber(system.damage, 0));
    system.rapidFire = Math.min(20, Math.max(1, Math.floor(toNumber(system.rapidFire, 1))));

    for (const key of ["min", "short", "medium", "long"]) {
      system.range[key] = Math.max(0, toNumber(system.range[key], 0));
    }

    context.item = item;
    context.system = system;
    context.dmgTypeOptions = {
      DE: "DE",
      DB: "DB",
      MCS: "MCS"
    };

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
