// AToW Battletech (Foundry VTT v13) - BattleMech Design Quirk Item Sheet

const SYSTEM_ID = "atow-battletech";
const TEMPLATE = `systems/${SYSTEM_ID}/templates/mech-quirk.hbs`;

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ItemSheetV2 } = foundry.applications.sheets;

const QUIRK_TYPE_CHOICES = Object.freeze({
  positive: "Positive Quirk",
  negative: "Negative Quirk"
});

function normalizeQuirkPoints(value) {
  const points = Number(value);
  if (!Number.isFinite(points)) return 0;
  return Math.min(5, Math.max(0, Math.round(points)));
}

function isAccurateWeaponQuirk(item) {
  return String(item?.name ?? "").trim().toLowerCase() === "accurate weapon";
}

function getCritSlots(system, locKey) {
  const raw = system?.crit?.[locKey]?.slots;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const max = ["head", "ll", "rl"].includes(locKey) ? 6 : 12;
    return Array.from({ length: max }, (_, index) => raw[index] ?? raw[String(index)] ?? {});
  }
  return [];
}

function looksLikeWeapon(item, label = "") {
  if (["weapon", "mechWeapon"].includes(item?.type)) return true;
  const name = String(item?.name ?? label ?? "");
  return /(laser|ppc|autocannon|\bac\s*\/?\s*\d+|\blrm\b|\bsrm\b|\bmrm\b|\bmml\b|\batm\b|gauss|machine gun|\bmg\b|flamer|rifle|narc missile beacon|arrow iv system|hatchet|sword)/i.test(name);
}

async function getInstalledWeaponChoices(actor) {
  if (!actor || actor.documentName !== "Actor") return {};

  const locKeys = ["head", "ct", "lt", "rt", "la", "ra", "ll", "rl"];
  const locLabels = {
    head: "HD",
    ct: "CT",
    lt: "LT",
    rt: "RT",
    la: "LA",
    ra: "RA",
    ll: "LL",
    rl: "RL"
  };
  const candidates = [];

  for (const locKey of locKeys) {
    const slots = getCritSlots(actor.system, locKey);
    for (let index = 0; index < slots.length; index++) {
      const slot = slots[index] ?? {};
      if (slot.partOf !== undefined && slot.partOf !== null) continue;

      const uuid = String(slot.uuid ?? "").trim();
      const label = String(slot.label ?? "").trim();
      if (!uuid && !label) continue;

      candidates.push({
        locKey,
        index,
        uuid,
        label,
        mountId: String(slot.mountId ?? "").trim(),
        rearMounted: Boolean(slot.rearMounted)
      });
    }
  }

  const resolved = new Map();
  await Promise.all([...new Set(candidates.map(candidate => candidate.uuid).filter(Boolean))].map(async uuid => {
    try {
      resolved.set(uuid, await fromUuid(uuid));
    } catch {
      resolved.set(uuid, null);
    }
  }));

  const choices = {};
  for (const candidate of candidates) {
    const item = candidate.uuid ? resolved.get(candidate.uuid) : null;
    if (!looksLikeWeapon(item, candidate.label)) continue;

    const key = candidate.mountId
      ? `mount:${candidate.mountId}`
      : `crit:${candidate.locKey}:${candidate.index}`;
    const name = String(item?.name ?? candidate.label ?? "Weapon");
    const location = `${locLabels[candidate.locKey] ?? candidate.locKey.toUpperCase()}${candidate.rearMounted ? " (Rear)" : ""}`;
    choices[key] = `${name} — ${location}, Slot ${candidate.index + 1}`;
  }

  return choices;
}

export class AToWMechQuirkSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(
    super.DEFAULT_OPTIONS,
    {
      classes: ["atow", "sheet", "item", "atow-item-sheet", "mech-quirk"],
      position: { width: 560, height: 420 },
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
    return `${this.item.name} - BattleMech Design Quirk`;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const system = foundry.utils.deepClone(this.item.system ?? {});

    system.description ??= "";
    system.polarity = system.polarity === "negative" ? "negative" : "positive";
    system.points = normalizeQuirkPoints(system.points);
    system.selectedWeaponKey = String(system.selectedWeaponKey ?? "");

    context.item = this.item;
    context.system = system;
    context.quirkTypeChoices = QUIRK_TYPE_CHOICES;
    context.isAccurateWeapon = isAccurateWeaponQuirk(this.item);
    context.hasOwningMech = this.item.parent?.documentName === "Actor";
    context.installedWeaponChoices = context.isAccurateWeapon && context.hasOwningMech
      ? await getInstalledWeaponChoices(this.item.parent)
      : {};
    context.hasInstalledWeapons = Object.keys(context.installedWeaponChoices).length > 0;
    return context;
  }
}
