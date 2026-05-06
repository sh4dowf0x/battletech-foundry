// module/dropship-sheet.js
// Spheroid DropShip actor sheet for AToW Battletech.

import { promptAndRollWeaponAttack } from "./mech-attack.js";

const SYSTEM_ID = "atow-battletech";
const TEMPLATE = `systems/${SYSTEM_ID}/templates/dropship-sheet.hbs`;
const SHEET_CSS = `systems/${SYSTEM_ID}/styles/dropship-sheet.css`;
const SHEET_CSS_ID = "atow-dropship-sheet-css";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;

const ARMOR_LOCS = [
  { key: "nose", label: "Nose" },
  { key: "left", label: "Left Side" },
  { key: "right", label: "Right Side" },
  { key: "aft", label: "Aft" }
];

const CRIT_TRACKS = [
  { key: "avionics", label: "Avionics", values: [1, 2, 5] },
  { key: "fcs", label: "FCS", values: [2, 4, "D"] },
  { key: "sensors", label: "Sensors", values: [1, 2, 5] },
  { key: "leftThrusters", label: "Left Thrusters", values: [1, 2, 3, "D"] },
  { key: "rightThrusters", label: "Right Thrusters", values: [1, 2, 3, "D"] },
  { key: "engine", label: "Engine", values: [-1, -2, -3, -4, -5, "D"] },
  { key: "landingGear", label: "Landing Gear", values: [5] },
  { key: "lifeSupport", label: "Life Support", values: [2] }
];

const BOOLEAN_CRITS = [
  { key: "kfBoomDestroyed", label: "K-F Boom" },
  { key: "dockingCollarDestroyed", label: "Docking Collar" }
];

function clampInt(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function buildPips(max, dmg) {
  const m = Math.max(0, Math.floor(Number(max ?? 0) || 0));
  const v = clampInt(dmg, 0, m, 0);
  return Array.from({ length: m }, (_, i) => ({ n: i + 1, filled: i < v }));
}

function buildTrack(track, value) {
  const raw = Number(value ?? 0) || 0;
  return {
    ...track,
    boxes: track.values.map((label, index) => {
      const n = index + 1;
      return { n, label, filled: raw >= n };
    })
  };
}

function velocityTurn(turn, data = {}) {
  return {
    n: turn,
    thrust: data.thrust ?? "",
    velocity: data.velocity ?? "",
    effectiveVelocity: data.effectiveVelocity ?? "",
    altitude: data.altitude ?? ""
  };
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
  return input.value ?? "";
}

export class ATOWDropshipSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
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
      classes: ["atow", "sheet", "actor", "dropship", "battletech"],
      position: { width: 1380, height: 900 },
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

    const armor = {};
    for (const loc of ARMOR_LOCS) {
      const data = system?.armor?.[loc.key] ?? {};
      const max = Number(data.max ?? 0) || 0;
      const dmg = Number(data.dmg ?? 0) || 0;
      armor[loc.key] = {
        ...loc,
        max,
        dmg,
        threshold: Number(data.threshold ?? 0) || 0,
        pips: buildPips(max, dmg)
      };
    }

    const siMax = Number(system?.structure?.si?.max ?? 0) || 0;
    const siDmg = Number(system?.structure?.si?.dmg ?? 0) || 0;
    const weapons = this.actor.items.contents
      .filter(i => i?.type === "mechWeapon" || i?.type === "weapon")
      .map(i => ({
        _id: i.id,
        name: i.name ?? "",
        sort: Number(i.sort ?? 0) || 0,
        system: i.system ?? {},
        itemUuid: i.uuid ?? ""
      }))
      .sort((a, b) => (a.sort - b.sort) || String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" }));

    const turns = system?.velocity?.turns ?? {};

    context.actor = this.actor;
    context.system = system;
    context.armorLocs = ARMOR_LOCS.map(loc => armor[loc.key]);
    context.armor = armor;
    context.si = {
      max: siMax,
      dmg: siDmg,
      pips: buildPips(siMax, siDmg)
    };
    context.weapons = weapons;
    context.critTracks = CRIT_TRACKS.map(track => buildTrack(track, system?.crit?.[track.key]));
    context.booleanCrits = BOOLEAN_CRITS.map(crit => ({
      ...crit,
      checked: Boolean(system?.crit?.[crit.key])
    }));
    context.velocityTop = Array.from({ length: 10 }, (_, i) => velocityTurn(i + 1, turns?.[String(i + 1)]));
    context.velocityBottom = Array.from({ length: 10 }, (_, i) => velocityTurn(i + 11, turns?.[String(i + 11)]));
    context.heatTotal = (Number(system?.heat?.doubleSinks ?? 0) || 0) || (Number(system?.heat?.sinks ?? 0) || 0);

    return context;
  }

  _onRender(context, options) {
    super._onRender(context, options);
    ATOWDropshipSheet._ensureSheetStyles();

    const root = this.element;
    if (!root) return;

    const form = root.matches?.("form.dropship-sheet") ? root : root.querySelector?.("form.dropship-sheet");
    if (form && form.dataset.atowFormBound !== "1") {
      form.dataset.atowFormBound = "1";
      form.addEventListener("change", (event) => this._onFormValueChange(event));
    }

    root.querySelectorAll(".ds-armor-pip").forEach((el) => {
      if (el.dataset.atowBound === "1") return;
      el.dataset.atowBound = "1";
      el.addEventListener("click", (event) => this._onPipClick(event, "armor"));
    });

    root.querySelectorAll(".ds-si-pip").forEach((el) => {
      if (el.dataset.atowBound === "1") return;
      el.dataset.atowBound = "1";
      el.addEventListener("click", (event) => this._onPipClick(event, "structure"));
    });

    root.querySelectorAll(".ds-crit-box").forEach((el) => {
      if (el.dataset.atowBound === "1") return;
      el.dataset.atowBound = "1";
      el.addEventListener("click", (event) => this._onCritTrackClick(event));
    });

    root.querySelectorAll("input[type='checkbox'][name^='system.crit.']").forEach((el) => {
      if (el.dataset.atowBound === "1") return;
      el.dataset.atowBound = "1";
      el.addEventListener("change", (event) => this._onBooleanCritChange(event));
    });

    root.querySelectorAll(".ds-weapon-row[data-item-id]").forEach((row) => {
      if (row.dataset.atowBound === "1") return;
      row.dataset.atowBound = "1";
      row.addEventListener("click", (event) => this._onWeaponClick(event));
      row.addEventListener("contextmenu", (event) => this._onWeaponContext(event));
      row.addEventListener("dragstart", (event) => this._onWeaponDragStart(event));
    });

    const dragHandle = root.querySelector?.("[data-dropship-drag-handle]");
    if (dragHandle && dragHandle.dataset.atowBound !== "1") {
      dragHandle.dataset.atowBound = "1";
      dragHandle.addEventListener("dragstart", (event) => this._onActorDragStart(event));
    }

    root.querySelectorAll(".item-delete").forEach((el) => {
      if (el.dataset.atowBound === "1") return;
      el.dataset.atowBound = "1";
      el.addEventListener("click", (event) => this._onItemDelete(event));
    });

    root.querySelectorAll("[data-drop-zone='dropship-weapons']").forEach((zone) => {
      if (zone.dataset.atowDropBound === "1") return;
      zone.dataset.atowDropBound = "1";
      zone.addEventListener("dragover", (event) => event.preventDefault());
      zone.addEventListener("drop", (event) => this._onWeaponDrop(event));
    });
  }

  async _onPipClick(event, kind) {
    event.preventDefault();
    const pip = event.currentTarget;
    const loc = pip?.dataset?.loc;
    const value = Number(pip?.dataset?.pip ?? pip?.dataset?.value ?? 0) || 0;
    if (!loc || value < 1) return;

    const path = kind === "armor"
      ? `system.armor.${loc}.dmg`
      : `system.structure.si.dmg`;
    const current = kind === "armor"
      ? Number(this.actor.system?.armor?.[loc]?.dmg ?? 0) || 0
      : Number(this.actor.system?.structure?.si?.dmg ?? 0) || 0;
    await this.actor.update({ [path]: current === value ? value - 1 : value });
    this.render(false);
  }

  async _onCritTrackClick(event) {
    event.preventDefault();
    const box = event.currentTarget;
    const key = box?.dataset?.track;
    const value = Number(box?.dataset?.value ?? 0) || 0;
    if (!key || value < 1) return;

    const path = `system.crit.${key}`;
    const current = Number(this.actor.system?.crit?.[key] ?? 0) || 0;
    await this.actor.update({ [path]: current === value ? value - 1 : value });
    this.render(false);
  }

  async _onBooleanCritChange(event) {
    const input = event.currentTarget;
    const path = String(input?.name ?? "").trim();
    if (!path) return;
    await this.actor.update({ [path]: Boolean(input.checked) });
    this.render(false);
  }

  async _onFormValueChange(event) {
    const input = event.target;
    const name = String(input?.name ?? "").trim();
    if (!name || input.closest?.(".ds-crit-list")) return;

    const value = parseFormInputValue(input);
    await this.actor.update({ [name]: value });

    if (
      /^system\.armor\.[^.]+\.max$/.test(name) ||
      name === "system.structure.si.max"
    ) {
      this.render(false);
    }
  }

  async _onWeaponClick(event) {
    if (event.target?.closest?.(".item-delete")) return;
    const row = event.currentTarget;
    const item = this.actor.items.get(row?.dataset?.itemId);
    if (!item) return;
    await promptAndRollWeaponAttack(this.actor, item, { weaponFireKey: row?.dataset?.itemUuid || item.uuid || `dropship:${item.id}` });
  }

  async _onWeaponContext(event) {
    event.preventDefault();
    const item = this.actor.items.get(event.currentTarget?.dataset?.itemId);
    item?.sheet?.render?.(true);
  }

  async _onItemDelete(event) {
    event.preventDefault();
    event.stopPropagation();
    const itemId = event.currentTarget.closest("[data-item-id]")?.dataset?.itemId;
    if (!itemId) return;
    await this.actor.deleteEmbeddedDocuments("Item", [itemId]);
  }

  async _onWeaponDrop(event) {
    event.preventDefault();
    if (!this.isEditable) return;

    const data = (() => {
      try {
        return TextEditor.getDragEventData(event);
      } catch (_) {
        const raw = event.dataTransfer?.getData("application/json") || event.dataTransfer?.getData("text/json");
        if (!raw) return null;
        try { return JSON.parse(raw); } catch (err) { return null; }
      }
    })();

    if (!data || data.type !== "Item") return;
    if (typeof data.uuid === "string" && this.actor?.uuid && data.uuid.startsWith(`${this.actor.uuid}.Item.`)) return;

    const doc = data.uuid ? await fromUuid(data.uuid).catch(() => null) : (data.data ? new Item(data.data) : null);
    if (!doc) return;

    const allowed = new Set(["mechWeapon", "weapon"]);
    if (!allowed.has(doc.type)) {
      ui.notifications?.warn?.("Drop a mech weapon here.");
      return;
    }

    const source = doc.toObject();
    delete source._id;
    if (source.type === "weapon") source.type = "mechWeapon";
    await this.actor.createEmbeddedDocuments("Item", [source]);
    this.render(false);
  }

  _onWeaponDragStart(event) {
    const item = this.actor.items.get(event.currentTarget?.dataset?.itemId);
    if (!item) return;
    event.dataTransfer?.setData("application/json", JSON.stringify({ type: "Item", uuid: item.uuid }));
  }

  _onActorDragStart(event) {
    if (!this.actor?.uuid) return;
    event.dataTransfer?.setData("application/json", JSON.stringify({ type: "Actor", uuid: this.actor.uuid }));
    event.dataTransfer?.setData("text/plain", this.actor.name ?? "DropShip");
  }
}
