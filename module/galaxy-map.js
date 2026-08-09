const SYSTEM_ID = "atow-battletech";
const GALAXY_FLAG = "galaxyMap";
const OVERLAY_NAME = "atow-galaxy-map-overlay";
const SYSTEM_NOTE_FLAG = "galaxySystem";
const SYSTEM_ICON = `systems/${SYSTEM_ID}/assets/galaxy-system.svg`;
const CAPITAL_SYSTEM_ICON = `systems/${SYSTEM_ID}/assets/galaxy-capital-system.svg`;
const GRAND_CAPITAL_SYSTEM_ICON = `systems/${SYSTEM_ID}/assets/galaxy-grand-capital-system.svg`;
const SYSTEM_ICON_SIZE = 70;
const CAPITAL_SYSTEM_ICON_SIZE = 80;
const GRAND_CAPITAL_SYSTEM_ICON_SIZE = 96;
const SYSTEM_FONT_SIZE = 45;
const CAPITAL_SYSTEM_FONT_SIZE = 45;
const GRAND_CAPITAL_SYSTEM_FONT_SIZE = 45;
const SYSTEM_LABEL_GAP = -8;

const GALAXY_SYSTEM_TYPES = Object.freeze({
  normal: { label: "Normal System", icon: SYSTEM_ICON, iconSize: SYSTEM_ICON_SIZE, fontSize: SYSTEM_FONT_SIZE },
  capital: { label: "Capital System", icon: CAPITAL_SYSTEM_ICON, iconSize: CAPITAL_SYSTEM_ICON_SIZE, fontSize: CAPITAL_SYSTEM_FONT_SIZE },
  grandCapital: { label: "Grand Capital System", icon: GRAND_CAPITAL_SYSTEM_ICON, iconSize: GRAND_CAPITAL_SYSTEM_ICON_SIZE, fontSize: GRAND_CAPITAL_SYSTEM_FONT_SIZE }
});

export const GALAXY_FACTIONS = Object.freeze({
  steiner: { label: "Steiner", color: 0x2878d0, line: 0x75b8ff, icon: "atow-galaxy-steiner" },
  kurita: { label: "Kurita", color: 0xc7353d, line: 0xff858b, icon: "atow-galaxy-kurita" },
  davion: { label: "Davion", color: 0xe1bd25, line: 0xffe77a, icon: "atow-galaxy-davion" },
  liao: { label: "Liao", color: 0x3b9b54, line: 0x8cdda0, icon: "atow-galaxy-liao" },
  marik: { label: "Marik", color: 0x8250b5, line: 0xc69aee, icon: "atow-galaxy-marik" },
  terran: { label: "Terran", color: 0xb9bec6, line: 0xf1f3f6, icon: "atow-galaxy-terran" },
  pirate: { label: "Pirate", color: 0x484d55, line: 0x969da8, icon: "atow-galaxy-pirate" }
});

const DEFAULT_REGION_FONT_SIZE = 80;
const MIN_REGION_FONT_SIZE = 36;
const MAX_REGION_FONT_SIZE = 220;

const state = {
  enabled: false,
  faction: "steiner",
  isPainting: false,
  paintedThisDrag: new Set(),
  originalHexes: null,
  workingHexes: null,
  systemDialogOpen: false,
  overlay: null,
  controlsRenderQueued: false,
  redrawQueued: false
};

export function getGalaxyMapData(scene = canvas?.scene ?? game?.scenes?.active) {
  const raw = scene?.getFlag?.(SYSTEM_ID, GALAXY_FLAG) ?? scene?.flags?.[SYSTEM_ID]?.[GALAXY_FLAG] ?? {};
  return foundry.utils.deepClone(raw ?? {});
}

function normalizeHexColor(value, fallback = "#ffffff") {
  const color = String(value ?? "").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : fallback;
}

function colorNumber(value, fallback = 0xffffff) {
  const color = normalizeHexColor(value, null);
  return color ? Number.parseInt(color.slice(1), 16) : fallback;
}

function lighterColor(value) {
  const base = colorNumber(value, 0xffffff);
  const red = Math.min(255, ((base >> 16) & 0xff) + 72);
  const green = Math.min(255, ((base >> 8) & 0xff) + 72);
  const blue = Math.min(255, (base & 0xff) + 72);
  return (red << 16) | (green << 8) | blue;
}

export function getGalaxyFactionDefinitions(scene = canvas?.scene ?? game?.scenes?.active) {
  const custom = getGalaxyMapData(scene)?.factions ?? {};
  const definitions = { ...GALAXY_FACTIONS };
  for (const [id, raw] of Object.entries(custom)) {
    const label = String(raw?.label ?? id).trim();
    const color = normalizeHexColor(raw?.color, "#ffffff");
    if (!label) continue;
    definitions[id] = {
      label,
      color: colorNumber(color),
      line: lighterColor(color),
      icon: "atow-galaxy-custom-faction",
      custom: true
    };
  }
  return definitions;
}

function getGalaxyRegions(scene = canvas?.scene ?? game?.scenes?.active) {
  return getGalaxyMapData(scene)?.regions ?? {};
}

function refreshCustomFactionStyles(definitions) {
  if (typeof document === "undefined") return;
  const styleId = "atow-galaxy-custom-faction-colors";
  let style = document.getElementById(styleId);
  if (!style) {
    style = document.createElement("style");
    style.id = styleId;
    document.head.appendChild(style);
  }
  style.textContent = Object.entries(definitions)
    .filter(([, faction]) => faction.custom)
    .map(([id, faction]) => `.atow-galaxy-faction-${id} { color: #${faction.color.toString(16).padStart(6, "0")} !important; }`)
    .join("\n");
}

export function isGalaxyMapScene(scene = canvas?.scene ?? game?.scenes?.active) {
  const enabled = getGalaxyMapData(scene)?.enabled;
  return enabled === true || enabled === 1 || String(enabled).toLowerCase() === "true";
}

export function isGalaxyMapTransparent(scene = canvas?.scene ?? game?.scenes?.active) {
  const transparent = getGalaxyMapData(scene)?.transparent;
  // Existing galaxy maps predate this flag and retain the original
  // semi-transparent presentation by default.
  return !(transparent === false || transparent === 0 || String(transparent).toLowerCase() === "false");
}

export function buildGalaxyHexUpdates(originalHexes = {}, nextHexes = {}) {
  const root = `flags.${SYSTEM_ID}.${GALAXY_FLAG}.hexes`;
  const updates = {};
  const keys = new Set([...Object.keys(originalHexes ?? {}), ...Object.keys(nextHexes ?? {})]);

  for (const key of keys) {
    const hadKey = Object.hasOwn(originalHexes ?? {}, key);
    const hasKey = Object.hasOwn(nextHexes ?? {}, key);
    const previous = hadKey ? originalHexes[key] : undefined;
    const next = hasKey ? nextHexes[key] : undefined;
    if (hadKey === hasKey && previous === next) continue;

    if (!hasKey) updates[`${root}.-=${key}`] = null;
    else updates[`${root}.${key}`] = next;
  }
  return updates;
}

function isHexScene(scene = canvas?.scene ?? game?.scenes?.active) {
  const type = Number(canvas?.grid?.type ?? scene?.grid?.type ?? 0);
  return type >= 2 && type <= 5;
}

function keyFromOffset(offset) {
  if (!offset) return null;
  const i = Number(offset.i ?? offset.x);
  const j = Number(offset.j ?? offset.y);
  if (!Number.isFinite(i) || !Number.isFinite(j)) return null;
  return `${Math.trunc(i)}:${Math.trunc(j)}`;
}

function offsetFromKey(key) {
  const [iRaw, jRaw] = String(key ?? "").split(":");
  const i = Number(iRaw);
  const j = Number(jRaw);
  if (!Number.isFinite(i) || !Number.isFinite(j)) return null;
  return { i, j };
}

function getEventPoint(event) {
  const global = event?.global ?? event?.data?.global ?? null;
  if (global && Number.isFinite(global.x) && Number.isFinite(global.y)) {
    try {
      const local = canvas?.stage?.toLocal?.(global);
      if (local && Number.isFinite(local.x) && Number.isFinite(local.y)) return { x: local.x, y: local.y };
    } catch (_) {}
    return { x: global.x, y: global.y };
  }

  try {
    const point = event?.data?.getLocalPosition?.(canvas.stage);
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) return { x: point.x, y: point.y };
  } catch (_) {}
  return null;
}

function gridOffsetFromPoint(point) {
  if (!point || !canvas?.grid) return null;

  try {
    const offset = canvas.grid.getOffset?.({ x: point.x, y: point.y });
    if (offset && Number.isFinite(offset.i) && Number.isFinite(offset.j)) return { i: offset.i, j: offset.j };
  } catch (_) {}

  try {
    const position = canvas.grid.getGridPositionFromPixels?.(point.x, point.y);
    if (Array.isArray(position) && position.length >= 2) return { i: Number(position[0]), j: Number(position[1]) };
  } catch (_) {}

  try {
    const position = canvas.grid.getGridPosition?.(point.x, point.y);
    if (Array.isArray(position) && position.length >= 2) return { i: Number(position[0]), j: Number(position[1]) };
  } catch (_) {}

  return null;
}

function topLeftFromOffset(offset) {
  if (!offset || !canvas?.grid) return null;
  try {
    const point = canvas.grid.getTopLeftPoint?.(offset);
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) return { x: point.x, y: point.y };
  } catch (_) {}

  try {
    const point = canvas.grid.getTopLeft?.(offset.i, offset.j);
    if (Array.isArray(point) && point.length >= 2) return { x: Number(point[0]), y: Number(point[1]) };
  } catch (_) {}
  return null;
}

function ensureOverlay() {
  if (!canvas?.ready || !canvas?.interface) return null;
  if (state.overlay && !state.overlay.destroyed) return state.overlay;

  const container = new PIXI.Container();
  container.name = OVERLAY_NAME;
  container.eventMode = "none";
  container.interactiveChildren = false;
  container.zIndex = 30;
  canvas.interface.sortableChildren = true;
  canvas.interface.addChild(container);
  state.overlay = container;
  return container;
}

function hexVertices(x, y, width, height, inset = 0) {
  return [
    { x: x + (width * 0.25), y: y + inset },
    { x: x + (width * 0.75), y: y + inset },
    { x: x + width - inset, y: y + (height * 0.5) },
    { x: x + (width * 0.75), y: y + height - inset },
    { x: x + (width * 0.25), y: y + height - inset },
    { x: x + inset, y: y + (height * 0.5) }
  ];
}

function drawHex(graphics, x, y, width, height) {
  graphics.drawPolygon(hexVertices(x, y, width, height, 1).flatMap(point => [point.x, point.y]));
}

export function collectGalaxyFactionBoundaries(hexes = {}, adjacentOffsets = null) {
  const getAdjacent = adjacentOffsets ?? (offset => canvas?.grid?.getAdjacentOffsets?.(offset) ?? []);
  const boundaries = [];

  for (const [key, owner] of Object.entries(hexes ?? {})) {
    if (!owner) continue;
    const offset = offsetFromKey(key);
    if (!offset) continue;

    for (const neighborOffset of getAdjacent(offset) ?? []) {
      const neighborKey = keyFromOffset(neighborOffset);
      if (!neighborKey || key.localeCompare(neighborKey) >= 0) continue;
      const neighborOwner = hexes[neighborKey];
      if (!neighborOwner || neighborOwner === owner) continue;
      boundaries.push({ key, neighborKey, owner, neighborOwner });
    }
  }
  return boundaries;
}

function sharedHexEdge(topLeft, neighborTopLeft, width, height) {
  const vertices = hexVertices(topLeft.x, topLeft.y, width, height);
  const center = { x: topLeft.x + (width / 2), y: topLeft.y + (height / 2) };
  const neighborCenter = { x: neighborTopLeft.x + (width / 2), y: neighborTopLeft.y + (height / 2) };
  const direction = { x: neighborCenter.x - center.x, y: neighborCenter.y - center.y };
  let best = null;

  for (let index = 0; index < vertices.length; index += 1) {
    const start = vertices[index];
    const end = vertices[(index + 1) % vertices.length];
    const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    const radial = { x: midpoint.x - center.x, y: midpoint.y - center.y };
    const radialLength = Math.hypot(radial.x, radial.y) || 1;
    const score = ((radial.x * direction.x) + (radial.y * direction.y)) / radialLength;
    if (!best || score > best.score) best = { start, end, score };
  }
  return best;
}

function drawFactionBorders(overlay, hexes, width, height) {
  const boundaries = collectGalaxyFactionBoundaries(hexes);
  if (!boundaries.length) return;

  const thickness = Math.max(2, Math.min(8, Math.round(Math.min(width, height) * 0.055)));
  const color = 0x14181e;
  const alpha = 0.94;
  const graphics = new PIXI.Graphics();
  const endpoints = [];
  graphics.lineStyle(thickness, color, alpha);

  for (const boundary of boundaries) {
    const topLeft = topLeftFromOffset(offsetFromKey(boundary.key));
    const neighborTopLeft = topLeftFromOffset(offsetFromKey(boundary.neighborKey));
    if (!topLeft || !neighborTopLeft) continue;
    const edge = sharedHexEdge(topLeft, neighborTopLeft, width, height);
    if (!edge) continue;
    graphics.moveTo(edge.start.x, edge.start.y);
    graphics.lineTo(edge.end.x, edge.end.y);
    endpoints.push(edge.start, edge.end);
  }

  // Round over the line endpoints so adjacent border segments meet cleanly at
  // corners and three-faction junctions rather than leaving hairline gaps.
  graphics.beginFill(color, alpha);
  for (const point of endpoints) graphics.drawCircle(point.x, point.y, thickness / 2);
  graphics.endFill();
  overlay.addChild(graphics);
}

function drawGalaxyRegionLabels(overlay, regions) {
  for (const region of Object.values(regions ?? {})) {
    const name = String(region?.name ?? "").trim();
    const x = Number(region?.x);
    const y = Number(region?.y);
    if (!name || !Number.isFinite(x) || !Number.isFinite(y)) continue;

    const fontSize = Math.max(MIN_REGION_FONT_SIZE, Math.min(MAX_REGION_FONT_SIZE,
      Math.round(Number(region?.fontSize ?? DEFAULT_REGION_FONT_SIZE) || DEFAULT_REGION_FONT_SIZE)));
    const text = new PIXI.Text(name, {
      fontFamily: CONFIG?.defaultFontFamily ?? "Arial",
      fontSize,
      fill: normalizeHexColor(region?.color, "#ffffff"),
      stroke: 0x000000,
      strokeThickness: Math.max(4, Math.round(fontSize * 0.09)),
      fontWeight: "700",
      letterSpacing: Math.max(1, Math.round(fontSize * 0.04)),
      align: "center"
    });
    text.anchor.set(0.5);
    text.position.set(x, y);
    text.alpha = 0.82;
    text.eventMode = "none";
    overlay.addChild(text);
  }
}

function queueRedraw() {
  if (state.redrawQueued) return;
  state.redrawQueued = true;
  requestAnimationFrame(() => {
    state.redrawQueued = false;
    drawGalaxyMapOverlay();
  });
}

export function drawGalaxyMapOverlay() {
  const overlay = ensureOverlay();
  if (!overlay) return;
  overlay.removeChildren().forEach(child => child.destroy?.({ children: true }));
  if (!isGalaxyMapScene() || !isHexScene()) return;

  const storedHexes = getGalaxyMapData()?.hexes ?? {};
  const hexes = state.workingHexes ?? storedHexes;
  const transparent = isGalaxyMapTransparent();
  const fillAlpha = transparent ? 0.34 : 1;
  const lineAlpha = transparent ? 0.58 : 1;
  const width = Number(canvas?.grid?.sizeX ?? canvas?.grid?.size ?? 0) || 100;
  const height = Number(canvas?.grid?.sizeY ?? canvas?.grid?.size ?? 0) || width;

  for (const [factionId, faction] of Object.entries(getGalaxyFactionDefinitions())) {
    const entries = Object.entries(hexes).filter(([, owner]) => owner === factionId);
    if (!entries.length) continue;

    const graphics = new PIXI.Graphics();
    graphics.lineStyle(1, faction.line, lineAlpha);
    graphics.beginFill(faction.color, fillAlpha);
    for (const [key] of entries) {
      const topLeft = topLeftFromOffset(offsetFromKey(key));
      if (!topLeft) continue;
      drawHex(graphics, topLeft.x, topLeft.y, width, height);
    }
    graphics.endFill();
    overlay.addChild(graphics);
  }

  drawFactionBorders(overlay, hexes, width, height);
  drawGalaxyRegionLabels(overlay, getGalaxyRegions());
}

function setFaction(factionId) {
  if (!["erase", "placeSystem", "placeRegion"].includes(factionId) && !getGalaxyFactionDefinitions()[factionId]) return;
  state.faction = factionId;
  queueControlsRender();
}

function escapeHTML(value) {
  if (foundry.utils.escapeHTML) return foundry.utils.escapeHTML(String(value ?? ""));
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isGalaxySystemNote(document) {
  const data = document?.getFlag?.(SYSTEM_ID, SYSTEM_NOTE_FLAG) ?? document?.flags?.[SYSTEM_ID]?.[SYSTEM_NOTE_FLAG];
  return Boolean(data?.system);
}

function normalizeGalaxySystemType(data = {}) {
  const explicit = String(data?.type ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (explicit === "grandcapital") return "grandCapital";
  if (explicit === "capital") return "capital";
  if (explicit === "normal" || explicit === "system") return "normal";
  const grandCapital = data?.grandCapital === true || data?.grandCapital === 1 || String(data?.grandCapital).toLowerCase() === "true";
  if (grandCapital) return "grandCapital";
  const capital = data?.capital === true || data?.capital === 1 || String(data?.capital).toLowerCase() === "true";
  return capital ? "capital" : "normal";
}

function galaxySystemAppearance(data = {}) {
  const type = normalizeGalaxySystemType(data);
  return { type, ...GALAXY_SYSTEM_TYPES[type] };
}

function styleGalaxySystemNote(note) {
  if (!isGalaxySystemNote(note?.document)) return;
  if (note.controlIcon?.bg) note.controlIcon.bg.visible = false;
  if (note.tooltip) {
    note.tooltip.anchor?.set?.(0.5, 0);
    note.tooltip.position?.set?.(0, (Number(note.document?.iconSize ?? SYSTEM_ICON_SIZE) / 2) + SYSTEM_LABEL_GAP);
    note.tooltip.visible = Boolean(note.visible);
  }
}

function queueGalaxySystemNoteStyle(note) {
  styleGalaxySystemNote(note);
  requestAnimationFrame(() => styleGalaxySystemNote(note));
}

async function syncGalaxySystemNoteAppearance(scene = canvas?.scene ?? game?.scenes?.active) {
  if (!scene || !game.user?.isGM || !isGalaxyMapScene(scene)) return 0;
  const updates = [];

  for (const note of scene.notes?.contents ?? scene.notes ?? []) {
    if (!isGalaxySystemNote(note)) continue;
    const systemData = note.getFlag?.(SYSTEM_ID, SYSTEM_NOTE_FLAG) ?? note.flags?.[SYSTEM_ID]?.[SYSTEM_NOTE_FLAG] ?? {};
    const appearance = galaxySystemAppearance(systemData);
    const desired = {
      texture: { src: appearance.icon },
      iconSize: appearance.iconSize,
      fontSize: appearance.fontSize,
      textAnchor: CONST.TEXT_ANCHOR_POINTS.BOTTOM,
      textColor: "#ffffff",
      global: true
    };
    const changed = note.texture?.src !== desired.texture.src ||
      Number(note.iconSize) !== desired.iconSize ||
      Number(note.fontSize) !== desired.fontSize ||
      Number(note.textAnchor) !== desired.textAnchor ||
      String(note.textColor) !== desired.textColor ||
      note.global !== true;
    if (changed) updates.push({ _id: note.id, ...desired });
  }

  if (!updates.length) return 0;
  await scene.updateEmbeddedDocuments("Note", updates, { atowGalaxySystemAppearance: true });
  return updates.length;
}

async function createGalaxySystem(point, { name, type = null, capital = false, grandCapital = false } = {}) {
  const scene = canvas?.scene ?? game?.scenes?.active;
  const systemName = String(name ?? "").trim();
  if (!scene || !game.user?.isGM || !isGalaxyMapScene(scene) || !systemName) return null;

  const systemType = normalizeGalaxySystemType({ type, capital, grandCapital });
  const appearance = GALAXY_SYSTEM_TYPES[systemType];
  const systemFlags = {
    system: true,
    type: systemType,
    capital: systemType !== "normal",
    grandCapital: systemType === "grandCapital",
    version: 2
  };

  const x = Math.round(Number(point?.x ?? 0) || 0);
  const y = Math.round(Number(point?.y ?? 0) || 0);
  const gridKey = keyFromOffset(gridOffsetFromPoint({ x, y }));
  const ownershipLevel = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2;
  const journalClass = foundry.documents?.JournalEntry?.implementation ?? globalThis.JournalEntry;
  let journal = null;

  try {
    journal = await journalClass.create({
      name: systemName,
      ownership: { default: ownershipLevel },
      flags: {
        [SYSTEM_ID]: {
          [SYSTEM_NOTE_FLAG]: systemFlags
        }
      },
      pages: [{
        name: systemName,
        type: "text",
        text: {
          content: `<h1>${escapeHTML(systemName)}</h1><p>BattleTech galaxy-map system.</p>`
        }
      }]
    }, { renderSheet: false, atowGalaxySystem: true });

    const page = journal?.pages?.contents?.[0] ?? Array.from(journal?.pages ?? [])[0] ?? null;
    const [note] = await scene.createEmbeddedDocuments("Note", [{
      entryId: journal.id,
      pageId: page?.id ?? null,
      x,
      y,
      elevation: 0,
      texture: { src: appearance.icon },
      iconSize: appearance.iconSize,
      text: systemName,
      fontSize: appearance.fontSize,
      textAnchor: CONST.TEXT_ANCHOR_POINTS.BOTTOM,
      textColor: "#ffffff",
      global: true,
      flags: {
        [SYSTEM_ID]: {
          [SYSTEM_NOTE_FLAG]: {
            ...systemFlags,
            gridKey,
            coordinates: { x, y }
          }
        }
      }
    }], { atowGalaxySystem: true });

    const suffix = systemType === "grandCapital" ? " (Grand Capital)" : systemType === "capital" ? " (Capital)" : "";
    ui.notifications?.info?.(`${systemName}${suffix} added to the galaxy map.`);
    return { note, journal, page };
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Failed to create galaxy-map system`, error);
    if (journal) await journal.delete({ atowGalaxySystemRollback: true }).catch(() => {});
    ui.notifications?.error?.(`Could not create the ${systemName} system.`);
    return null;
  }
}

async function promptAndCreateGalaxySystem(point) {
  if (state.systemDialogOpen) return null;
  state.systemDialogOpen = true;
  try {
    const result = await foundry.applications.api.DialogV2.input({
      window: { title: "Create Galaxy System" },
      content: `
        <div class="standard-form atow-galaxy-system-dialog">
          <div class="form-group">
            <label>System Name</label>
            <div class="form-fields">
              <input type="text" name="name" required autofocus autocomplete="off" />
            </div>
          </div>
          <div class="form-group">
            <label>System Type</label>
            <div class="form-fields">
              <select name="systemType">
                <option value="normal">Normal System</option>
                <option value="capital">Capital System</option>
                <option value="grandCapital">Grand Capital System</option>
              </select>
            </div>
            <p class="hint">Grand capitals use the largest marker and a prominent star.</p>
          </div>
        </div>`,
      ok: { label: "Create System", icon: "fas fa-location-dot" },
      rejectClose: false,
      modal: true
    });
    if (!result) return null;
    const name = String(result.name ?? "").trim();
    if (!name) {
      ui.notifications?.warn?.("Enter a name for the galaxy system.");
      return null;
    }
    return createGalaxySystem(point, { name, type: result.systemType });
  } finally {
    state.systemDialogOpen = false;
  }
}

async function promptAndChangeGalaxySystemType() {
  const scene = canvas?.scene ?? game?.scenes?.active;
  if (!scene || !game.user?.isGM || !isGalaxyMapScene(scene)) return false;
  const notes = Array.from(scene.notes?.contents ?? scene.notes ?? [])
    .filter(isGalaxySystemNote)
    .map(note => ({ note, label: String(note.text ?? game.journal?.get(note.entryId)?.name ?? note.id) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  if (!notes.length) {
    ui.notifications?.warn?.("This galaxy map has no star systems yet.");
    return false;
  }

  const options = notes.map(({ note, label }) => `<option value="${escapeHTML(note.id)}">${escapeHTML(label)}</option>`).join("");
  const result = await foundry.applications.api.DialogV2.input({
    window: { title: "Change Galaxy System Type" },
    content: `
      <div class="standard-form atow-galaxy-system-dialog">
        <div class="form-group">
          <label>System</label>
          <div class="form-fields"><select name="noteId">${options}</select></div>
        </div>
        <div class="form-group">
          <label>System Type</label>
          <div class="form-fields">
            <select name="systemType">
              <option value="normal">Normal System</option>
              <option value="capital">Capital System</option>
              <option value="grandCapital" selected>Grand Capital System</option>
            </select>
          </div>
        </div>
      </div>`,
    ok: { label: "Update System", icon: "fas fa-star" },
    rejectClose: false,
    modal: true
  });
  if (!result) return false;

  const note = scene.notes?.get?.(String(result.noteId ?? ""));
  if (!note || !isGalaxySystemNote(note)) return false;
  const systemType = normalizeGalaxySystemType({ type: result.systemType });
  const flagPath = `flags.${SYSTEM_ID}.${SYSTEM_NOTE_FLAG}`;
  const flagUpdate = {
    [`${flagPath}.type`]: systemType,
    [`${flagPath}.capital`]: systemType !== "normal",
    [`${flagPath}.grandCapital`]: systemType === "grandCapital",
    [`${flagPath}.version`]: 2
  };
  await note.update(flagUpdate, { atowGalaxySystemType: true });

  const journal = game.journal?.get?.(note.entryId);
  if (journal) await journal.update(flagUpdate, { atowGalaxySystemType: true });
  await syncGalaxySystemNoteAppearance(scene);
  ui.notifications?.info?.(`${note.text || journal?.name || "Galaxy system"} is now a ${GALAXY_SYSTEM_TYPES[systemType].label}.`);
  return true;
}

function factionIdFromLabel(label, definitions) {
  const base = String(label ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "faction";
  let id = base;
  let suffix = 2;
  while (definitions[id]) id = `${base}-${suffix++}`;
  return id;
}

async function promptAndAddGalaxyFaction() {
  const scene = canvas?.scene ?? game?.scenes?.active;
  if (!scene || !game.user?.isGM || !isGalaxyMapScene(scene)) return null;
  const result = await foundry.applications.api.DialogV2.input({
    window: { title: "Add Galaxy Faction" },
    content: `
      <div class="standard-form atow-galaxy-faction-dialog">
        <div class="form-group">
          <label>Faction Name</label>
          <div class="form-fields">
            <input type="text" name="name" required autofocus autocomplete="off" />
          </div>
        </div>
        <div class="form-group">
          <label>Territory Color</label>
          <div class="form-fields">
            <input type="color" name="color" value="#9b6b43" />
          </div>
        </div>
      </div>`,
    ok: { label: "Add Faction", icon: "fas fa-plus" },
    rejectClose: false,
    modal: true
  });
  if (!result) return null;

  const label = String(result.name ?? "").trim();
  if (!label) {
    ui.notifications?.warn?.("Enter a name for the new faction.");
    return null;
  }
  const color = normalizeHexColor(result.color, "#9b6b43");
  const id = factionIdFromLabel(label, getGalaxyFactionDefinitions(scene));
  await scene.update({
    [`flags.${SYSTEM_ID}.${GALAXY_FLAG}.factions.${id}`]: { label, color }
  }, { atowGalaxyFaction: true });
  state.faction = id;
  queueControlsRender();
  ui.notifications?.info?.(`${label} added to the galaxy-map faction palette.`);
  return { id, label, color };
}

async function createGalaxyRegion(point, { name, fontSize = DEFAULT_REGION_FONT_SIZE, color = "#ffffff" } = {}) {
  const scene = canvas?.scene ?? game?.scenes?.active;
  const regionName = String(name ?? "").trim();
  if (!scene || !game.user?.isGM || !isGalaxyMapScene(scene) || !regionName) return null;
  const id = foundry.utils.randomID?.() ?? globalThis.crypto?.randomUUID?.().replaceAll("-", "") ?? `${Date.now()}`;
  const region = {
    name: regionName,
    x: Math.round(Number(point?.x ?? 0) || 0),
    y: Math.round(Number(point?.y ?? 0) || 0),
    fontSize: Math.max(MIN_REGION_FONT_SIZE, Math.min(MAX_REGION_FONT_SIZE, Math.round(Number(fontSize) || DEFAULT_REGION_FONT_SIZE))),
    color: normalizeHexColor(color, "#ffffff"),
    version: 1
  };
  await scene.update({
    [`flags.${SYSTEM_ID}.${GALAXY_FLAG}.regions.${id}`]: region
  }, { atowGalaxyRegion: true });
  ui.notifications?.info?.(`${regionName} region label added.`);
  return { id, ...region };
}

async function promptAndCreateGalaxyRegion(point) {
  const result = await foundry.applications.api.DialogV2.input({
    window: { title: "Create Named Region" },
    content: `
      <div class="standard-form atow-galaxy-region-dialog">
        <div class="form-group">
          <label>Region Name</label>
          <div class="form-fields">
            <input type="text" name="name" required autofocus autocomplete="off" />
          </div>
        </div>
        <div class="form-group">
          <label>Label Size</label>
          <div class="form-fields">
            <input type="number" name="fontSize" value="${DEFAULT_REGION_FONT_SIZE}" min="${MIN_REGION_FONT_SIZE}" max="${MAX_REGION_FONT_SIZE}" step="4" data-dtype="Number" />
          </div>
          <p class="hint">Larger regions can use a larger label. System names currently use size 45.</p>
        </div>
        <div class="form-group">
          <label>Label Color</label>
          <div class="form-fields">
            <input type="color" name="color" value="#ffffff" />
          </div>
        </div>
      </div>`,
    ok: { label: "Create Region", icon: "fas fa-font" },
    rejectClose: false,
    modal: true
  });
  if (!result) return null;
  const name = String(result.name ?? "").trim();
  if (!name) {
    ui.notifications?.warn?.("Enter a name for the region.");
    return null;
  }
  return createGalaxyRegion(point, result);
}

async function manageGalaxyRegions() {
  const scene = canvas?.scene ?? game?.scenes?.active;
  if (!scene || !game.user?.isGM || !isGalaxyMapScene(scene)) return false;
  const regions = getGalaxyRegions(scene);
  const entries = Object.entries(regions);
  if (!entries.length) {
    ui.notifications?.warn?.("This galaxy map has no named regions yet.");
    return false;
  }

  const rows = entries.map(([id, region]) => `
    <div class="atow-galaxy-region-row" data-region-id="${escapeHTML(id)}">
      <input type="text" data-field="name" value="${escapeHTML(region?.name ?? "")}" aria-label="Region name" />
      <input type="number" data-field="fontSize" value="${Number(region?.fontSize ?? DEFAULT_REGION_FONT_SIZE)}" min="${MIN_REGION_FONT_SIZE}" max="${MAX_REGION_FONT_SIZE}" step="4" aria-label="Label size" />
      <input type="color" data-field="color" value="${normalizeHexColor(region?.color, "#ffffff")}" aria-label="Label color" />
      <label class="atow-galaxy-region-delete"><input type="checkbox" data-field="remove" /> Delete</label>
    </div>`).join("");

  const result = await foundry.applications.api.DialogV2.prompt({
    window: { title: "Manage Named Regions" },
    position: { width: 760 },
    content: `
      <div class="standard-form atow-galaxy-region-manager">
        <div class="atow-galaxy-region-head"><span>Name</span><span>Size</span><span>Color</span><span></span></div>
        ${rows}
      </div>`,
    ok: {
      label: "Save Regions",
      icon: "fas fa-floppy-disk",
      callback: (_event, button) => Array.from(button.form.querySelectorAll("[data-region-id]")).map(row => ({
        id: row.dataset.regionId,
        name: String(row.querySelector('[data-field="name"]')?.value ?? "").trim(),
        fontSize: Number(row.querySelector('[data-field="fontSize"]')?.value ?? DEFAULT_REGION_FONT_SIZE),
        color: row.querySelector('[data-field="color"]')?.value ?? "#ffffff",
        remove: Boolean(row.querySelector('[data-field="remove"]')?.checked)
      }))
    },
    rejectClose: false,
    modal: true
  });
  if (!result) return false;

  const root = `flags.${SYSTEM_ID}.${GALAXY_FLAG}.regions`;
  const updates = {};
  for (const edited of result) {
    const original = regions[edited.id];
    if (!original) continue;
    if (edited.remove) {
      updates[`${root}.-=${edited.id}`] = null;
      continue;
    }
    if (!edited.name) continue;
    updates[`${root}.${edited.id}`] = {
      ...original,
      name: edited.name,
      fontSize: Math.max(MIN_REGION_FONT_SIZE, Math.min(MAX_REGION_FONT_SIZE, Math.round(edited.fontSize || DEFAULT_REGION_FONT_SIZE))),
      color: normalizeHexColor(edited.color, "#ffffff")
    };
  }
  if (Object.keys(updates).length) await scene.update(updates, { atowGalaxyRegion: true });
  return true;
}

async function setOverlayTransparency(transparent) {
  const scene = canvas?.scene ?? game?.scenes?.active;
  if (!scene || !game.user?.isGM || !isGalaxyMapScene(scene)) return false;
  try {
    await scene.update({
      [`flags.${SYSTEM_ID}.${GALAXY_FLAG}.transparent`]: Boolean(transparent)
    }, { atowGalaxyTransparency: true });
    drawGalaxyMapOverlay();
    return true;
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Failed to toggle galaxy-map transparency`, error);
    ui.notifications?.error?.("Could not update the galaxy-map transparency.");
    return false;
  }
}

function queueControlsRender() {
  if (state.controlsRenderQueued) return;
  state.controlsRenderQueued = true;
  window.setTimeout(() => {
    state.controlsRenderQueued = false;
    // Foundry V13 caches the available control groups after its first render.
    // reset:true re-runs getSceneControlButtons so a newly enabled galaxy map
    // can add its toolbar without requiring a client reload.
    ui?.controls?.render?.({ reset: true });
  }, 0);
}

function unbindCanvasEvents() {
  const stage = canvas?.stage;
  if (!stage) return;
  stage.off?.("pointerdown", onPointerDown);
  stage.off?.("pointermove", onPointerMove);
  stage.off?.("pointerup", onPointerUp);
  stage.off?.("pointerupoutside", onPointerUp);
}

function bindCanvasEvents() {
  unbindCanvasEvents();
  const stage = canvas?.stage;
  if (!stage || !state.enabled) return;
  stage.eventMode = "static";
  stage.interactive = true;
  stage.on("pointerdown", onPointerDown);
  stage.on("pointermove", onPointerMove);
  stage.on("pointerup", onPointerUp);
  stage.on("pointerupoutside", onPointerUp);
}

function setEnabled(enabled) {
  const requested = Boolean(enabled) && Boolean(game.user?.isGM);
  if (requested && !isGalaxyMapScene()) {
    ui.notifications?.warn?.("Enable Galaxy Map in this Scene's BattleTech configuration first.");
    state.enabled = false;
  } else if (requested && !isHexScene()) {
    ui.notifications?.warn?.("BattleTech galaxy painting requires a hex-grid Scene.");
    state.enabled = false;
  } else {
    state.enabled = requested;
  }

  if (state.enabled) game?.[SYSTEM_ID]?.api?.terrain?.setEnabled?.(false);
  state.isPainting = false;
  state.originalHexes = null;
  state.workingHexes = null;
  state.paintedThisDrag.clear();
  bindCanvasEvents();
  queueControlsRender();
}

function beginStroke() {
  state.isPainting = true;
  state.paintedThisDrag.clear();
  state.originalHexes = foundry.utils.deepClone(getGalaxyMapData()?.hexes ?? {});
  state.workingHexes = foundry.utils.deepClone(state.originalHexes);
}

function paintAtEvent(event) {
  if (!state.enabled || !state.isPainting || !state.workingHexes) return;
  const key = keyFromOffset(gridOffsetFromPoint(getEventPoint(event)));
  if (!key || state.paintedThisDrag.has(key)) return;
  state.paintedThisDrag.add(key);

  if (state.faction === "erase") delete state.workingHexes[key];
  else state.workingHexes[key] = state.faction;
  queueRedraw();
}

async function commitStroke() {
  const scene = canvas?.scene ?? game?.scenes?.active;
  const originalHexes = state.originalHexes;
  const hexes = state.workingHexes;
  state.isPainting = false;
  state.paintedThisDrag.clear();
  if (!scene || !originalHexes || !hexes || !game.user?.isGM) {
    state.originalHexes = null;
    state.workingHexes = null;
    queueRedraw();
    return;
  }

  try {
    const updates = buildGalaxyHexUpdates(originalHexes, hexes);
    if (Object.keys(updates).length) await scene.update(updates, { atowGalaxyPaint: true });
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Failed to save galaxy-map territory`, error);
    ui.notifications?.error?.("Could not save the galaxy-map territory changes.");
  } finally {
    state.originalHexes = null;
    state.workingHexes = null;
  }
  queueRedraw();
}

function onPointerDown(event) {
  if (!state.enabled || !game.user?.isGM) return;
  if ((event?.button ?? 0) !== 0) return;
  event?.stopPropagation?.();
  event?.preventDefault?.();
  if (state.faction === "placeSystem") {
    const point = getEventPoint(event);
    if (point) promptAndCreateGalaxySystem(point);
    return;
  }
  if (state.faction === "placeRegion") {
    const point = getEventPoint(event);
    if (point) promptAndCreateGalaxyRegion(point);
    return;
  }
  beginStroke();
  paintAtEvent(event);
}

function onPointerMove(event) {
  if (!state.isPainting) return;
  event?.stopPropagation?.();
  event?.preventDefault?.();
  paintAtEvent(event);
}

function onPointerUp(event) {
  if (!state.isPainting || (event?.button ?? 0) !== 0) return;
  event?.stopPropagation?.();
  event?.preventDefault?.();
  commitStroke();
}

function activateFaction(factionId) {
  setFaction(factionId);
  setEnabled(true);
}

function buildGalaxyControl() {
  const tools = {};
  let order = 0;
  const factionDefinitions = getGalaxyFactionDefinitions();
  refreshCustomFactionStyles(factionDefinitions);
  for (const [id, faction] of Object.entries(factionDefinitions)) {
    tools[id] = {
      name: id,
      title: `Paint ${faction.label} territory`,
      icon: `fas fa-hexagon ${faction.custom ? `atow-galaxy-faction-${id}` : faction.icon}`,
      order: order++,
      active: state.enabled && state.faction === id,
      onChange: (_event, active) => {
        if (active === false) return;
        activateFaction(id);
      }
    };
  }

  tools.addFaction = {
    name: "addFaction",
    title: "Add a custom faction",
    icon: "fas fa-shield-halved atow-galaxy-add-faction",
    order: order++,
    button: true,
    onChange: (_event, active) => {
      if (active) promptAndAddGalaxyFaction();
    }
  };

  tools.erase = {
    name: "erase",
    title: "Erase territorial control",
    icon: "fas fa-eraser atow-galaxy-erase",
    order: order++,
    active: state.enabled && state.faction === "erase",
    onChange: (_event, active) => {
      if (active === false) return;
      activateFaction("erase");
    }
  };

  tools.placeSystem = {
    name: "placeSystem",
    title: "Place a linked star system",
    icon: "fas fa-location-dot atow-galaxy-system-tool",
    order: order++,
    active: state.enabled && state.faction === "placeSystem",
    onChange: (_event, active) => {
      if (active === false) return;
      activateFaction("placeSystem");
    }
  };

  tools.changeSystemType = {
    name: "changeSystemType",
    title: "Change an existing system's marker type",
    icon: "fas fa-star atow-galaxy-system-tool",
    order: order++,
    button: true,
    onChange: (_event, active) => {
      if (active) promptAndChangeGalaxySystemType();
    }
  };

  tools.placeRegion = {
    name: "placeRegion",
    title: "Place a named region",
    icon: "fas fa-font atow-galaxy-region-tool",
    order: order++,
    active: state.enabled && state.faction === "placeRegion",
    onChange: (_event, active) => {
      if (active === false) return;
      activateFaction("placeRegion");
    }
  };

  tools.manageRegions = {
    name: "manageRegions",
    title: "Edit named regions",
    icon: "fas fa-list-check atow-galaxy-manage-regions",
    order: order++,
    button: true,
    onChange: (_event, active) => {
      if (active) manageGalaxyRegions();
    }
  };

  tools.transparency = {
    name: "transparency",
    title: "Toggle transparent territory overlay",
    icon: "fas fa-circle-half-stroke atow-galaxy-transparency",
    order,
    toggle: true,
    active: isGalaxyMapTransparent(),
    onChange: (_event, active) => {
      setOverlayTransparency(active);
    }
  };

  return {
    name: "atowGalaxyMap",
    title: "BattleTech Galaxy Map",
    icon: "fas fa-globe",
    order: 100,
    visible: Boolean(game.user?.isGM && isGalaxyMapScene()),
    activeTool: state.faction,
    tools,
    onChange: (_event, active) => setEnabled(Boolean(active)),
    onToolChange: (_event, tool) => {
      const id = tool?.name;
      if (["erase", "placeSystem", "placeRegion"].includes(id) || factionDefinitions[id]) activateFaction(id);
    }
  };
}

function registerGalaxySceneControl(controls) {
  if (!controls || !game.user?.isGM || !isGalaxyMapScene()) return;
  const control = buildGalaxyControl();
  if (Array.isArray(controls)) {
    controls.push({ ...control, layer: "controls", tools: Object.values(control.tools) });
    return;
  }
  controls[control.name] = control;
}

export function registerAtowGalaxyMapTools(namespace = null) {
  const api = {
    factions: GALAXY_FACTIONS,
    getFactions: getGalaxyFactionDefinitions,
    getData: getGalaxyMapData,
    isGalaxyMapScene,
    isTransparent: isGalaxyMapTransparent,
    draw: drawGalaxyMapOverlay,
    createSystem: createGalaxySystem,
    changeSystemType: promptAndChangeGalaxySystemType,
    addFaction: promptAndAddGalaxyFaction,
    createRegion: createGalaxyRegion,
    getRegions: getGalaxyRegions,
    manageRegions: manageGalaxyRegions,
    syncSystemAppearance: syncGalaxySystemNoteAppearance,
    setFaction,
    setTransparency: setOverlayTransparency,
    setEnabled
  };
  if (namespace?.api) namespace.api.galaxyMap = api;

  Hooks.on("getSceneControlButtons", registerGalaxySceneControl);

  for (const hookName of ["drawNote", "refreshNote", "hoverNote"]) {
    Hooks.on(hookName, queueGalaxySystemNoteStyle);
  }

  Hooks.on("canvasReady", () => {
    state.enabled = false;
    state.isPainting = false;
    state.originalHexes = null;
    state.workingHexes = null;
    state.paintedThisDrag.clear();
    bindCanvasEvents();
    drawGalaxyMapOverlay();
    queueControlsRender();
    if (isGalaxyMapScene()) {
      game.settings?.set?.("core", "notesDisplayToggle", true).catch?.(() => {});
      syncGalaxySystemNoteAppearance().catch(error => {
        console.warn(`${SYSTEM_ID} | Failed to update galaxy-system marker appearance`, error);
      });
      for (const note of canvas?.notes?.placeables ?? []) queueGalaxySystemNoteStyle(note);
    }
  });

  Hooks.on("updateScene", (scene, changed) => {
    if (scene?.id !== canvas?.scene?.id) return;
    const changedPaths = Object.keys(foundry.utils.flattenObject(changed ?? {}));
    const galaxyFlagChanged = changedPaths.some(path =>
      path === `flags.${SYSTEM_ID}.${GALAXY_FLAG}` ||
      path.startsWith(`flags.${SYSTEM_ID}.${GALAXY_FLAG}.`)
    );
    if (!galaxyFlagChanged) return;
    if (isGalaxyMapScene(scene)) game?.[SYSTEM_ID]?.api?.terrain?.setEnabled?.(false);
    else setEnabled(false);
    drawGalaxyMapOverlay();
    queueControlsRender();
  });

  Hooks.on("deleteScene", scene => {
    if (scene?.id !== canvas?.scene?.id) return;
    unbindCanvasEvents();
    if (state.overlay && !state.overlay.destroyed) state.overlay.destroy({ children: true });
    state.overlay = null;
  });
}
