// AToW BattleTech - artwork-forward compendium browser for Foundry VTT v13.

const SYSTEM_ID = "atow-battletech";
const TEMPLATE = `systems/${SYSTEM_ID}/templates/compendium-browser.hbs`;

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const CATEGORY_DEFINITIONS = Object.freeze([
  { id: "all", label: "All", icon: "fa-solid fa-grid-2" },
  { id: "mechs", label: "BattleMechs", icon: "fa-solid fa-robot" },
  { id: "vehicles", label: "Vehicles", icon: "fa-solid fa-truck-monster" },
  { id: "buildings", label: "Buildings", icon: "fa-solid fa-building" },
  { id: "personal", label: "Personal Gear", icon: "fa-solid fa-person-rifle" },
  { id: "mechGear", label: "Mech Gear", icon: "fa-solid fa-gears" },
  { id: "creation", label: "Character Options", icon: "fa-solid fa-user-plus" },
  { id: "characters", label: "Characters", icon: "fa-solid fa-users" },
  { id: "creatures", label: "Abominations", icon: "fa-solid fa-skull" }
]);

const WEIGHT_OPTIONS = Object.freeze({
  light: "Light (20–35 tons)",
  medium: "Medium (40–55 tons)",
  heavy: "Heavy (60–75 tons)",
  assault: "Assault (80–100 tons)"
});

const ERA_OPTIONS = Object.freeze({
  ageOfWar: "Age of War (before 2571)",
  starLeague: "Star League (2571–2780)",
  successionWars: "Succession Wars (2781–3049)",
  clanInvasion: "Clan Invasion (3050–3061)",
  civilWar: "Civil War (3062–3067)",
  jihad: "Jihad (3068–3085)",
  darkAge: "Dark Age (3086–3150)",
  ilClan: "ilClan (3151+)",
  unknown: "Unknown Introduction Date"
});

const TYPE_LABELS = Object.freeze({
  character: "Character",
  npc: "NPC",
  mech: "BattleMech",
  dropship: "DropShip",
  building: "Building",
  wheeledvehicle: "Combat Vehicle",
  vtol: "VTOL",
  vehicle: "Vehicle",
  abomination: "Abomination",
  skill: "Skill",
  characterSkill: "Skill",
  trait: "Trait",
  characterTrait: "Trait",
  characterModule: "Character Module",
  characterWeapon: "Personal Weapon",
  characterArmor: "Personal Armor",
  characterEquipment: "Personal Equipment",
  mechWeapon: "Mech Weapon",
  mechEquipment: "Mech Equipment",
  mechQuirk: "Design Quirk"
});

function valueAt(object, ...paths) {
  for (const path of paths) {
    const value = foundry.utils.getProperty(object, path);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function numberAt(object, ...paths) {
  const value = Number(valueAt(object, ...paths));
  return Number.isFinite(value) ? value : 0;
}

function plainText(value) {
  const text = String(value ?? "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

function truncate(value, length = 190) {
  const text = plainText(value);
  if (text.length <= length) return text;
  return `${text.slice(0, Math.max(0, length - 1)).trimEnd()}…`;
}

function categoryForDocument(document) {
  const type = String(document?.type ?? "");
  if (type === "mech") return "mechs";
  if (["wheeledvehicle", "vtol", "vehicle", "dropship"].includes(type)) return "vehicles";
  if (type === "building") return "buildings";
  if (["characterWeapon", "characterArmor", "characterEquipment"].includes(type)) return "personal";
  if (["mechWeapon", "mechEquipment", "mechQuirk"].includes(type)) return "mechGear";
  if (["characterModule", "skill", "characterSkill", "trait", "characterTrait"].includes(type)) return "creation";
  if (["character", "npc"].includes(type)) return "characters";
  if (type === "abomination") return "creatures";
  return document?.documentName === "Actor" ? "characters" : "creation";
}

function weightClassForTonnage(tonnage) {
  const tons = Number(tonnage);
  if (!Number.isFinite(tons) || tons <= 0) return "";
  if (tons <= 35) return "light";
  if (tons <= 55) return "medium";
  if (tons <= 75) return "heavy";
  return "assault";
}

function eraForYear(year) {
  const value = Number(year);
  if (!Number.isFinite(value) || value <= 0) return "unknown";
  if (value < 2571) return "ageOfWar";
  if (value <= 2780) return "starLeague";
  if (value <= 3049) return "successionWars";
  if (value <= 3061) return "clanInvasion";
  if (value <= 3067) return "civilWar";
  if (value <= 3085) return "jihad";
  if (value <= 3150) return "darkAge";
  return "ilClan";
}

function formatRange(system) {
  const min = numberAt(system, "range.min", "min");
  const short = numberAt(system, "range.short", "sht");
  const medium = numberAt(system, "range.medium", "med");
  const long = numberAt(system, "range.long", "lng");
  if (![min, short, medium, long].some(Boolean)) return "";
  return `${min}/${short}/${medium}/${long}`;
}

function pushStat(stats, label, value) {
  if (value === undefined || value === null || value === "") return;
  stats.push({ label, value: String(value) });
}

function buildStats(document, { tonnage, year, techBase, role }) {
  const system = document.system ?? {};
  const stats = [];

  switch (document.type) {
    case "mech":
      pushStat(stats, "Tonnage", tonnage ? `${tonnage} t` : "");
      pushStat(stats, "Class", weightClassForTonnage(tonnage) ? WEIGHT_OPTIONS[weightClassForTonnage(tonnage)].split(" ")[0] : "");
      pushStat(stats, "BV", numberAt(system, "mech.bv", "bv") || "");
      pushStat(stats, "Year", year || "");
      pushStat(stats, "Tech", techBase);
      pushStat(stats, "Role", role);
      break;
    case "wheeledvehicle":
    case "vtol":
    case "vehicle":
      pushStat(stats, "Tonnage", tonnage ? `${tonnage} t` : "");
      pushStat(stats, "Type", valueAt(system, "vehicle.type", "vehicle.movement.type"));
      pushStat(stats, "BV", numberAt(system, "vehicle.bv", "bv") || "");
      pushStat(stats, "Move", numberAt(system, "vehicle.movement.cruise") ? `${numberAt(system, "vehicle.movement.cruise")}/${numberAt(system, "vehicle.movement.flank")}` : "");
      pushStat(stats, "Tech", techBase);
      break;
    case "dropship":
      pushStat(stats, "Tonnage", tonnage ? `${tonnage} t` : "");
      pushStat(stats, "Type", valueAt(system, "dropship.type"));
      pushStat(stats, "BV", numberAt(system, "dropship.bv") || "");
      pushStat(stats, "Thrust", numberAt(system, "dropship.thrust.safe") ? `${numberAt(system, "dropship.thrust.safe")}/${numberAt(system, "dropship.thrust.max")}` : "");
      break;
    case "building":
      pushStat(stats, "Function", valueAt(system, "building.function"));
      pushStat(stats, "Class", valueAt(system, "building.classification"));
      pushStat(stats, "Type", valueAt(system, "building.type"));
      pushStat(stats, "CF", numberAt(system, "building.cf") || "");
      pushStat(stats, "Hexes", numberAt(system, "building.size.hexes") || "");
      pushStat(stats, "Levels", numberAt(system, "building.levels") || "");
      pushStat(stats, "Tech", valueAt(system, "building.techBase"));
      break;
    case "mechWeapon":
      pushStat(stats, "Damage", numberAt(system, "damage") || "");
      pushStat(stats, "Heat", numberAt(system, "heat") || "0");
      pushStat(stats, "Range", formatRange(system));
      pushStat(stats, "Tonnage", numberAt(system, "tonnage", "tons", "weight") ? `${numberAt(system, "tonnage", "tons", "weight")} t` : "");
      break;
    case "mechEquipment":
      pushStat(stats, "Tonnage", numberAt(system, "tonnage", "tons", "weight") ? `${numberAt(system, "tonnage", "tons", "weight")} t` : "");
      pushStat(stats, "Criticals", numberAt(system, "critSlots") || "");
      pushStat(stats, "Ammo", valueAt(system, "ammoType"));
      pushStat(stats, "Shots", numberAt(system, "ammoAmount") || "");
      break;
    case "mechQuirk":
      pushStat(stats, "Type", String(system.polarity ?? "positive") === "negative" ? "Negative" : "Positive");
      pushStat(stats, "Points", numberAt(system, "points"));
      break;
    case "characterWeapon":
      pushStat(stats, "Category", valueAt(system, "weaponCategory"));
      pushStat(stats, "AP", valueAt(system, "damage.ap", "ap"));
      pushStat(stats, "BD", valueAt(system, "damage.bd", "bd"));
      pushStat(stats, "Range", valueAt(system, "range"));
      pushStat(stats, "Shots", valueAt(system, "shots", "magazine.max"));
      break;
    case "characterArmor":
      pushStat(stats, "BAR M/B/E/X", [
        valueAt(system, "bar.m"),
        valueAt(system, "bar.b"),
        valueAt(system, "bar.e"),
        valueAt(system, "bar.x")
      ].join("/"));
      pushStat(stats, "Mass", numberAt(system, "massKg") ? `${numberAt(system, "massKg")} kg` : "");
      pushStat(stats, "Tech", valueAt(system, "ratings.tech"));
      break;
    case "characterEquipment":
      pushStat(stats, "Type", valueAt(system, "gearType"));
      pushStat(stats, "Mass", numberAt(system, "massKg") ? `${numberAt(system, "massKg")} kg` : "");
      pushStat(stats, "Cost", numberAt(system, "costCbills") ? `${numberAt(system, "costCbills")} C-bills` : "");
      pushStat(stats, "Tech", valueAt(system, "ratings.tech"));
      break;
    case "characterModule":
      pushStat(stats, "Stage", valueAt(system, "moduleType"));
      pushStat(stats, "Cost", numberAt(system, "moduleCost"));
      break;
    case "skill":
    case "characterSkill":
      pushStat(stats, "Code", valueAt(system, "complexityCode", "c"));
      pushStat(stats, "Attribute", valueAt(system, "linkedAttribute"));
      break;
    case "trait":
    case "characterTrait":
      pushStat(stats, "Category", valueAt(system, "category"));
      pushStat(stats, "Cost", numberAt(system, "cost"));
      break;
    case "character":
      pushStat(stats, "Rank", valueAt(system, "rank"));
      pushStat(stats, "Affiliation", valueAt(system, "affiliation"));
      break;
    case "abomination":
      pushStat(stats, "Type", valueAt(system, "abomination.type"));
      pushStat(stats, "Size", valueAt(system, "abomination.sizeClass"));
      pushStat(stats, "Origin", valueAt(system, "abomination.origin"));
      break;
  }

  return stats.slice(0, 6);
}

function normalizeDocument(document, pack) {
  const system = document.system ?? {};
  const tonnage = numberAt(system, "mech.tonnage", "vehicle.tonnage", "dropship.tonnage", "stats.tonnage", "tonnage");
  const year = numberAt(system, "mech.yearProduced", "yearProduced", "year");
  const techBase = String(valueAt(system, "mech.techBase", "vehicle.techBase", "dropship.techBase", "building.techBase", "techBase", "ratings.tech") ?? "").trim();
  const role = String(valueAt(system, "mech.role", "vehicle.role", "dropship.role", "building.function", "role") ?? "").trim();
  const category = categoryForDocument(document);
  const description = valueAt(
    system,
    "description",
    "biography",
    "building.notes",
    "notes",
    "specialRules",
    "mech.notes",
    "vehicle.notes"
  );
  const image = String(valueAt(system, "mech.profileMedia") || document.img || "icons/svg/item-bag.svg");
  const isVideo = /\.(?:webm|mp4|m4v|ogv)(?:\?.*)?$/i.test(image);
  const typeLabel = TYPE_LABELS[document.type] ?? CONFIG[document.documentName]?.typeLabels?.[document.type] ?? document.type;
  const packLabel = game.i18n.localize(pack.title ?? pack.metadata?.label ?? pack.collection);
  const manufacturer = String(valueAt(system, "manufacturer") ?? "");
  const weightClass = document.type === "mech" ? weightClassForTonnage(tonnage) : "";
  const era = document.type === "mech" ? eraForYear(year) : "";
  const summary = truncate(description);
  const searchText = [
    document.name,
    typeLabel,
    packLabel,
    category,
    tonnage,
    weightClass,
    year,
    ERA_OPTIONS[era] ?? "",
    techBase,
    role,
    manufacturer,
    summary
  ].join(" ").toLocaleLowerCase();

  return {
    key: document.uuid,
    uuid: document.uuid,
    documentName: document.documentName,
    name: document.name,
    type: document.type,
    typeLabel,
    category,
    packId: pack.collection,
    packLabel,
    img: image,
    isVideo,
    summary,
    tonnage,
    weightClass,
    era,
    year,
    techBase,
    role,
    searchText,
    stats: buildStats(document, { tonnage, year, techBase, role })
  };
}

export class AToWCompendiumBrowser extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(
    super.DEFAULT_OPTIONS,
    {
      id: "atow-compendium-browser",
      classes: ["atow-compendium-browser"],
      position: { width: 1080, height: 760 },
      window: {
        title: "Compendium Browser",
        icon: "fa-solid fa-books",
        resizable: true
      }
    },
    { inplace: false }
  );

  static PARTS = {
    main: { template: TEMPLATE, root: true }
  };

  static #instance = null;

  static get instance() {
    AToWCompendiumBrowser.#instance ??= new AToWCompendiumBrowser();
    return AToWCompendiumBrowser.#instance;
  }

  #entries = null;
  #entryMap = new Map();
  #loadPromise = null;
  #state = {
    category: "all",
    search: "",
    pack: "",
    weight: "",
    era: "",
    techBase: ""
  };

  async #loadEntries({ refresh = false } = {}) {
    if (refresh) {
      this.#entries = null;
      this.#entryMap.clear();
      this.#loadPromise = null;
    }
    if (this.#entries) return this.#entries;
    if (this.#loadPromise) return this.#loadPromise;

    this.#loadPromise = (async () => {
      const packs = game.packs
        .filter(pack => ["Actor", "Item"].includes(pack.documentName))
        .filter(pack => pack.visible !== false);
      const entries = [];

      await Promise.all(packs.map(async pack => {
        try {
          const documents = await pack.getDocuments();
          for (const document of documents) entries.push(normalizeDocument(document, pack));
        } catch (error) {
          console.warn(`${SYSTEM_ID} | Could not index compendium ${pack.collection}`, error);
        }
      }));

      entries.sort((a, b) => {
        const categoryOrder = CATEGORY_DEFINITIONS.findIndex(category => category.id === a.category)
          - CATEGORY_DEFINITIONS.findIndex(category => category.id === b.category);
        if (categoryOrder) return categoryOrder;
        return String(a.name ?? "").localeCompare(String(b.name ?? ""));
      });

      this.#entries = entries;
      this.#entryMap = new Map(entries.map(entry => [entry.key, entry]));
      return entries;
    })();

    try {
      return await this.#loadPromise;
    } finally {
      this.#loadPromise = null;
    }
  }

  async refreshIndex() {
    await this.#loadEntries({ refresh: true });
    return this.render({ force: true });
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const entries = await this.#loadEntries();
    const categoryCounts = new Map(CATEGORY_DEFINITIONS.map(category => [category.id, 0]));
    categoryCounts.set("all", entries.length);
    for (const entry of entries) {
      categoryCounts.set(entry.category, (categoryCounts.get(entry.category) ?? 0) + 1);
    }

    const packOptions = {};
    const techBaseOptions = {};
    for (const entry of entries) {
      packOptions[entry.packId] = entry.packLabel;
      if (entry.techBase) techBaseOptions[entry.techBase.toLocaleLowerCase()] = entry.techBase;
    }

    context.entries = entries;
    context.totalEntries = entries.length;
    context.categories = CATEGORY_DEFINITIONS.map(category => ({
      ...category,
      count: categoryCounts.get(category.id) ?? 0,
      active: this.#state.category === category.id
    }));
    context.packOptions = Object.fromEntries(Object.entries(packOptions).sort((a, b) => a[1].localeCompare(b[1])));
    context.techBaseOptions = Object.fromEntries(Object.entries(techBaseOptions).sort((a, b) => a[1].localeCompare(b[1])));
    context.weightOptions = WEIGHT_OPTIONS;
    context.eraOptions = ERA_OPTIONS;
    context.state = this.#state;
    return context;
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const root = this.element;
    if (!root) return;

    root.querySelectorAll("[data-browser-category]").forEach(button => {
      button.addEventListener("click", () => {
        this.#state.category = String(button.dataset.browserCategory ?? "all");
        root.querySelectorAll("[data-browser-category]").forEach(candidate => {
          candidate.classList.toggle("active", candidate === button);
        });
        this.#applyFilters();
      });
    });

    const search = root.querySelector("[data-browser-search]");
    search?.addEventListener("input", () => {
      this.#state.search = String(search.value ?? "");
      this.#applyFilters();
    });

    for (const field of ["pack", "weight", "era", "techBase"]) {
      root.querySelector(`[data-browser-filter="${field}"]`)?.addEventListener("change", event => {
        this.#state[field] = String(event.currentTarget.value ?? "");
        this.#applyFilters();
      });
    }

    root.querySelector("[data-browser-clear]")?.addEventListener("click", () => {
      this.#state = { category: "all", search: "", pack: "", weight: "", era: "", techBase: "" };
      this.render({ force: true });
    });

    root.querySelector("[data-browser-refresh]")?.addEventListener("click", async buttonEvent => {
      const button = buttonEvent.currentTarget;
      button.disabled = true;
      button.querySelector("i")?.classList.add("fa-spin");
      await this.#loadEntries({ refresh: true });
      this.render({ force: true });
    });

    root.querySelectorAll("[data-entry-key]").forEach(card => {
      card.addEventListener("dblclick", () => this.#openEntry(card.dataset.entryKey));
      card.querySelector("[data-browser-open]")?.addEventListener("click", event => {
        event.stopPropagation();
        this.#openEntry(card.dataset.entryKey);
      });
      card.addEventListener("dragstart", event => {
        const entry = this.#entryMap.get(card.dataset.entryKey);
        if (!entry) return;
        event.dataTransfer?.setData("text/plain", JSON.stringify({
          type: entry.documentName,
          uuid: entry.uuid
        }));
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
      });
    });

    root.querySelectorAll(".atow-browser-card-art img").forEach(image => {
      image.addEventListener("error", () => {
        if (image.dataset.fallbackApplied === "true") return;
        image.dataset.fallbackApplied = "true";
        image.src = "icons/svg/item-bag.svg";
      });
    });

    this.#applyFilters();
  }

  async #openEntry(key) {
    const entry = this.#entryMap.get(String(key ?? ""));
    if (!entry) return;
    try {
      const document = await fromUuid(entry.uuid);
      document?.sheet?.render?.(true);
    } catch (error) {
      console.warn(`${SYSTEM_ID} | Could not open browser entry ${entry.uuid}`, error);
      ui.notifications?.warn?.(`Could not open ${entry.name}.`);
    }
  }

  #applyFilters() {
    const root = this.element;
    if (!root) return;

    const search = this.#state.search.trim().toLocaleLowerCase();
    const techBase = this.#state.techBase.toLocaleLowerCase();
    let visible = 0;

    root.querySelectorAll("[data-entry-key]").forEach(card => {
      const entry = this.#entryMap.get(card.dataset.entryKey);
      if (!entry) {
        card.hidden = true;
        return;
      }

      const matches =
        (this.#state.category === "all" || entry.category === this.#state.category)
        && (!search || entry.searchText.includes(search))
        && (!this.#state.pack || entry.packId === this.#state.pack)
        && (!this.#state.weight || entry.weightClass === this.#state.weight)
        && (!this.#state.era || entry.era === this.#state.era)
        && (!techBase || entry.techBase.toLocaleLowerCase() === techBase);

      card.hidden = !matches;
      if (matches) visible += 1;
    });

    const count = root.querySelector("[data-browser-result-count]");
    if (count) count.textContent = `${visible} result${visible === 1 ? "" : "s"}`;
    root.querySelector("[data-browser-empty]")?.toggleAttribute("hidden", visible !== 0);
  }
}

function injectCompendiumBrowserButton(_app, html) {
  const root = html instanceof HTMLElement ? html : (html?.[0] ?? null);
  if (!root || root.querySelector("[data-atow-compendium-browser]")) return;

  const actions = root.querySelector(".directory-header .header-actions");
  if (!actions) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "atow-open-compendium-browser";
  button.dataset.atowCompendiumBrowser = "true";
  button.innerHTML = '<i class="fa-solid fa-books" inert></i><span>Compendium Browser</span>';
  button.addEventListener("click", () => AToWCompendiumBrowser.instance.render({ force: true }));
  actions.append(button);
}

export function registerAToWCompendiumBrowser(namespace = null) {
  if (namespace?.api) {
    namespace.api.openCompendiumBrowser = () => AToWCompendiumBrowser.instance.render({ force: true });
    namespace.api.refreshCompendiumBrowser = () => AToWCompendiumBrowser.instance.refreshIndex();
  }

  Hooks.on("renderCompendiumDirectory", injectCompendiumBrowserButton);
}
