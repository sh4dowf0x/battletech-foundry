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

    const items = this.actor.items.contents.filter(i => i?.type === "mechWeapon" || i?.type === "weapon");
    const vehicleWeapons = items
      .map(i => ({
        _id: i.id,
        name: i.name ?? "",
        sort: Number(i.sort ?? 0) || 0,
        system: i.system ?? {},
        itemUuid: i.uuid ?? ""
      }))
      .sort((a, b) => (Number(a.sort ?? 0) - Number(b.sort ?? 0)) || String(a.name ?? "").localeCompare(String(b.name ?? ""), undefined, { sensitivity: "base" }));

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

    root.querySelectorAll(".header-action-btn[data-header-action]").forEach((button) => {
      if (button.dataset.atowBound === "1") return;
      button.dataset.atowBound = "1";
      button.addEventListener("click", (event) => this._onHeaderActionClick(event));
      if (button.getAttribute("draggable") === "true") {
        button.addEventListener("dragstart", (event) => this._onHeaderActionDragStart(event));
      }
    });
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

    root.querySelectorAll("[data-drop-zone='combat-vehicle-weapons']").forEach((zone) => {
      if (zone.dataset.atowDropBound === "1") return;
      zone.dataset.atowDropBound = "1";
      zone.addEventListener("dragover", (event) => event.preventDefault());
      zone.addEventListener("drop", (event) => this._onWeaponDrop(event));
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
    const row = event.currentTarget.closest("[data-item-id]");
    const itemId = row?.dataset?.itemId;
    if (!itemId) return;
    await this.actor.deleteEmbeddedDocuments("Item", [itemId]);
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
  }

  async _onWeaponDrop(event) {
    event.preventDefault();
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
}
