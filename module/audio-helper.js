const SYSTEM_ID = "atow-battletech";

export const ATOW_AUDIO_CUES = {
  heatNominal: `systems/${SYSTEM_ID}/assets/sounds/heat-nominal.ogg`,
  heatModerate: `systems/${SYSTEM_ID}/assets/sounds/heat-moderate.ogg`,
  heatExceedingRecommended: `systems/${SYSTEM_ID}/assets/sounds/heat-exceeding-recommended.ogg`,
  heatCritical: `systems/${SYSTEM_ID}/assets/sounds/heat-critical.ogg`,
  heatCriticalLegacy: `systems/${SYSTEM_ID}/assets/sounds/heat-critical-legacy.ogg`,

  ammoDepleted: `systems/${SYSTEM_ID}/assets/sounds/status-ammo-depleted.ogg`,
  armorBreached: `systems/${SYSTEM_ID}/assets/sounds/status-armour-breached.ogg`,
  coolantFailure: `systems/${SYSTEM_ID}/assets/sounds/status-coolant-failure.ogg`,
  damageCritical: `systems/${SYSTEM_ID}/assets/sounds/status-damage-critical.ogg`,
  ejecting: `systems/${SYSTEM_ID}/assets/sounds/status-ejecting.ogg`,
  jumpjetFailure: `systems/${SYSTEM_ID}/assets/sounds/status-jumpjet-failure.ogg`,
  powerRestored: `systems/${SYSTEM_ID}/assets/sounds/status-power-restored.ogg`,
  shuttingDown: `systems/${SYSTEM_ID}/assets/sounds/status-shutting-down.ogg`,
  systemsNominal: `systems/${SYSTEM_ID}/assets/sounds/status-systems-nominal.ogg`,
  weaponDestroyed: `systems/${SYSTEM_ID}/assets/sounds/status-weapon-destroyed.ogg`,
  targetDestroyed: `systems/${SYSTEM_ID}/assets/sounds/target-destroyed.ogg`
};

export const ATOW_AUDIO_EFFECTS = {
  jumpjetLight: `systems/${SYSTEM_ID}/assets/sounds/effect-jumpjet-light.ogg`,
  jumpjetMedium: `systems/${SYSTEM_ID}/assets/sounds/effect-jumpjet-medium.ogg`,
  jumpjetHeavy: `systems/${SYSTEM_ID}/assets/sounds/effect-jumpjet-heavy.ogg`,
  jumpjetAssault: `systems/${SYSTEM_ID}/assets/sounds/effect-jumpjet-assault.ogg`,
  mechExplosion1: `systems/${SYSTEM_ID}/assets/sounds/effect-mechexplosion1.ogg`,
  mechExplosion2: `systems/${SYSTEM_ID}/assets/sounds/effect-mechexplosion2.ogg`,
  powerDown: `systems/${SYSTEM_ID}/assets/sounds/effect-powerdown.ogg`,
  powerUp: `systems/${SYSTEM_ID}/assets/sounds/effect-powerup.ogg`
};

const AUDIO_GAP_MS = 500;
const TURN_AUDIO_DELAY_MS = 250;
const HEAT_RESOLUTION_WAIT_MS = 25;
const HEAT_RESOLUTION_MAX_ATTEMPTS = 20;

const audioState = globalThis.__ATOW_BT_AUDIO_STATE__ ?? (globalThis.__ATOW_BT_AUDIO_STATE__ = {
  queue: Promise.resolve(),
  lastTurnAnnouncementByActor: new Map()
});

function logAudioDebug(message, data = null) {
  try {
    console.warn(`AToW Battletech | Audio Debug | ${message}`, data ?? "");
    const enabled = Boolean(game.settings?.get?.(SYSTEM_ID, "audioDebug"));
    if (enabled) {
      const suffix = data ? ` ${JSON.stringify(data)}` : "";
      ui.notifications?.info?.(`AToW Audio: ${message}${suffix}`);
    }
  } catch (_) {}
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function getCombatStamp(combat) {
  return `${combat?.id ?? "no-combat"}:${combat?.round ?? 0}:${combat?.turn ?? 0}`;
}

function getActiveCombatantTokenDoc(actor, combat) {
  const combatant = combat?.combatant ?? null;
  const tokenDoc = combatant?.token ?? null;
  if (tokenDoc?.actor && actor && tokenDoc.actor === actor) return tokenDoc;
  if (tokenDoc && actor?.id && tokenDoc.actor?.id === actor.id) return tokenDoc;
  return null;
}

async function waitForHeatResolution(actor, combat) {
  const tokenDoc = getActiveCombatantTokenDoc(actor, combat);
  if (!tokenDoc?.getFlag) return;
  const stamp = getCombatStamp(combat);

  for (let i = 0; i < HEAT_RESOLUTION_MAX_ATTEMPTS; i += 1) {
    const resolvedStamp = String(tokenDoc.getFlag(SYSTEM_ID, "heatResolvedStamp") ?? "");
    if (resolvedStamp === stamp) return;
    await wait(HEAT_RESOLUTION_WAIT_MS);
  }
}

function getUnventedHeat(actor) {
  const heat = actor?.system?.heat ?? {};
  const effects = heat.effects ?? {};
  return Number(
    heat.unvented ??
    effects.unvented ??
    heat.value ??
    heat.current ??
    0
  ) || 0;
}

function getTotalStructureDamage(actor) {
  const structure = actor?.system?.structure ?? {};
  let total = 0;
  for (const v of Object.values(structure)) {
    const n = Number(v?.dmg ?? 0);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

function getDerivedAmmoBins(actor) {
  const crit = actor?.system?.crit ?? {};
  const saved = actor?.system?.ammoBins ?? {};
  const totals = new Map();

  const ammoKeyFromType = (typeText) => {
    const t = String(typeText ?? "").trim().toLowerCase();
    if (/^(ac|lrm|srm)-\d+$/.test(t)) return t;

    let m = t.match(/\bac\s*\/?\s*(\d+)\b/i);
    if (m?.[1]) return `ac-${m[1]}`;

    m = t.match(/\b(lrm|srm)\s*-?\s*(\d+)\b/i);
    if (m?.[1] && m?.[2]) return `${String(m[1]).toLowerCase()}-${m[2]}`;

    if (t.includes("machine gun") || t === "mg") return "mg";

    return t.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
  };

  const add = (name, key, amt) => {
    if (!key || !Number.isFinite(amt) || amt <= 0) return;
    const prev = totals.get(key);
    if (!prev) totals.set(key, { key, name, total: amt });
    else prev.total += amt;
  };

  for (const loc of Object.values(crit)) {
    const slots = loc?.slots;
    if (!slots) continue;
    const iter = Array.isArray(slots) ? slots : Object.values(slots);

    for (const slot of iter) {
      const label = String(slot?.label ?? "").trim();
      if (!label) continue;
      const m = label.match(/^\s*Ammo\s*\(([^)]+)\)\s*(\d+)\s*$/i);
      if (!m) continue;

      const typeText = String(m[1] ?? "").trim();
      const amt = Number(m[2] ?? 0);
      const key = ammoKeyFromType(typeText);
      add(typeText, key, amt);
    }
  }

  const bins = [];
  for (const [key, row] of totals.entries()) {
    const total = Number(row.total ?? 0) || 0;
    const savedCur = Number(saved?.[key]?.current);
    const current = Number.isFinite(savedCur) ? Math.max(0, Math.min(total, savedCur)) : total;
    bins.push({
      key,
      name: row.name,
      total,
      current
    });
  }

  return bins;
}

function hasAnyDepletedAmmo(actor) {
  for (const bin of getDerivedAmmoBins(actor)) {
    if ((Number(bin?.total ?? 0) || 0) > 0 && (Number(bin?.current ?? 0) || 0) <= 0) return true;
  }
  return false;
}

function hasDestroyedCritComponent(actor) {
  const crit = actor?.system?.crit ?? {};
  for (const loc of Object.values(crit)) {
    const slots = loc?.slots;
    if (!slots) continue;
    const entries = Array.isArray(slots) ? slots : Object.values(slots);
    for (const slot of entries) {
      if (slot?.destroyed) return true;
    }
  }
  return false;
}

function getActorTokenDocs(actor) {
  return actor?.getActiveTokens?.(true, true)?.map?.(t => t?.document ?? t)?.filter(Boolean) ?? [];
}

function doesUserOwnActorOrAnyToken(actor, user) {
  if (!actor || !user) return false;
  try {
    if (actor.testUserPermission?.(user, "OWNER")) return true;
  } catch (_) {}
  try {
    const tokenDocs = getActorTokenDocs(actor);
    return tokenDocs.some(td => td?.testUserPermission?.(user, "OWNER"));
  } catch (_) {
    return false;
  }
}

export function shouldCurrentUserHearActorAnnouncements(actor) {
  const user = game.user;
  if (!actor || !user) return false;

  const iOwnIt = doesUserOwnActorOrAnyToken(actor, user);
  if (!iOwnIt) return false;

  // If I am the GM and an active non-GM owner exists, let the player hear it instead.
  if (user.isGM) {
    const activePlayerOwnerExists = Array.from(game.users ?? []).some(u =>
      u?.active &&
      !u?.isGM &&
      doesUserOwnActorOrAnyToken(actor, u)
    );
    if (activePlayerOwnerExists) return false;
  }

  return true;
}

async function playClipLocal(src, { volume = 0.8 } = {}) {
  const clip = String(src ?? "").trim();
  if (!clip) return;
  const encodedClip = encodeURI(clip);
  logAudioDebug("playClipLocal:start", { clip, encodedClip, volume });

  await new Promise((resolve) => {
    try {
      const helper = foundry?.audio?.AudioHelper ?? globalThis.AudioHelper ?? null;
      const normalizedVolume = Math.max(0, Math.min(1, Number(volume) || 0));
      const audio = new Audio(encodedClip);
      audio.preload = "auto";
      audio.volume = normalizedVolume;

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        audio.onended = null;
        audio.onerror = null;
        resolve();
      };

      audio.onended = finish;
      audio.onerror = finish;

      if (helper?.play) {
        logAudioDebug("playClipLocal:using-audiohelper", { clip: encodedClip });
        Promise.resolve(helper.play({ src: encodedClip, volume: normalizedVolume, autoplay: true, loop: false }, false))
          .catch((err) => {
            logAudioDebug("playClipLocal:audiohelper-error", {
              clip: encodedClip,
              error: String(err?.message ?? err ?? "unknown")
            });
          });
        audio.load();
      } else {
        logAudioDebug("playClipLocal:using-browser-audio", { clip: encodedClip });
        const playPromise = audio.play();
        if (playPromise?.catch) {
          playPromise.catch((err) => {
            logAudioDebug("playClipLocal:browser-audio-error", {
              clip: encodedClip,
              error: String(err?.message ?? err ?? "unknown")
            });
            finish();
          });
        }
      }

      audio.onloadedmetadata = () => {
        setTimeout(finish, Math.max(1500, (audio.duration > 0 ? audio.duration * 1000 : 0) + 250));
      };
      setTimeout(finish, 4000);
    } catch (_) {
      resolve();
    }
  });
}

export async function enqueueAudioCues(cues, { gapMs = AUDIO_GAP_MS, volume = 0.8 } = {}) {
  const keys = Array.isArray(cues) ? cues.filter(Boolean) : [];
  if (!keys.length) return;
  logAudioDebug("enqueueAudioCues", { keys, gapMs, volume });

  audioState.queue = audioState.queue.then(async () => {
    for (let i = 0; i < keys.length; i += 1) {
      const cue = keys[i];
      const src = ATOW_AUDIO_CUES[cue];
      if (!src) continue;
      await playClipLocal(src, { volume });
      if (i < (keys.length - 1)) await wait(gapMs);
    }
  }).catch((err) => {
    console.warn("AToW Battletech | Audio queue failed", err);
  });

  return audioState.queue;
}

export async function enqueueActorAudioCues(actor, cues, options = {}) {
  if (!actor) return;
  const allowed = shouldCurrentUserHearActorAnnouncements(actor);
  logAudioDebug("enqueueActorAudioCues", {
    actor: actor?.name,
    user: game.user?.name,
    allowed,
    cues
  });
  if (!allowed) return;
  return enqueueAudioCues(cues, options);
}

export async function playActorShutdownAnnouncement(actor, { volume = 1.0 } = {}) {
  if (!actor) return;
  if (!shouldCurrentUserHearActorAnnouncements(actor)) return;
  return enqueueAudioCues(["shuttingDown"], { volume }).then(() => playClipLocal(ATOW_AUDIO_EFFECTS.powerDown, { volume }));
}

export async function playActorPowerRestoredAnnouncement(actor, { volume = 0.9 } = {}) {
  if (!actor) return;
  if (!shouldCurrentUserHearActorAnnouncements(actor)) return;
  return enqueueAudioCues(["powerRestored"], { volume }).then(() => playClipLocal(ATOW_AUDIO_EFFECTS.powerUp, { volume }));
}

function getMechWeightClass(actor) {
  const tonnage = Number(actor?.system?.mech?.tonnage ?? actor?.system?.tonnage ?? 0) || 0;
  if (tonnage <= 35) return "light";
  if (tonnage <= 55) return "medium";
  if (tonnage <= 75) return "heavy";
  return "assault";
}

export async function playActorJumpjetEffect(actor, { volume = 0.9 } = {}) {
  if (!actor) return;

  const weightClass = getMechWeightClass(actor);
  const src = ({
    light: ATOW_AUDIO_EFFECTS.jumpjetLight,
    medium: ATOW_AUDIO_EFFECTS.jumpjetMedium,
    heavy: ATOW_AUDIO_EFFECTS.jumpjetHeavy,
    assault: ATOW_AUDIO_EFFECTS.jumpjetAssault
  })[weightClass] ?? ATOW_AUDIO_EFFECTS.jumpjetMedium;

  logAudioDebug("playActorJumpjetEffect", {
    actor: actor?.name,
    weightClass,
    src
  });

  try {
    const helper = foundry?.audio?.AudioHelper ?? globalThis.AudioHelper ?? null;
    if (helper?.play) {
      return await helper.play({ src, volume, autoplay: true, loop: false }, true);
    }
  } catch (err) {
    console.warn("AToW Battletech | Global jumpjet playback failed, falling back to local", err);
  }

  return playClipLocal(src, { volume });
}

export async function playActorMechExplosionEffect(actor, { volume = 1.0 } = {}) {
  if (!actor) return;

  const variants = [
    ATOW_AUDIO_EFFECTS.mechExplosion1,
    ATOW_AUDIO_EFFECTS.mechExplosion2
  ].filter(Boolean);
  if (!variants.length) return;

  const src = variants[Math.floor(Math.random() * variants.length)] ?? variants[0];

  logAudioDebug("playActorMechExplosionEffect", {
    actor: actor?.name,
    src
  });

  try {
    const helper = foundry?.audio?.AudioHelper ?? globalThis.AudioHelper ?? null;
    if (helper?.play) {
      return await helper.play({ src, volume, autoplay: true, loop: false }, true);
    }
  } catch (err) {
    console.warn("AToW Battletech | Global mech explosion playback failed, falling back to local", err);
  }

  return playClipLocal(src, { volume });
}

export function buildTurnStartAnnouncement(actor) {
  if (!actor || String(actor.type ?? "").toLowerCase() !== "mech") return [];

  const clips = [];
  const hasCriticalDamage = hasDestroyedCritComponent(actor);
  const structureDamage = getTotalStructureDamage(actor);
  const ammoBins = getDerivedAmmoBins(actor);
  const ammoDepleted = hasAnyDepletedAmmo(actor);
  const heat = getUnventedHeat(actor);

  logAudioDebug("buildTurnStartAnnouncement", {
    actor: actor?.name,
    hasCriticalDamage,
    structureDamage,
    ammoDepleted,
    ammoBins,
    savedAmmoBins: actor?.system?.ammoBins ?? {},
    heat
  });

  if (hasCriticalDamage) clips.push("damageCritical");
  else if (structureDamage > 0) clips.push("armorBreached");

  if (ammoDepleted) clips.push("ammoDepleted");

  if (heat >= 14) clips.push("heatCritical");
  else if (heat >= 9) clips.push("heatExceedingRecommended");
  else if (heat >= 5) clips.push("heatModerate");
  else clips.push("heatNominal");

  return clips;
}

export async function queueTurnStartAnnouncement(actor, combat) {
  if (!actor || !combat?.started) return;
  await waitForHeatResolution(actor, combat);
  const allowed = shouldCurrentUserHearActorAnnouncements(actor);
  const clips = buildTurnStartAnnouncement(actor);
  logAudioDebug("queueTurnStartAnnouncement", {
    actor: actor?.name,
    actorId: actor?.id,
    user: game.user?.name,
    userId: game.user?.id,
    combatStarted: combat?.started,
    round: combat?.round,
    turn: combat?.turn,
    allowed,
    clips
  });
  if (!allowed) return;

  const stamp = `${combat.round ?? 0}:${combat.turn ?? 0}`;
  const actorKey = String(actor.uuid ?? actor.id ?? "");
  if (!actorKey) return;

  if (audioState.lastTurnAnnouncementByActor.get(actorKey) === stamp) return;
  audioState.lastTurnAnnouncementByActor.set(actorKey, stamp);
  if (!clips.length) return;

  await wait(TURN_AUDIO_DELAY_MS);
  return enqueueAudioCues(clips);
}

export function registerAtowAudioHooks() {
  if (globalThis.__ATOW_BT_AUDIO_HOOKS_REGISTERED__) return;
  globalThis.__ATOW_BT_AUDIO_HOOKS_REGISTERED__ = true;

  Hooks.on("updateCombat", (combat, changed) => {
    logAudioDebug("hook:updateCombat", {
      changed,
      combatStarted: combat?.started,
      combatantActor: combat?.combatant?.actor?.name ?? null,
      user: game.user?.name
    });
    if (!combat?.started) return;
    if (!("turn" in changed || "round" in changed)) return;

    const actor = combat?.combatant?.actor ?? null;
    if (!actor) return;

    queueTurnStartAnnouncement(actor, combat).catch(err => {
      console.warn("AToW Battletech | Turn-start announcement failed", err);
    });
  });
}
