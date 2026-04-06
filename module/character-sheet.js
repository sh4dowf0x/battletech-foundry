// module/character-sheet.js
// version: 0.1.4
// NOTE: This sheet now loads a dedicated stylesheet: systems/atow-battletech/styles/character-sheet.css

const SYSTEM_ID = "atow-battletech";
// NOTE: v2 sheet uses its own template file.
const TEMPLATE = `systems/${SYSTEM_ID}/templates/character-sheet.hbs`;
const SHEET_CSS = `systems/${SYSTEM_ID}/styles/character-sheet.css`;
const SHEET_CSS_ID = "atow-character-sheet-css";

// Combat tables are intentionally capped (canon sheet has 4 slots each).
const MAX_COMBAT_WEAPONS = 4;
const MAX_COMBAT_ARMOR = 4;

// Character Armor Type options (stored as string, but some older data may be numeric indices)
const ARMOR_TYPE_OPTIONS = [
  "Flak",
  "Ablative",
  "AB/Flak",
  "Ballistic Plate",
  "Neo-Chainmail",
  "Myomer",
  "Concealed",
  "Other"
];

function titleCase(str) {
  const s = String(str ?? "").trim();
  if (!s) return "";
  return s
    .split(/\s+/g)
    .map(w => w ? (w[0].toUpperCase() + w.slice(1)) : "")
    .join(" ");
}

function armorTypeToLabel(raw) {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "number" && Number.isFinite(raw)) return ARMOR_TYPE_OPTIONS[raw] ?? String(raw);
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) {
    const idx = Number(s);
    if (Number.isFinite(idx)) return ARMOR_TYPE_OPTIONS[idx] ?? s;
  }
  return s;
}



/**
 * AToW Skill XP thresholds (minimum XP required to reach each rank).
 * Mapping:
 *  - Rank 0 at 20 XP
 *  - Rank 1 at 30 XP
 *  - Rank 2 at 50 XP
 *  - Rank 3 at 80 XP
 *  - Rank 4 at 120 XP
 *  - Rank 5 at 170 XP
 *  - Rank 6 at 230 XP
 *  - Rank 7 at 300 XP
 *  - Rank 8 at 380 XP
 *  - Rank 9 at 470 XP
 *  - Rank 10 at 570 XP
 */
const SKILL_XP_TO_RANK = [
  { xp: 20, rank: 0 },
  { xp: 30, rank: 1 },
  { xp: 50, rank: 2 },
  { xp: 80, rank: 3 },
  { xp: 120, rank: 4 },
  { xp: 170, rank: 5 },
  { xp: 230, rank: 6 },
  { xp: 300, rank: 7 },
  { xp: 380, rank: 8 },
  { xp: 470, rank: 9 },
  { xp: 570, rank: 10 }
];

function skillRankFromXp(xp) {
  const n = Number(xp ?? 0) || 0;
  let rank = -1; // Untrained (below 20 XP)
  for (const row of SKILL_XP_TO_RANK) {
    if (n >= row.xp) rank = row.rank;
    else break;
  }
  return rank;
}

function skillMinXpForRank(rank) {
  const r = Number(rank ?? -1);
  if (!Number.isFinite(r) || r < 0) return 0;
  const row = SKILL_XP_TO_RANK.find(e => e.rank === r);
  return row ? row.xp : 0;
}

function derivedAttributeValueFromActor(actor, key) {
  const a = actor.system?.attributes?.[key] ?? {};
  const xp = Number(a.xp ?? (a.value ?? 0) * 100) || 0;
  return Math.floor(xp / 100);
}

/**
 * Convert an attribute key (system field) into a short label for display.
 */
function attributeLabelFromKey(key) {
  const k = String(key ?? "").trim();
  const map = { str: "STR", bod: "BOD", rfl: "REF", dex: "DEX", int: "INT", wil: "WIL", cha: "CHA" , edg: "EDG"};
  return map[k] ?? k.toUpperCase();
}

/**
 * AToW Attribute Link modifier table.
 * Attribute value -> link modifier.
 * 0:-4, 1:-2, 2-3:-1, 4-6:+0, 7-9:+1, 10+:+2
 */
function attributeLinkFromValue(value) {
  const v = Number(value ?? 0) || 0;
  if (v <= 0) return -4;
  if (v === 1) return -2;
  if (v <= 3) return -1;
  if (v <= 6) return 0;
  if (v <= 9) return 1;
  return 2;
}

function findSkillByName(actor, name) {
  const needle = String(name ?? "").trim().toLowerCase();
  if (!needle) return null;
  // Support both legacy ("skill") and current ("characterSkill") types.
  const isSkill = (i) => i?.type === "skill" || i?.type === "characterSkill";
  return actor.items.find(i => isSkill(i) && String(i.name ?? "").trim().toLowerCase() === needle)
    ?? actor.items.find(i => isSkill(i) && String(i.name ?? "").toLowerCase().includes(needle))
    ?? null;
}

function derivedSkillRankFromItem(item) {
  const xp = Number(item?.system?.xp ?? skillMinXpForRank(item?.system?.rank)) || 0;
  return skillRankFromXp(xp);
}

/**
 * Derived movement for AToW personal scale:
 * - Walk   = STR + REF
 * - Run    = 10 + STR + REF + Running skill level
 * - Sprint = Run * 2
 *
 * Note: our attribute key for REF is currently "rfl" on this sheet.
 */
function computeDerivedMove(actor) {
  const str = derivedAttributeValueFromActor(actor, "str");
  const ref = derivedAttributeValueFromActor(actor, "rfl");

  const runningSkill = findSkillByName(actor, "Running");
  const runningRankRaw = runningSkill ? derivedSkillRankFromItem(runningSkill) : -1;
  const runningRank = Math.max(0, Number(runningRankRaw) || 0); // don’t penalize if untrained (-1)

  const walk = str + ref;
  const run = 10 + str + ref + runningRank;
  const evade = run;
  const sprint = run * 2;

  // Climb: (Walk ÷ 2) + Climbing, but half speed if untrained/no skill.
  const climbingSkill = findSkillByName(actor, "Climbing");
  const climbingRankRaw = climbingSkill ? derivedSkillRankFromItem(climbingSkill) : -1;
  const hasClimbing = climbingRankRaw >= 0;
  const climbingRank = Math.max(0, Number(climbingRankRaw) || 0);
  const climbFull = Math.floor(walk / 2) + climbingRank;
  const climb = hasClimbing ? climbFull : Math.floor(climbFull / 2);

  // Crawl: ⌈Walk ÷ 4⌉
  const crawl = Math.ceil(walk / 4);

  // Swim: Walk + Swimming, but half speed if untrained/no skill.
  const swimmingSkill = findSkillByName(actor, "Swimming");
  const swimmingRankRaw = swimmingSkill ? derivedSkillRankFromItem(swimmingSkill) : -1;
  const hasSwimming = swimmingRankRaw >= 0;
  const swimmingRank = Math.max(0, Number(swimmingRankRaw) || 0);
  const swimFull = walk + swimmingRank;
  const swim = hasSwimming ? swimFull : Math.floor(swimFull / 2);

  return {
    walk, run, evade, sprint,
    climb, crawl, swim,
    str, ref,
    runningRank,
    climbingRank, swimmingRank
  };
}

/**
 * Derived vitals for AToW personal scale:
 * - Max Health  = BOD × 2
 * - Max Fatigue = WIL × 2
 *
 * Uses derived attribute values (from Attribute XP).
 */
function computeDerivedVitals(actor) {
  const bod = derivedAttributeValueFromActor(actor, "bod");
  const wil = derivedAttributeValueFromActor(actor, "wil");

  const healthMax = bod * 2;
  const fatigueMax = wil * 2;

  return { healthMax, fatigueMax, bod, wil };
}

/**
 * Derived Edge for AToW personal scale:
 * - Max Edge = EDG
 * Each EDG level provides 1 Edge point to spend.
 */
function computeDerivedEdge(actor) {
  const edg = derivedAttributeValueFromActor(actor, "edg");
  const edgeMax = Math.max(0, Number(edg ?? 0) || 0);
  return { edgeMax, edg };
}


/**
 * Build pip rows for the Condition Monitor display.
 * We group pips into rows of 5 to match the canon sheet layout.
 */
function buildPipRows(max, value, perRow = 5) {
  const m = Math.max(0, Number(max ?? 0) || 0);
  const vRaw = Number(value ?? 0) || 0;
  const v = Math.min(m, Math.max(0, vRaw));

  const pips = Array.from({ length: m }, (_, i) => {
    const n = i + 1;
    return { value: n, filled: n <= v };
  });

  const rows = [];
  for (let i = 0; i < pips.length; i += perRow) rows.push(pips.slice(i, i + perRow));
  return rows;
}

/**
 * Foundry form updates often turn "array-ish" paths like a.0.b into plain objects.
 * This helper normalizes either an Array or an Object-with-numeric-keys into an Array.
 */
function coerceIndexedCollection(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  return Object.keys(raw)
    .filter(k => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b))
    .map(k => raw[k]);
}

/**
 * Trait activation rule:
 * Trait activates when Trait XP reaches TP × 100.
 * - For positive TP, XP must be >= threshold.
 * - For negative TP, XP must be <= threshold.
 */

/**
 * Build a combat weapon row from a Character Weapon item.
 * Stored into system.combat.weapons so downstream scripts can read it.
 */
function combatWeaponRowFromItem(item) {
  const sys = item?.system ?? {};

  // Skill mapping (stored on the Character Weapon item sheet as system.skillKey)
  const skillKey = String(sys.skillKey ?? sys.skill ?? sys.attackSkill ?? sys.skillName ?? "").trim();
  const SKILL_MAP = {
    melee: { label: "Melee", tied: "Melee Weapons" },
    archery: { label: "Archery", tied: "Archery" },
    thrown: { label: "Thrown", tied: "Thrown Weapons" },
    smallArms: { label: "Small Arms", tied: "Small Arms" },
    support: { label: "Support", tied: "Support Weapons" }
  };

  const mapped = SKILL_MAP[skillKey] ?? null;

  // Prefer a short display label in the combat table.
  const skillLabel = String(
    mapped?.label ??
    sys.skillLabel ??
    sys.skillDisplay ??
    sys.skill ??
    sys.attackSkill ??
    sys.skillName ??
    ""
  );

  const tiedSkill = String(mapped?.tied ?? sys.tiedSkill ?? sys.skillTied ?? "");

  // AP/BD: support either a combined string (system.apbd) or split fields (system.damage.ap + system.damage.bd).
  const apbdCombined = String(sys.apbd ?? sys.apBd ?? sys.apBD ?? "").trim();
  const ap = sys?.damage?.ap ?? sys.ap ?? sys.armorPenetration ?? "";
  const bd = sys?.damage?.bd ?? sys.bd ?? sys.baseDamage ?? "";
  const apbd = apbdCombined || (
    (String(ap).trim() || String(bd).trim())
      ? `${String(ap ?? "").trim()}/${String(bd ?? "").trim()}`
      : ""
  );

  return {
    _sourceItemId: item.id,
    name: item.name ?? "",
    skill: skillLabel,
    // Future automation fields (may be ignored by the sheet form, but useful for scripts)
    skillKey: mapped ? skillKey : "",
    tiedSkill,
    apbd,
    range: String(sys.range ?? ""),
    ammo: String(sys.shots ?? sys.ammo ?? sys.ammoCount ?? "").trim(),
    notes: String(sys.notes ?? "")
  };
}


/**
 * Convert Character Armor coverage fields to a short Loc string for the combat table.
 * - If sys.coverage is an object of booleans, produce a stable abbreviated string (e.g., "H/T/A/L").
 * - Otherwise fall back to sys.loc (string).
 */
function coverageToLocString(coverage, fallback = "") {
  // If the item stores "coverage" as a string already, just use it.
  if (typeof coverage === "string") return coverage.trim();

  // Coverage checkboxes from character-armor.js: head/torso/arms/legs/hands/feet
  if (coverage && typeof coverage === "object") {
    const parts = [];
    if (coverage.head) parts.push("H");
    if (coverage.torso) parts.push("T");
    if (coverage.arms) parts.push("A");
    if (coverage.legs) parts.push("L");
    if (coverage.hands) parts.push("Ha");
    if (coverage.feet) parts.push("Fe");
    if (parts.length) return parts.join("/");
  }

  return String(fallback ?? "").trim();
}

/**
 * Build a combat armor row from a Character Armor item.
 * Stored into system.combat.armor so downstream scripts can read it.
 */
function combatArmorRowFromItem(item) {
  const sys = item?.system ?? {};
  const bar = sys.bar ?? {};
  const loc = coverageToLocString(sys.coverage, sys.loc);

  return {
    _sourceItemId: item.id,
    name: item.name ?? "",
    loc,
    type: armorTypeToLabel(sys.armorType ?? sys.type ?? ""),
    m: (bar.m ?? sys.m ?? ""),
    b: (bar.b ?? sys.b ?? ""),
    e: (bar.e ?? sys.e ?? ""),
    x: (bar.x ?? sys.x ?? "")
  };
}
/**
 * Determine a stable order for equipped embedded items so the combat tables don't jump around.
 * Priority:
 *  1) preferId (if provided and currently equipped)
 *  2) existing combat table order (_sourceItemId order)
 *  3) remaining equipped items by Foundry sort key
 *
 * @param {Actor} actor
 * @param {"characterWeapon"|"characterArmor"} type
 * @param {string|null} preferId
 * @param {number} [max] Optional cap on number of ids returned
 */
function orderedEquippedItemIds(actor, type, preferId = null, max = Infinity) {
  const equippedItems = actor.items.filter(i => i.type === type && !!i.system?.equipped);
  const equippedSet = new Set(equippedItems.map(i => i.id));

  const combat = actor.system?.combat ?? {};
  const rows = type === "characterWeapon"
    ? coerceIndexedCollection(combat.weapons)
    : coerceIndexedCollection(combat.armor);

  const ordered = [];

  if (preferId && equippedSet.has(preferId)) ordered.push(preferId);

  for (const r of rows) {
    const id = r?._sourceItemId;
    if (!id) continue;
    if (!equippedSet.has(id)) continue;
    if (!ordered.includes(id)) ordered.push(id);
  }

  const remaining = equippedItems
    .filter(i => !ordered.includes(i.id))
    .sort((a, b) => (Number(a.sort ?? 0) - Number(b.sort ?? 0)) || String(a.name ?? "").localeCompare(String(b.name ?? ""), undefined, { sensitivity: "base" }));

  for (const i of remaining) ordered.push(i.id);

  return ordered.slice(0, Math.max(0, Number(max ?? Infinity)));
}

function isTraitActive(tp, xp) {
  const t = Number(tp ?? 0) || 0;
  const x = Number(xp ?? 0) || 0;
  const threshold = t * 100;
  if (t < 0) return x <= threshold;
  return x >= threshold;
}

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;

export class ATOWCharacterSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  /** Ensure our sheet CSS is loaded once per session. */
  static _ensureSheetStyles() {
    if (document.getElementById(SHEET_CSS_ID)) return;
    const link = document.createElement("link");
    link.id = SHEET_CSS_ID;
    link.rel = "stylesheet";
    link.type = "text/css";
    link.href = SHEET_CSS;
    document.head.appendChild(link);
  }

  /** @inheritDoc */
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(
    super.DEFAULT_OPTIONS,
    {
      classes: ["atow", "sheet", "actor", "character", "atow-character-classic"],
      position: { width: 980, height: 900 },
      window: { resizable: true },

      form: {
        submitOnChange: true,
        closeOnSubmit: false
      },

      actions: {
        "roll-initiative": ATOWCharacterSheet._onRollInitiative,
        "roll-skill": ATOWCharacterSheet._onRollSkill
      }
    },
    { inplace: false }
  );

  static PARTS = {
    form: { template: TEMPLATE }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    context.actor = this.actor;
    context.system = this.actor.system;

    const sys = this.actor.system ?? {};
    const attrs = sys.attributes ?? {};
    const attrOrder = [
      ["str", "STR"],
      ["bod", "BOD"],
      ["rfl", "REF"],
      ["dex", "DEX"],
      ["int", "INT"],
      ["wil", "WIL"],
      ["cha", "CHA"],
      ["edg", "EDG"]
    ];

    const items = this.actor.items.contents;

    // Support both legacy and current item type names.
    const isSkill = (i) => i?.type === "skill" || i?.type === "characterSkill";
    const isTrait = (i) => i?.type === "trait" || i?.type === "characterTrait";
    const isEquipment = (i) => i?.type === "characterEquipment" || i?.type === "gear";

    const skills = items.filter(isSkill);
    const traits = items.filter(isTrait);
    const gear = items.filter(i => isEquipment(i) || ["characterWeapon", "characterArmor"].includes(i.type));

    const gearItems = gear.map(i => {
      const equipped = !!i.system?.equipped;
      const mass = Number(i.system?.mass ?? i.system?.massKg ?? i.system?.mass_kg ?? i.system?.weight ?? 0) || 0;
      const notes = String(i.system?.notes ?? i.system?.note ?? "").trim();
      const gearType = titleCase(i.system?.gearType ?? i.system?.type ?? "");
      return {
        _id: i.id,
        name: i.name,
        img: i.img,
        type: i.type,
        typeLabel: i.type === "characterWeapon"
          ? "Weapon"
          : (i.type === "characterArmor"
            ? "Armor"
            : (i.type === "characterEquipment" ? (gearType || "Equipment") : "Gear")),
        equipped,
        mass,
        notes
      };
    });

    const attributes = attrOrder.map(([key, label]) => {
      const a = attrs[key] ?? {};
      const xp = Number(a.xp ?? (a.value ?? 0) * 100) || 0;
      const value = Math.floor(xp / 100);
      const link = attributeLinkFromValue(value);
      return { key, label, xp, value, link };
    });

    const skillRows = skills
      .map(s => {
        const xp = Number(s.system?.xp ?? skillMinXpForRank(s.system?.rank)) || 0;
        const rank = skillRankFromXp(xp);

        // Skills can have up to 2 linked attributes (new fields), but older data may use linkedAttribute.
        const linkedAttribute1 = String(s.system?.linkedAttribute1 ?? s.system?.linkedAttribute ?? "").trim();
        const linkedAttribute2 = String(s.system?.linkedAttribute2 ?? "").trim();

        // De-duplicate (don't double-count if both fields are the same)
        const linkedKeys = Array.from(new Set([linkedAttribute1, linkedAttribute2].filter(k => !!k)));

        const attrLabels = linkedKeys.length
          ? linkedKeys.map(attributeLabelFromKey).join("+")
          : "";

        const attrValues = linkedKeys.map(k => derivedAttributeValueFromActor(this.actor, k));
        const attrLinks = attrValues.map(v => attributeLinkFromValue(v));

        // If multiple linked attributes exist, add ALL link modifiers together.
        const totalLink = attrLinks.reduce((a, b) => a + b, 0);

        const tnRaw = Number(s.system?.tn);
        const tn = Number.isFinite(tnRaw) ? tnRaw : null;

        // Optional "C" (category/check) field if you store it on the skill
        const c = String(s.system?.c ?? s.system?.check ?? s.system?.categoryShort ?? "").trim();

        const tnc = [
          tn !== null ? String(tn) : "",
          c
        ].filter(Boolean).join("/");

        return {
          _id: s.id,
          name: s.name,
          img: s.img,
          type: s.type,
          system: s.system,
          xp,
          rank,
          linkedAttribute1,
          linkedAttribute2,
          attrLabels,
          totalLink,
          tn,
          c,
          tnc
        };
      })
      .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""), undefined, { sensitivity: "base" }));

    // Split into two columns for a more "canon sheet" look
    const half = Math.ceil(skillRows.length / 2);
    context.skillsLeft = skillRows.slice(0, half);
    context.skillsRight = skillRows.slice(half);

    const traitRows = traits
      .map(t => {
        // Trait XP (positive spends, negative grants)
        const cost = Number(t.system?.cost ?? 0) || 0;

        // Trait Points (TP) determine activation threshold
        const tp = Number(t.system?.tp ?? 0) || 0;
        const threshold = tp * 100;
        const active = isTraitActive(tp, cost);

        const category = String(t.system?.category ?? "").trim();
        const pageRef = String(t.system?.pageRef ?? "").trim();

        return {
          _id: t.id,
          name: t.name,
          img: t.img,
          type: t.type,
          system: t.system,
          cost,
          tp,
          threshold,
          active,
          category,
          pageRef
        };
      })
      .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""), undefined, { sensitivity: "base" }));

    const xpSpentAttributes = attributes.reduce((sum, a) => sum + (Number(a.xp) || 0), 0);
    const xpSpentSkills = skillRows.reduce((sum, s) => sum + (Number(s.xp) || 0), 0);
    const xpSpentTraits = traitRows.reduce((sum, t) => sum + (Number(t.cost) || 0), 0);
    const xpSpentTotal = xpSpentAttributes + xpSpentSkills + xpSpentTraits;

    context.attributes = attributes;
    context.skills = skillRows; // kept for compatibility with older partials
    context.traits = traitRows;
    context.gear = gear;
    context.gearItems = gearItems;

    context.xpSummary = {
      spentTotal: xpSpentTotal,
      earnedTotal: Number(sys.xp?.total ?? 0) || 0
    };

    // Derived movement display values (computed; not editable)
    context.derivedMove = computeDerivedMove(this.actor);

    // Derived vitals display values (computed; max values are not editable)
    context.derivedVitals = computeDerivedVitals(this.actor);

    // --------------------------------------------
    // Combat Data (canon sheet layout)
    // --------------------------------------------
    const healthMax = Number(context.derivedVitals?.healthMax ?? 0) || 0;
    const fatigueMax = Number(context.derivedVitals?.fatigueMax ?? 0) || 0;
    const curHealth = Number(sys.health?.value ?? 0) || 0;
    const curFatigue = Number(sys.fatigue?.value ?? 0) || 0;

    context.healthPipRows = buildPipRows(healthMax, curHealth, 5);
    context.fatiguePipRows = buildPipRows(fatigueMax, curFatigue, 5);

    const combat = sys.combat ?? {};
    context.combatFlags = {
      stun: !!combat.stun,
      unconscious: !!combat.unconscious
    };

    // Personal Armor / Weapons are derived from equipped items (Character Armor / Character Weapon).
    // These sections are read-only on the sheet and primarily exist for downstream automation.
    const armorIds = orderedEquippedItemIds(this.actor, "characterArmor", null, MAX_COMBAT_ARMOR);
    const weaponIds = orderedEquippedItemIds(this.actor, "characterWeapon", null, MAX_COMBAT_WEAPONS);

    const equippedArmor = armorIds
      .map(id => this.actor.items.get(id))
      .filter(Boolean)
      .map(combatArmorRowFromItem);

    const equippedWeapons = weaponIds
      .map(id => this.actor.items.get(id))
      .filter(Boolean)
      .map(combatWeaponRowFromItem);

    const normalizeArmor = (row = {}) => ({
      _sourceItemId: String(row._sourceItemId ?? ""),
      name: String(row.name ?? ""),
      loc: String(row.loc ?? ""),
      type: String(row.type ?? ""),
      m: row.m ?? "",
      b: row.b ?? "",
      e: row.e ?? "",
      x: row.x ?? ""
    });

    const normalizeWeapon = (row = {}) => ({
      _sourceItemId: String(row._sourceItemId ?? ""),
      name: String(row.name ?? ""),
      skill: String(row.skill ?? ""),
      apbd: String(row.apbd ?? ""),
      range: String(row.range ?? ""),
      ammo: row.ammo ?? "",
      notes: String(row.notes ?? "")
    });

    const armorMin = MAX_COMBAT_ARMOR;
    const weaponsMin = MAX_COMBAT_WEAPONS;

    const armorOut = equippedArmor.map(normalizeArmor).slice(0, armorMin);
    const weaponsOut = equippedWeapons.map(normalizeWeapon).slice(0, weaponsMin);

    while (armorOut.length < armorMin) armorOut.push(normalizeArmor());
    while (weaponsOut.length < weaponsMin) weaponsOut.push(normalizeWeapon());

    context.combatArmor = armorOut;
    context.combatWeapons = weaponsOut;

    return context;
  }

  _onRender(context, options) {
    super._onRender(context, options);

    // Ensure per-sheet stylesheet is loaded
    ATOWCharacterSheet._ensureSheetStyles();

    const root = this.element;

    // Tabs are optional now; only bind if template includes them
    const nav = root?.querySelector?.(".sheet-tabs");
    const body = root?.querySelector?.(".sheet-body");
    if (nav && body) {
      this._tabsController = new foundry.applications.ux.Tabs({
        navSelector: ".sheet-tabs",
        contentSelector: ".sheet-body",
        initial: "core"
      });
      this._tabsController.bind(root);
    }

    if (this._boundRoot && this._delegatedClick) {
      this._boundRoot.removeEventListener("click", this._delegatedClick);
    }
    this._boundRoot = root;
    this._delegatedClick = this._handleClick.bind(this);
    root.addEventListener("click", this._delegatedClick);

    if (this._boundRootForChange && this._delegatedChange) {
      this._boundRootForChange.removeEventListener("change", this._delegatedChange);
    }
    this._boundRootForChange = root;
    this._delegatedChange = this._handleChange.bind(this);
    root.addEventListener("change", this._delegatedChange);



    // Allow dropping Items directly into the Gear section (it will embed onto the actor)
    const gearZone = root?.querySelector?.(".gear-drop-zone");
    if (gearZone && !this._gearDropBound) {
      this._gearDropBound = true;
      gearZone.addEventListener("dragover", ev => ev.preventDefault());
      gearZone.addEventListener("drop", ev => this._onDropToGear(ev));
    }
    // On first render, ensure derived values are synced into actor data so other features can use them.


    // Keep combat weapon/armor tables in sync with equipped items (runs once per sheet open)
    if (!this._gearSynced) {
      this._gearSynced = true;
      this._syncEquippedToCombatTables().catch(() => {});
    }
    if (!this._moveSynced) {
      this._moveSynced = true;
      this._updateDerivedMove().catch(() => {});
      this._updateDerivedVitals().catch(() => {});
      this._updateDerivedEdge().catch(() => {});
    }
  }

  async _preClose(options) {
    if (this.isEditable) {
      await this.submit();
      await this._updateActorXpSpent();
      await this._updateDerivedMove();
      await this._updateDerivedVitals();
    await this._updateDerivedEdge();
    }
    return super._preClose(options);
  }

  /* -------------------------------------------- */
  /* Derived updates                               */
  /* -------------------------------------------- */

  async _updateDerivedMove() {
    const { walk, run, evade, sprint, climb, crawl, swim } = computeDerivedMove(this.actor);

    const current = this.actor.system?.derived?.move ?? {};
    const curWalk = Number(current.walk ?? 0) || 0;
    const curRun = Number(current.run ?? 0) || 0;

    // Back-compat: some templates used "jump" where we now mean "sprint"
    const curSprint = Number(current.sprint ?? current.jump ?? 0) || 0;

    const curEvade = Number(current.evade ?? curRun ?? 0) || 0;
    const curClimb = Number(current.climb ?? 0) || 0;
    const curCrawl = Number(current.crawl ?? 0) || 0;
    const curSwim = Number(current.swim ?? 0) || 0;

    if (walk === curWalk && run === curRun && evade === curEvade && sprint === curSprint && climb === curClimb && crawl === curCrawl && swim === curSwim) return;

    await this.actor.update({
      "system.derived.move.walk": walk,
      "system.derived.move.run": run,
      "system.derived.move.evade": evade,
      "system.derived.move.sprint": sprint,
      "system.derived.move.climb": climb,
      "system.derived.move.crawl": crawl,
      "system.derived.move.swim": swim,
      "system.derived.move.jump": sprint // legacy field, safe to keep synced
    });
  }

  async _updateDerivedVitals() {
    const { healthMax, fatigueMax } = computeDerivedVitals(this.actor);

    const curHealthMax = Number(this.actor.system?.health?.max ?? 0) || 0;
    const curFatigueMax = Number(this.actor.system?.fatigue?.max ?? 0) || 0;

    // Optionally clamp current values if they exceed new maxima
    const curHealthVal = Number(this.actor.system?.health?.value ?? 0) || 0;
    const curFatigueVal = Number(this.actor.system?.fatigue?.value ?? 0) || 0;

    const update = {};

    if (healthMax !== curHealthMax) update["system.health.max"] = healthMax;
    if (fatigueMax !== curFatigueMax) update["system.fatigue.max"] = fatigueMax;

    if (curHealthVal > healthMax) update["system.health.value"] = healthMax;
    if (curFatigueVal > fatigueMax) update["system.fatigue.value"] = fatigueMax;

    if (Object.keys(update).length === 0) return;
    await this.actor.update(update);
  }

  async _updateDerivedEdge() {
    const { edgeMax } = computeDerivedEdge(this.actor);

    const curMax = Number(this.actor.system?.edge?.max ?? 0) || 0;
    const curVal = Number(this.actor.system?.edge?.value ?? 0) || 0;

    const update = {};
    if (edgeMax !== curMax) update["system.edge.max"] = edgeMax;

    // Clamp current edge to new max
    if (curVal > edgeMax) update["system.edge.value"] = edgeMax;

    // Ensure min exists (schema has it, but be safe)
    if (this.actor.system?.edge?.min === undefined) update["system.edge.min"] = 0;

    if (Object.keys(update).length === 0) return;
    await this.actor.update(update);
  }


  /* -------------------------------------------- */
  /* Inline change handling                        */
  /* -------------------------------------------- */

  async _handleChange(event) {
    const el = /** @type {HTMLElement} */ (event.target);
    if (!el) return;

    // Attribute XP changed: update derived attribute value and spent total
    const attrXp = el.closest("input.attr-xp");
    if (attrXp) {
      const name = attrXp.getAttribute("name") ?? "";
      const m = name.match(/^system\.attributes\.([a-zA-Z0-9_]+)\.xp$/);
      if (!m) return;

      const key = m[1];
      const xp = Number(attrXp.value ?? 0) || 0;
      const value = Math.floor(xp / 100);

      await this.actor.update({
        [`system.attributes.${key}.value`]: value
      });

      await this._updateActorXpSpent();
      await this._updateDerivedMove();
      await this._updateDerivedVitals();
    await this._updateDerivedEdge();
    return;
    }

    // Skill XP changed: update item xp + derived rank (AToW table)
    const skillXp = el.closest("input.skill-xp");
    if (skillXp) {
      const itemId = skillXp.dataset.itemId;
      if (!itemId) return;
      const item = this.actor.items.get(itemId);
      if (!item) return;

      const xp = Number(skillXp.value ?? 0) || 0;
      const rank = skillRankFromXp(xp);

      await item.update({
        "system.xp": xp,
        "system.rank": rank
      });

      await this._updateActorXpSpent();
      await this._updateDerivedMove();
      await this._updateDerivedVitals();
    await this._updateDerivedEdge();
    return;
    }

    // Trait cost (XP) changed: update item cost
    const traitCost = el.closest("input.trait-cost");
    if (traitCost) {
      const itemId = traitCost.dataset.itemId;
      if (!itemId) return;
      const item = this.actor.items.get(itemId);
      if (!item) return;

      const cost = Number(traitCost.value ?? 0) || 0;
      await item.update({
        "system.cost": cost
      });

      await this._updateActorXpSpent();
      this.render();
      return;
    }
  }

  _calculateXpSpentTotal() {
    const sys = this.actor.system ?? {};

    const attrs = sys.attributes ?? {};
    const attrKeys = Object.keys(attrs);
    const xpAttrs = attrKeys.reduce((sum, k) => {
      const a = attrs[k] ?? {};
      const xp = Number(a.xp ?? (a.value ?? 0) * 100) || 0;
      return sum + xp;
    }, 0);

    const skills = this.actor.items.filter(i => i.type === "skill" || i.type === "characterSkill");
    const xpSkills = skills.reduce((sum, s) => {
      const xp = Number(s.system?.xp ?? skillMinXpForRank(s.system?.rank)) || 0;
      return sum + xp;
    }, 0);

    const traits = this.actor.items.filter(i => i.type === "trait" || i.type === "characterTrait");
    const xpTraits = traits.reduce((sum, t) => sum + (Number(t.system?.cost ?? 0) || 0), 0);

    return xpAttrs + xpSkills + xpTraits;
  }

  async _updateActorXpSpent() {
    const spent = this._calculateXpSpentTotal();
    const current = Number(this.actor.system?.xp?.spent ?? 0) || 0;
    if (spent === current) return;

    await this.actor.update({
      "system.xp.spent": spent
    });
  }


  /* -------------------------------------------- */
  /* Drag & drop: add Equipment to Gear list       */
  /* -------------------------------------------- */

  /**
   * Drop handler for the Gear table.
   * Accepts characterEquipment items (and characterWeapon/characterArmor for convenience).
   */
  async _onDropToGear(event) {
    event.preventDefault();
    if (!this.isEditable) return;

    const data = (() => {
      try {
        return TextEditor.getDragEventData(event);
      } catch (e) {
        return null;
      }
    })();

    if (!data || data.type !== "Item") return;

    // If the dragged item is already embedded in this actor, do nothing.
    if (typeof data.uuid === "string" && this.actor?.uuid && data.uuid.startsWith(`${this.actor.uuid}.Item.`)) {
      return;
    }

    const dropped = data.uuid ? await fromUuid(data.uuid) : null;
    if (!dropped) return;

    // Allow only equipment-ish item types here.
    const allowed = new Set([
      "characterEquipment",
      "characterWeapon",
      "characterArmor",
      // legacy fallbacks
      "gear",
      "weapon",
      "armor"
    ]);

    if (!allowed.has(dropped.type)) {
      ui.notifications?.warn?.("Drop equipment, weapons, or armor here.");
      return;
    }

    const typeMap = {
      gear: "characterEquipment",
      weapon: "characterWeapon",
      armor: "characterArmor"
    };

    const obj = dropped.toObject();
    delete obj._id;
    obj.type = typeMap[obj.type] ?? obj.type;

    // Ensure expected core fields exist.
    obj.system = obj.system ?? {};
    if (obj.type === "characterEquipment" && obj.system.equipped === undefined) obj.system.equipped = false;

    await this.actor.createEmbeddedDocuments("Item", [obj]);
    this.render();
  }


  /* -------------------------------------------- */
  /* Gear equip -> Combat tables sync              */
  /* -------------------------------------------- */

  /**
   * Sync equipped Character Weapon/Armor items into system.combat.weapons / system.combat.armor.
   * We preserve any "manual" rows the user entered (rows without _sourceItemId).
   */
  async _syncEquippedToCombatTables(options = {}) {
    const combat = foundry.utils.duplicate(this.actor.system?.combat ?? {});

    const weaponIds = orderedEquippedItemIds(this.actor, "characterWeapon", options.preferWeaponId ?? null, MAX_COMBAT_WEAPONS);
    const armorIds = orderedEquippedItemIds(this.actor, "characterArmor", options.preferArmorId ?? null, MAX_COMBAT_ARMOR);

    const equippedWeapons = weaponIds
      .map(id => this.actor.items.get(id))
      .filter(Boolean)
      .map(combatWeaponRowFromItem);

    const equippedArmor = armorIds
      .map(id => this.actor.items.get(id))
      .filter(Boolean)
      .map(combatArmorRowFromItem);

    const curWeapons = coerceIndexedCollection(combat.weapons);
    const curArmor = coerceIndexedCollection(combat.armor);

    const eq = foundry.utils.isObjectEqual
      ? (a, b) => foundry.utils.isObjectEqual(a, b)
      : (a, b) => JSON.stringify(a) === JSON.stringify(b);

    if (eq(curWeapons, equippedWeapons) && eq(curArmor, equippedArmor)) return;

    combat.weapons = equippedWeapons;
    combat.armor = equippedArmor;

    await this.actor.update({ "system.combat": combat });
    this.render();
  }

  /* -------------------------------------------- */
  /* Click handling                                */
  /* -------------------------------------------- */

  async _handleClick(event) {
    const target = /** @type {HTMLElement} */ (event.target);
    if (!target) return;

    // ------------------------------------------------
    // Portrait click-to-edit (open FilePicker)
    // ------------------------------------------------
    const portrait = target.closest('img.profile-img, img.char-portrait, [data-edit="img"]');
    if (portrait) {
      // respect permissions / editability
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
        current: this.actor?.img ?? "",
        callback: async (path) => {
          if (!path) return;
          await this.actor.update({ img: path });
        }
      });

      // Some Foundry versions require browse() before render()
      try { fp.browse(); } catch (e) { /* ignore */ }
      fp.render(true);
      return;
    }

    // ------------------------------------------------
    // Condition Monitor pips (click to set)
    // ------------------------------------------------
    const pip = target.closest(".pip");
    if (pip) {
      event.preventDefault();

      const track = String(pip.dataset.track ?? "").trim();
      const value = Number(pip.dataset.value ?? 0) || 0;

      if (!track || !value) return;

      if (track === "health") {
        const cur = Number(this.actor.system?.health?.value ?? 0) || 0;
        const next = (cur === value) ? Math.max(0, value - 1) : value;
        return this.actor.update({ "system.health.value": next });
      }

      if (track === "fatigue") {
        const cur = Number(this.actor.system?.fatigue?.value ?? 0) || 0;
        const next = (cur === value) ? Math.max(0, value - 1) : value;
        return this.actor.update({ "system.fatigue.value": next });
      }
    }

    // ------------------------------------------------
    // Weapon attack roll (click weapon name in combat list)
    // ------------------------------------------------
    const weaponRoll = target.closest("[data-action='roll-weapon'], .weapon-roll");
    if (weaponRoll) {
      event.preventDefault();
      const itemId = weaponRoll.dataset.itemId || weaponRoll.getAttribute("data-item-id");
      if (!itemId) return;
      return this._rollWeaponAttack(itemId);
    }

    // ------------------------------------------------
    // Gear equip toggle (works for Gear, Character Weapon, Character Armor)
    // ------------------------------------------------
    const equipToggle = target.closest(".gear-equip-toggle");
    if (equipToggle) {
      event.preventDefault();
      const itemId = equipToggle.dataset.itemId;
      const item = itemId ? this.actor.items.get(itemId) : null;
      if (!item) return;

      const next = !item.system?.equipped;

      // Enforce maximum equipped weapons/armor (4 each). If we would exceed the cap,
      // automatically unequip the lowest-priority currently equipped item (the last slot).
      if (next && (item.type === "characterWeapon" || item.type === "characterArmor")) {
        const type = item.type;
        const cap = type === "characterWeapon" ? MAX_COMBAT_WEAPONS : MAX_COMBAT_ARMOR;

        // Current equipped ids (excluding the item we're equipping).
        let equippedIds = orderedEquippedItemIds(this.actor, type, null, Infinity).filter(id => id !== item.id);

        // We are about to add 1; ensure there are at most cap-1 others equipped.
        while (equippedIds.length >= cap) {
          const victimId = equippedIds[equippedIds.length - 1];
          const victim = this.actor.items.get(victimId);
          if (victim) await victim.update({ "system.equipped": false });
          equippedIds = equippedIds.slice(0, -1);
        }
      }

      await item.update({ "system.equipped": next });

      // Prefer showing the toggled-on item at the top.
      const opts = {};
      if (next && item.type === "characterWeapon") opts.preferWeaponId = item.id;
      if (next && item.type === "characterArmor") opts.preferArmorId = item.id;

      await this._syncEquippedToCombatTables(opts);
      return;
    }
    const createBtn = target.closest(".item-create");
    if (createBtn) {
      event.preventDefault();
      return this._createItem(createBtn.dataset.type);
    }

    const editBtn = target.closest(".item-edit");
    if (editBtn) {
      event.preventDefault();
      const li = editBtn.closest(".item");
      const itemId = li?.dataset?.itemId;
      const item = itemId ? this.actor.items.get(itemId) : null;
      return item?.sheet?.render(true);
    }

    const delBtn = target.closest(".item-delete");
    if (delBtn) {
      event.preventDefault();
      const li = delBtn.closest(".item");
      const itemId = li?.dataset?.itemId;
      const item = itemId ? this.actor.items.get(itemId) : null;
      if (!item) return;

      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: "Delete Item" },
        content: `<p>Delete <strong>${item.name}</strong>?</p>`,
        modal: true,
        rejectClose: false
      });

      if (ok) {
        await item.delete();
        await this._updateActorXpSpent();
        await this._syncEquippedToCombatTables();
        await this._updateDerivedMove();
        await this._updateDerivedVitals();
    await this._updateDerivedEdge();
    }
      return;
    }

    // Rollable skills
    const rollBtn = target.closest("[data-action='roll-skill']");
    if (rollBtn) return; // handled by actions
  }

  async _rollWeaponAttack(itemId) {
    const actor = this.actor;
    const weapon = actor.items.get(itemId);
    if (!weapon || weapon.type !== "characterWeapon") return;

    // Normalize weapon info similarly to the combat table.
    const row = combatWeaponRowFromItem(weapon);
    const tiedSkillName = String(row.tiedSkill || "").trim();
    const displaySkill = String(row.skill || "").trim();

    // Find the Skill item to roll against (preferred).
    const skillItem = tiedSkillName ? findSkillByName(actor, tiedSkillName) : null;

    if (!skillItem) {
      ui.notifications?.warn?.(`No matching Skill item found for ${weapon.name} (${tiedSkillName || displaySkill || "Unknown Skill"}).`);
      return;
    }

    const skillXp = Number(skillItem.system?.xp ?? skillMinXpForRank(skillItem.system?.rank)) || 0;
    const rank = skillRankFromXp(skillXp);

    // Linked attributes: up to 2, with legacy fallback.
    const linked1 = String(skillItem.system?.linkedAttribute1 ?? skillItem.system?.linkedAttribute ?? "").trim();
    const linked2 = String(skillItem.system?.linkedAttribute2 ?? "").trim();
    const linkedKeys = Array.from(new Set([linked1, linked2].filter(k => !!k)));

    const totalLink = linkedKeys
      .map(k => attributeLinkFromValue(derivedAttributeValueFromActor(actor, k)))
      .reduce((a, b) => a + b, 0);

    const modifier = rank + totalLink;

    const tnRaw = Number(skillItem.system?.tn);
    const tn = Number.isFinite(tnRaw) ? tnRaw : undefined;

    const flavorBits = [
      `${weapon.name} | Attack`,
      displaySkill ? `Skill: ${displaySkill}` : "",
      row.apbd ? `AP/BD: ${row.apbd}` : "",
      row.range ? `Range: ${row.range}` : ""
    ].filter(Boolean);

    const api = game[SYSTEM_ID]?.api;
    if (api?.rollCheck) {
      return api.rollCheck({
        actor,
        label: `${weapon.name} Attack`,
        modifier,
        tn,
        flavor: flavorBits.join(" • ")
      });
    }

    const roll = await new Roll(`2d6 + ${modifier}`).evaluate();
    return roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor: flavorBits.join(" • ")
    });
  }

  async _createItem(type = "characterEquipment") {
    if (!type) return;

    const prettyName = {
      characterEquipment: "New Equipment",
      characterWeapon: "New Weapon",
      characterArmor: "New Armor",
      characterSkill: "New Skill",
      characterTrait: "New Trait",
      // legacy fallbacks
      gear: "New Gear",
      skill: "New Skill",
      trait: "New Trait"
    }[type] ?? `New ${type.charAt(0).toUpperCase()}${type.slice(1)}`;

    const name = prettyName;
    await this.actor.createEmbeddedDocuments("Item", [{ name, type, system: {} }]);

    // In case the new item affects derived values, recompute
    await this._updateDerivedMove();
    await this._updateDerivedVitals();
    await this._updateDerivedEdge();
  }

  /* -------------------------------------------- */
  /* Actions (data-action handlers)               */
  /* -------------------------------------------- */

  static async _onRollInitiative(event, target) {
    event.preventDefault();

    const actor = this.actor;
    const combat = game.combat;
    const formula = "2d6";

    if (combat?.isActive) {
      const controlled = canvas?.tokens?.controlled?.find(t => t.actor?.id === actor.id) ?? null;
      const tokenDoc = controlled?.document ?? null;

      let combatant = null;

      try {
        if (tokenDoc?.id && typeof combat.getCombatantsByToken === "function") {
          combatant = combat.getCombatantsByToken(tokenDoc.id)?.[0] ?? null;
        }
        if (!combatant && typeof combat.getCombatantsByActor === "function") {
          combatant = combat.getCombatantsByActor(actor.id)?.[0] ?? null;
        }
      } catch (e) {}

      if (!combatant) {
        if (tokenDoc?.id) combatant = combat.combatants.find(c => c.tokenId === tokenDoc.id) ?? null;
        if (!combatant) combatant = combat.combatants.find(c => c.actorId === actor.id) ?? null;
      }

      if (combatant) {
        return combat.rollInitiative(combatant.id, {
          formula,
          messageOptions: {
            speaker: ChatMessage.getSpeaker({ actor, token: tokenDoc ?? undefined }),
            flavor: `${actor.name} | Initiative`
          }
        });
      }

      ui.notifications?.warn("This actor is not in the current combat. Add the token/actor to combat first.");
    }

    const roll = await new Roll(formula).evaluate();
    return roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor: `${actor.name} | Initiative`
    });
  }

  static async _onRollSkill(event, target) {
    event.preventDefault();

    const actor = this.actor;
    const itemId = target.dataset.itemId;
    if (!itemId) return;

    const skill = actor.items.get(itemId);
    if (!skill) return;

    const skillXp = Number(skill.system?.xp ?? skillMinXpForRank(skill.system?.rank)) || 0;
    const rank = skillRankFromXp(skillXp);

    // Skills can have up to 2 linked attributes; fall back to legacy linkedAttribute.
    const linked1 = String(skill.system?.linkedAttribute1 ?? skill.system?.linkedAttribute ?? "").trim();
    const linked2 = String(skill.system?.linkedAttribute2 ?? "").trim();

    // De-duplicate so we don't double-count the same attribute
    const linkedKeys = Array.from(new Set([linked1, linked2].filter(k => !!k)));

    const links = linkedKeys.map(k => {
      const val = derivedAttributeValueFromActor(actor, k);
      return { key: k, label: attributeLabelFromKey(k), link: attributeLinkFromValue(val) };
    });

    const totalLink = links.reduce((sum, l) => sum + l.link, 0);
    const linkLabel = links.length ? links.map(l => l.label).join(" / ") : "";

    const modifier = rank + totalLink;

    const tnRaw = Number(skill.system?.tn);
    const tn = Number.isFinite(tnRaw) ? tnRaw : undefined;

    const api = game[SYSTEM_ID]?.api;
    if (api?.rollCheck) {
      return api.rollCheck({
        actor,
        label: skill.name,
        modifier,
        tn,
        flavor: `${skill.name} (Rank ${rank}${linkLabel ? `, ${linkLabel} Link ${totalLink}` : ""})`
      });
    }

    const roll = await new Roll(`2d6 + ${modifier}`).evaluate();
    return roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor: `${skill.name}`
    });
  }
}
