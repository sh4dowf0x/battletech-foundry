const SYSTEM_ID = "atow-battletech";
const WALL_FLAG = "buildingVisionWall";
const SYNC_DELAY_MS = 50;

const pendingSceneSyncs = new Map();

function isResponsibleGM() {
  if (!game.user?.isGM) return false;
  const activeGM = game.users?.activeGM ?? null;
  return !activeGM || activeGM.id === game.user.id;
}

function isVisionBlockingBuilding(tokenDoc) {
  const actor = tokenDoc?.actor ?? null;
  if (String(actor?.type ?? "").toLowerCase() !== "building") return false;
  const building = actor.system?.building ?? {};
  return String(building.classification ?? "").trim().toLowerCase() === "wall"
    && Number(building.levels ?? 0) >= 2
    && !Boolean(building.defeated);
}

function wallFlag(wall) {
  return wall?.flags?.[SYSTEM_ID]?.[WALL_FLAG] ?? null;
}

function managedWalls(scene) {
  return Array.from(scene?.walls?.contents ?? scene?.walls ?? [])
    .filter(wall => Boolean(wallFlag(wall)));
}

function tokenCenter(tokenDoc) {
  const scene = tokenDoc?.parent ?? canvas?.scene ?? null;
  const gridSize = Number(scene?.grid?.size ?? canvas?.dimensions?.size ?? 100) || 100;
  const width = Number(tokenDoc?.object?.w ?? (Number(tokenDoc?.width ?? 1) * gridSize)) || gridSize;
  const height = Number(tokenDoc?.object?.h ?? (Number(tokenDoc?.height ?? 1) * gridSize)) || gridSize;
  return {
    x: (Number(tokenDoc?.x ?? 0) || 0) + (width / 2),
    y: (Number(tokenDoc?.y ?? 0) || 0) + (height / 2)
  };
}

function offsetKey(offset) {
  if (Array.isArray(offset) && offset.length >= 2) return `${offset[0]},${offset[1]}`;
  if (!offset || typeof offset !== "object") return null;
  const first = offset.i ?? offset.row ?? offset.r ?? offset.y;
  const second = offset.j ?? offset.column ?? offset.col ?? offset.q ?? offset.x;
  if (!Number.isFinite(Number(first)) || !Number.isFinite(Number(second))) return null;
  return `${Number(first)},${Number(second)}`;
}

function tokensAreAdjacent(scene, left, right) {
  const leftCenter = tokenCenter(left);
  const rightCenter = tokenCenter(right);
  const grid = scene?.id === canvas?.scene?.id ? canvas?.grid : null;

  try {
    if (grid?.getOffset && grid?.getAdjacentOffsets) {
      const leftOffset = grid.getOffset(leftCenter);
      const rightKey = offsetKey(grid.getOffset(rightCenter));
      const adjacentKeys = (grid.getAdjacentOffsets(leftOffset) ?? []).map(offsetKey);
      if (rightKey && adjacentKeys.includes(rightKey)) return true;
      if (rightKey) return false;
    }
  } catch (_) {
    // Fall through to the pixel-distance check for unusual/custom grids.
  }

  const distance = Math.hypot(rightCenter.x - leftCenter.x, rightCenter.y - leftCenter.y);
  const gridSize = Number(scene?.grid?.size ?? canvas?.dimensions?.size ?? 100) || 100;
  return distance > 1 && distance <= (gridSize * 1.1);
}

function connectionKey(leftId, rightId) {
  return [String(leftId), String(rightId)].sort().join(":");
}

function tokenHeightBounds(tokenDoc) {
  const bottom = Number(tokenDoc?.elevation ?? 0) || 0;
  const levels = Math.max(0, Number(tokenDoc?.actor?.system?.building?.levels ?? 0) || 0);
  return { bottom, top: bottom + levels };
}

function sameHeightBounds(left, right) {
  return Math.abs(left.bottom - right.bottom) < 0.0001
    && Math.abs(left.top - right.top) < 0.0001;
}

function wallSource(connection, coordinates) {
  const senses = CONST.WALL_SENSE_TYPES ?? {};
  return {
    c: coordinates,
    // A centered normal wall leaves its own structure token visible while
    // stopping vision immediately behind the connected wall line.
    light: senses.NORMAL ?? 1,
    move: senses.NONE ?? 0,
    sight: senses.NORMAL ?? 1,
    sound: senses.NONE ?? 0,
    dir: CONST.WALL_DIRECTIONS?.BOTH ?? 0,
    door: CONST.WALL_DOOR_TYPES?.NONE ?? 0,
    ds: CONST.WALL_DOOR_STATES?.CLOSED ?? 0,
    flags: {
      "wall-height": {
        bottom: connection.bottom,
        top: connection.top
      },
      [SYSTEM_ID]: {
        [WALL_FLAG]: {
          connectionKey: connection.key,
          tokenIds: connection.tokenIds
        }
      }
    }
  };
}

function desiredConnections(scene) {
  const tokens = Array.from(scene?.tokens?.contents ?? scene?.tokens ?? [])
    .filter(isVisionBlockingBuilding);
  const connections = new Map();

  for (let leftIndex = 0; leftIndex < tokens.length; leftIndex += 1) {
    const left = tokens[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < tokens.length; rightIndex += 1) {
      const right = tokens[rightIndex];
      if (!tokensAreAdjacent(scene, left, right)) continue;
      const key = connectionKey(left.id, right.id);
      const leftCenter = tokenCenter(left);
      const rightCenter = tokenCenter(right);
      const leftBounds = tokenHeightBounds(left);
      const rightBounds = tokenHeightBounds(right);
      const tokenIds = [left.id, right.id];

      if (sameHeightBounds(leftBounds, rightBounds)) {
        connections.set(key, {
          key,
          tokenIds,
          ...leftBounds,
          coordinates: [leftCenter.x, leftCenter.y, rightCenter.x, rightCenter.y]
            .map(value => Math.round(value))
        });
        continue;
      }

      const midpoint = {
        x: (leftCenter.x + rightCenter.x) / 2,
        y: (leftCenter.y + rightCenter.y) / 2
      };
      for (const [token, start, end, bounds] of [
        [left, leftCenter, midpoint, leftBounds],
        [right, midpoint, rightCenter, rightBounds]
      ]) {
        const segmentKey = `${key}:${token.id}`;
        connections.set(segmentKey, {
          key: segmentKey,
          tokenIds,
          ...bounds,
          coordinates: [start.x, start.y, end.x, end.y].map(value => Math.round(value))
        });
      }
    }
  }
  return connections;
}

export async function syncBuildingVisionWalls(scene = canvas?.scene ?? null) {
  if (!isResponsibleGM() || !scene) return;
  const desired = desiredConnections(scene);
  const existingByKey = new Map();
  const deleteIds = [];

  for (const wall of managedWalls(scene)) {
    const key = String(wallFlag(wall)?.connectionKey ?? "");
    // This also removes the older square/hex perimeter walls, whose flags
    // used tokenId and segment instead of a connection key.
    if (!key || !desired.has(key) || existingByKey.has(key)) deleteIds.push(wall.id);
    else existingByKey.set(key, wall);
  }

  const updates = [];
  const creates = [];
  for (const connection of desired.values()) {
    const source = wallSource(connection, connection.coordinates);
    const existing = existingByKey.get(connection.key);
    if (existing) updates.push({ _id: existing.id, ...source });
    else creates.push(source);
  }

  if (deleteIds.length) {
    await scene.deleteEmbeddedDocuments("Wall", deleteIds.filter(Boolean), { atowBuildingVision: true });
  }
  if (updates.length) {
    await scene.updateEmbeddedDocuments("Wall", updates, { atowBuildingVision: true });
  }
  if (creates.length) {
    await scene.createEmbeddedDocuments("Wall", creates, { atowBuildingVision: true });
  }
}

export async function syncBuildingTokenVisionWalls(tokenDoc) {
  return syncBuildingVisionWalls(tokenDoc?.parent ?? canvas?.scene ?? null);
}

function scheduleSceneSync(scene) {
  if (!isResponsibleGM() || !scene?.id) return;
  const previous = pendingSceneSyncs.get(scene.id);
  if (previous) clearTimeout(previous);
  pendingSceneSyncs.set(scene.id, setTimeout(() => {
    pendingSceneSyncs.delete(scene.id);
    syncBuildingVisionWalls(scene).catch(error => {
      console.warn(`${SYSTEM_ID} | Connected building-wall sync failed`, error);
    });
  }, SYNC_DELAY_MS));
}

export function registerBuildingVisionWalls(api = null) {
  if (globalThis.__ATOW_BUILDING_VISION_WALLS_REGISTERED__) return;
  globalThis.__ATOW_BUILDING_VISION_WALLS_REGISTERED__ = true;

  if (api?.api) {
    api.api.syncBuildingVisionWalls = syncBuildingVisionWalls;
    api.api.syncBuildingTokenVisionWalls = syncBuildingTokenVisionWalls;
  }

  Hooks.on("canvasReady", () => {
    syncBuildingVisionWalls(canvas?.scene).catch(error => {
      console.warn(`${SYSTEM_ID} | Initial connected building-wall sync failed`, error);
    });
  });

  Hooks.on("createToken", tokenDoc => scheduleSceneSync(tokenDoc?.parent));
  Hooks.on("updateToken", (tokenDoc, changed) => {
    if (["x", "y", "width", "height", "elevation", "actorId", "actorData", "delta"].some(key => key in (changed ?? {}))) {
      scheduleSceneSync(tokenDoc?.parent);
    }
  });
  Hooks.on("deleteToken", tokenDoc => scheduleSceneSync(tokenDoc?.parent));

  Hooks.on("updateActor", actor => {
    if (String(actor?.type ?? "").toLowerCase() !== "building") return;
    const scene = canvas?.scene ?? null;
    if (!scene) return;
    const usedOnScene = Array.from(scene.tokens?.contents ?? scene.tokens ?? [])
      .some(tokenDoc => String(tokenDoc.actorId ?? "") === String(actor.id ?? ""));
    if (usedOnScene) scheduleSceneSync(scene);
  });
}
