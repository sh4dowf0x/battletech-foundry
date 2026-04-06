// module/abomination-sheet.js
// Abomination actor sheet for AToW Battletech (gothic variant).

import { ATOWCharacterSheet } from "./character-sheet.js";
import { promptAndRollWeaponAttack } from "./abomination-attack.js";

const SYSTEM_ID = "atow-battletech";
const TEMPLATE = `systems/${SYSTEM_ID}/templates/abomination-sheet.hbs`;
const SHEET_CSS = `systems/${SYSTEM_ID}/styles/abomination-sheet.css`;
const SHEET_CSS_ID = "atow-abomination-sheet-css";

const TRACK_MAX = 95;
const TRACK_PIPS_PER_ROW = 19;
const TRACK_MAX_ROWS = 5;
const TRACK_COUNT_DEFAULT = 3;

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function buildPipRows(max, value, perRow = TRACK_PIPS_PER_ROW, maxRows = TRACK_MAX_ROWS) {
  const m = Math.max(0, Number(max ?? 0) || 0);
  const vRaw = Number(value ?? 0) || 0;
  const v = Math.min(m, Math.max(0, vRaw));

  const pips = Array.from({ length: m }, (_, i) => {
    const n = i + 1;
    return { value: n, filled: n <= v };
  });

  const rows = [];
  const limit = Math.min(maxRows, Math.ceil(pips.length / perRow));
  for (let i = 0; i < limit; i++) {
    rows.push(pips.slice(i * perRow, (i + 1) * perRow));
  }

  return rows;
}

function buildAbominationMechWeapons(actor) {
  const items = actor?.items?.contents ?? [];
  const weapons = items
    .filter(i => i?.type === "mechWeapon" || i?.type === "weapon")
    .map(i => ({
      _id: i.id,
      name: i.name ?? "",
      sort: Number(i.sort ?? 0) || 0,
      system: i.system ?? {},
      itemUuid: i.uuid ?? ""
    }))
    .sort((a, b) => (Number(a.sort ?? 0) - Number(b.sort ?? 0)) || String(a.name ?? "").localeCompare(String(b.name ?? ""), undefined, { sensitivity: "base" }));

  const meleeDamage = Number(actor?.system?.abomination?.physical?.melee ?? 0) || 0;
  if (meleeDamage > 0) {
    weapons.push({
      _id: "abom-melee",
      name: "Melee",
      sort: 9999,
      system: {
        loc: "",
        heat: 0,
        damage: meleeDamage,
        range: { min: 0, short: 1, medium: 0, long: 0 },
        abominationMelee: true
      },
      itemUuid: ""
    });
  }

  return weapons;
}

export class ATOWAbominationSheet extends ATOWCharacterSheet {
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
      classes: ["atow", "sheet", "actor", "abomination", "atow-abomination"],
      position: { width: 900, height: 520 },
      window: { resizable: true }
    },
    { inplace: false }
  );

  static PARTS = {
    form: { template: TEMPLATE }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const abom = this.actor.system?.abomination ?? {};
    const trackCount = clampInt(abom.trackCount, 1, 6, TRACK_COUNT_DEFAULT);
    const trackPips = clampInt(abom.trackPips, 1, TRACK_MAX, TRACK_MAX);

    const tracks = Array.from({ length: trackCount }, (_, idx) => {
      const key = `track${idx + 1}`;
      const value = abom[key] ?? 0;
      return {
        key,
        label: String(idx + 1),
        value,
        rows: buildPipRows(trackPips, value)
      };
    });

    const deadCount = tracks.reduce((sum, t) => sum + (Number(t.value ?? 0) >= trackPips ? 1 : 0), 0);
    const aliveCount = Math.max(0, trackCount - deadCount);

    this._abominationAliveCount = aliveCount;

    context.abominationTracks = tracks;
    context.abominationTrackConfig = { trackCount, trackPips };
    context.abominationAliveCount = aliveCount;
    context.abominationMechWeapons = buildAbominationMechWeapons(this.actor);

    return context;
  }

  _onRender(context, options) {
    super._onRender(context, options);
    ATOWAbominationSheet._ensureSheetStyles();

    const isDead = this._abominationAliveCount === 0;
    const hasDeadStatus = Boolean(this.actor?.statuses?.has?.("dead"));
    if (isDead !== hasDeadStatus) {
      this.actor.toggleStatusEffect("dead", { active: isDead, overlay: true }).catch(() => {});
    }

    const root = this.element;
    const dropZone = root?.querySelector?.(".abom-weapons-drop");
    if (dropZone && !this._abomDropBound) {
      this._abomDropBound = true;
      dropZone.addEventListener("dragover", (ev) => ev.preventDefault());
    }

    if (!this._abomGunnerySynced) {
      this._abomGunnerySynced = true;
      const pilotGunnery = this.actor.system?.pilot?.gunnery;
      const legacy = this.actor.system?.abomination?.gunnerySkill;
      if ((pilotGunnery === null || pilotGunnery === undefined) && legacy !== undefined) {
        this.actor.update({ "system.pilot.gunnery": legacy }).catch(() => {});
      }
    }
  }

  async _handleClick(event) {
    const target = event?.target;
    const attackBtn = target?.closest?.(".abom-we-attack");
    if (attackBtn) {
      event.preventDefault();
      const row = attackBtn.closest(".abom-we-row");
      const itemId = row?.dataset?.itemId;
      let item = itemId ? this.actor.items.get(itemId) : null;
      if (!item && itemId === "abom-melee") {
        const meleeDamage = Number(this.actor.system?.abomination?.physical?.melee ?? 0) || 0;
        if (meleeDamage <= 0) return;
        item = {
          id: "abom-melee",
          name: "Melee",
          type: "weapon",
          system: {
            loc: "",
            heat: 0,
            damage: meleeDamage,
            range: { min: 0, short: 1, medium: 0, long: 0 },
            abominationMelee: true
          }
        };
      }
      if (!item || (item.type !== "mechWeapon" && item.type !== "weapon")) return;
      await promptAndRollWeaponAttack(this.actor, item, { defaultSide: "front" });
      return;
    }

    const pip = target?.closest?.(".abom-pip");
    if (pip) {
      event.preventDefault();

      const track = String(pip.dataset.track ?? "").trim();
      const value = Number(pip.dataset.value ?? 0) || 0;
      if (!track || !value) return;

      const path = `system.abomination.${track}`;
      const current = Number(foundry.utils.getProperty(this.actor, path) ?? 0) || 0;
      const next = (current == value) ? Math.max(0, value - 1) : value;
      await this.actor.update({ [path]: next });
      return;
    }

    return super._handleClick(event);
  }

  async _onDrop(event) {
    const zone = event?.target?.closest?.("[data-drop-zone]")?.dataset?.dropZone;
    if (zone !== "abomination-weapons") return super._onDrop(event);
    if (!this.isEditable) return;

    const data = (() => {
      try {
        return TextEditor.getDragEventData(event);
      } catch (e) {
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
