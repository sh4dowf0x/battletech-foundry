// module/abomination-attack.js
// Abomination weapon-attack flow, reusing core mech-attack math.

import { calcRangeBandAndMod, calcTargetMoveModFromHexes, rollWeaponAttack } from "./mech-attack.js";

const SYSTEM_ID = "atow-battletech";
const TEMPLATE = `systems/${SYSTEM_ID}/templates/abomination-attack.hbs`;

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function getAttackerToken(actor) {
  const controlled = canvas?.tokens?.controlled ?? [];
  const matchControlled = controlled.find(t => t?.actor?.id === actor?.id);
  if (matchControlled) return matchControlled;

  const active = actor?.getActiveTokens?.(true, true) ?? actor?.getActiveTokens?.() ?? [];
  const tok = active?.[0] ?? null;
  return tok?.object ?? tok ?? null;
}

function getSingleTargetToken() {
  const targets = [...(game?.user?.targets ?? [])];
  if (targets.length !== 1) return null;
  return targets[0] ?? null;
}

function getTokenCenter(tokenLike) {
  if (!tokenLike) return null;

  const c = tokenLike?.center;
  if (c && Number.isFinite(c.x) && Number.isFinite(c.y)) return c;

  const oc = tokenLike?.object?.center;
  if (oc && Number.isFinite(oc.x) && Number.isFinite(oc.y)) return oc;

  const x = tokenLike?.x ?? tokenLike?.document?.x;
  const y = tokenLike?.y ?? tokenLike?.document?.y;
  const w = tokenLike?.width ?? tokenLike?.document?.width;
  const h = tokenLike?.height ?? tokenLike?.document?.height;

  if (!canvas?.grid) return null;
  const size = canvas.grid.size ?? canvas.dimensions?.size;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(size)) return null;

  return { x: x + (w * size) / 2, y: y + (h * size) / 2 };
}

function measureTokenDistance(attackerToken, targetToken) {
  if (!canvas?.grid || !attackerToken || !targetToken) return null;

  const a = getTokenCenter(attackerToken);
  const b = getTokenCenter(targetToken);
  if (!a || !b) return null;

  const ray = new Ray(a, b);
  const distances = canvas.grid.measureDistances([{ ray }], { gridSpaces: true });
  return num(distances?.[0], null);
}

function getAutoTargetMoveData(targetToken) {
  const tokenDoc = targetToken?.document ?? targetToken;
  const moved = num(tokenDoc?.getFlag?.(SYSTEM_ID, "movedThisTurn"), 0);
  const mod = calcTargetMoveModFromHexes(moved);
  return { moved, mod };
}

function normalizeDeg(d) {
  const n = Number(d);
  if (!Number.isFinite(n)) return 0;
  let x = n % 360;
  if (x < 0) x += 360;
  return x;
}

function _getAboutFaceFlags(token) {
  const flags = token?.document?.flags;
  if (!flags || typeof flags !== "object") return null;
  return flags["about-face"] ?? flags.aboutFace ?? flags.aboutface ?? null;
}

function _extractSnappedFacingDir(token) {
  if (!token?.document) return null;

  const candidates = [];
  const af = _getAboutFaceFlags(token);
  if (af && typeof af === "object") {
    candidates.push(
      af.direction,
      af.dir,
      af.facingDirection,
      af.facingDir,
      af.tokenDirection,
      af.facing
    );
    if (af.facing && typeof af.facing === "object") {
      candidates.push(af.facing.direction, af.facing.dir, af.facing.value);
    }
  }

  try {
    candidates.push(
      token.document.getFlag?.("about-face", "direction"),
      token.document.getFlag?.("about-face", "dir"),
      token.document.getFlag?.("about-face", "facingDirection"),
      token.document.getFlag?.("about-face", "facingDir"),
      token.document.getFlag?.("about-face", "tokenDirection")
    );
  } catch (_) {}

  const grid = canvas?.grid;
  const isHex = Boolean(grid?.isHexagonal || grid?.grid?.isHexagonal);
  const maxDir = isHex ? 5 : 7;

  for (const c of candidates) {
    if (!Number.isFinite(Number(c))) continue;
    const v = Number(c);
    if (!Number.isInteger(v)) continue;
    if (v >= 0 && v <= maxDir) return v;
  }

  return null;
}

function _extractFacingDegFromFlags(token) {
  if (!token?.document) return null;

  const candidates = [];
  const af = _getAboutFaceFlags(token);
  if (af && typeof af === "object") {
    candidates.push(af.rotation, af.angle, af.facingAngle, af.deg, af.degrees);
    if (af.facing && typeof af.facing === "object") {
      candidates.push(af.facing.rotation, af.facing.angle, af.facing.deg, af.facing.degrees);
    }
  }

  const flags = token.document.flags ?? {};
  for (const modId of Object.keys(flags)) {
    const f = flags[modId];
    if (!f || typeof f !== "object") continue;
    candidates.push(f.facing, f.direction, f.rotation, f.angle, f.facingAngle);
    if (f.facing && typeof f.facing === "object") {
      candidates.push(f.facing.rotation, f.facing.angle, f.facing.value);
    }
  }

  if (flags.facing && typeof flags.facing === "object") {
    candidates.push(flags.facing.rotation, flags.facing.angle, flags.facing.value);
  }

  for (const c of candidates) {
    if (!Number.isFinite(Number(c))) continue;
    const v = Number(c);
    if (v >= 0 && v < 360) return normalizeDeg(v);
  }

  return null;
}

function _aboutFaceFacingStringToDeg(dir) {
  const s = String(dir ?? "").trim().toLowerCase();
  if (!s) return null;
  if (s === "right") return 0;
  if (s === "down") return 90;
  if (s === "left") return 180;
  if (s === "up") return 270;
  return null;
}

function getTokenFacingDeg(token) {
  if (!token?.document) return null;

  try {
    const af = _getAboutFaceFlags(token);
    const afDir = af?.direction ?? token.document.getFlag?.("about-face", "direction");
    if (Number.isFinite(Number(afDir))) return normalizeDeg(Number(afDir));

    const afFacingStr = af?.facingDirection ?? token.document.getFlag?.("about-face", "facingDirection");
    const afDeg = _aboutFaceFacingStringToDeg(afFacingStr);
    if (Number.isFinite(Number(afDeg))) return normalizeDeg(Number(afDeg));
  } catch (_) {}

  const snapped = _extractSnappedFacingDir(token);
  if (Number.isFinite(snapped)) {
    const grid = canvas?.grid;
    const isHex = Boolean(grid?.isHexagonal || grid?.grid?.isHexagonal);
    return normalizeDeg(snapped * (isHex ? 60 : 45));
  }

  const flagged = _extractFacingDegFromFlags(token);
  if (flagged !== null) return flagged;

  const rot = token.document.rotation;
  if (Number.isFinite(rot)) return normalizeDeg(rot);

  return null;
}

function getTokenFacingDir(token) {
  const snapped = _extractSnappedFacingDir(token);
  if (Number.isFinite(snapped)) return snapped;

  const deg = getTokenFacingDeg(token);
  if (deg === null) return null;

  try {
    const grid = canvas?.grid;
    const origin = token?.center;
    if (grid?.getDirection && origin) {
      const rad = normalizeDeg(deg) * Math.PI / 180;
      const dist = grid.size ?? 100;
      const pt = { x: origin.x + Math.cos(rad) * dist, y: origin.y + Math.sin(rad) * dist };
      const dir = grid.getDirection(origin, pt);
      if (Number.isFinite(dir)) return dir;
    }
  } catch (_) {}

  return (Math.round(normalizeDeg(deg) / 60) % 6 + 6) % 6;
}

function getTargetSideFromFacing(attackerToken, targetToken) {
  if (!attackerToken || !targetToken) return null;

  const facingDeg = getTokenFacingDeg(targetToken);
  if (facingDeg === null) return null;

  try {
    const grid = canvas?.grid;
    const origin = targetToken?.center;
    const attackerPt = attackerToken?.center;
    if (grid?.getDirection && origin && attackerPt) {
      const facingDir = getTokenFacingDir(targetToken);
      const attackerDir = grid.getDirection(origin, attackerPt);
      if (Number.isFinite(facingDir) && Number.isFinite(attackerDir)) {
        const delta = ((attackerDir - facingDir) % 6 + 6) % 6;

        const dx0 = attackerPt.x - origin.x;
        const dy0 = attackerPt.y - origin.y;
        const bearingDeg = normalizeDeg(Math.atan2(dy0, dx0) * 180 / Math.PI);
        const relDeg = normalizeDeg(bearingDeg - facingDeg);

        let side;
        if (delta === 0 || delta === 1 || delta === 5) side = "front";
        else if (delta === 3) side = "rear";
        else if (delta === 2) side = "right";
        else side = "left";

        return { side, facingDeg, bearingDeg, relDeg, facingDir, attackerDir, delta };
      }
    }
  } catch (_) {}

  const dx = attackerToken.center.x - targetToken.center.x;
  const dy = attackerToken.center.y - targetToken.center.y;
  const bearingDeg = normalizeDeg(Math.atan2(dy, dx) * 180 / Math.PI);

  const relDeg = normalizeDeg(bearingDeg - facingDeg);

  let side;
  if (relDeg <= 90 || relDeg >= 270) side = "front";
  else if (relDeg > 90 && relDeg <= 150) side = "right";
  else if (relDeg > 150 && relDeg <= 210) side = "rear";
  else if (relDeg > 210 && relDeg < 270) side = "left";
  else side = "front";

  return { side, facingDeg, bearingDeg, relDeg };
}

function canAutoApplyDamage(targetActor) {
  const struct = targetActor?.system?.structure;
  if (!struct || typeof struct !== "object") return false;
  return Object.keys(struct).length > 0;
}

function getAbominationAliveCount(actor) {
  const abom = actor?.system?.abomination ?? {};
  const trackCount = clampInt(abom.trackCount, 1, 6, 3);
  const trackPips = clampInt(abom.trackPips, 1, 95, 95);

  let deadCount = 0;
  for (let i = 1; i <= trackCount; i++) {
    const value = Number(abom[`track${i}`] ?? 0) || 0;
    if (value >= trackPips) deadCount += 1;
  }

  const aliveCount = Math.max(0, trackCount - deadCount);
  return { aliveCount, trackCount };
}

export async function promptAndRollWeaponAttack(actor, weaponItem, { defaultSide = "front" } = {}) {
  const attackerToken = getAttackerToken(actor);
  const targetToken = getSingleTargetToken();

  if (!targetToken) {
    ui?.notifications?.warn?.("Select exactly 1 target token before making an attack.");
    return null;
  }
  if (!attackerToken) {
    ui?.notifications?.warn?.("Place/control your abomination token on the scene before making an attack.");
    return null;
  }

  const distance = measureTokenDistance(attackerToken, targetToken);
  if (distance === null) {
    ui?.notifications?.warn?.("Couldn't measure distance (no canvas/grid?).");
    return null;
  }

  const { aliveCount, trackCount } = getAbominationAliveCount(actor);
  if (aliveCount <= 0) {
    ui?.notifications?.warn?.("No living abominations remain to make an attack.");
    return null;
  }

  const isAbomMelee = Boolean(weaponItem?.system?.abominationMelee);
  if (isAbomMelee && distance > 1) {
    ui?.notifications?.warn?.("Abomination melee attacks require the target to be adjacent.");
    return null;
  }

  const { band } = calcRangeBandAndMod(weaponItem, distance);
  const arc = getTargetSideFromFacing(attackerToken, targetToken);
  const computedSide = arc?.side ?? defaultSide;

  const autoTargetMove = getAutoTargetMoveData(targetToken);
  const canApplyDamage = canAutoApplyDamage(targetToken?.actor);

  const arcNote = arc
    ? `Target facing ${Math.round(arc.facingDeg)} deg; arc ${computedSide.toUpperCase()}`
    : `No facing data found; defaulting to ${computedSide.toUpperCase()}`;

  const dialogHtml = await renderTemplate(TEMPLATE, {
    weaponName: weaponItem?.name ?? "Attack",
    targetName: targetToken?.name ?? "Target",
    distance,
    band,
    computedSide,
    arcNote,
    aliveCount,
    trackCount,
    autoTargetMove: autoTargetMove.moved,
    canApplyDamage,
    applyDamageDefault: canApplyDamage,
    showLocationDefault: true
  });

  return new Promise((resolve) => {
    new Dialog({
      title: `${weaponItem.name} - Attack`,
      content: dialogHtml,
      buttons: {
        roll: {
          icon: '<i class="fas fa-dice"></i>',
          label: "Roll",
          callback: async (html) => {
            const form = html[0].querySelector("form.atow-attack-dialog");
            const fd = new FormData(form);

            const opts = {
              attackerToken,
              targetToken,
              distance: num(fd.get("distance"), 0),
              attackerMoveMode: "stationary",
              targetHexes: num(fd.get("targetHexes"), 0),
              terrainMod: num(fd.get("terrainMod"), 0),
              otherMod: num(fd.get("otherMod"), 0),
              side: String(fd.get("side") ?? computedSide),
              applyDamage: canApplyDamage ? (fd.get("applyDamage") === "on") : false,
              applyHeat: false,
              showLocation: fd.get("showLocation") === "on",
              rapidShots: aliveCount,
              clusterShots: aliveCount,
              clusterLabel: "Abomination Volley",
              chatMode: "abomination",
              ignoreTargetingComputer: true,
              skillLabel: isAbomMelee ? "AniMelee" : "Gunnery",
              skillValue: isAbomMelee ? num(actor?.system?.abomination?.aniMeleeSkill, 0) : undefined
            };

            const result = await rollWeaponAttack(actor, weaponItem, opts);
            resolve(result);
          }
        },
        cancel: {
          label: "Cancel",
          callback: () => resolve(null)
        }
      },
      default: "roll"
    }).render(true);
  });
}
