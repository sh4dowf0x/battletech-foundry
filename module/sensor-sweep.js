const SYSTEM_ID = "atow-battletech";
const SENSOR_RANGE_HEXES = 30;
const SENSOR_BLIP_DURATION_MS = 5 * 60 * 1000;
const SENSOR_LABEL_REFERENCE_GRID = 125;
const SENSOR_LABEL_REFERENCE_FONT_SIZE = 24;

const activeSensorSweeps = new Map();

const SENSOR_CONTACT_TYPES = new Set([
  "mech",
  "abomination",
  "wheeledvehicle",
  "vehicle",
  "vtol",
  "dropship"
]);

const SENSOR_ANIMATIONS = Object.freeze({
  friendly: `systems/${SYSTEM_ID}/assets/animations/friendly-target.webm`,
  hostile: `systems/${SYSTEM_ID}/assets/animations/hostile-target.webm`,
  neutral: `systems/${SYSTEM_ID}/assets/animations/target.webm`
});

function tokenDocument(tokenLike) {
  return tokenLike?.document ?? tokenLike ?? null;
}

function tokenCenter(tokenLike) {
  const document = tokenDocument(tokenLike);
  const objectCenter = document?.object?.center;
  if (objectCenter && Number.isFinite(objectCenter.x) && Number.isFinite(objectCenter.y)) {
    return { x: objectCenter.x, y: objectCenter.y };
  }
  const sizeX = Number(canvas?.grid?.sizeX ?? canvas?.grid?.size ?? canvas?.dimensions?.size ?? 100) || 100;
  const sizeY = Number(canvas?.grid?.sizeY ?? canvas?.grid?.size ?? canvas?.dimensions?.size ?? sizeX) || sizeX;
  return {
    x: (Number(document?.x ?? 0) || 0) + ((Number(document?.width ?? 1) || 1) * sizeX / 2),
    y: (Number(document?.y ?? 0) || 0) + ((Number(document?.height ?? 1) || 1) * sizeY / 2)
  };
}

function pointInPlayableScene(point, scene = canvas?.scene ?? null) {
  if (!point || !scene) return false;
  const dimensions = canvas?.dimensions;
  const sceneRect = dimensions?.sceneRect;
  if (typeof sceneRect?.contains === "function") return sceneRect.contains(point.x, point.y);

  const left = Number(dimensions?.sceneX ?? 0) || 0;
  const top = Number(dimensions?.sceneY ?? 0) || 0;
  const width = Number(dimensions?.sceneWidth ?? scene?.width ?? 0) || 0;
  const height = Number(dimensions?.sceneHeight ?? scene?.height ?? 0) || 0;
  return point.x >= left && point.x <= left + width
    && point.y >= top && point.y <= top + height;
}

function tokenInPlayableScene(tokenLike, scene = canvas?.scene ?? null) {
  return pointInPlayableScene(tokenCenter(tokenLike), scene);
}

function distanceInHexes(source, target, scene = canvas?.scene ?? null) {
  try {
    const measured = canvas?.grid?.measurePath?.([source, target]);
    const distance = Number(measured?.distance);
    const gridDistance = Number(scene?.grid?.distance ?? 1) || 1;
    if (Number.isFinite(distance)) return distance / gridDistance;
  } catch (_) {}

  try {
    const measured = canvas?.grid?.measureDistances?.([{ ray: new Ray(source, target) }], { gridSpaces: true })?.[0];
    const gridDistance = Number(scene?.grid?.distance ?? 1) || 1;
    if (Number.isFinite(Number(measured))) return Number(measured) / gridDistance;
  } catch (_) {}

  const gridSize = Number(canvas?.grid?.size ?? canvas?.dimensions?.size ?? 100) || 100;
  return Math.hypot(target.x - source.x, target.y - source.y) / gridSize;
}

function resolveSourceToken(actor, suppliedToken = null) {
  const scene = canvas?.scene;
  const supplied = tokenDocument(suppliedToken);
  if (supplied?.actor?.id === actor?.id && supplied?.parent?.id === scene?.id) return supplied;

  const controlled = canvas?.tokens?.controlled?.find(token => token?.actor?.id === actor?.id)?.document;
  if (controlled) return controlled;

  return actor?.getActiveTokens?.(true, true)
    ?.map(tokenDocument)
    .find(document => document?.parent?.id === scene?.id)
    ?? actor?.getActiveTokens?.()
      ?.map(tokenDocument)
      .find(document => document?.parent?.id === scene?.id)
    ?? null;
}

function isVehicleContact(tokenLike) {
  const document = tokenDocument(tokenLike);
  const actorType = String(document?.actor?.type ?? "").trim().toLowerCase();
  return SENSOR_CONTACT_TYPES.has(actorType);
}

function dispositionKind(tokenLike) {
  const disposition = Number(tokenDocument(tokenLike)?.disposition ?? 0) || 0;
  if (disposition > 0) return "friendly";
  if (disposition < 0) return "hostile";
  return "neutral";
}

function mechWeightClass(tonnage) {
  const tons = Number(tonnage) || 0;
  if (tons <= 0) return "BattleMech";
  if (tons <= 35) return "Light Mech";
  if (tons <= 55) return "Medium Mech";
  if (tons <= 75) return "Heavy Mech";
  return "Assault Mech";
}

function sensorClassification(tokenLike) {
  const actor = tokenDocument(tokenLike)?.actor;
  const type = String(actor?.type ?? "").trim().toLowerCase();
  if (type === "mech") return mechWeightClass(actor?.system?.mech?.tonnage);
  if (type === "vtol") return "VTOL";
  if (type === "dropship") return "DropShip";
  if (type === "abomination") return "Abomination";
  if (type === "vehicle") return "Vehicle";
  if (type === "wheeledvehicle") {
    const movement = String(actor?.system?.vehicle?.movement?.type ?? "").trim().toLowerCase();
    if (movement === "tracked") return "Tank";
    if (movement === "wheeled") return "Wheeled Vehicle";
    if (movement === "hovercraft" || movement === "hover") return "Hovercraft";
    if (movement === "naval" || movement === "hydrofoil") return "Naval Vehicle";
    if (movement === "wige") return "WiGE Vehicle";
    return "Combat Vehicle";
  }
  return "Contact";
}

function sensorContactLabel(tokenLike, disposition, classification) {
  if (disposition !== "friendly") return classification;
  const document = tokenDocument(tokenLike);
  return String(document?.name ?? document?.actor?.name ?? classification).trim() || classification;
}

function sensorLabelStyle(disposition) {
  const gridSize = Number(canvas?.grid?.size ?? canvas?.dimensions?.size ?? SENSOR_LABEL_REFERENCE_GRID)
    || SENSOR_LABEL_REFERENCE_GRID;
  const gridRatio = Math.max(0.01, gridSize / SENSOR_LABEL_REFERENCE_GRID);
  // Sequencer multiplies attached text by (150 / grid size). To make the
  // final label itself scale linearly with a hex, our requested font must use
  // the square of the grid ratio. A linear adjustment merely cancels
  // Sequencer's normalization and leaves tiny-grid labels screen-sized.
  const fontSize = Math.min(384, Math.max(0.5,
    SENSOR_LABEL_REFERENCE_FONT_SIZE * gridRatio * gridRatio));
  const detailScale = Math.min(4, Math.max(0.2, gridRatio));
  const fill = disposition === "friendly"
    ? "#70e38b"
    : disposition === "hostile"
      ? "#ff6565"
      : "#f2f2f2";
  return {
    fill,
    fontSize,
    fontWeight: "bold",
    align: "center",
    stroke: "#05080a",
    strokeThickness: 5 * detailScale,
    dropShadow: true,
    dropShadowColor: "#000000",
    dropShadowBlur: 3 * detailScale,
    dropShadowDistance: 2 * detailScale,
    anchor: { x: 0.5, y: -1.6 }
  };
}

function sequencerAvailable() {
  return Boolean(game?.modules?.get?.("sequencer")?.active) && typeof globalThis.Sequence === "function";
}

function sensorSweepKey(sourceToken) {
  return String(sourceToken?.uuid ?? `${sourceToken?.parent?.id ?? canvas?.scene?.id ?? "scene"}.${sourceToken?.id ?? "token"}`);
}

async function clearSensorSweep(sourceToken) {
  const key = sensorSweepKey(sourceToken);
  const active = activeSensorSweeps.get(key);
  if (!active) return;
  window.clearTimeout(active.timeoutId);
  activeSensorSweeps.delete(key);
  if (!globalThis.Sequencer?.EffectManager?.endEffects) return;
  await Promise.allSettled(active.names.map(name =>
    globalThis.Sequencer.EffectManager.endEffects({ name }, false)));
}

export function getSensorContacts(actor, suppliedToken = null, { range = SENSOR_RANGE_HEXES } = {}) {
  const scene = canvas?.scene;
  const sourceToken = resolveSourceToken(actor, suppliedToken);
  if (!scene || !sourceToken) return { sourceToken, sourceOnMap: false, contacts: [] };

  const origin = tokenCenter(sourceToken);
  const sourceOnMap = pointInPlayableScene(origin, scene);
  if (!sourceOnMap) return { sourceToken, sourceOnMap, contacts: [] };
  const maximumRange = Math.max(0, Number(range) || SENSOR_RANGE_HEXES);
  const contacts = Array.from(scene.tokens?.contents ?? scene.tokens ?? [])
    .filter(token => token?.id !== sourceToken.id)
    .filter(isVehicleContact)
    .filter(token => tokenInPlayableScene(token, scene))
    .map(token => {
      const disposition = dispositionKind(token);
      const classification = sensorClassification(token);
      return {
        token,
        range: distanceInHexes(origin, tokenCenter(token), scene),
        disposition,
        classification,
        label: sensorContactLabel(token, disposition, classification)
      };
    })
    .filter(contact => Number.isFinite(contact.range) && contact.range <= maximumRange + 0.001)
    .sort((left, right) => left.range - right.range);

  return { sourceToken, sourceOnMap, contacts };
}

export async function runMechSensorSweep(actor, suppliedToken = null) {
  if (!actor || String(actor.type ?? "").toLowerCase() !== "mech") {
    ui.notifications?.warn?.("Select or open a BattleMech to use active sensors.");
    return false;
  }
  if (!actor.isOwner && !game.user?.isGM) {
    ui.notifications?.warn?.("You must own this BattleMech to activate its sensors.");
    return false;
  }
  if (!canvas?.ready || !canvas?.scene) {
    ui.notifications?.warn?.("Open the scene containing this BattleMech before activating sensors.");
    return false;
  }
  if (!sequencerAvailable()) {
    ui.notifications?.warn?.("Active sensor blips require the Sequencer module.");
    return false;
  }

  const { sourceToken, sourceOnMap, contacts } = getSensorContacts(actor, suppliedToken);
  if (!sourceToken) {
    ui.notifications?.warn?.("Place this BattleMech on the active scene before activating sensors.");
    return false;
  }
  if (!sourceOnMap) {
    ui.notifications?.warn?.("Move this BattleMech out of the scene padding area before activating sensors.");
    return false;
  }
  await clearSensorSweep(sourceToken);
  if (!contacts.length) {
    ui.notifications?.info?.(`Sensors: no vehicle contacts detected within ${SENSOR_RANGE_HEXES} hexes.`);
    return true;
  }

  const sequence = new Sequence({ moduleName: SYSTEM_ID, softFail: true });
  const effectNames = [];
  for (const contact of contacts) {
    const location = contact.token?.object ?? contact.token;
    const effectName = `${SYSTEM_ID}.sensor.${game.user?.id ?? "user"}.${sourceToken.id}.${contact.token.id}`;
    effectNames.push(effectName);
    sequence
      .effect()
      .file(SENSOR_ANIMATIONS[contact.disposition] ?? SENSOR_ANIMATIONS.neutral)
      .attachTo(location, {
        bindVisibility: false,
        bindAlpha: false,
        bindElevation: true,
        bindScale: true,
        bindRotation: false
      })
      .scaleToObject(1.35)
      .aboveLighting()
      .xray()
      .opacity(0.95)
      .text(contact.label, sensorLabelStyle(contact.disposition))
      .fadeOut(750)
      .loopOptions({ loops: 0, loopDelay: 0 })
      .persist()
      .temporary()
      .name(effectName);
  }

  // Critical: this prevents sensor information from being broadcast to other
  // clients. Only the player who clicked Sensors sees these classification blips.
  await sequence.play({ local: true });
  const sweepKey = sensorSweepKey(sourceToken);
  const timeoutId = window.setTimeout(() => {
    const active = activeSensorSweeps.get(sweepKey);
    if (!active || active.timeoutId !== timeoutId) return;
    activeSensorSweeps.delete(sweepKey);
    if (!globalThis.Sequencer?.EffectManager?.endEffects) return;
    for (const name of active.names) {
      globalThis.Sequencer.EffectManager.endEffects({ name }, false).catch(() => {});
    }
  }, SENSOR_BLIP_DURATION_MS);
  activeSensorSweeps.set(sweepKey, { names: effectNames, timeoutId });
  ui.notifications?.info?.(`Sensors: ${contacts.length} vehicle contact${contacts.length === 1 ? "" : "s"} identified for 5 minutes.`);
  return true;
}

export const ATOW_SENSOR_SWEEP = Object.freeze({
  rangeHexes: SENSOR_RANGE_HEXES,
  blipDurationMs: SENSOR_BLIP_DURATION_MS,
  labelReferenceGrid: SENSOR_LABEL_REFERENCE_GRID,
  contactTypes: [...SENSOR_CONTACT_TYPES],
  animations: SENSOR_ANIMATIONS
});
