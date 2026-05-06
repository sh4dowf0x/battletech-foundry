const SYSTEM_ID = "atow-battletech";
const TEMPLATE = `systems/${SYSTEM_ID}/templates/company-sheet.hbs`;
const SHEET_CSS = `systems/${SYSTEM_ID}/styles/company-sheet.css`;
const SHEET_CSS_ID = "atow-company-sheet-css";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "roster", label: "Roster" },
  { id: "assets", label: "Assets" },
  { id: "logistics", label: "Logistics" },
  { id: "missions", label: "Missions" },
  { id: "contacts", label: "Contacts" },
  { id: "maintenance", label: "Maintenance" },
  { id: "notes", label: "Notes" }
];

const TRACKERS = [
  { key: "reputation", label: "Reputation" },
  { key: "morale", label: "Morale" },
  { key: "readiness", label: "Readiness" },
  { key: "supply", label: "Supply" },
  { key: "cohesion", label: "Cohesion" },
  { key: "discipline", label: "Discipline" },
  { key: "notoriety", label: "Notoriety" },
  { key: "politicalFavor", label: "Political Favor" },
  { key: "debt", label: "Debt" },
  { key: "infamy", label: "Infamy" },
  { key: "tempo", label: "Operational Tempo" }
];

const TABLES = {
  contacts: { name: "", faction: "", role: "", relationship: "", reliability: "", provides: "", favors: "", notes: "" },
  combatPersonnel: { name: "", callsign: "", rank: "", role: "", lance: "", asset: "", skills: "", status: "Active", sourceUuid: "" },
  supportPersonnel: { name: "", role: "", specialty: "", department: "", workload: "", morale: "", notes: "", sourceUuid: "" },
  subunits: { name: "", commander: "", role: "", members: "", assets: "", readiness: "Ready", notes: "" },
  mechs: { name: "", chassis: "", tonnage: "", pilot: "", lance: "", condition: "Operational", ownership: "", priority: "", notes: "", sourceUuid: "" },
  vehicles: { name: "", type: "", crew: "", capacity: "", section: "", condition: "Operational", notes: "", sourceUuid: "" },
  abominations: {
    name: "",
    type: "",
    sizeClass: "",
    aliveTracks: "",
    trackProfile: "",
    movement: "",
    aniMelee: "",
    gunnery: "",
    physical: "",
    handler: "",
    condition: "Contained",
    notes: "",
    sourceUuid: ""
  },
  aerospace: { model: "", pilot: "", bay: "", status: "Operational", fuelAmmo: "", notes: "" },
  infantry: { name: "", size: "", commander: "", equipment: "", transport: "", readiness: "", casualties: "" },
  dropships: {
    name: "",
    class: "",
    type: "",
    tonnage: "",
    techBase: "",
    rulesLevel: "",
    role: "",
    safeThrust: "",
    maxThrust: "",
    bv: "",
    fuel: "",
    scale: "",
    captain: "",
    cargo: "",
    condition: "",
    ownership: "",
    docking: "",
    sourceUuid: ""
  },
  facilities: { name: "", type: "", capacity: "", security: "", localRep: "", vulnerabilities: "", notes: "" },
  supplies: { category: "", status: "Adequate", quantity: "", monthlyUse: "", notes: "" },
  repairs: { asset: "", issue: "", priority: "", techHours: "", parts: "", status: "", notes: "" },
  salvage: { item: "", source: "", claim: "", condition: "", value: "", restriction: "", notes: "" },
  missions: { name: "", date: "", employer: "", location: "", objective: "", result: "", reward: "", salvage: "", losses: "", impact: "", events: "", journalUuid: "", journalName: "" },
  contracts: { assignment: "", employer: "", type: "", primary: "", secondary: "", restrictions: "", payment: "", salvageRights: "", timeLimit: "", complications: "", failure: "" },
  rumors: { title: "", source: "", status: "", notes: "" },
  plotHooks: { title: "", theater: "", threat: "", lead: "", goal: "", notes: "" }
};

const COMMAND_STAFF = [
  ["commandingOfficer", "Commanding Officer"],
  ["executiveOfficer", "Executive Officer"],
  ["operationsOfficer", "Operations Officer"],
  ["logisticsOfficer", "Logistics Officer"],
  ["intelligenceOfficer", "Intelligence Officer"],
  ["quartermaster", "Quartermaster"],
  ["chiefTechnician", "Chief Technician"],
  ["medicalOfficer", "Medical Officer"],
  ["transportCommander", "Dropship / Transport Commander"]
];

function clone(value) {
  return foundry.utils.deepClone(value);
}

function arrayFrom(value) {
  return Array.isArray(value) ? value : [];
}

function parseInputValue(input) {
  if (!input) return null;
  if (input.type === "checkbox") return Boolean(input.checked);
  if (input.type === "number" || input.dataset?.dtype === "Number") {
    const raw = String(input.value ?? "").trim();
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  return input.value ?? "";
}

function ensureRowShape(table, row = {}) {
  return { ...(TABLES[table] ?? {}), ...(row ?? {}) };
}

function escapeHtml(value) {
  const esc = foundry.utils.escapeHTML;
  if (typeof esc === "function") return esc(String(value ?? ""));
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseCompanyTableFieldName(name) {
  const match = String(name ?? "").match(/^system\.company\.([^.]+)\.(\d+)\.([^.]+)$/);
  if (!match) return null;
  const [, table, index, key] = match;
  if (!TABLES[table]) return null;
  return { table, index: Number(index), key };
}

function parseDragData(event) {
  try {
    return TextEditor.getDragEventData(event);
  } catch (_) {
    const raw = event?.dataTransfer?.getData("application/json") || event?.dataTransfer?.getData("text/json") || event?.dataTransfer?.getData("text/plain");
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }
}

function readMechSourceField(actor, pathList) {
  for (const path of pathList) {
    const value = foundry.utils.getProperty(actor, path);
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "object") {
      const text = value.name ?? value.label ?? value.value ?? "";
      if (text !== "") return text;
      continue;
    }
    return value;
  }
  return "";
}

function formatMechDropRow(actor) {
  return ensureRowShape("mechs", {
    name: String(actor?.name ?? "").trim(),
    chassis: String(readMechSourceField(actor, [
      "system.mech.chassis",
      "system.mech.model",
      "system.dropship.type",
      "system.vehicle.type"
    ]) || actor?.name || "").trim(),
    tonnage: Number(readMechSourceField(actor, [
      "system.mech.tonnage",
      "system.stats.tonnage",
      "system.vehicle.tonnage",
      "system.dropship.tonnage"
    ]) ?? 0) || 0,
    pilot: String(readMechSourceField(actor, [
      "system.pilot.name",
      "system.pilot",
      "system.crew.name"
    ]) || "").trim(),
    condition: "Operational",
    ownership: "Company-owned",
    priority: "Standard",
    notes: String(readMechSourceField(actor, [
      "system.mech.role",
      "system.dropship.role"
    ]) || "").trim(),
    sourceUuid: String(actor?.uuid ?? "").trim()
  });
}

function formatDropshipDropRow(actor) {
  const thrust = actor?.system?.dropship?.thrust ?? {};
  return ensureRowShape("dropships", {
    name: String(actor?.name ?? "").trim(),
    class: String(readMechSourceField(actor, [
      "system.dropship.type",
      "system.dropship.scale",
      "system.mech.model"
    ]) || actor?.name || "").trim(),
    type: String(readMechSourceField(actor, [
      "system.dropship.type"
    ]) || "").trim(),
    tonnage: Number(readMechSourceField(actor, [
      "system.dropship.tonnage"
    ]) ?? 0) || 0,
    techBase: String(readMechSourceField(actor, [
      "system.dropship.techBase"
    ]) || "").trim(),
    rulesLevel: String(readMechSourceField(actor, [
      "system.dropship.rulesLevel"
    ]) || "").trim(),
    role: String(readMechSourceField(actor, [
      "system.dropship.role"
    ]) || "").trim(),
    safeThrust: Number(thrust?.safe ?? 0) || 0,
    maxThrust: Number(thrust?.max ?? 0) || 0,
    bv: Number(readMechSourceField(actor, [
      "system.dropship.bv"
    ]) ?? 0) || 0,
    fuel: Number(readMechSourceField(actor, [
      "system.dropship.fuel"
    ]) ?? 0) || 0,
    scale: String(readMechSourceField(actor, [
      "system.dropship.scale"
    ]) || "").trim(),
    captain: String(readMechSourceField(actor, [
      "system.pilot.name",
      "system.crew.name"
    ]) || "").trim(),
    cargo: String(readMechSourceField(actor, [
      "system.dropship.cargo",
      "system.cargo"
    ]) || "").trim(),
    condition: "Operational",
    ownership: "Company-owned",
    docking: "",
    sourceUuid: String(actor?.uuid ?? "").trim()
  });
}

function formatVehicleDropRow(actor) {
  return ensureRowShape("vehicles", {
    name: String(actor?.name ?? "").trim(),
    type: String(readMechSourceField(actor, [
      "system.vehicle.type",
      "system.vehicle.role",
      "system.vehicle.movement.type"
    ]) || "").trim(),
    crew: String(readMechSourceField(actor, [
      "system.crew.name",
      "system.crew",
      "system.pilot.name"
    ]) || "").trim(),
    capacity: String(readMechSourceField(actor, [
      "system.vehicle.tonnage",
      "system.vehicle.bv"
    ]) || "").trim(),
    section: String(readMechSourceField(actor, [
      "system.vehicle.role",
      "system.vehicle.movement.type"
    ]) || "").trim(),
    condition: "Operational",
    notes: String(readMechSourceField(actor, [
      "system.vehicle.engine",
      "system.vehicle.rulesLevel"
    ]) || "").trim(),
    sourceUuid: String(actor?.uuid ?? "").trim()
  });
}

function getAbominationAliveTrackSummary(actor) {
  const abom = actor?.system?.abomination ?? {};
  const trackCount = Math.max(1, Math.min(6, Math.floor(Number(abom.trackCount ?? 3) || 3)));
  const trackPips = Math.max(1, Math.floor(Number(abom.trackPips ?? 15) || 15));
  let dead = 0;
  for (let i = 1; i <= trackCount; i++) {
    if ((Number(abom[`track${i}`] ?? 0) || 0) >= trackPips) dead += 1;
  }
  return `${Math.max(0, trackCount - dead)}/${trackCount}`;
}

function formatAbominationDropRow(actor) {
  const abom = actor?.system?.abomination ?? {};
  const ground = Number(abom.groundMp ?? 0) || 0;
  const jump = Number(abom.jumpMp ?? 0) || 0;
  const vtol = Number(abom.vtolMp ?? 0) || 0;
  const trackCount = Math.max(1, Math.min(6, Math.floor(Number(abom.trackCount ?? 3) || 3)));
  const trackPips = Math.max(1, Math.floor(Number(abom.trackPips ?? 15) || 15));
  const physical = abom.physical ?? {};
  const physicalParts = [
    Number(physical.mob ?? 0) ? `Mob ${Number(physical.mob)}` : "",
    Number(physical.hobble ?? 0) ? `Hobble ${Number(physical.hobble)}` : "",
    Number(physical.melee ?? 0) ? `Melee ${Number(physical.melee)}` : ""
  ].filter(Boolean);
  return ensureRowShape("abominations", {
    name: String(actor?.name ?? "").trim(),
    type: String(abom.type ?? "").trim(),
    sizeClass: String(abom.sizeClass ?? "").trim(),
    aliveTracks: getAbominationAliveTrackSummary(actor),
    trackProfile: `${trackCount} x ${trackPips}`,
    movement: `G ${ground} / J ${jump} / V ${vtol}`,
    aniMelee: String(abom.aniMeleeSkill ?? "").trim(),
    gunnery: String(abom.gunnerySkill ?? actor?.system?.pilot?.gunnery ?? "").trim(),
    physical: physicalParts.join(", "),
    handler: String(abom.handler ?? "").trim(),
    condition: "Contained",
    notes: String(abom.bonus ?? abom.manifestations ?? "").trim(),
    sourceUuid: String(actor?.uuid ?? "").trim()
  });
}

function formatCharacterCombatRow(actor) {
  const rank = String(readMechSourceField(actor, ["system.rank"]) || "").trim();
  const affiliation = String(readMechSourceField(actor, ["system.affiliation"]) || "").trim();
  return ensureRowShape("combatPersonnel", {
    name: String(actor?.name ?? "").trim(),
    callsign: "",
    rank,
    role: String(actor?.type ?? "").toLowerCase() === "character" ? "MechWarrior" : "Personnel",
    lance: "",
    asset: "",
    skills: affiliation,
    status: "Active",
    sourceUuid: String(actor?.uuid ?? "").trim()
  });
}

function formatCharacterSupportRow(actor) {
  const rank = String(readMechSourceField(actor, ["system.rank"]) || "").trim();
  const affiliation = String(readMechSourceField(actor, ["system.affiliation"]) || "").trim();
  const notes = String(readMechSourceField(actor, ["system.biographyNotes"]) || "").trim();
  return ensureRowShape("supportPersonnel", {
    name: String(actor?.name ?? "").trim(),
    role: String(actor?.type ?? "").toLowerCase() === "character" ? "Support Staff" : "Personnel",
    specialty: affiliation || rank,
    department: "",
    workload: "",
    morale: "",
    notes,
    sourceUuid: String(actor?.uuid ?? "").trim()
  });
}

function mergeMechDropRow(existing, dropped) {
  const row = ensureRowShape("mechs", existing);
  const isBlank = (value) => String(value ?? "").trim() === "";
  const isUnsetNumber = (value) => !Number.isFinite(Number(value)) || Number(value) <= 0;
  return {
    ...row,
    sourceUuid: dropped.sourceUuid || row.sourceUuid || "",
    name: isBlank(row.name) ? dropped.name : row.name,
    chassis: isBlank(row.chassis) ? dropped.chassis : row.chassis,
    tonnage: isUnsetNumber(row.tonnage) ? dropped.tonnage : row.tonnage,
    pilot: isBlank(row.pilot) ? dropped.pilot : row.pilot,
    condition: isBlank(row.condition) ? dropped.condition : row.condition,
    ownership: isBlank(row.ownership) ? dropped.ownership : row.ownership,
    priority: isBlank(row.priority) ? dropped.priority : row.priority,
    notes: isBlank(row.notes) ? dropped.notes : row.notes
  };
}

function mergeDropshipDropRow(existing, dropped) {
  const row = ensureRowShape("dropships", existing);
  const isBlank = (value) => String(value ?? "").trim() === "";
  const isUnsetNumber = (value) => !Number.isFinite(Number(value)) || Number(value) <= 0;
  return {
    ...row,
    sourceUuid: dropped.sourceUuid || row.sourceUuid || "",
    name: isBlank(row.name) ? dropped.name : row.name,
    class: isBlank(row.class) ? dropped.class : row.class,
    type: isBlank(row.type) ? dropped.type : row.type,
    tonnage: isUnsetNumber(row.tonnage) ? dropped.tonnage : row.tonnage,
    techBase: isBlank(row.techBase) ? dropped.techBase : row.techBase,
    rulesLevel: isBlank(row.rulesLevel) ? dropped.rulesLevel : row.rulesLevel,
    role: isBlank(row.role) ? dropped.role : row.role,
    safeThrust: isUnsetNumber(row.safeThrust) ? dropped.safeThrust : row.safeThrust,
    maxThrust: isUnsetNumber(row.maxThrust) ? dropped.maxThrust : row.maxThrust,
    bv: isUnsetNumber(row.bv) ? dropped.bv : row.bv,
    fuel: isUnsetNumber(row.fuel) ? dropped.fuel : row.fuel,
    scale: isBlank(row.scale) ? dropped.scale : row.scale,
    captain: isBlank(row.captain) ? dropped.captain : row.captain,
    cargo: isBlank(row.cargo) ? dropped.cargo : row.cargo,
    condition: isBlank(row.condition) ? dropped.condition : row.condition,
    ownership: isBlank(row.ownership) ? dropped.ownership : row.ownership,
    docking: isBlank(row.docking) ? dropped.docking : row.docking
  };
}

function mergeVehicleDropRow(existing, dropped) {
  const row = ensureRowShape("vehicles", existing);
  const isBlank = (value) => String(value ?? "").trim() === "";
  return {
    ...row,
    sourceUuid: dropped.sourceUuid || row.sourceUuid || "",
    name: isBlank(row.name) ? dropped.name : row.name,
    type: isBlank(row.type) ? dropped.type : row.type,
    crew: isBlank(row.crew) ? dropped.crew : row.crew,
    capacity: isBlank(row.capacity) ? dropped.capacity : row.capacity,
    section: isBlank(row.section) ? dropped.section : row.section,
    condition: isBlank(row.condition) ? dropped.condition : row.condition,
    notes: isBlank(row.notes) ? dropped.notes : row.notes
  };
}

function mergeAbominationDropRow(existing, dropped) {
  const row = ensureRowShape("abominations", existing);
  const isBlank = (value) => String(value ?? "").trim() === "";
  return {
    ...row,
    sourceUuid: dropped.sourceUuid || row.sourceUuid || "",
    name: isBlank(row.name) ? dropped.name : row.name,
    type: isBlank(row.type) ? dropped.type : row.type,
    sizeClass: isBlank(row.sizeClass) ? dropped.sizeClass : row.sizeClass,
    aliveTracks: isBlank(row.aliveTracks) ? dropped.aliveTracks : row.aliveTracks,
    trackProfile: isBlank(row.trackProfile) ? dropped.trackProfile : row.trackProfile,
    movement: isBlank(row.movement) ? dropped.movement : row.movement,
    aniMelee: isBlank(row.aniMelee) ? dropped.aniMelee : row.aniMelee,
    gunnery: isBlank(row.gunnery) ? dropped.gunnery : row.gunnery,
    physical: isBlank(row.physical) ? dropped.physical : row.physical,
    handler: isBlank(row.handler) ? dropped.handler : row.handler,
    condition: isBlank(row.condition) ? dropped.condition : row.condition,
    notes: isBlank(row.notes) ? dropped.notes : row.notes
  };
}

function mergeCharacterCombatRow(existing, dropped) {
  const row = ensureRowShape("combatPersonnel", existing);
  const isBlank = (value) => String(value ?? "").trim() === "";
  return {
    ...row,
    sourceUuid: dropped.sourceUuid || row.sourceUuid || "",
    name: isBlank(row.name) ? dropped.name : row.name,
    callsign: isBlank(row.callsign) ? dropped.callsign : row.callsign,
    rank: isBlank(row.rank) ? dropped.rank : row.rank,
    role: isBlank(row.role) ? dropped.role : row.role,
    lance: isBlank(row.lance) ? dropped.lance : row.lance,
    asset: isBlank(row.asset) ? dropped.asset : row.asset,
    skills: isBlank(row.skills) ? dropped.skills : row.skills,
    status: isBlank(row.status) ? dropped.status : row.status
  };
}

function mergeCharacterSupportRow(existing, dropped) {
  const row = ensureRowShape("supportPersonnel", existing);
  const isBlank = (value) => String(value ?? "").trim() === "";
  return {
    ...row,
    sourceUuid: dropped.sourceUuid || row.sourceUuid || "",
    name: isBlank(row.name) ? dropped.name : row.name,
    role: isBlank(row.role) ? dropped.role : row.role,
    specialty: isBlank(row.specialty) ? dropped.specialty : row.specialty,
    department: isBlank(row.department) ? dropped.department : row.department,
    workload: isBlank(row.workload) ? dropped.workload : row.workload,
    morale: isBlank(row.morale) ? dropped.morale : row.morale,
    notes: isBlank(row.notes) ? dropped.notes : row.notes
  };
}

async function enrichMissionRows(rows) {
  const out = [];
  for (const row of rows) {
    const shaped = ensureRowShape("missions", row);
    const uuid = String(shaped.journalUuid ?? "").trim();
    if (uuid && !String(shaped.journalName ?? "").trim()) {
      const doc = await fromUuid(uuid).catch(() => null);
      const entry = doc?.documentName === "JournalEntryPage" ? doc.parent : doc;
      shaped.journalName = String(doc?.name ?? entry?.name ?? "").trim();
    }
    out.push(shaped);
  }
  return out;
}

export class ATOWCompanySheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  constructor(...args) {
    super(...args);
    this._activeTab = "overview";
    this._fieldSaveTimers = new Map();
    this._pendingFieldUpdates = new Map();
    this._tableSaveTimers = new Map();
    this._pendingTableSaves = new Set();
  }

  static _ensureSheetStyles() {
    if (document.getElementById(SHEET_CSS_ID)) return;
    const link = document.createElement("link");
    link.id = SHEET_CSS_ID;
    link.rel = "stylesheet";
    link.type = "text/css";
    link.href = SHEET_CSS;
    document.head.appendChild(link);
  }

  static DEFAULT_OPTIONS = foundry.utils.mergeObject(
    super.DEFAULT_OPTIONS,
    {
      classes: ["atow", "sheet", "actor", "company", "battletech"],
      position: { width: 1320, height: 900 },
      window: { resizable: true },
      form: {
        submitOnChange: false,
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
    const system = this.actor.system ?? {};
    const company = system.company ?? {};

    context.actor = this.actor;
    context.system = system;
    context.company = company;
    context.tabs = TABS.map(tab => ({ ...tab, active: tab.id === this._activeTab }));
    context.commandStaff = COMMAND_STAFF.map(([key, label]) => ({
      key,
      label,
      value: company?.commandStaff?.[key] ?? ""
    }));
    context.trackers = TRACKERS.map(t => ({
      ...t,
      value: Number(company?.trackers?.[t.key] ?? 0) || 0
    }));

    for (const table of Object.keys(TABLES)) {
      const rows = arrayFrom(company?.[table]).map(row => ensureRowShape(table, row));
      context[table] = table === "missions" ? await enrichMissionRows(rows) : rows;
    }

    return context;
  }

  _onRender(context, options) {
    super._onRender(context, options);
    ATOWCompanySheet._ensureSheetStyles();

    const root = this.element;
    if (!root) return;

    root.querySelectorAll("[data-company-tab]").forEach(button => {
      if (button.dataset.bound === "1") return;
      button.dataset.bound = "1";
      button.addEventListener("click", event => this._onTabClick(event));
    });

    const form = root.matches?.("form.company-sheet") ? root : root.querySelector?.("form.company-sheet");
    if (form && form.dataset.bound !== "1") {
      form.dataset.bound = "1";
      form.addEventListener("input", event => this._onFormValueChange(event));
      form.addEventListener("change", event => this._onFormValueChange(event));
    }

    root.querySelectorAll("[data-action]").forEach(button => {
      if (button.dataset.actionBound === "1") return;
      button.dataset.actionBound = "1";
      button.addEventListener("click", event => this._onAction(event));
    });

    const mechZone = root.querySelector?.("[data-drop-zone='company-mechs']");
    if (mechZone && mechZone.dataset.dropBound !== "1") {
      mechZone.dataset.dropBound = "1";
      mechZone.addEventListener("dragover", event => {
        if (!this.isEditable) return;
        event.preventDefault();
        mechZone.classList.add("is-drop-hover");
      });
      mechZone.addEventListener("dragleave", () => mechZone.classList.remove("is-drop-hover"));
      mechZone.addEventListener("drop", event => this._onMechDrop(event));
    }

    const dropshipZone = root.querySelector?.("[data-drop-zone='company-dropships']");
    if (dropshipZone && dropshipZone.dataset.dropBound !== "1") {
      dropshipZone.dataset.dropBound = "1";
      dropshipZone.addEventListener("dragover", event => {
        if (!this.isEditable) return;
        event.preventDefault();
        dropshipZone.classList.add("is-drop-hover");
      });
      dropshipZone.addEventListener("dragleave", () => dropshipZone.classList.remove("is-drop-hover"));
      dropshipZone.addEventListener("drop", event => this._onDropshipDrop(event));
    }

    const vehicleZone = root.querySelector?.("[data-drop-zone='company-vehicles']");
    if (vehicleZone && vehicleZone.dataset.dropBound !== "1") {
      vehicleZone.dataset.dropBound = "1";
      vehicleZone.addEventListener("dragover", event => {
        if (!this.isEditable) return;
        event.preventDefault();
        vehicleZone.classList.add("is-drop-hover");
      });
      vehicleZone.addEventListener("dragleave", () => vehicleZone.classList.remove("is-drop-hover"));
      vehicleZone.addEventListener("drop", event => this._onVehicleDrop(event));
    }

    const abominationZone = root.querySelector?.("[data-drop-zone='company-abominations']");
    if (abominationZone && abominationZone.dataset.dropBound !== "1") {
      abominationZone.dataset.dropBound = "1";
      abominationZone.addEventListener("dragover", event => {
        if (!this.isEditable) return;
        event.preventDefault();
        abominationZone.classList.add("is-drop-hover");
      });
      abominationZone.addEventListener("dragleave", () => abominationZone.classList.remove("is-drop-hover"));
      abominationZone.addEventListener("drop", event => this._onAbominationDrop(event));
    }

    const combatZone = root.querySelector?.("[data-drop-zone='company-combat-personnel']");
    if (combatZone && combatZone.dataset.dropBound !== "1") {
      combatZone.dataset.dropBound = "1";
      combatZone.addEventListener("dragover", event => {
        if (!this.isEditable) return;
        event.preventDefault();
        combatZone.classList.add("is-drop-hover");
      });
      combatZone.addEventListener("dragleave", () => combatZone.classList.remove("is-drop-hover"));
      combatZone.addEventListener("drop", event => this._onCharacterDrop(event, "combatPersonnel"));
    }

    const supportZone = root.querySelector?.("[data-drop-zone='company-support-personnel']");
    if (supportZone && supportZone.dataset.dropBound !== "1") {
      supportZone.dataset.dropBound = "1";
      supportZone.addEventListener("dragover", event => {
        if (!this.isEditable) return;
        event.preventDefault();
        supportZone.classList.add("is-drop-hover");
      });
      supportZone.addEventListener("dragleave", () => supportZone.classList.remove("is-drop-hover"));
      supportZone.addEventListener("drop", event => this._onCharacterDrop(event, "supportPersonnel"));
    }

    root.querySelectorAll("[data-drop-zone='company-mission-journal']").forEach(zone => {
      if (zone.dataset.dropBound === "1") return;
      zone.dataset.dropBound = "1";
      zone.addEventListener("dragover", event => {
        if (!this.isEditable) return;
        event.preventDefault();
        zone.classList.add("is-drop-hover");
      });
      zone.addEventListener("dragleave", () => zone.classList.remove("is-drop-hover"));
      zone.addEventListener("drop", event => this._onMissionJournalDrop(event));
    });
  }

  async _onTabClick(event) {
    event.preventDefault();
    const tab = String(event.currentTarget?.dataset?.companyTab ?? "overview");
    if (!TABS.some(t => t.id === tab)) return;
    await this._flushPendingSave();
    this._activeTab = tab;
    this.render(false);
  }

  async _onFormValueChange(event) {
    const input = event.target;
    const name = String(input?.name ?? "").trim();
    if (!name) return;
    if (input.closest?.("[data-action]")) return;

    const tableField = parseCompanyTableFieldName(name);
    if (tableField) {
      const immediate = event.type === "change" || input.type === "checkbox" || input.type === "number";
      this._queueTableSave(tableField.table, { immediate });
      return;
    }

    const value = parseInputValue(input);
    const immediate = event.type === "change" || input.type === "checkbox" || input.type === "number";
    this._queueFieldSave(name, value, { immediate });
  }

  async _onAction(event) {
    event.preventDefault();
    const button = event.currentTarget;
    const action = String(button?.dataset?.action ?? "");
    const table = String(button?.dataset?.table ?? "");
    if (!TABLES[table]) return;

    if (action === "add-row") {
      const rows = arrayFrom(this.actor.system?.company?.[table]).map(row => ensureRowShape(table, row));
      rows.push(clone(TABLES[table]));
      await this.actor.update({ [`system.company.${table}`]: rows });
      this.render(false);
      return;
    }

    if (table === "missions" && action === "create-mission-journal") {
      const index = Number(button?.dataset?.index);
      if (!Number.isInteger(index) || index < 0) return;
      await this._createMissionJournal(index);
      return;
    }

    if (table === "missions" && action === "open-mission-journal") {
      const index = Number(button?.dataset?.index);
      if (!Number.isInteger(index) || index < 0) return;
      await this._openMissionJournal(index);
      return;
    }

    if (action === "delete-row") {
      const index = Number(button?.dataset?.index);
      if (!Number.isInteger(index) || index < 0) return;
      const rows = arrayFrom(this.actor.system?.company?.[table]).map(row => ensureRowShape(table, row));
      const row = rows[index] ?? null;
      const rowLabel = String(row?.name ?? row?.assignment ?? row?.title ?? row?.item ?? row?.asset ?? row?.class ?? "").trim() || "this entry";
      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: "Confirm Removal" },
        content: `<p>Remove <strong>${rowLabel}</strong>?</p>`,
        modal: true,
        rejectClose: false
      });
      if (!ok) return;
      rows.splice(index, 1);
      await this.actor.update({ [`system.company.${table}`]: rows });
      this.render(false);
    }
  }

  async _onMechDrop(event) {
    event.preventDefault();
    event.currentTarget?.classList?.remove("is-drop-hover");
    if (!this.isEditable) return;

    const data = parseDragData(event);
    if (!data) return;

    const sourceDoc = data.uuid ? await fromUuid(data.uuid).catch(() => null) : (data.data ? (data.type === "Actor" ? new Actor(data.data) : null) : null);
    const actor = sourceDoc?.documentName === "Token" ? sourceDoc.actor : sourceDoc;
    if (!actor || actor.documentName !== "Actor") return;
    if (String(actor.type ?? "").toLowerCase() !== "mech") {
      ui.notifications?.warn?.("Drop a mech actor onto the BattleMechs section.");
      return;
    }

    const rows = arrayFrom(this.actor.system?.company?.mechs).map(row => ensureRowShape("mechs", row));
    const newRow = formatMechDropRow(actor);
    const sourceUuid = String(newRow.sourceUuid ?? "").trim();
    const existingIndex = sourceUuid ? rows.findIndex(row => String(row?.sourceUuid ?? "").trim() === sourceUuid) : -1;

    if (existingIndex >= 0) rows[existingIndex] = mergeMechDropRow(rows[existingIndex], newRow);
    else rows.push(newRow);

    await this.actor.update({ "system.company.mechs": rows });
    this.render(false);
  }

  async _onDropshipDrop(event) {
    event.preventDefault();
    event.currentTarget?.classList?.remove("is-drop-hover");
    if (!this.isEditable) return;

    const data = parseDragData(event);
    if (!data) return;

    const sourceDoc = data.uuid ? await fromUuid(data.uuid).catch(() => null) : (data.data ? (data.type === "Actor" ? new Actor(data.data) : null) : null);
    const actor = sourceDoc?.documentName === "Token" ? sourceDoc.actor : sourceDoc;
    if (!actor || actor.documentName !== "Actor") return;
    if (String(actor.type ?? "").toLowerCase() !== "dropship") {
      ui.notifications?.warn?.("Drop a DropShip actor onto the DropShips section.");
      return;
    }

    const rows = arrayFrom(this.actor.system?.company?.dropships).map(row => ensureRowShape("dropships", row));
    const newRow = formatDropshipDropRow(actor);
    const sourceUuid = String(newRow.sourceUuid ?? "").trim();
    const existingIndex = sourceUuid ? rows.findIndex(row => String(row?.sourceUuid ?? "").trim() === sourceUuid) : -1;

    if (existingIndex >= 0) rows[existingIndex] = mergeDropshipDropRow(rows[existingIndex], newRow);
    else rows.push(newRow);

    await this.actor.update({ "system.company.dropships": rows });
    this.render(false);
  }

  async _onVehicleDrop(event) {
    event.preventDefault();
    event.currentTarget?.classList?.remove("is-drop-hover");
    if (!this.isEditable) return;

    const data = parseDragData(event);
    if (!data) return;

    const sourceDoc = data.uuid ? await fromUuid(data.uuid).catch(() => null) : (data.data ? (data.type === "Actor" ? new Actor(data.data) : null) : null);
    const actor = sourceDoc?.documentName === "Token" ? sourceDoc.actor : sourceDoc;
    if (!actor || actor.documentName !== "Actor") return;
    const actorType = String(actor.type ?? "").toLowerCase();
    if (!["vehicle", "wheeledvehicle"].includes(actorType)) {
      ui.notifications?.warn?.("Drop a combat vehicle actor onto the Vehicles section.");
      return;
    }

    const rows = arrayFrom(this.actor.system?.company?.vehicles).map(row => ensureRowShape("vehicles", row));
    const newRow = formatVehicleDropRow(actor);
    const sourceUuid = String(newRow.sourceUuid ?? "").trim();
    const existingIndex = sourceUuid ? rows.findIndex(row => String(row?.sourceUuid ?? "").trim() === sourceUuid) : -1;

    if (existingIndex >= 0) rows[existingIndex] = mergeVehicleDropRow(rows[existingIndex], newRow);
    else rows.push(newRow);

    await this.actor.update({ "system.company.vehicles": rows });
    this.render(false);
  }

  async _onAbominationDrop(event) {
    event.preventDefault();
    event.currentTarget?.classList?.remove("is-drop-hover");
    if (!this.isEditable) return;

    const data = parseDragData(event);
    if (!data) return;

    const sourceDoc = data.uuid ? await fromUuid(data.uuid).catch(() => null) : (data.data ? (data.type === "Actor" ? new Actor(data.data) : null) : null);
    const actor = sourceDoc?.documentName === "Token" ? sourceDoc.actor : sourceDoc;
    if (!actor || actor.documentName !== "Actor") return;
    if (String(actor.type ?? "").toLowerCase() !== "abomination") {
      ui.notifications?.warn?.("Drop an Abomination actor onto the Abominations section.");
      return;
    }

    const rows = arrayFrom(this.actor.system?.company?.abominations).map(row => ensureRowShape("abominations", row));
    const newRow = formatAbominationDropRow(actor);
    const sourceUuid = String(newRow.sourceUuid ?? "").trim();
    const existingIndex = sourceUuid ? rows.findIndex(row => String(row?.sourceUuid ?? "").trim() === sourceUuid) : -1;

    if (existingIndex >= 0) rows[existingIndex] = mergeAbominationDropRow(rows[existingIndex], newRow);
    else rows.push(newRow);

    await this.actor.update({ "system.company.abominations": rows });
    this.render(false);
  }

  async _onCharacterDrop(event, table) {
    event.preventDefault();
    event.currentTarget?.classList?.remove("is-drop-hover");
    if (!this.isEditable) return;
    if (!["combatPersonnel", "supportPersonnel"].includes(table)) return;

    const data = parseDragData(event);
    if (!data) return;

    const sourceDoc = data.uuid ? await fromUuid(data.uuid).catch(() => null) : (data.data ? (data.type === "Actor" ? new Actor(data.data) : null) : null);
    const actor = sourceDoc?.documentName === "Token" ? sourceDoc.actor : sourceDoc;
    if (!actor || actor.documentName !== "Actor") return;
    const actorType = String(actor.type ?? "").toLowerCase();
    if (!["character", "npc"].includes(actorType)) {
      ui.notifications?.warn?.("Drop a character or NPC actor onto the roster.");
      return;
    }

    const rows = arrayFrom(this.actor.system?.company?.[table]).map(row => ensureRowShape(table, row));
    const dropped = table === "combatPersonnel" ? formatCharacterCombatRow(actor) : formatCharacterSupportRow(actor);
    const sourceUuid = String(dropped.sourceUuid ?? "").trim();
    const existingIndex = sourceUuid ? rows.findIndex(row => String(row?.sourceUuid ?? "").trim() === sourceUuid) : -1;

    if (existingIndex >= 0) {
      rows[existingIndex] = table === "combatPersonnel"
        ? mergeCharacterCombatRow(rows[existingIndex], dropped)
        : mergeCharacterSupportRow(rows[existingIndex], dropped);
    } else {
      rows.push(dropped);
    }

    await this.actor.update({ [`system.company.${table}`]: rows });
    this.render(false);
  }

  async _onMissionJournalDrop(event) {
    event.preventDefault();
    event.currentTarget?.classList?.remove("is-drop-hover");
    if (!this.isEditable) return;

    const index = Number(event.currentTarget?.dataset?.index);
    if (!Number.isInteger(index) || index < 0) return;

    const data = parseDragData(event);
    if (!data) return;
    const doc = data.uuid ? await fromUuid(data.uuid).catch(() => null) : null;
    if (!doc || !["JournalEntry", "JournalEntryPage"].includes(String(doc.documentName ?? ""))) {
      ui.notifications?.warn?.("Drop a Journal Entry or Journal page onto the mission journal link.");
      return;
    }

    await this._setMissionJournal(index, doc);
  }

  async _setMissionJournal(index, doc) {
    await this._flushPendingSave();
    const rows = this._collectTableRows("missions").map(row => ensureRowShape("missions", row));
    const row = rows[index];
    if (!row) return;

    const entry = doc?.documentName === "JournalEntryPage" ? doc.parent : doc;
    row.journalUuid = String(doc?.uuid ?? entry?.uuid ?? "").trim();
    row.journalName = String(doc?.name ?? entry?.name ?? "Mission Journal").trim();

    await this.actor.update({ "system.company.missions": rows });
    this.render(false);
  }

  async _createMissionJournal(index) {
    if (!this.isEditable) return;
    await this._flushPendingSave();

    const rows = this._collectTableRows("missions").map(row => ensureRowShape("missions", row));
    const row = rows[index];
    if (!row) return;

    const existingUuid = String(row.journalUuid ?? "").trim();
    if (existingUuid) {
      await this._openMissionJournal(index);
      return;
    }

    const missionName = String(row.name ?? "").trim() || `Mission ${index + 1}`;
    const companyName = String(this.actor?.name ?? "Company").trim();
    const journalName = `${companyName} - ${missionName}`;
    const content = [
      `<h1>${escapeHtml(missionName)}</h1>`,
      `<p><strong>Company:</strong> ${escapeHtml(companyName)}</p>`,
      row.date ? `<p><strong>Date:</strong> ${escapeHtml(row.date)}</p>` : "",
      row.employer ? `<p><strong>Employer:</strong> ${escapeHtml(row.employer)}</p>` : "",
      row.location ? `<p><strong>Location:</strong> ${escapeHtml(row.location)}</p>` : "",
      row.objective ? `<h2>Objective</h2><p>${escapeHtml(row.objective)}</p>` : "<h2>Objective</h2><p></p>",
      row.result ? `<h2>Result</h2><p>${escapeHtml(row.result)}</p>` : "<h2>Result</h2><p></p>",
      row.reward ? `<h2>Reward</h2><p>${escapeHtml(row.reward)}</p>` : "",
      row.salvage ? `<h2>Salvage</h2><p>${escapeHtml(row.salvage)}</p>` : "",
      row.losses ? `<h2>Losses</h2><p>${escapeHtml(row.losses)}</p>` : "",
      row.impact ? `<h2>Reputation Impact</h2><p>${escapeHtml(row.impact)}</p>` : "",
      row.events ? `<h2>Notable Events</h2><p>${escapeHtml(row.events)}</p>` : "<h2>Notable Events</h2><p></p>"
    ].filter(Boolean).join("");

    let journal = null;
    try {
      journal = await JournalEntry.create({
        name: journalName,
        pages: [{
          name: missionName,
          type: "text",
          text: { content, format: CONST.JOURNAL_ENTRY_PAGE_FORMATS?.HTML ?? 1 }
        }]
      });
    } catch (err) {
      console.warn("ATOWCompanySheet | Mission journal page create failed; falling back to empty journal", err);
      journal = await JournalEntry.create({ name: journalName });
    }

    const page = Array.from(journal?.pages ?? [])[0] ?? null;
    row.journalUuid = String(page?.uuid ?? journal?.uuid ?? "").trim();
    row.journalName = String(page?.name ?? journal?.name ?? journalName).trim();

    await this.actor.update({ "system.company.missions": rows });
    this.render(false);
    await this._renderJournalDocument(page ?? journal);
  }

  async _openMissionJournal(index) {
    await this._flushPendingSave();
    const rows = this._collectTableRows("missions").map(row => ensureRowShape("missions", row));
    const row = rows[index];
    const uuid = String(row?.journalUuid ?? "").trim();
    if (!uuid) {
      ui.notifications?.warn?.("This mission does not have a linked journal yet.");
      return;
    }

    const doc = await fromUuid(uuid).catch(() => null);
    if (!doc) {
      ui.notifications?.warn?.("The linked journal could not be found.");
      return;
    }
    await this._renderJournalDocument(doc);
  }

  async _renderJournalDocument(doc) {
    const entry = doc?.documentName === "JournalEntryPage" ? doc.parent : doc;
    if (entry?.sheet?.render) {
      entry.sheet.render(true, doc?.documentName === "JournalEntryPage" ? { pageId: doc.id } : {});
      return;
    }
    doc?.sheet?.render?.(true);
  }

  _queueFieldSave(name, value, { immediate = false } = {}) {
    if (!this.isEditable) return;
    this._pendingFieldUpdates.set(name, value);

    const existingTimer = this._fieldSaveTimers.get(name);
    if (existingTimer) clearTimeout(existingTimer);

    const commit = async () => {
      this._fieldSaveTimers.delete(name);
      const current = this._pendingFieldUpdates.get(name);
      this._pendingFieldUpdates.delete(name);
      if (current === undefined) return;
      try {
        await this.actor.update({ [name]: current }, { render: false });
      } catch (err) {
        console.warn("AToWCompanySheet | Field save failed", err);
      }
    };

    if (immediate) {
      void commit();
      return;
    }

    const timer = setTimeout(() => {
      void commit();
    }, 150);
    this._fieldSaveTimers.set(name, timer);
  }

  _collectTableRows(table) {
    const form = this.element?.matches?.("form.company-sheet") ? this.element : this.element?.querySelector?.("form.company-sheet");
    const defaults = TABLES[table];
    if (!form || !defaults) {
      return arrayFrom(this.actor.system?.company?.[table]).map(row => ensureRowShape(table, row));
    }

    const rows = [];
    const selector = `[name^="system.company.${table}."]`;
    form.querySelectorAll(selector).forEach(input => {
      const parsed = parseCompanyTableFieldName(input.name);
      if (!parsed || parsed.table !== table || !Number.isInteger(parsed.index) || parsed.index < 0) return;
      rows[parsed.index] = rows[parsed.index] ?? clone(defaults);
      rows[parsed.index][parsed.key] = parseInputValue(input);
    });

    return rows.filter(Boolean).map(row => ensureRowShape(table, row));
  }

  _queueTableSave(table, { immediate = false } = {}) {
    if (!this.isEditable || !TABLES[table]) return;
    this._pendingTableSaves.add(table);

    const existingTimer = this._tableSaveTimers.get(table);
    if (existingTimer) clearTimeout(existingTimer);

    const commit = async () => {
      this._tableSaveTimers.delete(table);
      if (!this._pendingTableSaves.has(table)) return;
      this._pendingTableSaves.delete(table);
      try {
        await this.actor.update({ [`system.company.${table}`]: this._collectTableRows(table) }, { render: false });
      } catch (err) {
        console.warn(`AToWCompanySheet | ${table} table save failed`, err);
      }
    };

    if (immediate) {
      void commit();
      return;
    }

    const timer = setTimeout(() => {
      void commit();
    }, 150);
    this._tableSaveTimers.set(table, timer);
  }

  async _flushPendingSave() {
    if (!this.isEditable) return;
    for (const timer of this._fieldSaveTimers.values()) clearTimeout(timer);
    this._fieldSaveTimers.clear();
    for (const timer of this._tableSaveTimers.values()) clearTimeout(timer);
    this._tableSaveTimers.clear();

    const updates = {};
    for (const table of this._pendingTableSaves) {
      updates[`system.company.${table}`] = this._collectTableRows(table);
    }
    this._pendingTableSaves.clear();

    for (const [path, value] of this._pendingFieldUpdates.entries()) {
      updates[path] = value;
    }
    this._pendingFieldUpdates.clear();

    if (!Object.keys(updates).length) return;
    try {
      await this.actor.update(updates, { render: false });
    } catch (err) {
      console.warn("AToWCompanySheet | Flush submit failed", err);
    }
  }

  async _preClose(options) {
    if (this.isEditable) {
      await this._flushPendingSave();
    }
    return super._preClose(options);
  }
}
