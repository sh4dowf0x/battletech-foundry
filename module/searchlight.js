const SYSTEM_ID = "atow-battletech";
const SEARCHLIGHT_FLAG = "searchlights";
const LIGHT_DOCUMENT_FLAG = "searchlight";
const MAX_RANGE_HEXES = 30;
const MECH_EYE_HEIGHT = 2;

let systemSocket = null;
let activePickerCleanup = null;
const followTimers = new Map();

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function sceneSearchlights(scene = canvas?.scene ?? null) {
  const value = scene?.getFlag?.(SYSTEM_ID, SEARCHLIGHT_FLAG)
    ?? scene?.flags?.[SYSTEM_ID]?.[SEARCHLIGHT_FLAG]
    ?? [];
  return Array.isArray(value) ? foundry.utils.deepClone(value) : [];
}

function tokenCenter(tokenDoc) {
  const objectCenter = tokenDoc?.object?.center;
  if (objectCenter && Number.isFinite(objectCenter.x) && Number.isFinite(objectCenter.y)) return { x: objectCenter.x, y: objectCenter.y };
  const sizeX = Number(canvas?.grid?.sizeX ?? canvas?.grid?.size ?? canvas?.dimensions?.size ?? 100) || 100;
  const sizeY = Number(canvas?.grid?.sizeY ?? canvas?.grid?.size ?? canvas?.dimensions?.size ?? sizeX) || sizeX;
  return {
    x: (Number(tokenDoc?.x ?? 0) || 0) + ((Number(tokenDoc?.width ?? 1) || 1) * sizeX / 2),
    y: (Number(tokenDoc?.y ?? 0) || 0) + ((Number(tokenDoc?.height ?? 1) || 1) * sizeY / 2)
  };
}

function snapToGridCenter(point) {
  try {
    const offset = canvas?.grid?.getOffset?.(point);
    const center = canvas?.grid?.getCenterPoint?.(offset);
    if (center && Number.isFinite(center.x) && Number.isFinite(center.y)) return { x: center.x, y: center.y };
  } catch (_) {}
  return point;
}

function distanceHexes(start, end, scene = canvas?.scene ?? null) {
  try {
    const path = canvas?.grid?.measurePath?.([start, end]);
    const distance = Number(path?.distance);
    const gridDistance = Number(scene?.grid?.distance ?? 1) || 1;
    if (Number.isFinite(distance)) return distance / gridDistance;
  } catch (_) {}
  try {
    const distance = canvas?.grid?.measureDistances?.([{ ray: new Ray(start, end) }], { gridSpaces: true })?.[0];
    const gridDistance = Number(scene?.grid?.distance ?? 1) || 1;
    if (Number.isFinite(Number(distance))) return Number(distance) / gridDistance;
  } catch (_) {}
  const gridSize = Number(canvas?.grid?.size ?? canvas?.dimensions?.size ?? 100) || 100;
  return Math.hypot(end.x - start.x, end.y - start.y) / gridSize;
}

function sourceState(scene, tokenId) {
  return sceneSearchlights(scene).find(entry => String(entry?.tokenId ?? "") === String(tokenId ?? "")) ?? null;
}

function mechIsShutdown(actor) {
  if (!actor) return false;
  return Boolean(
    actor.system?.heat?.shutdown
    || actor.system?.heat?.effects?.shutdown?.active
    || actor.getFlag?.(SYSTEM_ID, "shutdownManual")
  );
}

export function isMechSearchlightActive(actorOrToken, scene = canvas?.scene ?? null) {
  if (!scene || !actorOrToken) return false;
  const tokenId = actorOrToken?.document?.id ?? actorOrToken?.id;
  if (tokenId && sourceState(scene, tokenId)) return true;
  const actorId = actorOrToken?.actor?.id ?? actorOrToken?.actorId ?? actorOrToken?.id;
  return sceneSearchlights(scene).some(entry => String(entry?.actorId ?? "") === String(actorId ?? ""));
}

function pointToBeamDistanceHexes(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = (dx * dx) + (dy * dy);
  const t = lengthSquared > 0
    ? clamp((((point.x - start.x) * dx) + ((point.y - start.y) * dy)) / lengthSquared, 0, 1)
    : 0;
  const closest = { x: start.x + (dx * t), y: start.y + (dy * t) };
  const gridSize = Number(canvas?.grid?.size ?? canvas?.dimensions?.size ?? 100) || 100;
  return {
    t,
    distance: Math.hypot(point.x - closest.x, point.y - closest.y) / gridSize
  };
}

export function isTokenSearchlightIlluminated(tokenLike, scene = canvas?.scene ?? null) {
  if (!tokenLike || !scene) return false;
  const document = tokenLike.document ?? tokenLike;
  const point = tokenCenter(document);
  for (const beam of sceneSearchlights(scene)) {
    const start = beam?.start;
    const end = beam?.end;
    if (!start || !end) continue;
    const projection = pointToBeamDistanceHexes(point, start, end);
    const beamHalfWidth = 0.18 + (projection.t * 0.42);
    if (projection.distance <= beamHalfWidth) return true;
    const endpointDistance = Math.hypot(point.x - end.x, point.y - end.y)
      / (Number(canvas?.grid?.size ?? canvas?.dimensions?.size ?? 100) || 100);
    if (endpointDistance <= 0.7) return true;
  }
  return false;
}

/**
 * Test whether a token is illuminated by any active Foundry light source.
 * This includes Ambient Lights and token-carried lights, so flares, lamps,
 * building lights, and similar scene lighting require no BattleTech flags.
 * Global illumination is deliberately excluded: it represents the scene's
 * ambient light level rather than a local source which defeats darkness.
 *
 * The tracked searchlight beam remains as a fallback so an attack opened in
 * the same instant as a beam update still receives the expected result.
 */
export function isTokenBattlefieldIlluminated(tokenLike, scene = canvas?.scene ?? null) {
  const searchlightIlluminated = isTokenSearchlightIlluminated(tokenLike, scene);
  if (!tokenLike || !scene || scene.id !== canvas?.scene?.id) return searchlightIlluminated;

  const document = tokenLike.document ?? tokenLike;
  const point = tokenCenter(document);
  point.elevation = Number(document?.elevation ?? 0) || 0;

  try {
    const foundryIlluminated = canvas?.effects?.testInsideLight?.(point, {
      condition: source => source?.constructor?.sourceType !== "GlobalLight"
        && Boolean(source?.object)
        && !source?.isPreview
    });
    if (foundryIlluminated) return true;
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Could not test battlefield illumination`, error);
  }

  return searchlightIlluminated;
}

function lightFlag(light) {
  return light?.flags?.[SYSTEM_ID]?.[LIGHT_DOCUMENT_FLAG] ?? null;
}

async function deleteSourceLights(scene, tokenId) {
  const ids = Array.from(scene?.lights?.contents ?? scene?.lights ?? [])
    .filter(light => String(lightFlag(light)?.tokenId ?? "") === String(tokenId ?? ""))
    .map(light => light.id)
    .filter(Boolean);
  if (ids.length) await scene.deleteEmbeddedDocuments("AmbientLight", ids, { atowSearchlight: true });
}

function ambientLightSources(scene, tokenDoc, start, end, beamId, rangeHexes) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const pixelDistance = Math.max(1, Math.hypot(dx, dy));
  const gridSize = Number(scene?.grid?.size ?? canvas?.dimensions?.size ?? 100) || 100;
  const gridDistance = Number(scene?.grid?.distance ?? 1) || 1;
  const radius = Math.max(gridDistance, rangeHexes * gridDistance);
  const coneAngle = clamp((2 * Math.atan2(gridSize * 0.6, pixelDistance) * 180) / Math.PI, 3, 35);
  // Foundry rotation 0 faces south, so convert the canvas ray angle by -90.
  const rotation = ((Math.atan2(dy, dx) * 180) / Math.PI) - 90;
  const elevation = (Number(tokenDoc.elevation ?? 0) || 0) + MECH_EYE_HEIGHT;
  const commonConfig = {
    color: "#fff1bd",
    alpha: 0.42,
    coloration: 1,
    luminosity: 0.6,
    attenuation: 0.35,
    saturation: 0.08,
    contrast: 0.05,
    shadows: 0,
    animation: { type: null, speed: 5, intensity: 5 },
    darkness: { min: 0, max: 1 }
  };
  const flag = role => ({ [SYSTEM_ID]: { [LIGHT_DOCUMENT_FLAG]: { id: beamId, tokenId: tokenDoc.id, role } } });
  return [
    {
      x: start.x,
      y: start.y,
      elevation,
      rotation,
      walls: true,
      vision: false,
      hidden: false,
      config: { ...commonConfig, angle: coneAngle, bright: radius, dim: 0 },
      flags: flag("beam")
    },
    {
      x: end.x,
      y: end.y,
      elevation,
      rotation: 0,
      walls: true,
      vision: false,
      hidden: false,
      config: { ...commonConfig, angle: 360, bright: gridDistance * 0.75, dim: gridDistance * 0.25 },
      flags: flag("destination")
    }
  ];
}

async function gmDisableSearchlight(sceneId, tokenId) {
  if (!game.user?.isGM) return false;
  const scene = game.scenes?.get?.(sceneId);
  if (!scene) return false;
  await deleteSourceLights(scene, tokenId);
  const next = sceneSearchlights(scene).filter(entry => String(entry.tokenId) !== String(tokenId));
  await scene.setFlag(SYSTEM_ID, SEARCHLIGHT_FLAG, next);
  return true;
}

async function gmAimSearchlight(sceneId, tokenId, destination) {
  if (!game.user?.isGM) return false;
  const scene = game.scenes?.get?.(sceneId);
  const tokenDoc = scene?.tokens?.get?.(tokenId);
  if (!scene || !tokenDoc || String(tokenDoc.actor?.type ?? "").toLowerCase() !== "mech") return false;
  const rawStart = tokenCenter(tokenDoc);
  const start = { x: Math.round(rawStart.x), y: Math.round(rawStart.y) };
  const end = { x: Math.round(Number(destination?.x)), y: Math.round(Number(destination?.y)) };
  if (!Number.isFinite(end.x) || !Number.isFinite(end.y)) return false;
  const rangeHexes = distanceHexes(start, end, scene);
  if (rangeHexes > MAX_RANGE_HEXES + 0.001) return false;

  await deleteSourceLights(scene, tokenId);
  const beamId = foundry.utils.randomID();
  await scene.createEmbeddedDocuments("AmbientLight", ambientLightSources(scene, tokenDoc, start, end, beamId, rangeHexes), { atowSearchlight: true });
  const next = sceneSearchlights(scene).filter(entry => String(entry.tokenId) !== String(tokenId));
  next.push({ id: beamId, tokenId, actorId: tokenDoc.actor?.id ?? tokenDoc.actorId, start, end, rangeHexes });
  await scene.setFlag(SYSTEM_ID, SEARCHLIGHT_FLAG, next);
  return true;
}

async function executeAsGM(functionName, ...args) {
  if (game.user?.isGM) return functionName === "gmAimSearchlight" ? gmAimSearchlight(...args) : gmDisableSearchlight(...args);
  if (!systemSocket) {
    ui.notifications?.warn?.("Searchlights require an active GM and socketlib.");
    return false;
  }
  return systemSocket.executeAsGM(functionName, ...args);
}

function pickerPoint(event) {
  const global = event?.global ?? event?.data?.global;
  if (!global) return null;
  try {
    const local = canvas.stage.toLocal(global);
    return snapToGridCenter({ x: local.x, y: local.y });
  } catch (_) {
    return snapToGridCenter({ x: global.x, y: global.y });
  }
}

function pickDestination(start, scene) {
  if (activePickerCleanup) activePickerCleanup();
  return new Promise(resolve => {
    const stage = canvas?.stage;
    if (!stage) return resolve(null);
    const graphics = new PIXI.Graphics();
    graphics.eventMode = "none";
    graphics.zIndex = 10000;
    canvas.interface.sortableChildren = true;
    canvas.interface.addChild(graphics);
    const priorCursor = canvas.app?.view?.style?.cursor ?? "";
    if (canvas.app?.view?.style) canvas.app.view.style.cursor = "crosshair";

    const cleanup = () => {
      stage.off("pointermove", onMove);
      stage.off("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
      graphics.destroy();
      if (canvas.app?.view?.style) canvas.app.view.style.cursor = priorCursor;
      if (activePickerCleanup === cleanup) activePickerCleanup = null;
    };
    const finish = value => { cleanup(); resolve(value); };
    const draw = point => {
      const range = distanceHexes(start, point, scene);
      const valid = range <= MAX_RANGE_HEXES + 0.001;
      graphics.clear();
      graphics.lineStyle(Math.max(4, (Number(canvas.grid?.size ?? 100) || 100) * 0.08), valid ? 0xffef9a : 0xff4d4d, 0.7);
      graphics.moveTo(start.x, start.y);
      graphics.lineTo(point.x, point.y);
      graphics.beginFill(valid ? 0xffef9a : 0xff4d4d, 0.35);
      graphics.drawCircle(point.x, point.y, Math.max(8, (Number(canvas.grid?.size ?? 100) || 100) * 0.18));
      graphics.endFill();
    };
    const onMove = event => { const point = pickerPoint(event); if (point) draw(point); };
    const onDown = event => {
      const button = Number(event?.button ?? event?.data?.button ?? 0);
      if (button === 2) { event?.stopPropagation?.(); finish(null); return; }
      if (button !== 0) return;
      const point = pickerPoint(event);
      if (!point) return;
      const range = distanceHexes(start, point, scene);
      if (range > MAX_RANGE_HEXES + 0.001) {
        ui.notifications?.warn?.(`Searchlight range is limited to ${MAX_RANGE_HEXES} hexes.`);
        return;
      }
      event?.stopPropagation?.();
      event?.preventDefault?.();
      finish(point);
    };
    const onKey = event => { if (event.key === "Escape") finish(null); };
    activePickerCleanup = cleanup;
    stage.on("pointermove", onMove);
    stage.on("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    ui.notifications?.info?.(`Searchlight: click a destination within ${MAX_RANGE_HEXES} hexes. Right-click or press Escape to cancel.`);
  });
}

export async function toggleMechSearchlight(actor, tokenDoc = null) {
  tokenDoc = tokenDoc?.document ?? tokenDoc ?? actor?.getActiveTokens?.(true, true)?.[0]?.document ?? actor?.getActiveTokens?.()?.[0]?.document ?? null;
  const scene = tokenDoc?.parent ?? canvas?.scene ?? null;
  if (!actor || String(actor.type ?? "").toLowerCase() !== "mech" || !tokenDoc || !scene) {
    ui.notifications?.warn?.("Place or select this BattleMech on the active scene before using its searchlight.");
    return false;
  }
  if (sourceState(scene, tokenDoc.id)) {
    const disabled = await executeAsGM("gmDisableSearchlight", scene.id, tokenDoc.id);
    if (disabled) ui.notifications?.info?.(`${actor.name}: searchlight switched off.`);
    return disabled;
  }
  if (mechIsShutdown(actor)) {
    ui.notifications?.warn?.("A shut-down BattleMech cannot activate its searchlight. Restart the 'Mech first.");
    return false;
  }
  if (scene.id !== canvas?.scene?.id) {
    ui.notifications?.warn?.("Open the BattleMech's scene before aiming its searchlight.");
    return false;
  }
  const destination = await pickDestination(tokenCenter(tokenDoc), scene);
  if (!destination) return false;
  const aimed = await executeAsGM("gmAimSearchlight", scene.id, tokenDoc.id, destination);
  if (aimed) ui.notifications?.info?.(`${actor.name}: searchlight active.`);
  return aimed;
}

/** Switch off every active beam belonging to this BattleMech. */
export async function disableMechSearchlights(actor) {
  if (!actor || !game.user?.isGM) return false;
  let changed = false;
  for (const scene of game.scenes?.contents ?? []) {
    const entries = sceneSearchlights(scene).filter(entry => String(entry?.actorId ?? "") === String(actor.id ?? ""));
    for (const entry of entries) {
      changed = (await gmDisableSearchlight(scene.id, entry.tokenId)) || changed;
    }
  }
  return changed;
}

export function registerSearchlightSockets(existingSocket = null) {
  const socketlibApi = globalThis.socketlib;
  if (!existingSocket && !socketlibApi?.registerSystem) return null;
  systemSocket = existingSocket ?? socketlibApi.registerSystem(SYSTEM_ID);
  if (!systemSocket.functions?.has?.("gmAimSearchlight")) systemSocket.register("gmAimSearchlight", gmAimSearchlight);
  if (!systemSocket.functions?.has?.("gmDisableSearchlight")) systemSocket.register("gmDisableSearchlight", gmDisableSearchlight);
  return systemSocket;
}

export function registerSearchlightHooks(api = null) {
  if (globalThis.__ATOW_SEARCHLIGHT_HOOKS_REGISTERED__) return;
  globalThis.__ATOW_SEARCHLIGHT_HOOKS_REGISTERED__ = true;
  if (api?.api) {
    api.api.toggleMechSearchlight = toggleMechSearchlight;
    api.api.disableMechSearchlights = disableMechSearchlights;
    api.api.isTokenSearchlightIlluminated = isTokenSearchlightIlluminated;
    api.api.isTokenBattlefieldIlluminated = isTokenBattlefieldIlluminated;
  }
  Hooks.on("updateToken", (tokenDoc, changed, options) => {
    if (!game.user?.isGM || options?.atowSearchlight) return;
    if (!["x", "y", "elevation"].some(key => key in (changed ?? {}))) return;
    const scene = tokenDoc?.parent;
    const active = sourceState(scene, tokenDoc?.id);
    if (!active) return;
    const key = `${scene.id}:${tokenDoc.id}`;
    const previous = followTimers.get(key);
    if (previous) clearTimeout(previous);
    followTimers.set(key, setTimeout(() => {
      followTimers.delete(key);
      const current = sourceState(scene, tokenDoc.id);
      if (!current) return;
      gmAimSearchlight(scene.id, tokenDoc.id, current.end).catch(error => console.warn(`${SYSTEM_ID} | Searchlight follow sync failed`, error));
    }, 75));
  });
  Hooks.on("deleteToken", tokenDoc => {
    if (!game.user?.isGM || !sourceState(tokenDoc?.parent, tokenDoc?.id)) return;
    const key = `${tokenDoc.parent.id}:${tokenDoc.id}`;
    const pending = followTimers.get(key);
    if (pending) clearTimeout(pending);
    followTimers.delete(key);
    gmDisableSearchlight(tokenDoc.parent.id, tokenDoc.id).catch(error => console.warn(`${SYSTEM_ID} | Searchlight cleanup failed`, error));
  });
}
