// module/skill-sheet.js
// Item sheet for Skill items (type: "skill")

import {
  SKILL_CLASSIFICATION_REFERENCE_VERSION,
  getReferencedSkillClassification
} from "./skill-classifications.js";

const SYSTEM_ID = "atow-battletech";
const TEMPLATE = `systems/${SYSTEM_ID}/templates/skill-sheet.hbs`;

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ItemSheetV2 } = foundry.applications.sheets;

const ACTION_COMPLEXITY_OPTIONS = Object.freeze([
  { value: "simple", label: "Simple" },
  { value: "complex", label: "Complex" }
]);

const TRAINING_CATEGORY_OPTIONS = Object.freeze([
  { value: "basic", label: "Basic" },
  { value: "advanced", label: "Advanced" }
]);

export function getSkillClassification(skillOrSystem = {}, { preferCanonical = false } = {}) {
  const system = skillOrSystem?.system ?? skillOrSystem;
  const referenced = getReferencedSkillClassification(skillOrSystem);
  const referenceVersion = Number(system.classificationReferenceVersion ?? 0) || 0;
  const legacyCodes = [system.c, system.check, system.categoryShort, system.complexityCode]
    .map(value => String(value ?? "").trim().toUpperCase())
    .filter(value => /^(?:S|C)(?:A|B)$/.test(value));
  const legacyCode = legacyCodes.find(value => value !== "SB") ?? legacyCodes[0] ?? "";
  const legacyComplexity = legacyCode.startsWith("C") ? "complex" : (legacyCode.startsWith("S") ? "simple" : "");
  const legacyTraining = legacyCode.endsWith("A") ? "advanced" : (legacyCode.endsWith("B") ? "basic" : "");
  let actionComplexity = String(system.actionComplexity ?? system.complexity ?? "simple").trim().toLowerCase();
  let trainingCategory = String(system.trainingCategory ?? system.training ?? "basic").trim().toLowerCase();
  if (!preferCanonical && referenced && referenceVersion < SKILL_CLASSIFICATION_REFERENCE_VERSION) {
    actionComplexity = referenced.actionComplexity;
    trainingCategory = referenced.trainingCategory;
  }
  // Template defaults appear on old documents in Foundry. A pre-existing
  // non-SB legacy code therefore wins only while both new fields are defaults.
  if (!preferCanonical && !referenced && legacyCode && legacyCode !== "SB" && actionComplexity === "simple" && trainingCategory === "basic") {
    actionComplexity = legacyComplexity;
    trainingCategory = legacyTraining;
  }
  const normalizedComplexity = ["simple", "complex"].includes(actionComplexity) ? actionComplexity : "simple";
  const normalizedTraining = ["basic", "advanced"].includes(trainingCategory) ? trainingCategory : "basic";
  return {
    actionComplexity: normalizedComplexity,
    trainingCategory: normalizedTraining,
    code: `${normalizedComplexity === "complex" ? "C" : "S"}${normalizedTraining === "advanced" ? "A" : "B"}`
  };
}

export class ATOWSkillSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  /** @inheritDoc */
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(
    super.DEFAULT_OPTIONS,
    {
      classes: ["atow", "sheet", "item", "atow-item-sheet", "skill"],
      position: { width: 760, height: 500 },
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
    const classification = getSkillClassification(item);

    context.item = item;
    context.system = sys;

    context.tnOptions = tnOptions;
    context.attributeOptions = attributeOptions;
    context.actionComplexityOptions = ACTION_COMPLEXITY_OPTIONS;
    context.trainingCategoryOptions = TRAINING_CATEGORY_OPTIONS;
    context.classification = classification;

    context.selected = {
      tn,
      linkedAttribute1: attr1,
      linkedAttribute2: attr2,
      actionComplexity: classification.actionComplexity,
      trainingCategory: classification.trainingCategory
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

  /** @inheritDoc */
  async _onSubmit(formConfig = {}, event) {
    const result = await super._onSubmit(formConfig, event);

    // Keep legacy system.linkedAttribute synced to attribute #1 for compatibility
    const sys = this.item.system ?? {};
    const a1 = String(sys.linkedAttribute1 ?? "").trim();
    const legacy = String(sys.linkedAttribute ?? "").trim();
    const classification = getSkillClassification(this.item, { preferCanonical: true });
    const classificationCode = String(sys.complexityCode ?? "").trim().toUpperCase();
    const legacyCode = String(sys.c ?? "").trim().toUpperCase();
    const referenced = getReferencedSkillClassification(this.item);
    const referenceVersion = Number(sys.classificationReferenceVersion ?? 0) || 0;

    const updates = {};
    if (a1 !== legacy) updates["system.linkedAttribute"] = a1;
    if (classificationCode !== classification.code) updates["system.complexityCode"] = classification.code;
    if (legacyCode !== classification.code) updates["system.c"] = classification.code;
    if (referenced && referenceVersion < SKILL_CLASSIFICATION_REFERENCE_VERSION) {
      updates["system.classificationReferenceVersion"] = SKILL_CLASSIFICATION_REFERENCE_VERSION;
    }
    if (Object.keys(updates).length) {
      await this.item.update(updates);
    }

    return result;
  }
}
