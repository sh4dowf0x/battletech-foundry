// module/wheeledvehicle-sheet.js
// Wheeled vehicle actor sheet for AToW Battletech.

import { promptAndRollWeaponAttack } from "./mech-attack.js";

const SYSTEM_ID = "atow-battletech";
const TEMPLATE = `systems/${SYSTEM_ID}/templates/wheeledvehicle-sheet.hbs`;
const SHEET_CSS = `systems/${SYSTEM_ID}/styles/wheeledvehicle-sheet.css`;
const SHEET_CSS_ID = "atow-wheeledvehicle-sheet-css";

const ARMOR_KEYS = [
  { key: "front", label: "Front" },
  { key: "left", label: "Left" },
  { key: "right", label: "Right" },
  { key: "rear", label: "Rear" },
  { key: "turret", label: "Turret" }
];

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

export class ATOWWheeledVehicleSheet extends ActorSheet {
  static _ensureSheetStyles() {
    if (document.getElementById(SHEET_CSS_ID)) return;
    const link = document.createElement("link");
    link.id = SHEET_CSS_ID;
    link.rel = "stylesheet";
    link.type = "text/css";
    link.href = SHEET_CSS;
    document.head.appendChild(link);
  }

  static get defaultOptions() {
    const opts = super.defaultOptions ?? {};
    return {
      ...opts,
      classes: [...(opts.classes ?? []), "atow", "sheet", "actor", "wheeledvehicle", "atow-wheeledvehicle"],
      template: TEMPLATE,
      width: 1080,
      height: 720,
      submitOnChange: true,
      submitOnClose: true
    };
  }

  async getData(options) {
    const context = await super.getData(options);
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

    const items = (this.actor.items ?? []).filter(i => i?.type === "mechWeapon" || i?.type === "weapon");
    const weapons = items
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

    context.actor = this.actor;
    context.system = system;
    context.tonnageOptions = TONNAGE_OPTIONS.reduce((acc, t) => {
      acc[String(t)] = String(t);
      return acc;
    }, {});
    context.vehicleTonnage = tonnage;
    context.armor = armor;
    context.structure = structure;
    context.vehicleWeapons = weapons;
    context.crewTracks = {
      commander: buildTrack(CREW_HIT_MAX, crew.commanderHit),
      driver: buildTrack(CREW_HIT_MAX, crew.driverHit)
    };
    context.critTracks = {
      sensor: buildTrack(SENSOR_HIT_MAX, crit.sensorHits),
      motive: buildTrack(MOTIVE_HIT_MAX, crit.motiveHits)
    };

    return context;
  }

  activateListeners(html) {
    super.activateListeners(html);
    ATOWWheeledVehicleSheet._ensureSheetStyles();

    html.find(".item-delete").on("click", (event) => this._onItemDelete(event));
    html.find(".wv-we-row").on("click", (event) => this._onWeaponRowClick(event));
    html.find(".wv-we-row").on("contextmenu", (event) => this._onWeaponRowContext(event));
    html.find(".wv-armor-pip").on("click", (event) => this._onArmorPip(event));
    html.find(".wv-structure-pip").on("click", (event) => this._onStructurePip(event));
    html.find(".wv-track-box").on("click", (event) => this._onTrackBox(event));

    const dropZone = html.find(".wv-drop-zone");
    if (dropZone.length) {
      dropZone.on("dragover", (ev) => ev.preventDefault());
    }
  }

  async _onItemDelete(event) {
    event.preventDefault();
    const row = event.currentTarget.closest("[data-item-id]");
    const itemId = row?.dataset?.itemId;
    if (!itemId) return;
    await this.actor.deleteEmbeddedDocuments("Item", [itemId]);
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
    const row = event.currentTarget.closest(".wv-we-row");
    const itemId = row?.dataset?.itemId;
    if (!itemId) return;
    const weapon = this.actor.items.get(itemId);
    if (!weapon) return;
    if (!["mechWeapon", "weapon"].includes(weapon.type)) return;
    await promptAndRollWeaponAttack(this.actor, weapon, { defaultSide: "front" });
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

  async _onDrop(event) {
    const zone = event?.target?.closest?.("[data-drop-zone]")?.dataset?.dropZone;
    if (zone !== "wheeled-weapons") return super._onDrop(event);
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
    this.render();
  }
}
