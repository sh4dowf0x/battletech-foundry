// module/mech-equipment.js
// AToW Battletech (Foundry VTT v13) - Mech Equipment Item Sheet (ItemSheetV2)

const SYSTEM_ID = "atow-battletech";
const TEMPLATE = `systems/${SYSTEM_ID}/templates/mech-equipment.hbs`;

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ItemSheetV2 } = foundry.applications.sheets;

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export class AToWMechEquipmentSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(
    super.DEFAULT_OPTIONS,
    {
      classes: ["atow", "sheet", "item", "atow-item-sheet", "mech-equipment"],
      position: { width: 620, height: 500 },
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
    return `${this.item.name} - Mech Equipment`;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    const item = this.item;
    const system = foundry.utils.deepClone(item.system ?? {});

    system.notes ??= "";
    system.specialRules ??= "";
    system.ammoType ??= "";
    const isPartialWing = /^partial\s*[-]?\s*wing(?:\s*\((?:clan|inner\s+sphere)\))?$/i.test(String(item.name ?? "").trim());
    const isMASC = /(?:\bmasc\b|\bmyomer\s+acceleration\s+signal\s+circuitry\b)/i.test(String(item.name ?? "").trim());
    const isSupercharger = /\bsuper\s*[-]?\s*charger\b/i.test(String(item.name ?? "").trim());
    const isImprovedJumpJet = /\bimproved\s+jump\s*jets?\b/i.test(String(item.name ?? "").trim());
    const isECMSuite = /^(?:ecm\s+suite(?:\s*\(clan\))?|guardian\s+ecm)$/i.test(String(item.name ?? "").trim());
    const isFerroLamellor = /^ferro\s*-?\s*lamellor(?:\s+armor)?$/i.test(String(item.name ?? "").trim());
    const isCarrierDerived = isPartialWing || isMASC || isSupercharger || isImprovedJumpJet;
    system.critSlots = Math.max(isCarrierDerived ? 0 : 1, Math.floor(toNumber(system.critSlots, isCarrierDerived ? 0 : 1)));
    system.ammoAmount = Math.max(0, toNumber(system.ammoAmount, 0));
    system.heatDissipation = Math.max(0, toNumber(system.heatDissipation, 0));
    system.tonnage = Math.max(0, toNumber(system.tonnage ?? system.tons ?? system.weight, 0));
    if (isCarrierDerived) {
      system.critSlots = 0;
      system.heatDissipation = 0;
      system.tonnage = 0;
    } else if (isECMSuite) {
      system.critSlots = 2;
      system.tonnage = 1.5;
    } else if (isFerroLamellor) {
      // Distributed armor construction component: install one zero-ton slot at a time.
      system.critSlots = 1;
      system.tonnage = 0;
    }

    context.item = item;
    context.system = system;
    context.isPartialWing = isPartialWing;
    context.isMASC = isMASC;
    context.isSupercharger = isSupercharger;
    context.isImprovedJumpJet = isImprovedJumpJet;
    context.isECMSuite = isECMSuite;
    context.isFerroLamellor = isFerroLamellor;
    context.isCarrierDerived = isCarrierDerived;

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
