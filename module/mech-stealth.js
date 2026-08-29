const SYSTEM_ID = "atow-battletech";
export const STEALTH_ARMOR_STATUS_ID = "stealth-active";
export const STEALTH_ARMOR_HEAT_PER_TURN = 10;

const STEALTH_LABEL_RE = /^stealth(?:\s+armor)?$/i;
const STEALTH_LOCATIONS = Object.freeze({
  la: "Left Arm",
  ra: "Right Arm",
  lt: "Left Torso",
  rt: "Right Torso",
  ll: "Left Leg",
  rl: "Right Leg"
});

function critSlots(actor, locKey) {
  const raw = actor?.system?.crit?.[locKey]?.slots ?? [];
  return Array.isArray(raw) ? raw : Object.values(raw);
}

function isStealthLabel(value) {
  return STEALTH_LABEL_RE.test(String(value ?? "").trim());
}

function getStartSlot(slots, index) {
  const slot = slots[index] ?? {};
  const startIndex = slot.partOf !== undefined && slot.partOf !== null ? Number(slot.partOf) : index;
  return { slot, startIndex, startSlot: slots[startIndex] ?? slot };
}

function countStealthSlotsInLocation(actor, locKey) {
  const slots = critSlots(actor, locKey);
  let total = 0;
  let intact = 0;
  for (let index = 0; index < slots.length; index += 1) {
    const { slot, startSlot } = getStartSlot(slots, index);
    if (!isStealthLabel(startSlot?.label)) continue;
    total += 1;
    if (!slot?.destroyed && !startSlot?.destroyed) intact += 1;
  }
  return { total, intact };
}

function actorECMIsDisabled(actor) {
  const flags = actor?.flags?.[SYSTEM_ID] ?? {};
  const system = actor?.system ?? {};
  if (flags.ecmDisabled === true) return true;
  if (actor?.getFlag?.(SYSTEM_ID, "ecmDisabled") === true) return true;
  return system?.ecm?.disabled === true || system?.mech?.ecmDisabled === true;
}

function mechIsShutdown(actor) {
  return Boolean(
    actor?.system?.heat?.shutdown
    || actor?.system?.heat?.effects?.shutdown?.active
    || actor?.getFlag?.(SYSTEM_ID, "shutdownManual")
  );
}

function installedECMSystems(actor) {
  const systems = [];
  for (const [locKey, location] of Object.entries(actor?.system?.crit ?? {})) {
    const raw = location?.slots ?? [];
    const slots = Array.isArray(raw) ? raw : Object.values(raw);
    for (let index = 0; index < slots.length; index += 1) {
      const slot = slots[index] ?? {};
      if (slot.partOf !== undefined && slot.partOf !== null) continue;
      const label = String(slot.label ?? "").trim();
      let name = null;
      let stealthCompatible = false;
      if (/\bguardian\s+ecm\b/i.test(label)) {
        name = "Guardian ECM";
        stealthCompatible = true;
      } else if (/\bangel\s+ecm\b/i.test(label)) {
        name = "Angel ECM";
        stealthCompatible = true;
      } else if (/\becm\s+suite\b/i.test(label)) {
        name = "ECM Suite";
      }
      if (!name) continue;

      const span = Math.max(1, Math.floor(Number(slot.span ?? 1) || 1));
      let destroyed = Boolean(slot.destroyed);
      for (let offset = 1; offset < span; offset += 1) destroyed ||= Boolean(slots[index + offset]?.destroyed);
      systems.push({ name, locKey, index, span, destroyed, stealthCompatible });
    }
  }
  return systems;
}

function installedC3Systems(actor) {
  const systems = [];
  for (const [locKey, location] of Object.entries(actor?.system?.crit ?? {})) {
    const raw = location?.slots ?? [];
    const slots = Array.isArray(raw) ? raw : Object.values(raw);
    for (let index = 0; index < slots.length; index += 1) {
      const slot = slots[index] ?? {};
      if (slot.partOf !== undefined && slot.partOf !== null) continue;
      const label = String(slot.label ?? "").trim();
      if (!/(?:^|\b)c3(?:i)?(?:\b|$)|command\s+control\s+computer/i.test(label)) continue;
      const span = Math.max(1, Math.floor(Number(slot.span ?? 1) || 1));
      let destroyed = Boolean(slot.destroyed);
      for (let offset = 1; offset < span; offset += 1) destroyed ||= Boolean(slots[index + offset]?.destroyed);
      systems.push({ name: label || "C3", locKey, index, span, destroyed });
    }
  }
  return systems;
}

export function getMechECMState(actor) {
  const systems = installedECMSystems(actor);
  const enabled = actor?.getFlag?.(SYSTEM_ID, "ecmEnabled") !== false;
  const externallyDisabled = actorECMIsDisabled(actor);
  return {
    installed: systems.length > 0,
    intact: systems.some(system => !system.destroyed),
    enabled,
    externallyDisabled,
    active: systems.some(system => !system.destroyed) && enabled && !externallyDisabled && !mechIsShutdown(actor),
    systems
  };
}

export function getMechC3State(actor) {
  const systems = installedC3Systems(actor);
  const enabled = actor?.getFlag?.(SYSTEM_ID, "c3Enabled") !== false;
  return {
    installed: systems.length > 0,
    intact: systems.some(system => !system.destroyed),
    enabled,
    active: systems.some(system => !system.destroyed) && enabled && !mechIsShutdown(actor),
    systems
  };
}

export function getOperationalECMName(actor, { stealthCompatibleOnly = false } = {}) {
  if (String(actor?.type ?? "").toLowerCase() !== "mech"
    || actorECMIsDisabled(actor)
    || actor?.getFlag?.(SYSTEM_ID, "ecmEnabled") === false
    || mechIsShutdown(actor)) return null;
  const system = installedECMSystems(actor).find(entry => !entry.destroyed && (!stealthCompatibleOnly || entry.stealthCompatible));
  return system?.name ?? null;
}

export function getStealthArmorState(actor) {
  const locations = {};
  for (const [locKey, label] of Object.entries(STEALTH_LOCATIONS)) {
    locations[locKey] = { label, ...countStealthSlotsInLocation(actor, locKey), required: 2 };
  }

  const totalSlots = Object.values(locations).reduce((sum, entry) => sum + entry.total, 0);
  const intactSlots = Object.values(locations).reduce((sum, entry) => sum + entry.intact, 0);
  const installed = Object.values(locations).every(entry => entry.total === entry.required);
  const critsOperational = Object.values(locations).every(entry => entry.total === entry.required && entry.intact === entry.required);
  const ecmSystems = installedECMSystems(actor).filter(entry => entry.stealthCompatible);
  const ecmInstalled = ecmSystems.length > 0;
  const ecmName = getOperationalECMName(actor, { stealthCompatibleOnly: true });
  const ecmOperational = Boolean(ecmName);
  const requestedActive = Boolean(actor?.getFlag?.(SYSTEM_ID, "stealthArmorActive") ?? actor?.flags?.[SYSTEM_ID]?.stealthArmorActive);
  const operational = installed && critsOperational && ecmOperational;

  return {
    locations,
    totalSlots,
    intactSlots,
    requiredSlots: 12,
    installed,
    critsOperational,
    ecmInstalled,
    ecmOperational,
    ecmName,
    requestedActive,
    operational,
    active: requestedActive && operational,
    heatPerTurn: STEALTH_ARMOR_HEAT_PER_TURN
  };
}

export function isStealthArmorActive(actor) {
  return getStealthArmorState(actor).active;
}

export function getStealthArmorTargetModifier(actor, rangeBand) {
  if (!isStealthArmorActive(actor)) return { mod: 0, applied: false, band: String(rangeBand ?? "") };
  const band = String(rangeBand ?? "").trim().toLowerCase();
  const mod = band.includes("medium") ? 1 : ((band.includes("long") || band.includes("extreme")) ? 2 : 0);
  return { mod, applied: true, band: String(rangeBand ?? "") };
}

async function setStealthStatus(actor, active) {
  if (!actor) return false;
  try {
    if (typeof actor.toggleStatusEffect === "function") {
      await actor.toggleStatusEffect(STEALTH_ARMOR_STATUS_ID, { active: Boolean(active) });
      return true;
    }
  } catch (_) {}

  const effects = Array.from(actor.effects ?? []);
  const existing = effects.find(effect => {
    const coreId = effect.getFlag?.("core", "statusId") ?? effect.flags?.core?.statusId;
    return coreId === STEALTH_ARMOR_STATUS_ID
      || effect.statuses?.has?.(STEALTH_ARMOR_STATUS_ID)
      || (Array.isArray(effect.statuses) && effect.statuses.includes(STEALTH_ARMOR_STATUS_ID));
  });
  if (active) {
    if (existing) {
      if (existing.disabled) await existing.update({ disabled: false });
      return true;
    }
    const definition = (CONFIG.statusEffects ?? []).find(effect => effect?.id === STEALTH_ARMOR_STATUS_ID) ?? {};
    const icon = definition.img ?? definition.icon ?? `systems/${SYSTEM_ID}/assets/status/stealth-active.svg`;
    await actor.createEmbeddedDocuments("ActiveEffect", [{
      name: definition.name ?? definition.label ?? "Stealth Armor Active",
      img: icon,
      icon,
      disabled: false,
      statuses: [STEALTH_ARMOR_STATUS_ID],
      flags: { core: { statusId: STEALTH_ARMOR_STATUS_ID } }
    }]);
    return true;
  }
  if (existing && !existing.disabled) await existing.update({ disabled: true });
  return true;
}

export async function toggleStealthArmor(actor) {
  if (!actor || String(actor.type ?? "").toLowerCase() !== "mech") {
    ui.notifications?.warn?.("Select or open a BattleMech to use Stealth Armor.");
    return false;
  }

  const current = getStealthArmorState(actor);
  if (current.requestedActive) {
    await actor.setFlag(SYSTEM_ID, "stealthArmorActive", false);
    await setStealthStatus(actor, false);
    ui.notifications?.info?.(`${actor.name}: Stealth Armor deactivated.`);
    return true;
  }
  if (mechIsShutdown(actor)) {
    ui.notifications?.warn?.("A shut-down BattleMech cannot activate Stealth Armor. Restart the 'Mech first.");
    return false;
  }
  if (!current.installed) {
    ui.notifications?.warn?.("Stealth Armor requires 12 critical slots: two in each arm, each leg, and each side torso.");
    return false;
  }
  if (!current.critsOperational) {
    ui.notifications?.warn?.("The Stealth Armor installation is damaged and cannot function.");
    return false;
  }
  if (!current.ecmInstalled) {
    ui.notifications?.warn?.("Stealth Armor requires Guardian ECM or Angel ECM equipment.");
    return false;
  }
  if (!current.ecmOperational) {
    ui.notifications?.warn?.("The required Guardian or Angel ECM is destroyed or disabled.");
    return false;
  }

  await actor.setFlag(SYSTEM_ID, "stealthArmorActive", true);
  await setStealthStatus(actor, true);
  ui.notifications?.info?.(`${actor.name}: Stealth Armor active. The system generates 10 heat per turn.`);
  return true;
}

export async function toggleMechECM(actor) {
  const state = getMechECMState(actor);
  if (!state.installed) {
    ui.notifications?.warn?.("This BattleMech has no ECM system installed.");
    return false;
  }
  if (state.enabled) {
    await actor.setFlag(SYSTEM_ID, "ecmEnabled", false);
    await syncStealthArmorState(actor);
    ui.notifications?.info?.(`${actor.name}: ECM switched off.`);
    return true;
  }
  if (mechIsShutdown(actor)) {
    ui.notifications?.warn?.("Restart the BattleMech before enabling ECM.");
    return false;
  }
  if (!state.intact) {
    ui.notifications?.warn?.("The installed ECM system is destroyed and cannot be enabled.");
    return false;
  }
  if (state.externallyDisabled) {
    ui.notifications?.warn?.("The installed ECM system is disabled and cannot be enabled.");
    return false;
  }
  await actor.setFlag(SYSTEM_ID, "ecmEnabled", true);
  ui.notifications?.info?.(`${actor.name}: ECM enabled.`);
  return true;
}

export async function toggleMechC3(actor) {
  const state = getMechC3State(actor);
  if (!state.installed) {
    ui.notifications?.warn?.("This BattleMech has no C3 system installed.");
    return false;
  }
  if (state.enabled) {
    await actor.setFlag(SYSTEM_ID, "c3Enabled", false);
    ui.notifications?.info?.(`${actor.name}: C3 switched off.`);
    return true;
  }
  if (mechIsShutdown(actor)) {
    ui.notifications?.warn?.("Restart the BattleMech before enabling C3.");
    return false;
  }
  if (!state.intact) {
    ui.notifications?.warn?.("The installed C3 system is destroyed and cannot be enabled.");
    return false;
  }
  await actor.setFlag(SYSTEM_ID, "c3Enabled", true);
  ui.notifications?.info?.(`${actor.name}: C3 enabled.`);
  return true;
}

/**
 * Power down active electronic systems. Flags deliberately remain disabled
 * after startup so the pilot must bring each system back online manually.
 */
export async function shutdownMechElectronics(actor) {
  if (!actor || String(actor.type ?? "").toLowerCase() !== "mech") return [];
  const updates = {};
  const disabled = [];
  if (getStealthArmorState(actor).requestedActive) {
    updates[`flags.${SYSTEM_ID}.stealthArmorActive`] = false;
    disabled.push("Stealth Armor");
  }
  const ecm = getMechECMState(actor);
  if (ecm.installed && ecm.enabled) {
    updates[`flags.${SYSTEM_ID}.ecmEnabled`] = false;
    disabled.push("ECM");
  }
  const c3 = getMechC3State(actor);
  if (c3.installed && c3.enabled) {
    updates[`flags.${SYSTEM_ID}.c3Enabled`] = false;
    disabled.push("C3");
  }
  if (actor.getFlag?.(SYSTEM_ID, "amsEnabled") !== false) {
    updates[`flags.${SYSTEM_ID}.amsEnabled`] = false;
    disabled.push("AMS");
  }
  if (actor.getFlag?.(SYSTEM_ID, "dazzleMode") === true) {
    updates[`flags.${SYSTEM_ID}.dazzleMode`] = false;
    disabled.push("Dazzle Mode");
  }
  for (const [flagName, label] of [["mascState", "MASC"], ["superchargerState", "Supercharger"]]) {
    const state = actor.getFlag?.(SYSTEM_ID, flagName) ?? {};
    if (!state.active) continue;
    updates[`flags.${SYSTEM_ID}.${flagName}.active`] = false;
    updates[`flags.${SYSTEM_ID}.${flagName}.successful`] = false;
    disabled.push(label);
  }
  if (Object.keys(updates).length) await actor.update(updates, { atowElectronicsShutdown: true });
  await setStealthStatus(actor, false);
  return disabled;
}

export async function syncStealthArmorState(actor) {
  if (!actor || String(actor.type ?? "").toLowerCase() !== "mech") return null;
  let state = getStealthArmorState(actor);
  if (state.requestedActive && !state.operational) {
    await actor.setFlag(SYSTEM_ID, "stealthArmorActive", false);
    state = getStealthArmorState(actor);
    ui.notifications?.warn?.(`${actor.name}: Stealth Armor shut down because its armor components or required ECM are no longer operational.`);
  }
  await setStealthStatus(actor, state.active);
  return state;
}

export function registerStealthArmorHooks(namespace = null) {
  if (namespace?.api) {
    namespace.api.getStealthArmorState = getStealthArmorState;
    namespace.api.isStealthArmorActive = isStealthArmorActive;
    namespace.api.toggleStealthArmor = toggleStealthArmor;
    namespace.api.getMechECMState = getMechECMState;
    namespace.api.toggleMechECM = toggleMechECM;
    namespace.api.getMechC3State = getMechC3State;
    namespace.api.toggleMechC3 = toggleMechC3;
    namespace.api.shutdownMechElectronics = shutdownMechElectronics;
  }
  if (globalThis.__ATOW_STEALTH_ARMOR_HOOKS_REGISTERED__) return;
  globalThis.__ATOW_STEALTH_ARMOR_HOOKS_REGISTERED__ = true;

  const timers = new Map();
  const schedule = actor => {
    if (!game.user?.isGM || String(actor?.type ?? "").toLowerCase() !== "mech") return;
    const key = String(actor.uuid ?? actor.id ?? "");
    if (!key) return;
    const prior = timers.get(key);
    if (prior) clearTimeout(prior);
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      syncStealthArmorState(actor).catch(error => console.warn(`${SYSTEM_ID} | Stealth Armor state sync failed`, error));
    }, 75));
  };

  Hooks.on("canvasReady", () => {
    const actors = new Set((canvas?.tokens?.placeables ?? []).map(token => token?.actor).filter(Boolean));
    for (const actor of actors) schedule(actor);
  });
  Hooks.on("updateActor", (actor, changed, options) => {
    if (options?.atowStealthArmorSync) return;
    const paths = Object.keys(foundry.utils.flattenObject(changed ?? {}));
    if (paths.some(path => path.startsWith("system.crit.")
      || path.includes("ecmDisabled")
      || path.includes("ecmEnabled")
      || path.includes("stealthArmorActive"))) schedule(actor);
  });
}
