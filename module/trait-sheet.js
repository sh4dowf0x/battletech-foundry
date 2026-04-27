// module/trait-sheet.js
// Item sheet for Trait items (type: "trait")

const SYSTEM_ID = "atow-battletech";
const TEMPLATE = `systems/${SYSTEM_ID}/templates/trait-sheet.hbs`;

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ItemSheetV2 } = foundry.applications.sheets;

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Trait activation rule:
 * Trait activates when XP reaches TP × 100.
 * - For positive TP, XP must be >= threshold.
 * - For negative TP, XP must be <= threshold.
 */
function isTraitActive(tp, xp) {
  const threshold = tp * 100;
  if (tp < 0) return xp <= threshold;
  return xp >= threshold;
}

export class ATOWTraitSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  /** @inheritDoc */
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(
    super.DEFAULT_OPTIONS,
    {
      classes: ["atow", "sheet", "item", "atow-item-sheet", "trait"],
      position: { width: 620, height: 560 },
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

    // Trait Points (TP) and XP spent/awarded into the trait (we reuse system.cost from the character sheet)
    const tp = toNumber(sys.tp, 0);
    const xp = toNumber(sys.cost, 0);

    const threshold = tp * 100;
    const active = isTraitActive(tp, xp);

    context.item = item;
    context.system = sys;

    context.trait = {
      tp,
      xp,
      threshold,
      active
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
