const SYSTEM_ID = "atow-battletech";
const TERRAIN_FLAG = "terrain";
const OVERLAY_NAME = "atow-terrain-overlay";

const BRUSHES = {
  lightWoods: { label: "Light Woods", title: "Paint light woods", icon: "fas fa-tree" },
  heavyWoods: { label: "Heavy Woods", title: "Paint heavy woods", icon: "fas fa-tree" },
  water1: { label: "Water 1", title: "Paint depth 1 water", icon: "fas fa-water" },
  water2: { label: "Water 2", title: "Paint depth 2 water", icon: "fas fa-water" },
  rough: { label: "Rough", title: "Toggle rough terrain", icon: "fas fa-mountain" },
  elevUp: { label: "Elev +", title: "Raise hex elevation by 1", icon: "fas fa-arrow-up" },
  elevDown: { label: "Elev -", title: "Lower hex elevation by 1", icon: "fas fa-arrow-down" },
  elev0: { label: "Elev 0", title: "Reset hex elevation to 0", icon: "fas fa-equals" },
  clear: { label: "Clear", title: "Erase BattleTech terrain from a hex", icon: "fas fa-eraser" }
};

const state = {
  enabled: false,
  brush: "lightWoods",
  isPainting: false,
  paintedThisDrag: new Set(),
  overlay: null,
  controlsRenderQueued: false
};

function terrainData(scene = canvas?.scene ?? game?.scenes?.active) {
  return foundry.utils.deepClone(scene?.getFlag?.(SYSTEM_ID, TERRAIN_FLAG) ?? {});
}

function isEmptyTerrain(entry) {
  if (!entry || typeof entry !== "object") return true;
  return !entry.woods && !entry.waterDepth && !entry.elevation && !entry.rough;
}

function applyBrush(entry, brush) {
  const next = { ...(entry ?? {}) };

  if (brush === "clear") return null;
  if (brush === "lightWoods") {
    next.woods = "light";
    return next;
  }
  if (brush === "heavyWoods") {
    next.woods = "heavy";
    return next;
  }
  if (brush === "water1") {
    next.waterDepth = 1;
    return next;
  }
  if (brush === "water2") {
    next.waterDepth = 2;
    return next;
  }
  if (brush === "rough") {
    next.rough = !next.rough;
    return next;
  }
  if (brush === "elevUp") {
    next.elevation = (Number(next.elevation ?? 0) || 0) + 1;
    return next;
  }
  if (brush === "elevDown") {
    next.elevation = (Number(next.elevation ?? 0) || 0) - 1;
    return next;
  }
  if (brush === "elev0") {
    delete next.elevation;
    return next;
  }

  return next;
}

async function paintTerrainAtKey(key, brush = state.brush) {
  const scene = canvas?.scene ?? game?.scenes?.active;
  if (!scene || !game.user?.isGM || !key) return false;

  const data = terrainData(scene);
  if (brush === "clear") {
    delete data[key];
    await scene.update({ [`flags.${SYSTEM_ID}.${TERRAIN_FLAG}.-=${key}`]: null });
    drawTerrainOverlay();
    return true;
  }

  const next = applyBrush(data[key], brush);
  if (!next || isEmptyTerrain(next)) delete data[key];
  else data[key] = next;

  await scene.setFlag(SYSTEM_ID, TERRAIN_FLAG, data);
  drawTerrainOverlay();
  return true;
}

function keyFromOffset(offset) {
  if (!offset) return null;
  const i = Number(offset.i ?? offset.x);
  const j = Number(offset.j ?? offset.y);
  if (!Number.isFinite(i) || !Number.isFinite(j)) return null;
  return `${Math.trunc(i)},${Math.trunc(j)}`;
}

function offsetFromKey(key) {
  const [iRaw, jRaw] = String(key ?? "").split(",");
  const i = Number(iRaw);
  const j = Number(jRaw);
  if (!Number.isFinite(i) || !Number.isFinite(j)) return null;
  return { i, j };
}

function getEventPoint(event) {
  const g = event?.global ?? event?.data?.global ?? null;
  if (g && Number.isFinite(g.x) && Number.isFinite(g.y)) {
    try {
      const local = canvas?.stage?.toLocal?.(g);
      if (local && Number.isFinite(local.x) && Number.isFinite(local.y)) return { x: local.x, y: local.y };
    } catch (_) {}
    return { x: g.x, y: g.y };
  }

  try {
    const pt = event?.data?.getLocalPosition?.(canvas.stage);
    if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) return { x: pt.x, y: pt.y };
  } catch (_) {}

  return null;
}

function gridOffsetFromPoint(point) {
  if (!point || !canvas?.grid) return null;

  try {
    const off = canvas.grid.getOffset?.({ x: point.x, y: point.y });
    if (off && Number.isFinite(off.i) && Number.isFinite(off.j)) return { i: off.i, j: off.j };
  } catch (_) {}

  try {
    const pos = canvas.grid.getGridPositionFromPixels?.(point.x, point.y);
    if (Array.isArray(pos) && pos.length >= 2) return { i: Number(pos[0]), j: Number(pos[1]) };
  } catch (_) {}

  try {
    const pos = canvas.grid.getGridPosition?.(point.x, point.y);
    if (Array.isArray(pos) && pos.length >= 2) return { i: Number(pos[0]), j: Number(pos[1]) };
  } catch (_) {}

  const size = Number(canvas.grid.size ?? canvas.dimensions?.size ?? 0) || 100;
  return { i: Math.floor(point.x / size), j: Math.floor(point.y / size) };
}

function keyFromPoint(point) {
  return keyFromOffset(gridOffsetFromPoint(point));
}

export function getTerrainKeyAtPoint(point) {
  return keyFromPoint(point);
}

function tokenCenterPointForPosition(tokenLike, position = {}) {
  const doc = tokenLike?.document ?? tokenLike;
  const x = Number(position?.x ?? doc?.x ?? 0) || 0;
  const y = Number(position?.y ?? doc?.y ?? 0) || 0;

  // Token x/y are top-left pixel coordinates. On Foundry v13 hex grids,
  // grid.getCenterPoint can interpret {x,y} as a grid offset and return a
  // point outside the scene (e.g. x=0,y=0 -> x=-sizeX/4). For terrain lookup
  // we need the token's visual center in scene pixels.
  const cellW = Number(canvas?.grid?.sizeX ?? canvas?.grid?.size ?? canvas?.dimensions?.size ?? 0) || 100;
  const cellH = Number(canvas?.grid?.sizeY ?? canvas?.grid?.size ?? canvas?.dimensions?.size ?? 0) || cellW;
  const width = Number(doc?.width ?? 1) || 1;
  const height = Number(doc?.height ?? 1) || 1;
  return { x: x + ((width * cellW) / 2), y: y + ((height * cellH) / 2) };
}

function topLeftFromOffset(offset) {
  if (!offset || !canvas?.grid) return null;

  try {
    const pt = canvas.grid.getTopLeftPoint?.(offset);
    if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) return { x: pt.x, y: pt.y };
  } catch (_) {}

  const cellW = Number(canvas.grid.sizeX ?? canvas.grid.size ?? 0) || 100;
  const cellH = Number(canvas.grid.sizeY ?? canvas.grid.size ?? 0) || cellW;
  return { x: offset.i * cellW, y: offset.j * cellH };
}

function ensureOverlay() {
  if (!canvas?.ready || !canvas?.interface) return null;
  if (state.overlay && !state.overlay.destroyed) return state.overlay;

  const container = new PIXI.Container();
  container.name = OVERLAY_NAME;
  container.eventMode = "none";
  container.interactiveChildren = false;
  container.zIndex = 40;
  canvas.interface.sortableChildren = true;
  canvas.interface.addChild(container);
  state.overlay = container;
  return container;
}

function terrainColor(entry) {
  if (Number(entry?.waterDepth ?? 0) > 0) return { fill: 0x2f8fd8, alpha: 0.32, line: 0x78c7ff };
  if (entry?.woods === "heavy") return { fill: 0x184f2a, alpha: 0.36, line: 0x60b36f };
  if (entry?.woods === "light") return { fill: 0x3f8f42, alpha: 0.28, line: 0x8fd17c };
  if (entry?.rough) return { fill: 0x8a7f6a, alpha: 0.28, line: 0xc8b58a };
  if (Number(entry?.elevation ?? 0) !== 0) return { fill: 0x8d8175, alpha: 0.20, line: 0xd0c1aa };
  return { fill: 0xffffff, alpha: 0.12, line: 0xffffff };
}

function drawCell(graphics, x, y, w, h) {
  try {
    const gridType = Number(canvas?.grid?.type ?? canvas?.scene?.grid?.type ?? 0);
    const isHex = gridType >= 2 && gridType <= 5;
    if (isHex) {
      // BattleTech maps use flat-top horizontal hexes.
      const pts = [
        x + (w * 0.25), y + 2,
        x + (w * 0.75), y + 2,
        x + w - 2, y + (h * 0.5),
        x + (w * 0.75), y + h - 2,
        x + (w * 0.25), y + h - 2,
        x + 2, y + (h * 0.5)
      ];
      graphics.drawPolygon(pts);
      return;
    }
  } catch (_) {}

  graphics.drawRoundedRect(x + 2, y + 2, Math.max(4, w - 4), Math.max(4, h - 4), 6);
}

function terrainLabel(entry) {
  const parts = [];
  if (entry?.woods === "light") parts.push("LW");
  if (entry?.woods === "heavy") parts.push("HW");
  if (Number(entry?.waterDepth ?? 0) > 0) parts.push(`W${Number(entry.waterDepth)}`);
  if (entry?.rough) parts.push("R");
  const elevation = Number(entry?.elevation ?? 0) || 0;
  if (elevation) parts.push(elevation > 0 ? `+${elevation}` : `${elevation}`);
  return parts.join(" ");
}

export function drawTerrainOverlay() {
  const overlay = ensureOverlay();
  if (!overlay) return;

  overlay.removeChildren().forEach(c => c.destroy?.({ children: true }));
  const data = terrainData();
  const cellW = Number(canvas?.grid?.sizeX ?? canvas?.grid?.size ?? 0) || 100;
  const cellH = Number(canvas?.grid?.sizeY ?? canvas?.grid?.size ?? 0) || cellW;

  for (const [key, entry] of Object.entries(data)) {
    if (isEmptyTerrain(entry)) continue;
    const offset = offsetFromKey(key);
    const topLeft = topLeftFromOffset(offset);
    if (!topLeft) continue;

    const style = terrainColor(entry);
    const g = new PIXI.Graphics();
    g.lineStyle(2, style.line, 0.75);
    g.beginFill(style.fill, style.alpha);
    drawCell(g, topLeft.x, topLeft.y, cellW, cellH);
    g.endFill();
    overlay.addChild(g);

    const label = terrainLabel(entry);
    if (!label) continue;
    const text = new PIXI.Text(label, {
      fontFamily: "Arial",
      fontSize: Math.max(10, Math.round(cellH * 0.18)),
      fill: 0xffffff,
      stroke: 0x111111,
      strokeThickness: 3,
      fontWeight: "700"
    });
    text.anchor.set(0.5);
    text.x = topLeft.x + (cellW / 2);
    text.y = topLeft.y + (cellH / 2);
    overlay.addChild(text);
  }
}

function setBrush(brush) {
  if (!BRUSHES[brush]) return;
  state.brush = brush;
  queueControlsRender();
}

function setEnabled(enabled) {
  state.enabled = Boolean(enabled) && Boolean(game.user?.isGM);
  state.isPainting = false;
  state.paintedThisDrag.clear();
  bindCanvasEvents();
  queueControlsRender();
}

function queueControlsRender() {
  if (state.controlsRenderQueued) return;
  state.controlsRenderQueued = true;
  window.setTimeout(() => {
    state.controlsRenderQueued = false;
    ui?.controls?.render?.({ force: true });
  }, 0);
}

function removePalette() {
  for (const palette of document.querySelectorAll(".atow-terrain-palette")) {
    palette.remove();
  }
}

function activateTerrainBrush(brush) {
  setBrush(brush);
  setEnabled(true);
}

function buildTerrainControl() {
  const brushTools = Object.entries(BRUSHES).reduce((tools, [key, brush], index) => {
    tools[key] = {
      name: key,
      title: brush.label,
      icon: brush.icon,
      order: index,
      active: state.enabled && state.brush === key,
      onChange: (_event, active) => {
        if (active === false) return;
        activateTerrainBrush(key);
      }
    };
    return tools;
  }, {});

  brushTools.debugTerrain = {
    name: "debugTerrain",
    title: "Report selected token terrain",
    icon: "fas fa-bug",
    order: Object.keys(BRUSHES).length,
    button: true,
    onChange: () => reportSelectedTokenTerrain()
  };

  return {
    name: "atowTerrain",
    title: "BattleTech Terrain",
    icon: "fas fa-mountain",
    order: 99,
    visible: Boolean(game.user?.isGM),
    activeTool: state.brush,
    tools: brushTools,
    onChange: (_event, active) => {
      setEnabled(Boolean(active));
    },
    onToolChange: (_event, tool) => {
      const brush = tool?.name;
      if (BRUSHES[brush]) activateTerrainBrush(brush);
    }
  };
}

function registerTerrainSceneControl(controls) {
  if (!controls || !game.user?.isGM) return;
  const control = buildTerrainControl();

  if (Array.isArray(controls)) {
    controls.push({
      ...control,
      layer: "controls",
      tools: Object.values(control.tools)
    });
    return;
  }

  controls[control.name] = control;
}

function reportSelectedTokenTerrain() {
  const token = canvas?.tokens?.controlled?.[0] ?? null;
  if (!token) {
    ui.notifications?.warn?.("Select one token, then click Debug Selected Token.");
    return null;
  }

  const info = getTerrainDebugForToken(token);
  const terrainText = info?.terrain ? JSON.stringify(info.terrain) : "none";
  const message = `Terrain key ${info?.key ?? "?"}; point ${Math.round(info?.point?.x ?? 0)},${Math.round(info?.point?.y ?? 0)}; terrain: ${terrainText}`;
  console.warn("AToW Terrain Debug", info);
  ui.notifications?.info?.(message);
  return info;
}

async function handlePaintEvent(event) {
  if (!state.enabled || !game.user?.isGM) return;
  const key = keyFromPoint(getEventPoint(event));
  if (!key || state.paintedThisDrag.has(key)) return;
  state.paintedThisDrag.add(key);
  await paintTerrainAtKey(key);
}

function bindCanvasEvents() {
  const stage = canvas?.stage;
  if (!stage) return;

  stage.off?.("pointerdown", onPointerDown);
  stage.off?.("pointermove", onPointerMove);
  stage.off?.("pointerup", onPointerUp);
  stage.off?.("pointerupoutside", onPointerUp);

  if (!state.enabled) return;
  stage.eventMode = "static";
  stage.interactive = true;
  stage.on("pointerdown", onPointerDown);
  stage.on("pointermove", onPointerMove);
  stage.on("pointerup", onPointerUp);
  stage.on("pointerupoutside", onPointerUp);
}

function onPointerDown(event) {
  if (!state.enabled || !game.user?.isGM) return;
  event?.stopPropagation?.();
  event?.preventDefault?.();
  state.isPainting = true;
  state.paintedThisDrag.clear();
  handlePaintEvent(event).catch(err => console.warn("AToW Terrain | Paint failed", err));
}

function onPointerMove(event) {
  if (!state.isPainting) return;
  event?.stopPropagation?.();
  event?.preventDefault?.();
  handlePaintEvent(event).catch(err => console.warn("AToW Terrain | Paint failed", err));
}

function onPointerUp(event) {
  event?.stopPropagation?.();
  event?.preventDefault?.();
  state.isPainting = false;
  state.paintedThisDrag.clear();
}

export function getTerrainAtGridKey(key, scene = canvas?.scene ?? game?.scenes?.active) {
  if (!key) return null;
  return terrainData(scene)?.[key] ?? null;
}

export function getTerrainAtPoint(point, scene = canvas?.scene ?? game?.scenes?.active) {
  return getTerrainAtGridKey(keyFromPoint(point), scene);
}

export function getTerrainForToken(tokenLike, scene = canvas?.scene ?? game?.scenes?.active) {
  const doc = tokenLike?.document ?? tokenLike;
  const token = doc?.object ?? tokenLike?.object ?? tokenLike;
  const point = token?.center ?? {
    x: Number(doc?.x ?? 0) + ((Number(doc?.width ?? 1) || 1) * (Number(canvas?.grid?.size ?? 0) || 100) / 2),
    y: Number(doc?.y ?? 0) + ((Number(doc?.height ?? 1) || 1) * (Number(canvas?.grid?.size ?? 0) || 100) / 2)
  };
  return getTerrainAtPoint(point, scene);
}

export function getTerrainForTokenPosition(tokenLike, position = {}, scene = canvas?.scene ?? game?.scenes?.active) {
  return getTerrainAtPoint(tokenCenterPointForPosition(tokenLike, position), scene);
}

export function getTerrainDebugForToken(tokenLike, position = {}, scene = canvas?.scene ?? game?.scenes?.active) {
  const point = tokenCenterPointForPosition(tokenLike, position);
  const key = keyFromPoint(point);
  return {
    tokenName: tokenLike?.name ?? tokenLike?.document?.name ?? tokenLike?.actor?.name ?? null,
    position: {
      x: Number(position?.x ?? tokenLike?.document?.x ?? tokenLike?.x ?? 0) || 0,
      y: Number(position?.y ?? tokenLike?.document?.y ?? tokenLike?.y ?? 0) || 0
    },
    point,
    key,
    terrain: getTerrainAtGridKey(key, scene),
    sceneId: scene?.id ?? null,
    gridType: canvas?.grid?.type ?? canvas?.scene?.grid?.type ?? null,
    gridSize: {
      size: canvas?.grid?.size ?? null,
      sizeX: canvas?.grid?.sizeX ?? null,
      sizeY: canvas?.grid?.sizeY ?? null
    }
  };
}

export function registerAtowTerrainTools(namespace = null) {
  const api = {
    drawTerrainOverlay,
    terrainData,
    getTerrainKeyAtPoint,
    getTerrainAtGridKey,
    getTerrainAtPoint,
    getTerrainForToken,
    getTerrainForTokenPosition,
    getTerrainDebugForToken,
    setBrush,
    setEnabled
  };

  if (namespace?.api) namespace.api.terrain = api;

  Hooks.on("getSceneControlButtons", registerTerrainSceneControl);

  Hooks.once("ready", () => {
    removePalette();
    queueControlsRender();
  });

  Hooks.on("canvasReady", () => {
    drawTerrainOverlay();
    bindCanvasEvents();
  });

  Hooks.on("updateScene", (scene, changed) => {
    if (scene?.id !== canvas?.scene?.id) return;
    if (!foundry.utils.hasProperty(changed, `flags.${SYSTEM_ID}.${TERRAIN_FLAG}`)) return;
    drawTerrainOverlay();
  });

  Hooks.on("deleteScene", () => {
    if (state.overlay && !state.overlay.destroyed) {
      state.overlay.destroy({ children: true });
      state.overlay = null;
    }
  });
}
