const SYSTEM_ID = "atow-battletech";
const WALL_HEIGHT_SCOPE = "wall-height";
const MECH_VISION_HEIGHT = 2;

function isResponsibleGM() {
  if (!game.user?.isGM) return false;
  const activeGM = game.users?.activeGM ?? null;
  return !activeGM || activeGM.id === game.user.id;
}

function isMech(actor) {
  return String(actor?.type ?? "").trim().toLowerCase() === "mech";
}

function configuredHeight(document) {
  const value = document?.getFlag?.(WALL_HEIGHT_SCOPE, "tokenHeight")
    ?? document?.flags?.[WALL_HEIGHT_SCOPE]?.tokenHeight;
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function needsDefaultHeight(document) {
  return configuredHeight(document) <= 0;
}

export async function ensureMechTokenVisionHeight(tokenDoc) {
  if (!isResponsibleGM() || !tokenDoc || !isMech(tokenDoc.actor) || !needsDefaultHeight(tokenDoc)) return false;
  await tokenDoc.update({
    [`flags.${WALL_HEIGHT_SCOPE}.tokenHeight`]: MECH_VISION_HEIGHT
  }, { atowMechVisionHeight: true });
  return true;
}

async function ensureMechPrototypeVisionHeight(actor) {
  if (!isResponsibleGM() || !isMech(actor) || !needsDefaultHeight(actor.prototypeToken)) return false;
  await actor.update({
    [`prototypeToken.flags.${WALL_HEIGHT_SCOPE}.tokenHeight`]: MECH_VISION_HEIGHT
  }, { atowMechVisionHeight: true });
  return true;
}

async function syncSceneMechVisionHeights(scene = canvas?.scene ?? null) {
  if (!isResponsibleGM() || !scene) return;
  for (const tokenDoc of scene.tokens?.contents ?? []) {
    await ensureMechTokenVisionHeight(tokenDoc);
  }
}

export function registerMechVisionHeight(api = null) {
  if (globalThis.__ATOW_MECH_VISION_HEIGHT_REGISTERED__) return;
  globalThis.__ATOW_MECH_VISION_HEIGHT_REGISTERED__ = true;

  if (api?.api) {
    api.api.ensureMechTokenVisionHeight = ensureMechTokenVisionHeight;
    api.config.mechVisionHeight = MECH_VISION_HEIGHT;
  }

  Hooks.once("ready", async () => {
    if (!isResponsibleGM()) return;
    for (const actor of game.actors?.contents ?? []) {
      if (!isMech(actor)) continue;
      await ensureMechPrototypeVisionHeight(actor).catch(error => {
        console.warn(`${SYSTEM_ID} | Could not set ${actor.name} prototype vision height`, error);
      });
    }
  });

  Hooks.on("canvasReady", () => {
    syncSceneMechVisionHeights(canvas?.scene).catch(error => {
      console.warn(`${SYSTEM_ID} | Mech token vision-height sync failed`, error);
    });
  });

  Hooks.on("preCreateToken", tokenDoc => {
    if (!isMech(tokenDoc?.actor) || !needsDefaultHeight(tokenDoc)) return;
    tokenDoc.updateSource({
      flags: {
        ...(tokenDoc.flags ?? {}),
        [WALL_HEIGHT_SCOPE]: {
          ...(tokenDoc.flags?.[WALL_HEIGHT_SCOPE] ?? {}),
          tokenHeight: MECH_VISION_HEIGHT
        }
      }
    });
  });

  Hooks.on("createToken", tokenDoc => {
    ensureMechTokenVisionHeight(tokenDoc).catch(error => {
      console.warn(`${SYSTEM_ID} | New mech token vision-height sync failed`, error);
    });
  });

  Hooks.on("createActor", actor => {
    ensureMechPrototypeVisionHeight(actor).catch(error => {
      console.warn(`${SYSTEM_ID} | New mech prototype vision-height sync failed`, error);
    });
  });
}
