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
const MOB_HOBBLE_MODIFIERS = [
  { creatures: "4-6", mob: "+1", hobble: "+0" },
  { creatures: "3", mob: "+2", hobble: "+1" },
  { creatures: "2", mob: "+3", hobble: "+3" },
  { creatures: "1", mob: "+3", hobble: "+5" }
];
const MOB_HIT_TABLE = [
  { roll: "2", biped: "Head", quad: "Head" },
  { roll: "3", biped: "Rear Center Torso", quad: "Front Right Torso" },
  { roll: "4", biped: "Rear Right Torso", quad: "Rear Center Torso" },
  { roll: "5", biped: "Front Right Torso", quad: "Rear Right Torso" },
  { roll: "6", biped: "Right Arm", quad: "Front Right Torso" },
  { roll: "7", biped: "Front Center Torso", quad: "Front Center Torso" },
  { roll: "8", biped: "Left Arm", quad: "Front Left Torso" },
  { roll: "9", biped: "Front Left Torso", quad: "Rear Left Torso" },
  { roll: "10", biped: "Rear Left Torso", quad: "Rear Center Torso" },
  { roll: "11", biped: "Rear Center Torso", quad: "Front Left Torso" },
  { roll: "12", biped: "Head", quad: "Head" }
];
const HOBBLE_HIT_TABLE = [
  { roll: "1", biped: "Right Leg", quad: "Right Front Leg" },
  { roll: "2", biped: "Right Leg", quad: "Right Front Leg" },
  { roll: "3", biped: "Right Leg", quad: "Right Rear Leg" },
  { roll: "4", biped: "Left Leg", quad: "Left Rear Leg" },
  { roll: "5", biped: "Left Leg", quad: "Left Front Leg" },
  { roll: "6", biped: "Left Leg", quad: "Left Front Leg" }
];

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

  const mobDamage = Number(actor?.system?.abomination?.physical?.mob ?? 0) || 0;
  if (mobDamage > 0) {
    weapons.push({
      _id: "abom-mob",
      name: "Mob",
      sort: 9997,
      system: {
        loc: "Spec",
        heat: "—",
        damage: mobDamage,
        range: { min: 0, short: 1, medium: 0, long: 0 },
        displayRange: "Adj",
        abominationSpecialAction: "mob"
      },
      itemUuid: ""
    });
  }

  const hobbleDamage = Number(actor?.system?.abomination?.physical?.hobble ?? 0) || 0;
  if (hobbleDamage > 0) {
    weapons.push({
      _id: "abom-hobble",
      name: "Hobble",
      sort: 9998,
      system: {
        loc: "Spec",
        heat: "—",
        damage: hobbleDamage,
        range: { min: 0, short: 1, medium: 0, long: 0 },
        displayRange: "Adj",
        abominationSpecialAction: "hobble"
      },
      itemUuid: ""
    });
  }

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
    context.hideThirdColumn = this._hideThirdColumn === true;
    context.mobHobbleModifiers = MOB_HOBBLE_MODIFIERS;
    context.mobHitTable = MOB_HIT_TABLE;
    context.hobbleHitTable = HOBBLE_HIT_TABLE;
    context.abominationHeaderMeta = [
      String(abom.sizeClass ?? "").trim(),
      `${aliveCount}/${trackCount} Alive`,
      (abom.groundMp != null && abom.groundMp !== "") ? `${Number(abom.groundMp) || 0} Ground MP` : ""
    ].filter(Boolean);

    return context;
  }

  _onRender(context, options) {
    super._onRender(context, options);
    ATOWAbominationSheet._ensureSheetStyles();

    const root = this.element;
    if (root) this._injectWindowColumnToggle(root);

    const isDead = this._abominationAliveCount === 0;
    const hasDeadStatus = Boolean(this.actor?.statuses?.has?.("dead"));
    if (isDead !== hasDeadStatus) {
      this.actor.toggleStatusEffect("dead", { active: isDead, overlay: true }).catch(() => {});
    }

    const dropZone = root?.querySelector?.(".abom-weapons-drop");
    if (dropZone && !this._abomDropBound) {
      this._abomDropBound = true;
      dropZone.addEventListener("dragover", (ev) => ev.preventDefault());
    }

    if (this._abomContextRoot && this._abomDelegatedContextMenu) {
      this._abomContextRoot.removeEventListener("contextmenu", this._abomDelegatedContextMenu);
    }
    this._abomContextRoot = root;
    this._abomDelegatedContextMenu = this._handleContextMenu.bind(this);
    root?.addEventListener?.("contextmenu", this._abomDelegatedContextMenu);

    root?.querySelectorAll?.(".abom-we-row[draggable='true']")?.forEach?.((row) => {
      if (row.dataset.atowDragBound === "1") return;
      row.dataset.atowDragBound = "1";
      row.addEventListener("dragstart", (event) => this._onWeaponDragStart(event));
    });

    if (!this._abomGunnerySynced) {
      this._abomGunnerySynced = true;
      const pilotGunnery = this.actor.system?.pilot?.gunnery;
      const legacy = this.actor.system?.abomination?.gunnerySkill;
      if ((pilotGunnery === null || pilotGunnery === undefined) && legacy !== undefined) {
        this.actor.update({ "system.pilot.gunnery": legacy }).catch(() => {});
      }
    }
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

  async _handleClick(event) {
    const target = event?.target;
    const row = target?.closest?.(".abom-we-row");
    if (row && !target?.closest?.(".item-delete")) {
      event.preventDefault();
      const itemId = row?.dataset?.itemId;
      if (itemId === "abom-mob" || itemId === "abom-hobble") {
        await this._showMobHobbleReference(itemId === "abom-mob" ? "mob" : "hobble");
        return;
      }
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
      await promptAndRollWeaponAttack(this.actor, item, {
        defaultSide: "front",
        weaponFireKey: itemId || item?.uuid || item?.id || item?.name
      });
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

  async _handleChange(event) {
    const el = /** @type {HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement} */ (event.target);
    if (!el) return super._handleChange?.(event);

    const name = String(el.name ?? "").trim();
    const explicitNumericFields = new Set([
      "system.abomination.groundMp",
      "system.abomination.jumpMp",
      "system.abomination.vtolMp"
    ]);

    if (explicitNumericFields.has(name)) {
      const value = Number(el.value ?? 0) || 0;
      await this.actor.update({ [name]: value });
      return;
    }

    return super._handleChange?.(event);
  }

  async _handleContextMenu(event) {
    const target = event?.target;
    const row = target?.closest?.(".abom-we-row");
    if (row && !target?.closest?.(".item-delete")) {
      event.preventDefault();
      const itemId = row?.dataset?.itemId;
      if (itemId === "abom-mob" || itemId === "abom-hobble") {
        await this._showMobHobbleReference(itemId === "abom-mob" ? "mob" : "hobble");
        return;
      }
      if (!itemId || itemId === "abom-melee") return;
      const item = this.actor.items.get(itemId);
      return item?.sheet?.render(true);
    }
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
      console.warn("ATOWAbominationSheet | Weapon drag start failed", err);
    }
  }

  async _showMobHobbleReference(kind = "mob") {
    const action = String(kind ?? "mob").toLowerCase() === "hobble" ? "hobble" : "mob";
    const hitTitle = action === "mob" ? "Mob Attack Hit Location" : "Hobble Attack Hit Location";
    const hitRollLabel = action === "mob" ? "2D6" : "1D6";
    const hitRows = (action === "mob" ? MOB_HIT_TABLE : HOBBLE_HIT_TABLE)
      .map((row) => `
        <tr>
          <td>${row.roll}</td>
          <td>${row.biped}</td>
          <td>${row.quad}</td>
        </tr>`)
      .join("");

    const modRows = MOB_HOBBLE_MODIFIERS
      .map((row) => `
        <tr>
          <td>${row.creatures}</td>
          <td>${row.mob}</td>
          <td>${row.hobble}</td>
        </tr>`)
      .join("");

    const content = `
      <div class="abom-ref-dialog">
        <p><b>${action === "mob" ? "Mob" : "Hobble"}</b> automation is not fully implemented yet. Use this reference while resolving the attack manually.</p>
        <table class="abom-ref-table">
          <thead>
            <tr>
              <th>Creatures</th>
              <th>Mob</th>
              <th>Hobble</th>
            </tr>
          </thead>
          <tbody>${modRows}</tbody>
        </table>
        <table class="abom-ref-table" style="margin-top: 12px;">
          <thead>
            <tr>
              <th>Roll (${hitRollLabel})</th>
              <th>${hitTitle}<br/>Bipedal</th>
              <th>${hitTitle}<br/>Four-Legged</th>
            </tr>
          </thead>
          <tbody>${hitRows}</tbody>
        </table>
      </div>`;

    return new Dialog({
      title: `${action === "mob" ? "Mob" : "Hobble"} Reference`,
      content,
      buttons: {
        ok: { label: "Close" }
      },
      default: "ok"
    }).render(true);
  }
}
