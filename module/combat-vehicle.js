// module/combat-vehicle.js
// Combat vehicle actor sheet for AToW Battletech.

import { promptAndRollWeaponAttack } from "./mech-attack.js";

const SYSTEM_ID = "atow-battletech";
const TEMPLATE = `systems/${SYSTEM_ID}/templates/combat-vehicle.hbs`;
const SHEET_CSS = `systems/${SYSTEM_ID}/styles/combat-vehicle.css`;
const SHEET_CSS_ID = "atow-combat-vehicle-sheet-css";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;

const ARMOR_KEYS = [
  { key: "front", label: "Front" },
  { key: "left", label: "Left" },
  { key: "right", label: "Right" },
  { key: "rear", label: "Rear" },
  { key: "turret", label: "Turret" }
];

const MOVEMENT_TYPE_OPTIONS = ["Tracked", "Wheeled", "Hovercraft"];
const CREW_HIT_MAX = 2;
const SENSOR_HIT_MAX = 2;
const MOTIVE_HIT_MAX = 4;
const TONNAGE_OPTIONS = Array.from({ length: 17 }, (_, i) => 20 + (i * 5));
const VEHICLE_EQUIPMENT_TYPES = new Set(["mechEquipment", "equipment", "gear", "ammo"]);
const PROCESSED_DROP_EVENTS = new WeakSet();

function slugifyAmmoKey(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function ammoKeyFromTypeLabel(typeText) {
  const t = String(typeText ?? "").trim().toLowerCase();
  if (!t || t === "none" || t === "n/a" || t === "na" || t === "n-a" || t === "no ammo" || t === "ammo none") return null;
  if (/^(ac|lrm|mrm|srm|atm)-\d+(?:-(?:er|he))?$/.test(t)) return t;
  if (/^lbx-\d+(?:-cluster)?$/.test(t)) return t;

  const isCluster = /\bcluster\b/i.test(t);
  let m = t.match(/\blb\s*(\d+)\s*-\s*x\s*ac\b/i);
  if (m?.[1]) return slugifyAmmoKey(`lbx-${m[1]}${isCluster ? "-cluster" : ""}`);
  m = t.match(/\blbx\b[^\d]*(\d+)\b/i);
  if (m?.[1]) return slugifyAmmoKey(`lbx-${m[1]}${isCluster ? "-cluster" : ""}`);

  m = t.match(/\batm\b[^\d]*(3|6|9|12)\b/i) ?? t.match(/\badvanced\s+tactical\s+missiles?\b[^\d]*(3|6|9|12)\b/i);
  if (m?.[1]) {
    const variant = /\ber\b/i.test(t) ? "-er" : (/\bhe\b/i.test(t) ? "-he" : "");
    return slugifyAmmoKey(`atm-${m[1]}${variant}`);
  }

  if (t.includes("gauss")) return "gauss";
  m = t.match(/\bac\s*\/?\s*(\d+)\b/i);
  if (m?.[1]) return slugifyAmmoKey(`ac-${m[1]}`);
  m = t.match(/\b(lrm|mrm|srm)\s*-?\s*(\d+)\b/i) ?? t.match(/\b(lrm|mrm|srm)\b[^\d]*(\d+)\b/i);
  if (m?.[1] && m?.[2]) return slugifyAmmoKey(`${m[1]}-${m[2]}`);
  m = t.match(/\bmedium\s+range\s+missiles?\b[^\d]*(10|20|30|40)\b/i);
  if (m?.[1]) return slugifyAmmoKey(`mrm-${m[1]}`);
  if (t.includes("machine gun") || t === "mg") return "mg";
  if (t === "ams" || /\banti\s*-?\s*missile\s+system\b/i.test(t)) return "ams";
  if (/\barrow\s*iv\b/i.test(t) && /\bhoming\b/i.test(t)) return "arrow-iv-homing";

  return slugifyAmmoKey(t);
}

function defaultAmmoAmountForKey(key) {
  const defaults = {
    "ac-2": 45,
    "ac-5": 20,
    "ac-10": 10,
    "ac-20": 5,
    "gauss": 8,
    "lrm-5": 24,
    "lrm-10": 12,
    "lrm-15": 8,
    "lrm-20": 6,
    "mrm-10": 24,
    "mrm-20": 12,
    "mrm-30": 8,
    "mrm-40": 6,
    "srm-2": 50,
    "srm-4": 25,
    "srm-6": 15,
    "mg": 200,
    "ams": 12,
    "arrow-iv-homing": 5
  };

  const k = String(key ?? "").trim().toLowerCase();
  if (defaults[k]) return defaults[k];
  if (/^atm-(3|6|9|12)(?:-(?:er|he))?$/.test(k)) return 10;
  if (/^lbx-2(?:-cluster)?$/.test(k)) return 45;
  if (/^lbx-5(?:-cluster)?$/.test(k)) return 20;
  if (/^lbx-10(?:-cluster)?$/.test(k)) return 10;
  if (/^lbx-20(?:-cluster)?$/.test(k)) return 5;
  return 0;
}

function parseAmmoDropItem(item) {
  if (!item) return null;
  const sys = item.system ?? {};
  const name = String(item.name ?? "").trim();
  const candidates = [
    sys.ammoType,
    sys.ammoName,
    sys.ammoLabel,
    sys.ammo?.type,
    sys.ammo?.name,
    sys.type,
    sys.subtype,
    name
  ].map(v => String(v ?? "").trim()).filter(Boolean);

  const ammoLabelMatch = name.match(/^\s*Ammo\s*\(([^)]+)\)\s*(\d+)?\s*$/i);
  const trailingCountMatch = name.match(/\b(\d+)\s*(?:shots?|rounds?)\b/i) ?? name.match(/\)\s*(\d+)\s*$/i);
  const nameAmmoTypeMatch =
    ammoLabelMatch ??
    name.match(/\b((?:LB\s*\d+\s*-\s*X\s*AC|LBX\s*(?:AC\s*\/?\s*)?\d+|ATM\s*(?:3|6|9|12)(?:\s*(?:ER|HE))?|AC\s*\/?\s*\d+|LRM\b[^\d]*\d+|MRM\b[^\d]*\d+|Medium\s+Range\s+Missiles?\b[^\d]*(?:10|20|30|40)|SRM\b[^\d]*\d+|Gauss(?:\s+Rifle)?|Machine Gun|MG|AMS|Arrow\s*IV\s*Homing))\b/i);

  let ammoType = String(ammoLabelMatch?.[1] ?? candidates[0] ?? nameAmmoTypeMatch?.[1] ?? "").trim();
  const candidateKey = ammoKeyFromTypeLabel(ammoType);
  if ((!candidateKey || !defaultAmmoAmountForKey(candidateKey)) && nameAmmoTypeMatch?.[1]) {
    ammoType = String(nameAmmoTypeMatch[1]).trim();
  }
  let amount = Number(sys.ammoAmount ?? sys.shots ?? sys.rounds ?? sys.ammo?.amount ?? sys.ammo?.shots ?? 0);

  if (!Number.isFinite(amount) || amount <= 0) amount = Number(ammoLabelMatch?.[2] ?? trailingCountMatch?.[1] ?? 0);

  ammoType = ammoType.replace(/^\s*Ammo\s*\(([^)]+)\)\s*(\d+)?\s*$/i, "$1").trim();

  const key = ammoKeyFromTypeLabel(ammoType);
  if (!Number.isFinite(amount) || amount <= 0) amount = defaultAmmoAmountForKey(key);
  amount = Math.max(0, Math.floor(Number.isFinite(amount) ? amount : 0));

  const looksLikeAmmo = /\bammo\b/i.test(name) || Boolean(sys.ammoType) || Boolean(sys.ammoAmount) || Boolean(sys.ammo?.type) || Boolean(sys.ammo?.amount);
  if (!looksLikeAmmo) return null;
  if (!key || amount <= 0) return null;

  return {
    key,
    name: ammoType || key,
    amount
  };
}

function buildAmmoBinsFromEquipmentItems(items, savedBins = {}) {
  const totals = new Map();

  const add = (ammo) => {
    if (!ammo?.key || !ammo.amount) return;
    const prev = totals.get(ammo.key);
    if (!prev) totals.set(ammo.key, { key: ammo.key, name: ammo.name, total: ammo.amount });
    else prev.total += ammo.amount;
  };

  for (const item of items ?? []) add(parseAmmoDropItem(item));

  const bins = [];
  for (const [key, row] of totals.entries()) {
    const total = Math.max(0, Math.floor(Number(row.total ?? 0) || 0));
    const saved = savedBins?.[key] ?? {};
    const savedCurrent = Number(saved.current);
    const current = Number.isFinite(savedCurrent) ? clampInt(savedCurrent, 0, total, total) : total;
    bins.push({
      key,
      name: String(saved.name ?? row.name ?? key),
      total,
      current
    });
  }

  for (const [key, saved] of Object.entries(savedBins ?? {})) {
    if (totals.has(key)) continue;
    const total = Math.max(0, Math.floor(Number(saved?.total ?? 0) || 0));
    if (total <= 0) continue;
    const savedCurrent = Number(saved.current);
    bins.push({
      key,
      name: String(saved.name ?? key),
      total,
      current: Number.isFinite(savedCurrent) ? clampInt(savedCurrent, 0, total, total) : total
    });
  }

  bins.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" }));
  return bins;
}

function clampInt(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function buildTrack(max, value) {
  const m = Math.max(0, Number(max ?? 0) || 0);
  const v = clampInt(value, 0, m, 0);
  return Array.from({ length: m }, (_, i) => {
    const n = i + 1;
    return { n, filled: n <= v };
  });
}

function buildArmorPips(max, dmg) {
  const m = Math.max(0, Number(max ?? 0) || 0);
  const v = clampInt(dmg, 0, m, 0);
  return Array.from({ length: m }, (_, i) => {
    const n = i + 1;
    return { n, filled: n <= v };
  });
}

function getActorTokenDocument(actor) {
  if (!actor) return null;

  const activeTokens = actor.getActiveTokens?.(true, true) ?? actor.getActiveTokens?.() ?? [];
  for (const token of activeTokens) {
    if (!token) continue;
    if (token.document) return token.document;
    return token;
  }

  try {
    const controlled = canvas?.tokens?.controlled ?? [];
    const match = controlled.find((token) => token?.actor?.id === actor.id);
    if (match?.document) return match.document;
    if (match) return match;
  } catch (_) {}

  try {
    const placeables = canvas?.tokens?.placeables ?? [];
    const match = placeables.find((token) => token?.actor?.id === actor.id);
    if (match?.document) return match.document;
    if (match) return match;
  } catch (_) {}

  return null;
}

function parseFormInputValue(input) {
  if (!input) return null;
  if (input.type === "checkbox") return Boolean(input.checked);
  if (input.type === "number") {
    const raw = String(input.value ?? "").trim();
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  const name = String(input.name ?? "").trim();
  const numericNames = new Set([
    "system.vehicle.tonnage",
    "system.vehicle.bv",
    "system.vehicle.movement.cruise",
    "system.vehicle.movement.flank",
    "system.crew.gunnery",
    "system.crew.driving"
  ]);
  if (numericNames.has(name)) {
    const n = Number(input.value ?? 0);
    return Number.isFinite(n) ? n : 0;
  }

  return input.value ?? "";
}

export class ATOWCombatVehicleSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  constructor(...args) {
    super(...args);
    this._hideThirdColumn = false;
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
      classes: ["atow", "sheet", "actor", "wheeledvehicle", "combat-vehicle", "battletech"],
      position: { width: 1320, height: 860 },
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

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const system = this.actor.system ?? {};
    const tonnage = Number(system?.vehicle?.tonnage ?? 0) || 0;
    const structurePerLoc = Math.max(0, Math.floor(tonnage / 10));

    const armor = {};
    for (const loc of ARMOR_KEYS) {
      const data = system?.armor?.[loc.key] ?? {};
      const max = Number(data.max ?? 0) || 0;
      const dmg = Number(data.dmg ?? 0) || 0;
      armor[loc.key] = {
        key: loc.key,
        label: loc.label,
        max,
        dmg,
        pips: buildArmorPips(max, dmg)
      };
    }

    const structure = {};
    for (const loc of ARMOR_KEYS) {
      const data = system?.structure?.[loc.key] ?? {};
      const dmg = Number(data.dmg ?? 0) || 0;
      structure[loc.key] = {
        key: loc.key,
        label: loc.label,
        max: structurePerLoc,
        dmg,
        pips: buildArmorPips(structurePerLoc, dmg)
      };
    }

    const weaponItems = this.actor.items.contents.filter(i => i?.type === "mechWeapon" || i?.type === "weapon");
    const vehicleWeapons = weaponItems
      .map(i => ({
        _id: i.id,
        name: i.name ?? "",
        sort: Number(i.sort ?? 0) || 0,
        system: i.system ?? {},
        itemUuid: i.uuid ?? ""
      }))
      .sort((a, b) => (Number(a.sort ?? 0) - Number(b.sort ?? 0)) || String(a.name ?? "").localeCompare(String(b.name ?? ""), undefined, { sensitivity: "base" }));

    const equipmentItems = this.actor.items.contents.filter(i => VEHICLE_EQUIPMENT_TYPES.has(i?.type));
    const vehicleEquipment = equipmentItems
      .map(i => {
        const ammo = parseAmmoDropItem(i);
        return {
          _id: i.id,
          name: i.name ?? "",
          sort: Number(i.sort ?? 0) || 0,
          type: i.type,
          isAmmo: Boolean(ammo),
          ammoName: ammo?.name ?? "",
          ammoAmount: ammo?.amount ?? 0,
          system: i.system ?? {},
          itemUuid: i.uuid ?? ""
        };
      })
      .sort((a, b) => (Number(a.sort ?? 0) - Number(b.sort ?? 0)) || String(a.name ?? "").localeCompare(String(b.name ?? ""), undefined, { sensitivity: "base" }));

    const ammoBins = buildAmmoBinsFromEquipmentItems(equipmentItems, system?.ammoBins ?? {});

    const crew = system?.crew ?? {};
    const crit = system?.crit ?? {};
    const movementType = String(system?.vehicle?.movement?.type ?? "Wheeled").trim() || "Wheeled";

    context.actor = this.actor;
    context.system = system;
    context.hideThirdColumn = this._hideThirdColumn === true;
    context.tonnageOptions = TONNAGE_OPTIONS.reduce((acc, t) => {
      acc[String(t)] = String(t);
      return acc;
    }, {});
    context.movementTypeOptions = MOVEMENT_TYPE_OPTIONS;
    context.vehicleTonnage = tonnage;
    context.vehicleTypeLabel = movementType;
    context.armor = armor;
    context.structure = structure;
    context.vehicleWeapons = vehicleWeapons;
    context.vehicleEquipment = vehicleEquipment;
    context.hasVehicleEquipment = vehicleEquipment.length > 0;
    context.ammoBins = ammoBins;
    context.hasAmmoBins = ammoBins.length > 0;
    context.isDazzleMode = Boolean(this.actor?.getFlag?.(SYSTEM_ID, "dazzleMode"));
    context.crewTracks = {
      commander: buildTrack(CREW_HIT_MAX, crew.commanderHit),
      driver: buildTrack(CREW_HIT_MAX, crew.driverHit)
    };
    context.critTracks = {
      sensor: buildTrack(SENSOR_HIT_MAX, crit.sensorHits),
      motive: buildTrack(MOTIVE_HIT_MAX, crit.motiveHits)
    };

    const tokenDoc = getActorTokenDocument(this.actor);
    const moved = tokenDoc?.getFlag?.(SYSTEM_ID, "movedThisTurn");
    const mpSpent = tokenDoc?.getFlag?.(SYSTEM_ID, "mpSpentThisTurn");
    const modeFlag = tokenDoc?.getFlag?.(SYSTEM_ID, "moveMode");

    context.movementStatus = {
      moved: (moved === undefined || moved === null) ? "—" : String(Number(moved)),
      mpSpent: (mpSpent === undefined || mpSpent === null) ? "—" : String(Number(mpSpent)),
      mode: modeFlag ? String(modeFlag).toUpperCase() : "—"
    };

    return context;
  }

  _onRender(context, options) {
    super._onRender(context, options);
    ATOWCombatVehicleSheet._ensureSheetStyles();

    const root = this.element;
    if (!root) return;
    this._injectWindowColumnToggle(root);

    const form = root.matches?.("form.combat-vehicle-sheet") ? root : root.querySelector?.("form.combat-vehicle-sheet");
    if (form && form.dataset.atowFormBound !== "1") {
      form.dataset.atowFormBound = "1";
      form.addEventListener("change", (event) => this._onFormValueChange(event));
    }

    const portrait = root.querySelector('[data-edit="img"]');
    if (portrait && portrait.dataset.atowImgBound !== "1") {
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
          type: "imagevideo",
          current: this.actor?.img ?? "",
          callback: async (path) => {
            if (!path) return;
            await this.actor.update({ img: path });
          }
        });

        try { fp.browse(); } catch (_) {}
        fp.render(true);
      });
    }

    root.querySelectorAll(".item-delete").forEach((el) => {
      if (el.dataset.atowBound === "1") return;
      el.dataset.atowBound = "1";
      el.addEventListener("click", (event) => this._onItemDelete(event));
    });

    root.querySelectorAll(".cv-eq-row[data-item-id]").forEach((row) => {
      if (row.dataset.atowBound === "1") return;
      row.dataset.atowBound = "1";
      row.addEventListener("contextmenu", (event) => this._onEquipmentRowContext(event));
    });

    root.querySelectorAll(".header-action-btn[data-header-action]").forEach((button) => {
      if (button.dataset.atowBound === "1") return;
      button.dataset.atowBound = "1";
      button.addEventListener("click", (event) => this._onHeaderActionClick(event));
      if (button.getAttribute("draggable") === "true") {
        button.addEventListener("dragstart", (event) => this._onHeaderActionDragStart(event));
      }
    });

    const dragHandle = root.querySelector?.("[data-combat-vehicle-drag-handle]");
    if (dragHandle && dragHandle.dataset.atowBound !== "1") {
      dragHandle.dataset.atowBound = "1";
      dragHandle.addEventListener("dragstart", (event) => this._onActorDragStart(event));
    }
    this._primeHeaderActionMacros(root).catch(err => {
      console.warn("ATOWCombatVehicleSheet | Failed to prime header action macros", err);
    });

    root.querySelectorAll(".cv-we-row[data-item-id]").forEach((row) => {
      if (row.dataset.atowBound === "1") return;
      row.dataset.atowBound = "1";
      row.addEventListener("click", (event) => this._onWeaponRowClick(event));
      row.addEventListener("contextmenu", (event) => this._onWeaponRowContext(event));
      if (row.getAttribute("draggable") === "true") {
        row.addEventListener("dragstart", (event) => this._onWeaponDragStart(event));
      }
    });

    root.querySelectorAll(".cv-armor-pip").forEach((el) => {
      if (el.dataset.atowBound === "1") return;
      el.dataset.atowBound = "1";
      el.addEventListener("click", (event) => this._onArmorPip(event));
    });

    root.querySelectorAll(".cv-structure-pip").forEach((el) => {
      if (el.dataset.atowBound === "1") return;
      el.dataset.atowBound = "1";
      el.addEventListener("click", (event) => this._onStructurePip(event));
    });

    root.querySelectorAll(".cv-track-box").forEach((el) => {
      if (el.dataset.atowBound === "1") return;
      el.dataset.atowBound = "1";
      el.addEventListener("click", (event) => this._onTrackBox(event));
    });

    root.querySelectorAll(".cv-ammo-table input[name^='system.ammoBins.'][name$='.current']").forEach((input) => {
      if (input.dataset.atowBound === "1") return;
      input.dataset.atowBound = "1";
      input.addEventListener("change", (event) => this._onAmmoBinCurrentChange(event));
    });

    root.querySelectorAll("[data-drop-zone='combat-vehicle-weapons']").forEach((zone) => {
      if (zone.dataset.atowDropBound === "1") return;
      zone.dataset.atowDropBound = "1";
      zone.addEventListener("dragover", (event) => event.preventDefault());
      zone.addEventListener("drop", (event) => this._onWeaponDrop(event));
    });

    root.querySelectorAll("[data-drop-zone='combat-vehicle-equipment']").forEach((zone) => {
      if (zone.dataset.atowDropBound === "1") return;
      zone.dataset.atowDropBound = "1";
      zone.addEventListener("dragover", (event) => event.preventDefault());
      zone.addEventListener("drop", (event) => this._onEquipmentDrop(event));
    });
  }

  _injectWindowColumnToggle(root) {
    const app = root?.closest?.(".window-app, .application");
    const header = app?.querySelector?.(".window-header");
    const controls = app?.querySelector?.(".window-header .window-controls, .window-header .header-controls");
    const host = controls ?? header;
    if (!host) return;

    app?.querySelector?.(".atow-toggle-third-column")?.remove?.();

    const button = document.createElement("button");
    button.type = "button";
    button.className = "header-control atow-toggle-third-column";
    button.title = this._hideThirdColumn ? "Show Right Column" : "Hide Right Column";
    button.setAttribute("aria-label", button.title);
    button.innerHTML = '<i class="fas fa-columns"></i>';
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this._hideThirdColumn = !this._hideThirdColumn;
      this.render(false);
    });

    const anchor = header?.querySelector?.(".close, .header-control.close, .window-control.close, [data-action='close']");
    if (anchor?.parentElement) anchor.parentElement.insertBefore(button, anchor);
    else host.prepend(button);
  }

  async _onItemDelete(event) {
    event.preventDefault();
    event.stopPropagation?.();
    const row = event.currentTarget.closest("[data-item-id]");
    const itemId = row?.dataset?.itemId;
    if (!itemId) return;
    const item = this.actor.items.get(itemId);
    const removeAmmo = Boolean(row?.classList?.contains("cv-eq-row"));
    const ammo = removeAmmo ? parseAmmoDropItem(item) : null;
    await this.actor.deleteEmbeddedDocuments("Item", [itemId]);
    if (ammo) await this._removeAmmoBin(ammo);
    this.render(false);
  }

  async _onHeaderActionClick(event) {
    event.preventDefault();
    const action = String(event.currentTarget?.dataset?.headerAction ?? "").trim().toLowerCase();
    if (!action) return;
    await this._executeHeaderAction(action);
  }

  async _onHeaderActionDragStart(event) {
    const button = event.currentTarget;
    const action = String(button?.dataset?.headerAction ?? "").trim().toLowerCase();
    if (!action) return;

    const dt = event.dataTransfer;
    if (!dt) return;

    const label = String(button?.dataset?.macroLabel ?? button?.textContent ?? action).trim() || action;
    const img = String(button?.dataset?.macroImg ?? "icons/svg/dice-target.svg").trim() || "icons/svg/dice-target.svg";
    const macroUuid = String(button?.dataset?.macroUuid ?? "").trim();

    const tokenDoc =
      this.token?.document ??
      this.actor?.getActiveTokens?.(true, true)?.[0]?.document ??
      this.actor?.getActiveTokens?.()?.[0]?.document ??
      null;

    const payload = {
      type: "ATOWHeaderAction",
      action,
      label,
      img,
      actorId: this.actor?.id ?? null,
      tokenId: tokenDoc?.id ?? null
    };

    if (macroUuid) {
      dt.setData("text/plain", macroUuid);
      dt.setData("text/uri-list", macroUuid);
      dt.setData("application/json", JSON.stringify({ type: "Macro", uuid: macroUuid }));
      dt.setData("text/json", JSON.stringify({ type: "Macro", uuid: macroUuid }));
    } else {
      const data = JSON.stringify(payload);
      dt.setData("text/plain", label);
      dt.setData("application/json", data);
      dt.setData("text/json", data);
    }

    dt.effectAllowed = "copyMove";
  }

  _onActorDragStart(event) {
    if (!this.actor?.uuid) return;
    const dt = event.dataTransfer;
    if (!dt) return;

    const payload = {
      type: "Actor",
      uuid: this.actor.uuid
    };

    dt.setData("application/json", JSON.stringify(payload));
    dt.setData("text/json", JSON.stringify(payload));
    dt.setData("text/plain", this.actor.name ?? "Combat Vehicle");
    dt.effectAllowed = "copyMove";
  }

  async _primeHeaderActionMacros(root) {
    const ensureMacro = game?.[SYSTEM_ID]?.api?.ensureHeaderActionMacro ?? null;
    if (typeof ensureMacro !== "function") return;

    const tokenDoc =
      this.token?.document ??
      this.actor?.getActiveTokens?.(true, true)?.[0]?.document ??
      this.actor?.getActiveTokens?.()?.[0]?.document ??
      null;

    const buttons = Array.from(root.querySelectorAll(".header-action-btn[data-header-action]") ?? []);
    for (const button of buttons) {
      const action = String(button?.dataset?.headerAction ?? "").trim();
      if (!action) continue;

      const macro = await ensureMacro({
        action,
        label: String(button?.dataset?.macroLabel ?? button?.textContent ?? action).trim(),
        img: String(button?.dataset?.macroImg ?? "icons/svg/dice-target.svg").trim(),
        actorId: this.actor?.id ?? null,
        tokenId: tokenDoc?.id ?? null
      });

      if (macro?.uuid) button.dataset.macroUuid = macro.uuid;
    }
  }

  async _executeHeaderAction(action) {
    const execute =
      game?.[SYSTEM_ID]?.api?.executeHeaderAction ??
      game?.[SYSTEM_ID]?.api?.runHeaderActionMacro ??
      null;

    if (typeof execute !== "function") {
      ui.notifications?.warn?.("This header action is not available right now.");
      return false;
    }

    const tokenDoc =
      this.token?.document ??
      this.actor?.getActiveTokens?.(true, true)?.[0]?.document ??
      this.actor?.getActiveTokens?.()?.[0]?.document ??
      null;

    const ok = await execute({
      action,
      actorId: this.actor?.id ?? null,
      tokenId: tokenDoc?.id ?? null
    });

    if (ok) this.render(false);
    return ok;
  }

  _onWeaponRowClick(event) {
    if (event?.button === 2) return;
    if (event.target?.closest?.(".item-delete")) return;
    return this._onWeaponAttack(event);
  }

  _onWeaponRowContext(event) {
    if (event.target?.closest?.(".item-delete")) return;
    event.preventDefault();
    const row = event.currentTarget;
    const itemId = row?.dataset?.itemId;
    const item = itemId ? this.actor.items.get(itemId) : null;
    if (item?.sheet) item.sheet.render(true);
  }

  _onEquipmentRowContext(event) {
    if (event.target?.closest?.(".item-delete")) return;
    event.preventDefault();
    const row = event.currentTarget;
    const itemId = row?.dataset?.itemId;
    const item = itemId ? this.actor.items.get(itemId) : null;
    if (item?.sheet) item.sheet.render(true);
  }

  async _onWeaponAttack(event) {
    event.preventDefault();
    const row = event.currentTarget.closest(".cv-we-row");
    const itemId = row?.dataset?.itemId;
    const itemUuid = String(row?.dataset?.itemUuid ?? "").trim();
    if (!itemId) return;
    const weapon = this.actor.items.get(itemId);
    if (!weapon) return;
    if (!["mechWeapon", "weapon"].includes(weapon.type)) return;
    await promptAndRollWeaponAttack(this.actor, weapon, {
      defaultSide: "front",
      weaponFireKey: itemUuid || itemId
    });
  }

  _onWeaponDragStart(event) {
    try {
      const row = event.currentTarget;
      const uuid = String(row?.dataset?.itemUuid ?? "").trim();
      if (!uuid) return;

      const dt = event?.dataTransfer ?? null;
      if (!dt) return;

      const payload = { type: "Item", uuid };
      const data = JSON.stringify(payload);
      dt.setData("text/plain", data);
      dt.setData("application/json", data);
      dt.setData("text/json", data);
      dt.effectAllowed = "copyMove";
    } catch (err) {
      console.warn("ATOWCombatVehicleSheet | Weapon drag start failed", err);
    }
  }

  async _onArmorPip(event) {
    event.preventDefault();
    const el = event.currentTarget;
    const loc = el.dataset.loc;
    const pip = Number(el.dataset.pip ?? 0);
    if (!loc || Number.isNaN(pip)) return;

    const armorLoc = this.actor.system?.armor?.[loc] ?? {};
    const max = Number(armorLoc.max ?? 0);
    const current = Number(armorLoc.dmg ?? 0);

    let next = pip;
    if (pip <= current) next = Math.max(0, pip - 1);
    next = clampInt(next, 0, max, 0);

    await this.actor.update({ [`system.armor.${loc}.dmg`]: next });
    this.render(false);
  }

  async _onStructurePip(event) {
    event.preventDefault();
    const el = event.currentTarget;
    const loc = el.dataset.loc;
    const pip = Number(el.dataset.pip ?? 0);
    if (!loc || Number.isNaN(pip)) return;

    const tonnage = Number(this.actor.system?.vehicle?.tonnage ?? 0) || 0;
    const max = Math.max(0, Math.floor(tonnage / 10));
    const structLoc = this.actor.system?.structure?.[loc] ?? {};
    const current = Number(structLoc.dmg ?? 0);

    let next = pip;
    if (pip <= current) next = Math.max(0, pip - 1);
    next = clampInt(next, 0, max, 0);

    await this.actor.update({ [`system.structure.${loc}.dmg`]: next });
    this.render(false);
  }

  async _onTrackBox(event) {
    event.preventDefault();
    const el = event.currentTarget;
    const track = String(el.dataset.track ?? "").trim();
    const value = Number(el.dataset.value ?? 0);
    if (!track || Number.isNaN(value)) return;

    const path = `system.${track}`;
    const current = Number(foundry.utils.getProperty(this.actor, path) ?? 0) || 0;
    const next = (current === value) ? Math.max(0, value - 1) : value;
    await this.actor.update({ [path]: next });
    this.render(false);
  }

  async _onAmmoBinCurrentChange(event) {
    event?.preventDefault?.();

    const input = event?.currentTarget;
    const rawName = String(input?.name ?? "").trim();
    const match = rawName.match(/^system\.ammoBins\.([^.]+)\.current$/);
    if (!match?.[1]) return;

    const key = String(match[1]);
    const total = Number(input?.max ?? this.actor?.system?.ammoBins?.[key]?.total ?? 0) || 0;
    const rawValue = Number(input?.value ?? 0);
    const next = Math.max(0, Math.min(total > 0 ? total : rawValue, Number.isFinite(rawValue) ? rawValue : 0));

    if (input) input.value = String(next);
    await this.actor.update({ [`system.ammoBins.${key}.current`]: next });
    this.render(false);
  }

  async _onFormValueChange(event) {
    const input = event.target;
    const name = String(input?.name ?? "").trim();
    if (!name) return;

    if (/^system\.ammoBins\.[^.]+\.current$/.test(name)) return;

    const value = parseFormInputValue(input);
    await this.actor.update({ [name]: value });

    if (
      name === "system.vehicle.tonnage" ||
      /^system\.armor\.[^.]+\.max$/.test(name)
    ) {
      this.render(false);
    }
  }

  async _onWeaponDrop(event) {
    event.preventDefault();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
    if (PROCESSED_DROP_EVENTS.has(event)) return;
    PROCESSED_DROP_EVENTS.add(event);
    if (!this.isEditable) return;

    const data = (() => {
      try {
        return TextEditor.getDragEventData(event);
      } catch (_) {
        return null;
      }
    })();

    if (!data || data.type !== "Item") return;

    if (typeof data.uuid === "string" && this.actor?.uuid && data.uuid.startsWith(`${this.actor.uuid}.Item.`)) {
      return;
    }

    const dropped = data.uuid ? await fromUuid(data.uuid) : (data.data ? new Item(data.data) : null);
    if (!dropped) return;

    const allowed = new Set(["mechWeapon", "weapon"]);
    if (!allowed.has(dropped.type)) {
      ui.notifications?.warn?.("Drop a mech weapon here.");
      return;
    }

    const typeMap = { weapon: "mechWeapon" };
    const obj = dropped.toObject();
    delete obj._id;
    obj.type = typeMap[obj.type] ?? obj.type;

    await this.actor.createEmbeddedDocuments("Item", [obj]);
    this.render(false);
  }

  async _onEquipmentDrop(event) {
    event.preventDefault();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
    if (PROCESSED_DROP_EVENTS.has(event)) return;
    PROCESSED_DROP_EVENTS.add(event);
    if (!this.isEditable) return;

    const data = (() => {
      try {
        return TextEditor.getDragEventData(event);
      } catch (_) {
        return null;
      }
    })();

    if (!data || data.type !== "Item") return;

    if (typeof data.uuid === "string" && this.actor?.uuid && data.uuid.startsWith(`${this.actor.uuid}.Item.`)) {
      return;
    }

    const dropped = data.uuid ? await fromUuid(data.uuid) : (data.data ? new Item(data.data) : null);
    if (!dropped) return;

    const ammo = parseAmmoDropItem(dropped);
    if (!ammo && !VEHICLE_EQUIPMENT_TYPES.has(dropped.type)) {
      ui.notifications?.warn?.("Drop mech equipment or ammunition here.");
      return;
    }

    const typeMap = { equipment: "mechEquipment", gear: "mechEquipment", ammo: "mechEquipment" };
    const obj = dropped.toObject();
    delete obj._id;
    obj.type = typeMap[obj.type] ?? obj.type;

    await this.actor.createEmbeddedDocuments("Item", [obj]);
    if (ammo) await this._addAmmoBin(ammo);
    this.render(false);
  }

  async _addAmmoBin(ammo) {
    if (!ammo?.key || !ammo.amount) return;

    const existing = this.actor.system?.ammoBins?.[ammo.key] ?? {};
    const oldTotal = Math.max(0, Math.floor(Number(existing.total ?? 0) || 0));
    const oldCurrentRaw = Number(existing.current);
    const oldCurrent = Number.isFinite(oldCurrentRaw) ? clampInt(oldCurrentRaw, 0, oldTotal, oldTotal) : oldTotal;
    const added = Math.max(0, Math.floor(Number(ammo.amount ?? 0) || 0));
    const total = oldTotal + added;
    const current = oldCurrent + added;

    await this.actor.update({
      [`system.ammoBins.${ammo.key}.name`]: String(ammo.name ?? ammo.key),
      [`system.ammoBins.${ammo.key}.total`]: total,
      [`system.ammoBins.${ammo.key}.current`]: current
    });

    ui.notifications?.info?.(`${this.actor.name}: added ${added} ${String(ammo.name ?? ammo.key)} ammo.`);
  }

  async _removeAmmoBin(ammo) {
    if (!ammo?.key || !ammo.amount) return;

    const existing = this.actor.system?.ammoBins?.[ammo.key] ?? {};
    const oldTotal = Math.max(0, Math.floor(Number(existing.total ?? 0) || 0));
    const oldCurrentRaw = Number(existing.current);
    const oldCurrent = Number.isFinite(oldCurrentRaw) ? clampInt(oldCurrentRaw, 0, oldTotal, oldTotal) : oldTotal;
    const removed = Math.max(0, Math.floor(Number(ammo.amount ?? 0) || 0));
    const total = Math.max(0, oldTotal - removed);
    const current = total > 0 ? clampInt(oldCurrent - removed, 0, total, total) : 0;

    if (total <= 0) {
      await this.actor.update({ [`system.ammoBins.-=${ammo.key}`]: null });
      return;
    }

    await this.actor.update({
      [`system.ammoBins.${ammo.key}.name`]: String(existing.name ?? ammo.name ?? ammo.key),
      [`system.ammoBins.${ammo.key}.total`]: total,
      [`system.ammoBins.${ammo.key}.current`]: current
    });
  }
}
