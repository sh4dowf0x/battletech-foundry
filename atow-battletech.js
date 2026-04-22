// atow-battletech.js (ROOT)
// version 0.0.2

import { ATOWCharacterSheet } from "./module/character-sheet.js";
import { ATOWAbominationSheet } from "./module/abomination-sheet.js";
import { ATOWSkillSheet } from "./module/skill-sheet.js";
import { ATOWTraitSheet } from "./module/trait-sheet.js";
import { ATOWCharacterEquipmentSheet } from "./module/character-equipment.js";
import { ATOWCharacterModuleSheet } from "./module/character-module.js";
import { AToWMechSheet } from "./module/mech-sheet.js";
import { AToWMechWeaponSheet} from "./module/mech-weapon.js";
import { ATOWWheeledVehicleSheet } from "./module/wheeledvehicle-sheet.js";

import { AToWMechEquipmentSheet } from "./module/mech-equipment.js";
import { registerATOWCharacterWeaponSheet } from "./module/character-weapon.js";
import { registerATOWCharacterArmorSheet } from "./module/character-armor.js";

export const SYSTEM_ID = "atow-battletech";

/**
 * A small namespace we can hang utilities off of.
 * We store it on game[SYSTEM_ID] so macros/modules can call into it.
 */
export const ATOW = {
  SYSTEM_ID,
  api: {},
  config: {}
};

const JUMP_JET_SFX = `systems/${SYSTEM_ID}/assets/jumpjet.mp3`;

async function playSystemSfx(src, { volume = 0.8 } = {}) {
  try {
    const helper = foundry?.audio?.AudioHelper ?? null;
    if (!helper?.play || !src) return;
    await helper.play({ src, volume, autoplay: true, loop: false }, false);
  } catch (err) {
    console.warn(`${SYSTEM_ID} | Failed to play SFX`, err);
  }
}

// Simple clamp helper (Math.clamp is not standard)
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

// Heat can exceed the normal 30-point token/resource bar maximum.
// Keep system.heat.max at 30 for the bar, but allow stored heat.value/current up to this cap.
const HEAT_HARD_CAP = 100;

Hooks.once("init", async () => {
  console.log(`${SYSTEM_ID} | Initializing system`);

  // Expose a stable namespace
  game[SYSTEM_ID] = ATOW;

  // Combat initiative defaults for AToW (personal scale): 2d6
  // This is used by the Combat Tracker "Roll" / "Reroll" buttons.
  CONFIG.Combat.initiative = CONFIG.Combat.initiative ?? { decimals: 0, formula: null };
  CONFIG.Combat.initiative.decimals = 0;
  CONFIG.Combat.initiative.formula = "2d6";



  // Optional: Provide readable labels for document types (helps with UI text)
  CONFIG.Actor.typeLabels = CONFIG.Actor.typeLabels ?? {};
  CONFIG.Actor.typeLabels.character = "Character";
  CONFIG.Actor.typeLabels.npc = "NPC";
  CONFIG.Actor.typeLabels.mech = "Mech";
  CONFIG.Actor.typeLabels.vehicle = "Vehicle";
  CONFIG.Actor.typeLabels.wheeledvehicle = "Wheeled Vehicle";
  CONFIG.Actor.typeLabels.abomination = "Abomination";

  CONFIG.Item.typeLabels = CONFIG.Item.typeLabels ?? {};
  CONFIG.Item.typeLabels.characterSkill = "Skill";
  CONFIG.Item.typeLabels.characterTrait = "Trait";
  CONFIG.Item.typeLabels.mechWeapon = "Mech Weapon";
  CONFIG.Item.typeLabels.mechEquipment = "Mech Equipment";
  CONFIG.Item.typeLabels.characterModule = "Character Module";

  
  CONFIG.Item.typeLabels.characterWeapon = "Character Weapon";
  CONFIG.Item.typeLabels.characterArmor = "Character Armor";
  CONFIG.Item.typeLabels.characterEquipment = "Character Equipment";
registerSystemSettings();
  registerHandlebarsHelpers();

  // ------------------------------------------------
  // Status Effects (Token HUD list)
  // ------------------------------------------------
  // Keep Foundry's special/built-in combat statuses (e.g. "defeated"),
  // but replace the rest of the default list with Battletech-focused effects.
  function registerAToWStatusEffects() {
    const existing = Array.isArray(CONFIG.statusEffects) ? CONFIG.statusEffects : [];
    const specialIds = new Set(Object.values(CONFIG.specialStatusEffects ?? {}).filter(Boolean));

    // Create a stable 16-char ActiveEffect _id from a status id.
    // Foundry V13 status effect configs are Partial<ActiveEffectData>, whose default _id may be "".
    // If TokenHUD uses _id when toggling, an empty _id yields Actor#toggleStatusEffect("").
    const stableEffectDocId = (sid) => {
      sid = String(sid ?? "").trim();
      let hash = 0;
      for (let i = 0; i < sid.length; i++) hash = ((hash * 31) + sid.charCodeAt(i)) >>> 0;
      const suffix = hash.toString(36).padStart(12, "0").slice(-12);
      return ("atow" + suffix).slice(0, 16);
    };

    const normalizeStatus = (e) => {
      if (!e || typeof e !== "object") return null;
      const id = String(e.id ?? "").trim();
      if (!id) return null;

      // Prefer the V13 field names, but keep deprecated aliases for backwards compatibility.
      if (!e._id || String(e._id).trim() === "") e._id = stableEffectDocId(id);
      if (!e.name && e.label) e.name = e.label;
      if (!e.label && e.name) e.label = e.name;

      if (!e.img && e.icon) e.img = e.icon;
      if (!e.icon && e.img) e.icon = e.img;

      // Foundry V13: ensure the status can be toggled via Token HUD / Actor#toggleStatusEffect
      // by providing both a core.statusId flag and a statuses array.
      try {
        e.flags = e.flags ?? {};
        e.flags.core = e.flags.core ?? {};
        if (!e.flags.core.statusId) e.flags.core.statusId = id;
      } catch (_) {}

      try {
        const st = e.statuses;
        if (Array.isArray(st)) {
          if (!st.includes(id)) st.push(id);
        } else if (st && typeof st === "object" && typeof st.has === "function" && typeof st.add === "function") {
          // Set-like
          if (!st.has(id)) st.add(id);
        } else if (typeof st === "string" && st.trim()) {
          const s = st.trim();
          e.statuses = s === id ? [s] : [s, id];
        } else {
          e.statuses = [id];
        }
      } catch (_) {
        e.statuses = [id];
      }

      return e;
    };

    // Preserve any existing status entries that match a special status id (e.g. "defeated").
    const preserved = existing
      .filter(e => e && typeof e === "object" && e.id && specialIds.has(e.id))
      .map(e => normalizeStatus(e))
      .filter(Boolean);

    // Ensure DEFEATED exists (combat features rely on this)
    let defeatedId = CONFIG.specialStatusEffects?.DEFEATED;
    if (!defeatedId || typeof defeatedId !== "string") defeatedId = "defeated";
    defeatedId = String(defeatedId).trim() || "defeated";
    if (!preserved.some(e => e.id === defeatedId)) {
      preserved.push(normalizeStatus({
        id: defeatedId,
        name: game.i18n?.localize?.("COMBAT.Defeated") ?? "Defeated",
        img: "icons/svg/skull.svg",
        icon: "icons/svg/skull.svg",
        _id: stableEffectDocId(defeatedId)
      }));
    }

    const icon = (file) => `systems/${SYSTEM_ID}/assets/status/${file}.svg`;

    const mk = (id, name, img) => normalizeStatus({
      id,
      name,
      img,
      icon: img,
      label: name,
      _id: stableEffectDocId(id)
    });

    // BattleTech status effects (Token HUD list)
    // NOTE: These are *status definitions* only. Your sheet/automation applies them by id via toggleStatusEffect.
    const bt = [
      // Common combat/terrain modifiers
      mk("prone",         "Prone",         icon("prone")),
      mk("skidding",      "Skidding",      icon("skidding")),
      mk("atow-walked",   "Walked",        icon("atow-walked")),
      mk("atow-ran",      "Ran",           icon("atow-ran")),
      mk("atow-jumped",   "Jumped",        icon("atow-jumped")),
      mk("light-woods",   "Light Woods",   icon("light-woods")),
      mk("heavy-woods",   "Heavy Woods",   icon("heavy-woods")),
      mk("in-water",      "In Water",      icon("in-water")),
      mk("partial-cover", "Partial Cover", icon("partial-cover")),

      // Core AToW conditions
      mk("atow.shutdown",  "Shutdown", "icons/svg/lightning.svg"),
      mk("atow.immobile",  "Immobile", "icons/svg/padlock.svg"),

      // Location destruction (used by mech-sheet.js structure cascading)
      mk("left-arm-destroyed",    "Left Arm Destroyed",    icon("left-arm-destroyed")),
      mk("right-arm-destroyed",   "Right Arm Destroyed",   icon("right-arm-destroyed")),
      mk("left-leg-destroyed",    "Left Leg Destroyed",    icon("left-leg-destroyed")),
      mk("right-leg-destroyed",   "Right Leg Destroyed",   icon("right-leg-destroyed")),
      mk("left-torso-destroyed",  "Left Torso Destroyed",  icon("left-torso-destroyed")),
      mk("right-torso-destroyed", "Right Torso Destroyed", icon("right-torso-destroyed"))
    ].filter(Boolean);

    CONFIG.statusEffects = [...preserved, ...bt].filter(e => e?.id);

    // Ensure DEFEATED special status effect is never blank
    if (!CONFIG.specialStatusEffects.DEFEATED) CONFIG.specialStatusEffects.DEFEATED = "defeated";
  }

  registerAToWStatusEffects();


  // ------------------------------------------------
  // Scene Config: BattleTech Environment (global rules flags)
  // ------------------------------------------------
  // Stored on Scene flags as: flags.atow-battletech.environment.*
  // Attack automation can read these to apply global TN modifiers.
  function registerAToWSceneEnvironmentTab() {
    const TAB = "atow-battletech-env";
    const FLAG_ROOT = `flags.${SYSTEM_ID}.environment`;

    const getEnv = (scene) => {
      const env = scene?.getFlag?.(SYSTEM_ID, "environment") ?? scene?.flags?.[SYSTEM_ID]?.environment ?? {};
      return env ?? {};
    };

    const opt = (value, label, current) => {
      const sel = String(current ?? "") === String(value) ? " selected" : "";
      return `<option value="${value}"${sel}>${label}</option>`;
    };

    /**
     * SceneConfig is a DocumentSheetV2 (ApplicationV2). In V13, hook "html" is a plain HTMLElement.
     * Some configurations are not tabbed at all. We support both:
     * - If tab navigation exists, we inject a "BattleTech" tab.
     * - If no tabs exist, we inject a BattleTech fieldset section into the form.
     */
    Hooks.on("renderSceneConfig", (app, html) => {
      try {
        const scene =
          app?.document ??
          app?.object ??
          app?._document ??
          app?._object ??
          app?.options?.document ??
          app?.options?.object ??
          null;
        const root = html instanceof HTMLElement ? html : (Array.isArray(html) ? html[0] : null);
        if (!scene || !root) return;

        // Avoid double insert (tab or section)
        if (root.querySelector(`.tab[data-tab="${TAB}"], fieldset[data-atow-env="1"]`)) return;

        const env = getEnv(scene);
        const lighting = env.lighting ?? "day";
        const rain = env.rain ?? "none";
        const fog = env.fog ?? "none";
        const snow = env.snow ?? "none";
        const wind = String(env.wind ?? "0");
        const planetTemp = env.planetTemp ?? "normal";

        const inner = `
  <h3 class="form-header">BattleTech Environment</h3>

  <div class="form-group">
    <label>Lighting</label>
    <div class="form-fields">
      <select name="${FLAG_ROOT}.lighting">
        ${opt("day", "Day / Normal", lighting)}
        ${opt("dusk", "Dusk / Dawn (+1 all attacks)", lighting)}
        ${opt("fullmoon", "Full Moon Night (+2 all attacks)", lighting)}
        ${opt("moonless", "Moonless Night (+3 all attacks)", lighting)}
      </select>
    </div>
  </div>

  <div class="form-group">
    <label>Rain</label>
    <div class="form-fields">
      <select name="${FLAG_ROOT}.rain">
        ${opt("none", "None", rain)}
        ${opt("moderate", "Moderate Rain (+1 all attacks)", rain)}
        ${opt("heavy", "Heavy Rain (+2 all attacks)", rain)}
      </select>
    </div>
  </div>

  <div class="form-group">
    <label>Fog</label>
    <div class="form-fields">
      <select name="${FLAG_ROOT}.fog">
        ${opt("none", "None", fog)}
        ${opt("heavy", "Heavy Fog (+1 direct-fire energy)", fog)}
      </select>
    </div>
    <p class="hint">Fog is intended to affect direct-fire energy weapons (lasers/PPC) only.</p>
  </div>

  <div class="form-group">
    <label>Snow</label>
    <div class="form-fields">
      <select name="${FLAG_ROOT}.snow">
        ${opt("none", "None", snow)}
        ${opt("snowing", "Snowing (+1 all attacks)", snow)}
      </select>
    </div>
  </div>

  <div class="form-group">
    <label>Wind (Missiles)</label>
    <div class="form-fields">
      <select name="${FLAG_ROOT}.wind">
        ${opt("0", "None", wind)}
        ${opt("1", "Light (+1 missile attacks)", wind)}
        ${opt("2", "Moderate (+2 missile attacks)", wind)}
        ${opt("3", "Heavy (+3 missile attacks)", wind)}
      </select>
    </div>
    <p class="hint">Wind is intended to affect missile attacks only.</p>
  </div>

  <hr/>

  <h3 class="form-header">Planet Conditions (later)</h3>
  <div class="form-group">
    <label>Temperature</label>
    <div class="form-fields">
      <select name="${FLAG_ROOT}.planetTemp">
        ${opt("normal", "Normal", planetTemp)}
        ${opt("hot", "Hot (future: heat rules)", planetTemp)}
        ${opt("cold", "Cold (future: heat rules)", planetTemp)}
      </select>
    </div>
    <p class="hint">Placeholder for later heat generation/venting modifiers.</p>
  </div>`;

        // Try to inject as a tab if navigation exists
        const tabs = root.querySelector('nav.tabs[data-group], nav.sheet-tabs[data-group], nav.tabs, nav.sheet-tabs');
        const body = root.querySelector('section.sheet-body, .sheet-body');

        if (tabs && body) {
          const group = tabs.getAttribute("data-group") || tabs.dataset?.group || "primary";

          // Add tab button
          const btn = document.createElement("a");
          btn.className = "item";
          btn.dataset.tab = TAB;
          btn.textContent = "BattleTech";
          tabs.appendChild(btn);

          // Add tab panel
          const panel = document.createElement("div");
          panel.className = "tab";
          panel.dataset.group = group;
          panel.dataset.tab = TAB;
          panel.innerHTML = inner;
          body.appendChild(panel);

          // Manual switching (works even if Foundry doesn't rebind)
          btn.addEventListener("click", (ev) => {
            ev.preventDefault();
            tabs.querySelectorAll("a.item").forEach(a => a.classList.remove("active"));
            btn.classList.add("active");

            body.querySelectorAll(`.tab[data-group="${group}"]`).forEach(t => t.classList.remove("active"));
            panel.classList.add("active");
          });

          // Default: don't auto-activate; user clicks the tab.
        } else {
          // No tab UI present: inject a fieldset at the bottom of the form
          const form = root.querySelector("form");
          if (!form) return;

          const fs = document.createElement("fieldset");
          fs.dataset.atowEnv = "1";
          fs.style.marginTop = "0.5rem";
          fs.innerHTML = inner;

          // Append at end (safe) - or you can move later into a specific spot.
          form.appendChild(fs);
        }

        // Expose API to read environment quickly
        ATOW.api.getSceneEnvironment = () => {
          const s = canvas?.scene ?? game.scenes?.active;
          return (s?.getFlag?.(SYSTEM_ID, "environment") ?? s?.flags?.[SYSTEM_ID]?.environment ?? {}) ?? {};
        };
      } catch (err) {
        console.warn("AToW Battletech | SceneConfig BattleTech environment injection failed", err);
      }
    });
  }

  registerAToWSceneEnvironmentTab();




  // Register the Character sheet (this is what makes your .hbs actually appear)
  Actors.registerSheet(SYSTEM_ID, ATOWCharacterSheet, {
    types: ["character"],
    makeDefault: true,
    label: "AToW Character Sheet"
  });

  Actors.registerSheet(SYSTEM_ID, ATOWAbominationSheet, {
    types: ["abomination"],
    makeDefault: true,
    label: "AToW Abomination Sheet"
  });

  Actors.registerSheet(SYSTEM_ID, AToWMechSheet, {
    types: ["mech"],
    makeDefault: true
  });

  Actors.registerSheet(SYSTEM_ID, ATOWWheeledVehicleSheet, {
    types: ["wheeledvehicle"],
    makeDefault: true,
    label: "AToW Wheeled Vehicle Sheet"
  });

  // Register the Skill item sheet
  Items.registerSheet(SYSTEM_ID, ATOWSkillSheet, {
    types: ["characterSkill"],
    makeDefault: true,
    label: "AToW Skill Sheet"
  });

    Items.registerSheet(SYSTEM_ID, AToWMechWeaponSheet, {
    types: ["mechWeapon"],
    makeDefault: true,
    label: "AToW Mech Weapon Sheet"
  });


  Items.registerSheet(SYSTEM_ID, AToWMechEquipmentSheet, {
    types: ["mechEquipment"],
    makeDefault: true,
    label: "AToW Mech Equipment Sheet"
  });

  // Register Character Weapon/Armor item sheets
  registerATOWCharacterWeaponSheet();
  registerATOWCharacterArmorSheet();



  // Register the Character Module item sheet
  Items.registerSheet(SYSTEM_ID, ATOWCharacterModuleSheet, {
    types: ["characterModule"],
    makeDefault: true,
    label: "AToW Character Module Sheet"
  });

// Register the Trait item sheet
  Items.registerSheet(SYSTEM_ID, ATOWTraitSheet, {
    types: ["characterTrait"],
    makeDefault: true,
    label: "AToW Trait Sheet"
  });

  // Register the Character Equipment item sheet
  Items.registerSheet(SYSTEM_ID, ATOWCharacterEquipmentSheet, {
    types: ["characterEquipment"],
    makeDefault: true,
    label: "AToW Character Equipment Sheet"
  });

  // Preload templates (now that they're in /templates)
  await preloadHandlebarsTemplates();

  // Public API (we’ll expand this as we go)
  ATOW.api.rollCheck = rollCheck;

  // ------------------------------------------------
  // Combat Movement Automation (Walk/Run/Jump effects)
  // ------------------------------------------------
  const MOVE_EFFECT_IDS = {
    walk: "atow-walked",
    run: "atow-ran",
    jump: "atow-jumped"
  };

  /**
   * Robust status toggling:
   * - Prefer TokenDocument.toggleStatusEffect (updates token HUD).
   * - Fallback to an ActiveEffect on the Actor with flags.core.statusId so it still works
   *   even if the token method fails (permissions / API mismatch / missing status def).
   */
  

const getStatusDef = (id) => {
  try {
    const list = Array.isArray(CONFIG.statusEffects) ? CONFIG.statusEffects : [];
    return list.find(e => e?.id === id) ?? null;
  } catch (_) {
    return null;
  }
};

/**
 * Robust status toggling:
 * - Prefer TokenDocument.toggleStatusEffect (updates token HUD).
 * - Fallback to Token.toggleEffect (requires icon path).
 * - Final fallback: add/enable an ActiveEffect on the Actor with `statuses: [statusId]`
 *   so `actor.statuses` and `TokenDocument.hasStatusEffect()` can detect it reliably.
 *
 * This matters for our "jumped" modifier logic, which depends on status detection.
 */
const setTokenStatusEffect = async (tokenLike, statusId, active = false) => {
  if (!tokenLike || !statusId) return;

  // Accept either a boolean or an options object like { active: true }
  if (active && typeof active === "object" && ("active" in active)) active = !!active.active;
  else active = !!active;

  // Normalize: accept TokenDocument OR Token
  const tokenDoc = tokenLike?.document ?? tokenLike;
  const tokenObj =
    tokenDoc?.object ??
    (tokenLike?.document ? tokenLike : null) ??
    tokenLike?.object ??
    null;

  const def = getStatusDef(statusId);
  const iconPath = def?.icon ?? null;

  const actor = tokenDoc?.actor ?? tokenObj?.actor;

  const _statusIsActive = () => {
    try {
      if (tokenDoc?.hasStatusEffect) return !!tokenDoc.hasStatusEffect(statusId);
    } catch (_) {}
    try {
      if (actor?.statuses?.has) return actor.statuses.has(statusId);
      if (Array.isArray(actor?.statuses)) return actor.statuses.includes(statusId);
    } catch (_) {}
    try {
      const effects = Array.from(actor?.effects ?? []);
      return effects.some(e => {
        const sid = (e.getFlag?.("core", "statusId") ?? e.flags?.core?.statusId) ?? null;
        if (sid === statusId && !e.disabled) return true;
        if (!e.disabled && e.statuses?.has && e.statuses.has(statusId)) return true;
        if (!e.disabled && Array.isArray(e.statuses) && e.statuses.includes(statusId)) return true;
        return false;
      });
    } catch (_) {}
    return false;
  };

  const _cleanupDuplicates = async () => {
    // De-dupe token icon entries (legacy toggleEffect path can append duplicate icon paths).
    try {
      if (tokenDoc && iconPath && Array.isArray(tokenDoc.effects)) {
        const inEffects = Array.from(tokenDoc.effects);
        let seen = false;
        const next = [];
        for (const e of inEffects) {
          if (e === iconPath) {
            if (!active) continue;
            if (seen) continue;
            seen = true;
          }
          next.push(e);
        }
        const changed = next.length !== inEffects.length || next.some((v, i) => v !== inEffects[i]);
        if (changed) await tokenDoc.update({ effects: next }).catch(() => {});
      }
    } catch (_) {}

    // De-dupe ActiveEffects that map to this statusId.
    try {
      if (!actor) return;
      const matches = Array.from(actor.effects ?? []).filter(e => {
        const sid = (e.getFlag?.("core", "statusId") ?? e.flags?.core?.statusId) ?? null;
        if (sid === statusId) return true;
        try {
          if (e.statuses?.has && e.statuses.has(statusId)) return true;
          if (Array.isArray(e.statuses) && e.statuses.includes(statusId)) return true;
        } catch (_) {}
        return false;
      });

      if (!matches.length) return;

      if (active) {
        const keep = matches.find(e => !e.disabled) ?? matches[0];
        if (keep?.disabled && typeof keep.update === "function") {
          await keep.update({ disabled: false }).catch(() => {});
        }
        for (const e of matches) {
          if (e.id === keep?.id) continue;
          if (typeof e.delete === "function") await e.delete().catch(() => {});
        }
      } else {
        for (const e of matches) {
          if (!e.disabled && typeof e.update === "function") await e.update({ disabled: true }).catch(() => {});
          else if (typeof e.delete === "function") await e.delete().catch(() => {});
        }
      }
    } catch (_) {}
  };

  // Idempotent guard: if already at desired state, avoid re-toggling and just clean duplicates.
  if (_statusIsActive() === active) {
    await _cleanupDuplicates();
    return;
  }

  // 1) Preferred: TokenDocument.toggleStatusEffect (Foundry v11+)
  // Foundry has changed signatures across versions; try several combinations.
  const _tryToggleStatus = async (arg) => {
    if (!tokenDoc || typeof tokenDoc.toggleStatusEffect !== "function") return false;
    try {
      await tokenDoc.toggleStatusEffect(arg, { active });
      return true;
    } catch (_) {}
    try {
      await tokenDoc.toggleStatusEffect(arg, active);
      return true;
    } catch (_) {}
    return false;
  };

  try {
    if (await _tryToggleStatus(statusId)) { await _cleanupDuplicates(); return; }
    if (def && (await _tryToggleStatus(def))) { await _cleanupDuplicates(); return; }
  } catch (err) {
    console.warn(`AToW Battletech | toggleStatusEffect failed for "${statusId}"`, err);
    // fall through
  }

  // 1b) Fallback: Actor.toggleStatusEffect (preferred over deprecated Token.toggleEffect)
  try {
    if (actor && typeof actor.toggleStatusEffect === "function" && def?.id) {
      await actor.toggleStatusEffect(statusId, { active });
      await _cleanupDuplicates();
      return;
    }
  } catch (err) {
    console.warn(`AToW Battletech | actor.toggleStatusEffect failed for "${statusId}"`, err);
    // fall through
  }

  // 1c) Fallback: Token.toggleEffect (expects icon path, not status id)
  try {
    if (tokenObj && typeof tokenObj.toggleEffect === "function" && iconPath) {
      await tokenObj.toggleEffect(iconPath, { active });
      await _cleanupDuplicates();
      return;
    }
  } catch (err) {
    console.warn(`AToW Battletech | toggleEffect failed for "${statusId}"`, err);
    // fall through
  }
    // 2) Final fallback: actor ActiveEffect
    if (!actor) return;

  const effects = Array.from(actor.effects ?? []);
  const existing = effects.find(e => {
    const sid = (e.getFlag?.("core", "statusId") ?? e.flags?.core?.statusId) ?? null;
    if (sid === statusId) return true;

    try {
      if (e.statuses?.has && e.statuses.has(statusId)) return true;
      if (Array.isArray(e.statuses) && e.statuses.includes(statusId)) return true;
    } catch (_) {}

    return false;
  });

  if (active) {
    if (existing) {
      if (existing.disabled) await existing.update({ disabled: false }).catch(() => {});
      await _cleanupDuplicates();
      return;
    }

    const name = def?.name ?? def?.label ?? statusId;
    const icon = def?.icon ?? "icons/svg/wing.svg";

    await actor.createEmbeddedDocuments("ActiveEffect", [{
      name,
      icon,
      disabled: false,
      statuses: [statusId],
      flags: { core: { statusId } }
    }]).catch(() => {});

    await _cleanupDuplicates();
    return;
  }

  // Deactivate
  if (existing) {
    if (!existing.disabled && typeof existing.update === "function") {
      await existing.update({ disabled: true }).catch(() => {});
    } else {
      await existing.delete().catch(() => {});
    }
  }
  await _cleanupDuplicates();
};


/**
 * Determine whether a Mech should be considered "Immobile" for rules that reference the atow-immobile condition.
 * We currently auto-apply Immobile when:
 *  - The mech is shut down (heat or otherwise), OR
 *  - All four limbs are destroyed (LA, RA, LL, RL).
 */
const _num0 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const _isStructureLocDestroyed = (actor, locKey) => {
  const loc = actor?.system?.structure?.[locKey] ?? {};
  const max = _num0(loc.max);
  const dmg = _num0(loc.dmg);
  return max > 0 && dmg >= max;
};

const _isAllFourLimbsDestroyed = (actor) => {
  return (
    _isStructureLocDestroyed(actor, "la") &&
    _isStructureLocDestroyed(actor, "ra") &&
    _isStructureLocDestroyed(actor, "ll") &&
    _isStructureLocDestroyed(actor, "rl")
  );
};

// -----------------------------------
// Shutdown + Immobile status ids
// -----------------------------------
const SHUTDOWN_STATUS_ID = "atow.shutdown";
const IMMOBILE_STATUS_ID = "atow.immobile";
// Legacy + core ids we purge (no longer used by rules).
const LEGACY_IMMOBILE_STATUS_ID = "atow-immobile";
const CORE_IMMOBILE_STATUS_ID = "immobile";

// Guard to prevent our own internal status churn from being interpreted as a manual toggle.
if (!globalThis.__ATOW_BT_STATUS_SYNC_GUARD__) globalThis.__ATOW_BT_STATUS_SYNC_GUARD__ = new Set();

const _withStatusSyncGuard = async (actor, fn) => {
  const id = actor?.id;
  if (!id) return await fn();
  globalThis.__ATOW_BT_STATUS_SYNC_GUARD__.add(id);
  try { return await fn(); }
  finally { globalThis.__ATOW_BT_STATUS_SYNC_GUARD__.delete(id); }
};

const _isGuardedStatusSync = (actor) => {
  try { return globalThis.__ATOW_BT_STATUS_SYNC_GUARD__?.has?.(actor?.id); } catch (_) {}
  return false;
};

const _actorHasStatus = (actor, statusId) => {
  if (!actor || !statusId) return false;
  try {
    if (actor.statuses?.has) return actor.statuses.has(statusId);
    if (Array.isArray(actor.statuses)) return actor.statuses.includes(statusId);
  } catch (_) {}
  try {
    const effects = Array.from(actor.effects ?? []);
    return effects.some(e => {
      if (e?.disabled) return false;
      const sid = (e.getFlag?.("core", "statusId") ?? e.flags?.core?.statusId) ?? null;
      if (sid === statusId) return true;
      if (e.statuses?.has && e.statuses.has(statusId)) return true;
      if (Array.isArray(e.statuses) && e.statuses.includes(statusId)) return true;
      return false;
    });
  } catch (_) {}
  return false;
};

const _isHeatShutdown = (actor) => {
  return Boolean(actor?.system?.heat?.shutdown) || Boolean(actor?.system?.heat?.effects?.shutdown?.active);
};

const _getManualShutdown = (actor) => {
  try { return Boolean(actor?.getFlag?.(SYSTEM_ID, "shutdownManual")); } catch (_) {}
  return false;
};

const _setManualShutdown = async (actor, value) => {
  try {
    if (!actor?.setFlag) return;
    await actor.setFlag(SYSTEM_ID, "shutdownManual", !!value);
  } catch (_) {}
};

const _shouldBeShutdown = (actor) => {
  if (!actor) return false;
  // "Shutdown" state is derived from:
  //  - heat-driven shutdown markers (system.heat.shutdown / system.heat.effects.shutdown.active)
  //  - an explicit manual shutdown flag set by the user toggling the atow.shutdown status
  //
  // IMPORTANT: Do NOT include actorHasStatus(atow.shutdown) here, or the status becomes self-sticky
  // and prevents auto-startup / clearing from working correctly.
  return _isHeatShutdown(actor) || _getManualShutdown(actor);
};

const _setActorStatusEffect = async (actor, statusId, active) => {
  if (!actor || !statusId) return;

  const desired = !!active;
  const def = getStatusDef(statusId);
  const name = def?.name ?? def?.label ?? statusId;
  const icon = def?.icon ?? "icons/svg/wing.svg";

  // Collect *all* matching effects (we also use this to de-dupe).
  const effects = Array.from(actor.effects ?? []);
  const matches = effects.filter(e => {
    try {
      const sid = (e.getFlag?.("core", "statusId") ?? e.flags?.core?.statusId) ?? null;
      if (sid === statusId) return true;
      if (e.statuses?.has && e.statuses.has(statusId)) return true;
      if (Array.isArray(e.statuses) && e.statuses.includes(statusId)) return true;
    } catch (_) {}
    return false;
  });

  const _disableEffect = async (e) => {
    try {
      if (!e) return;
      if (!e.disabled && typeof e.update === "function") await e.update({ disabled: true });
      else if (typeof e.delete === "function") await e.delete();
    } catch (_) {}
  };

  const _enableEffect = async (e) => {
    try {
      if (!e) return;
      if (e.disabled && typeof e.update === "function") await e.update({ disabled: false });
    } catch (_) {}
  };

  if (desired) {
    // Prefer to keep exactly one enabled effect.
    if (matches.length) {
      const enabled = matches.filter(e => !e.disabled);
      const keep = enabled[0] ?? matches[0];

      await _enableEffect(keep);

      // Disable any duplicates so we don't get double icons / double statuses.
      for (const e of matches) {
        if (!e || e.id === keep.id) continue;
        await _disableEffect(e);
      }
      return;
    }

    // No existing effect -> create a new status effect on the actor.
    await actor.createEmbeddedDocuments("ActiveEffect", [{
      name,
      icon,
      disabled: false,
      statuses: [statusId],
      flags: { core: { statusId } }
    }]).catch(() => {});
    return;
  }

  // desired === false: disable/delete all matching effects.
  for (const e of matches) await _disableEffect(e);
};

const _shouldBeImmobile = (actor) => {
  if (!actor) return false;
  const shutdown = _shouldBeShutdown(actor);
  return shutdown || _isAllFourLimbsDestroyed(actor);
};


const _syncShutdownAndImmobileOnActorTokens = async (actor) => {
  if (!actor) return;

  const desiredShutdown = _shouldBeShutdown(actor);
  const desiredImmobile = desiredShutdown || _isAllFourLimbsDestroyed(actor);

  // Ensure actor-level effects exist even if there is no active token.
  await _withStatusSyncGuard(actor, async () => {
    await _setActorStatusEffect(actor, SHUTDOWN_STATUS_ID, desiredShutdown);
    await _setActorStatusEffect(actor, IMMOBILE_STATUS_ID, desiredImmobile);
    // Back-compat effect id
    await _setActorStatusEffect(actor, LEGACY_IMMOBILE_STATUS_ID, false); // purge legacy status
    await _setActorStatusEffect(actor, CORE_IMMOBILE_STATUS_ID, false); // purge core immobile status
  });

  // Sync all active tokens for this actor.
  const tokens = actor.getActiveTokens?.(true, true) ?? actor.getActiveTokens?.() ?? [];
  for (const tok of tokens ?? []) {
    const doc = tok?.document ?? tok;

    // Token flag used by various combat rules/macros
    try {
      if (doc?.setFlag) await doc.setFlag(SYSTEM_ID, "shutdown", desiredShutdown);
    } catch (_) {}
    // NOTE: We intentionally do NOT call TokenDocument.toggleStatusEffect for atow.shutdown/atow.immobile here.
    // Doing both actor.toggleStatusEffect and token.toggleStatusEffect can create duplicate ActiveEffects (double icons).
    // Actor-level effects already propagate to linked tokens.

    // Still purge legacy/core immobile that might exist on the token HUD.
    await setTokenStatusEffect(doc, LEGACY_IMMOBILE_STATUS_ID, false);
    await setTokenStatusEffect(doc, CORE_IMMOBILE_STATUS_ID, false);
  }
};


// Register once
if (!globalThis.__ATOW_BT_IMMOBILE_SYNC_REGISTERED__) {
  globalThis.__ATOW_BT_IMMOBILE_SYNC_REGISTERED__ = true;

  // Keep Shutdown + Immobile status effects in sync with heat shutdown + limb-loss state.
  // (We no longer apply the legacy "atow-immobile" status; we only purge it if present.)
  Hooks.on("updateActor", async (actor, changed, options) => {
    try {
      if (actor?.type && actor.type !== "mech") return;

      // Avoid reacting to token/effect churn that doesn't touch our relevant data.
      const flat = foundry.utils.flattenObject(changed ?? {});
      const keys = Object.keys(flat);

            const touchedShutdown = keys.includes("system.heat.shutdown") || keys.some(k => k.startsWith("system.heat.shutdown")) || keys.some(k => k.startsWith(`flags.${SYSTEM_ID}.shutdownManual`));
      const touchedStructure =
        keys.some(k => k.startsWith("system.structure.la.")) ||
        keys.some(k => k.startsWith("system.structure.ra.")) ||
        keys.some(k => k.startsWith("system.structure.ll.")) ||
        keys.some(k => k.startsWith("system.structure.rl."));

      if (!touchedShutdown && !touchedStructure) return;

      await _syncShutdownAndImmobileOnActorTokens(actor);
    } catch (err) {
      console.warn("AToW Battletech | Immobile sync failed", err);
    }
  });


// Detect manual toggling of the Shutdown status and store it as an actor flag,
// so we can distinguish heat shutdown (automatic) from pilot shutdown (manual).
const _isShutdownEffect = (effect) => {
  try {
    const sid = (effect?.getFlag?.("core", "statusId") ?? effect?.flags?.core?.statusId) ?? null;
    if (sid === SHUTDOWN_STATUS_ID) return true;
    if (effect?.statuses?.has && effect.statuses.has(SHUTDOWN_STATUS_ID)) return true;
    if (Array.isArray(effect?.statuses) && effect.statuses.includes(SHUTDOWN_STATUS_ID)) return true;
  } catch (_) {}
  return false;
};

const _onShutdownEffectChange = async (effect) => {
  const actor = effect?.parent;
  if (!actor || actor.type !== "mech") return;
  if (_isGuardedStatusSync(actor)) return;
  if (!_isShutdownEffect(effect)) return;

  const enabled = !effect.disabled;
  await _setManualShutdown(actor, enabled);

  // Ensure shutdown->immobile linkage and token flags update immediately.
  await _syncShutdownAndImmobileOnActorTokens(actor);
};

Hooks.on("createActiveEffect", async (effect) => {
  try { await _onShutdownEffectChange(effect); } catch (_) {}
});
Hooks.on("deleteActiveEffect", async (effect) => {
  try {
    const actor = effect?.parent;
    if (!actor || actor.type !== "mech") return;
    if (_isGuardedStatusSync(actor)) return;
    if (!_isShutdownEffect(effect)) return;

    await _setManualShutdown(actor, false);
    await _syncShutdownAndImmobileOnActorTokens(actor);
  } catch (_) {}
});
Hooks.on("updateActiveEffect", async (effect, changed) => {
  try {
    // Only react if disabled changed (toggle)
    const flat = foundry.utils.flattenObject(changed ?? {});
    if (!("disabled" in flat) && !Object.keys(flat).some(k => k.endsWith(".disabled"))) return;
    await _onShutdownEffectChange(effect);
  } catch (_) {}
});


// One-time cleanup + initial sync.
// Purges the legacy "atow-immobile" status and ensures atow.shutdown / atow.immobile reflect current heat + limb-loss state.
Hooks.once("ready", async () => {
  try {
    const actors = (game.actors?.contents ?? Array.from(game.actors ?? [])) ?? [];
    for (const a of actors) {
      if (!a || a.type !== "mech") continue;
      await _syncShutdownAndImmobileOnActorTokens(a);
    }
  } catch (err) {
    console.warn("AToW Battletech | Initial shutdown/immobile sync failed", err);
  }
});


}



  const clearMoveStatuses = async (tokenDoc, { preserveTurnStart = false } = {}) => {
    if (!tokenDoc) return;
    for (const id of Object.values(MOVE_EFFECT_IDS)) {
      await setTokenStatusEffect(tokenDoc, id, false);
    }
    // Legacy cleanup: older builds used a "jumped" status id.
    await setTokenStatusEffect(tokenDoc, "jumped", false);
    await tokenDoc.unsetFlag("atow-battletech", "moveMode");
    await tokenDoc.unsetFlag("atow-battletech", "movedThisTurn");
    await tokenDoc.unsetFlag("atow-battletech", "jumpedThisTurn");
    await tokenDoc.unsetFlag("atow-battletech", "movementEndedThisTurn");
    if (!preserveTurnStart) await tokenDoc.unsetFlag("atow-battletech", "turnStart");
  };

  const setMoveStatus = async (tokenDoc, mode) => {
    if (!tokenDoc) return;
    // disable all, then enable one
    for (const [m, id] of Object.entries(MOVE_EFFECT_IDS)) {
      const active = (m === mode);
      await setTokenStatusEffect(tokenDoc, id, active);
    }
    await tokenDoc.setFlag("atow-battletech", "moveMode", mode);
  };

  const measureGridSpaces = (fromXY, toXY) => {
    try {
      const t = canvas?.grid?.type ?? canvas?.scene?.grid?.type;
      const HEX_TYPES = new Set([
        CONST?.GRID_TYPES?.HEXODDR,
        CONST?.GRID_TYPES?.HEXEVENR,
        CONST?.GRID_TYPES?.HEXODDQ,
        CONST?.GRID_TYPES?.HEXEVENQ
      ].filter(v => v !== undefined && v !== null));

      if (HEX_TYPES.size && HEX_TYPES.has(t)) {
        const hexDist = measureHexSpaces(fromXY, toXY, t);
        if (Number.isFinite(hexDist)) return hexDist;
      }
    } catch (_) {
      // fall back to default measurement
    }
    const [fx, fy] = canvas.grid.getCenter(fromXY.x, fromXY.y);
    const [tx, ty] = canvas.grid.getCenter(toXY.x, toXY.y);
    const ray = new Ray(new PIXI.Point(fx, fy), new PIXI.Point(tx, ty));
    return Number(canvas.grid.measureDistances([{ ray }], { gridSpaces: true })?.[0]) || 0;
  };

  const getGridPosFromPixels = (x, y) => {
    if (typeof canvas?.grid?.getOffset === "function") {
      const off = canvas.grid.getOffset({ x, y });
      if (Array.isArray(off)) return off;
      if (off && typeof off === "object") {
        const gx = off.x ?? off.col ?? off.q ?? off.i;
        const gy = off.y ?? off.row ?? off.r ?? off.j;
        if (gx != null && gy != null) return [gx, gy];
      }
    }
    if (typeof canvas?.grid?.getGridPositionFromPixels === "function") {
      return canvas.grid.getGridPositionFromPixels(x, y);
    }
    if (typeof canvas?.grid?.getGridPosition === "function") {
      return canvas.grid.getGridPosition(x, y);
    }
    return null;
  };

  const getCenterPointFromTopLeft = (x, y) => {
    if (typeof canvas?.grid?.getCenterPoint === "function") {
      const pt = canvas.grid.getCenterPoint({ x, y });
      if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) return { x: pt.x, y: pt.y };
    }
    if (typeof canvas?.grid?.getCenter === "function") {
      const [cx, cy] = canvas.grid.getCenter(x, y);
      if (Number.isFinite(cx) && Number.isFinite(cy)) return { x: cx, y: cy };
    }
    return { x, y };
  };

  const measureHexSpaces = (fromXY, toXY, gridType) => {
    const aCenter = getCenterPointFromTopLeft(fromXY.x, fromXY.y);
    const bCenter = getCenterPointFromTopLeft(toXY.x, toXY.y);
    const a = getGridPosFromPixels(aCenter.x, aCenter.y);
    const b = getGridPosFromPixels(bCenter.x, bCenter.y);
    if (!a || !b) return null;

    const [aq, ar] = a;
    const [bq, br] = b;

    const offsetToCubeOddQ = (q, r) => {
      const x = q;
      const z = r - (q - (q & 1)) / 2;
      const y = -x - z;
      return { x, y, z };
    };

    const offsetToCubeEvenQ = (q, r) => {
      const x = q;
      const z = r - (q + (q & 1)) / 2;
      const y = -x - z;
      return { x, y, z };
    };

    const offsetToCubeOddR = (q, r) => {
      const z = r;
      const x = q - (r - (r & 1)) / 2;
      const y = -x - z;
      return { x, y, z };
    };

    const offsetToCubeEvenR = (q, r) => {
      const z = r;
      const x = q - (r + (r & 1)) / 2;
      const y = -x - z;
      return { x, y, z };
    };

    let ca = null;
    let cb = null;
    // NOTE: Foundry's offset grid for HEXEVENQ/HEXODDQ is inverted vs redblob's naming.
    // Swap the Q formulas so adjacent hexes compute as distance 1 on "columns-even" grids.
    if (gridType === CONST?.GRID_TYPES?.HEXODDQ) {
      ca = offsetToCubeEvenQ(aq, ar);
      cb = offsetToCubeEvenQ(bq, br);
    } else if (gridType === CONST?.GRID_TYPES?.HEXEVENQ) {
      ca = offsetToCubeOddQ(aq, ar);
      cb = offsetToCubeOddQ(bq, br);
    } else if (gridType === CONST?.GRID_TYPES?.HEXODDR) {
      ca = offsetToCubeOddR(aq, ar);
      cb = offsetToCubeOddR(bq, br);
    } else if (gridType === CONST?.GRID_TYPES?.HEXEVENR) {
      ca = offsetToCubeEvenR(aq, ar);
      cb = offsetToCubeEvenR(bq, br);
    }

    if (!ca || !cb) return null;
    const dx = Math.abs(ca.x - cb.x);
    const dy = Math.abs(ca.y - cb.y);
    const dz = Math.abs(ca.z - cb.z);
    return Math.max(dx, dy, dz);
  };

  const offsetToCubeByGridType = (q, r, gridType) => {
    if (gridType === CONST?.GRID_TYPES?.HEXODDQ) {
      const x = q;
      const z = r - (q + (q & 1)) / 2;
      const y = -x - z;
      return { x, y, z };
    }
    if (gridType === CONST?.GRID_TYPES?.HEXEVENQ) {
      const x = q;
      const z = r - (q - (q & 1)) / 2;
      const y = -x - z;
      return { x, y, z };
    }
    if (gridType === CONST?.GRID_TYPES?.HEXODDR) {
      const z = r;
      const x = q - (r - (r & 1)) / 2;
      const y = -x - z;
      return { x, y, z };
    }
    if (gridType === CONST?.GRID_TYPES?.HEXEVENR) {
      const z = r;
      const x = q - (r + (r & 1)) / 2;
      const y = -x - z;
      return { x, y, z };
    }
    return null;
  };

  const getHexMovementFacingAngleCW = (fromXY, toXY) => {
    try {
      const aCenter = getCenterPointFromTopLeft(fromXY.x, fromXY.y);
      const bCenter = getCenterPointFromTopLeft(toXY.x, toXY.y);
      const dx = bCenter.x - aCenter.x;
      const dy = bCenter.y - aCenter.y;
      if (Math.hypot(dx, dy) < 0.0001) return null;
      return normalizeDegrees(Math.atan2(dy, dx) * 180 / Math.PI);
    } catch (_) {
      return null;
    }
  };


/**
 * Prefer token drag ruler waypoints (actual path) when available.
 * Falls back to straight segment distance (measureGridSpaces) when ruler info is not available.
 *
 * Returns an integer number of grid spaces.
 */
const _getActiveTokenRuler = (tokenDoc) => {
  const tok = tokenDoc?._object ?? canvas?.tokens?.get(tokenDoc?.id) ?? null;
  const rulers = [];
  if (tok?.ruler) rulers.push(tok.ruler);
  if (canvas?.controls?.ruler) rulers.push(canvas.controls.ruler);
  const children = canvas?.controls?.rulers?.children ?? [];
  if (Array.isArray(children)) rulers.push(...children);

  for (const r of rulers) {
    if (!r) continue;
    const rTok = r.token ?? r._token ?? r.draggedEntity ?? r.subject ?? null;
    if (rTok && tok && rTok.id && tok.id && rTok.id !== tok.id) continue;
    if (Array.isArray(r?.segments) && r.segments.length > 0) return r;
    if (Array.isArray(r?.waypoints) && r.waypoints.length > 0) return r;
  }
  return null;
};

const measureTokenRulerSpaces = (tokenDoc, fromXY, toXY) => {
  try {
    const ruler = _getActiveTokenRuler(tokenDoc);
    if (!ruler) return null;

    if (Array.isArray(ruler.segments) && ruler.segments.length > 0) {
      let total = 0;
      for (const seg of ruler.segments) {
        const ray = seg?.ray ?? seg;
        const a = ray?.A ?? ray?.from ?? null;
        const b = ray?.B ?? ray?.to ?? null;
        if (!a || !b) continue;
        const rayObj = new Ray(new PIXI.Point(a.x, a.y), new PIXI.Point(b.x, b.y));
        const dist = Number(canvas.grid.measureDistances([{ ray: rayObj }], { gridSpaces: true })?.[0]) || 0;
        total += dist;
      }
      if (total > 0) return total;
    }

    // Some rulers are not active for token movement; ensure there are waypoints.
    const wps = ruler.waypoints;
    if (!Array.isArray(wps) || wps.length < 1) return null;

    // If ruler has an explicit token reference, require it matches.
    const tok = tokenDoc?._object ?? canvas?.tokens?.get(tokenDoc?.id);
    const rulerToken = ruler.token ?? ruler._token ?? null;
    if (rulerToken && tok && rulerToken.id && tok.id && rulerToken.id !== tok.id) return null;

    // Build a path in pixel coordinates, ensuring it begins at current token center and ends at destination center.
    const pts = [];
    // Some rulers include the origin implicitly; some include it as the first waypoint.
    for (const p of wps) {
      if (!p) continue;
      const x = Number(p.x ?? p[0]);
      const y = Number(p.y ?? p[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      let px = x;
      let py = y;
      if (typeof canvas.grid.getTopLeft === "function" && typeof canvas.grid.getCenter === "function") {
        const [tx, ty] = canvas.grid.getTopLeft(x, y);
        const [cx, cy] = canvas.grid.getCenter(tx, ty);
        const d = Math.hypot(cx - x, cy - y);
        if (d > 1) {
          px = cx;
          py = cy;
        }
      }
      pts.push({ x: px, y: py });
    }
    if (pts.length < 1) return null;

    const [fx, fy] = canvas.grid.getCenter(fromXY.x, fromXY.y);
    const [tx, ty] = canvas.grid.getCenter(toXY.x, toXY.y);

    // Ensure origin
    const first = pts[0];
    const dFirst = Math.hypot(first.x - fx, first.y - fy);
    const gridSize = Number(canvas.grid.size ?? canvas.dimensions?.size ?? 0) || 0;
    if (gridSize && dFirst > gridSize * 0.75) {
      // Ruler origin doesn't match current token location; fall back to straight distance.
      return null;
    }
    if (dFirst > 1) pts.unshift({ x: fx, y: fy });

    // Ensure destination
    const last = pts[pts.length - 1];
    const dLast = Math.hypot(last.x - tx, last.y - ty);
    if (dLast > 1) pts.push({ x: tx, y: ty });

    let total = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const ray = new Ray(new PIXI.Point(a.x, a.y), new PIXI.Point(b.x, b.y));
      const seg = Number(canvas.grid.measureDistances([{ ray }], { gridSpaces: true })?.[0]) || 0;
      total += seg;
    }

    return Number(total) || 0;
  } catch (err) {
    console.warn("AToW Battletech | measureTokenRulerSpaces failed", err);
    return null;
  }
};

const measureTokenSegmentSpaces = (_tokenDoc, fromXY, toXY) => {
  const rulerDist = measureTokenRulerSpaces(_tokenDoc, fromXY, toXY);
  if (Number.isFinite(rulerDist) && rulerDist > 0) return rulerDist;
  return measureGridSpaces(fromXY, toXY);
};

  // ------------------------------------------------
  // Facing / Turn Cost (movement points spent to change facing)
  // ------------------------------------------------
  const isHexGrid = () => {
    try {
      const t = canvas?.grid?.type ?? canvas?.scene?.grid?.type;
      const HEX = new Set([
        CONST?.GRID_TYPES?.HEXODDR,
        CONST?.GRID_TYPES?.HEXEVENR,
        CONST?.GRID_TYPES?.HEXODDQ,
        CONST?.GRID_TYPES?.HEXEVENQ
      ].filter(v => v !== undefined && v !== null));
      return HEX.size ? HEX.has(t) : false;
    } catch (_) { return false; }
  };

  const getFacingStepDegrees = () => (isHexGrid() ? 60 : 90);

  const getHexFacingOffsetDegrees = () => {
    try {
      const t = canvas?.grid?.type ?? canvas?.scene?.grid?.type;
      if (t === CONST?.GRID_TYPES?.HEXODDQ || t === CONST?.GRID_TYPES?.HEXEVENQ) return 30;
    } catch (_) {}
    return 0;
  };

  const getFacingOffsetDegrees = () => (isHexGrid() ? getHexFacingOffsetDegrees() : 0);

  const getRotationToFacingOffsetDegrees = () => {
    try {
      const t = canvas?.grid?.type ?? canvas?.scene?.grid?.type;
      if (t === CONST?.GRID_TYPES?.HEXODDQ || t === CONST?.GRID_TYPES?.HEXEVENQ) return 90;
    } catch (_) {}
    return 0;
  };

  const facingIndexToDegrees = (index) => {
    const step = getFacingStepDegrees();
    const offset = getFacingOffsetDegrees();
    return normalizeDegrees((Number(index ?? 0) || 0) * step + offset);
  };

  const normalizeDegrees = (deg) => {
    let d = Number(deg ?? 0) || 0;
    d = ((d % 360) + 360) % 360;
    return d;
  };

  const getNativeFacingFlagPath = () => `flags.${SYSTEM_ID}.facing`;

  const _quantizeToFacingStep = (deg, step = getFacingStepDegrees()) => {
    const d = normalizeDegrees(deg);
    const s = Number(step ?? 0) || 0;
    if (s <= 0) return d;
    const offset = getFacingOffsetDegrees();
    return normalizeDegrees(Math.round((d - offset) / s) * s + offset);
  };

  const _nativeFacingArtRotationEnabled = () => {
    try {
      return !!game.settings.get(SYSTEM_ID, "rotateTokenArtWithFacing");
    } catch (_) {
      return false;
    }
  };

  const _normalizeNativeFacing = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    const maxDir = isHexGrid() ? 5 : 7;
    if (Number.isInteger(n) && n >= 0 && n <= maxDir) {
      return facingIndexToDegrees(n);
    }
    return _quantizeToFacingStep(n);
  };

  const _getNativeFacing = (tokenDoc) => {
    try {
      const v = tokenDoc?.getFlag?.(SYSTEM_ID, "facing");
      return _normalizeNativeFacing(v);
    } catch (_) {
      return null;
    }
  };

  const _getNativeFacingFromChanges = (changes) => {
    try {
      const v = foundry.utils.getProperty(changes, getNativeFacingFlagPath());
      return _normalizeNativeFacing(v);
    } catch (_) {
      return null;
    }
  };

  // ------------------------------------------------
  // About Face compatibility
  // ------------------------------------------------
  // If the "about-face" module is active, it maintains a token-facing value at
  // flags.about-face.direction. That value is what the About Face indicator uses
  // when it draws its arrow. If our system uses TokenDocument.rotation instead,
  // facings can appear "off" relative to the indicator. To keep them aligned,
  // we treat flags.about-face.direction as the authoritative facing when present.
  //
  // About Face sets the flag in its preUpdateToken hook:
  //   foundry.utils.setProperty(updates, `flags.about-face.direction`, tokenDirection);
  // where tokenDirection is snapped to grid facings and represents CW degrees.
  const _aboutFaceActive = () => Boolean(game?.modules?.get?.("about-face")?.active);

  const _normalizeAboutFaceDir = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    const maxDir = isHexGrid() ? 5 : 7;
    if (Number.isInteger(n) && n >= 0 && n <= maxDir) {
      return facingIndexToDegrees(n);
    }
    return normalizeDegrees(n);
  };

  const _getAboutFaceDir = (tokenDoc) => {
    try {
      const v = tokenDoc?.getFlag?.("about-face", "direction");
      return _normalizeAboutFaceDir(v);
    } catch (_) {
      return null;
    }
  };

  const _getAboutFaceDirFromChanges = (changes) => {
    try {
      const v = foundry.utils.getProperty(changes, "flags.about-face.direction");
      return _normalizeAboutFaceDir(v);
    } catch (_) {
      return null;
    }
  };

  const getTokenFacingDegrees = (tokenDoc) => {
    const nativeDir = _getNativeFacing(tokenDoc);
    if (nativeDir != null) return normalizeDegrees(nativeDir);

    if (_aboutFaceActive()) {
      const dir = _getAboutFaceDir(tokenDoc);
      if (dir != null) return normalizeDegrees(dir);
    }
    return normalizeDegrees(tokenDoc?.rotation ?? 0);
  };

  const getTokenFacingDegreesAfterChanges = (tokenDoc, changes) => {
    const nativeDirChg = _getNativeFacingFromChanges(changes);
    if (nativeDirChg != null) return normalizeDegrees(nativeDirChg);

    const nativeDir = _getNativeFacing(tokenDoc);
    if (nativeDir != null) return normalizeDegrees(nativeDir);

    if (_aboutFaceActive()) {
      const dirChg = _getAboutFaceDirFromChanges(changes);
      if (dirChg != null) return normalizeDegrees(dirChg);

      // Fall back to the token's current About Face direction if present.
      const dir = _getAboutFaceDir(tokenDoc);
      if (dir != null) return normalizeDegrees(dir);
    }

    // Non-About-Face (or no AF data available): use rotation.
    if ("rotation" in (changes ?? {})) return normalizeDegrees(changes.rotation ?? 0);
    return normalizeDegrees(tokenDoc?.rotation ?? 0);
  };

  // Smallest signed delta from a -> b in degrees, range [-180, 180)
  const signedAngleDelta = (a, b) => {
    const A = normalizeDegrees(a);
    const B = normalizeDegrees(b);
    let d = B - A;
    if (d >= 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  };

  const snapToNearestLegalFacing = (deg, { currentFacing = null } = {}) => {
    const count = isHexGrid() ? 6 : 4;
    const candidates = Array.from({ length: count }, (_, i) => facingIndexToDegrees(i));
    const angle = normalizeDegrees(deg);

    let best = candidates[0];
    let bestDelta = Infinity;
    const ties = [];

    for (const candidate of candidates) {
      const delta = Math.abs(signedAngleDelta(angle, candidate));
      if (delta + 0.0001 < bestDelta) {
        best = candidate;
        bestDelta = delta;
        ties.length = 0;
        ties.push(candidate);
      } else if (Math.abs(delta - bestDelta) <= 0.0001) {
        ties.push(candidate);
      }
    }

    if (ties.length > 1 && currentFacing != null) {
      let tieBest = ties[0];
      let tieDelta = Infinity;
      for (const candidate of ties) {
        const delta = Math.abs(signedAngleDelta(currentFacing, candidate));
        if (delta < tieDelta) {
          tieBest = candidate;
          tieDelta = delta;
        }
      }
      return normalizeDegrees(tieBest);
    }

    return normalizeDegrees(best);
  };

  // Converts a rotation change to "facing steps" (hexsides or square facings)
  const facingStepsFromRotationDelta = (fromRot, toRot) => {
    const step = getFacingStepDegrees();
    const d = Math.abs(signedAngleDelta(fromRot, toRot));
    if (d < 0.0001) return 0;
    return Math.round(d / step);
  };


  // Movement direction helpers (used for optional forward/back-only movement)
  // In Foundry/PIXI screen coordinates (y-down), token.rotation increases clockwise with:
  //   0° = right (east), 90° = down (south), 180° = left (west), 270° = up (north).
  // About Face uses the same convention for its "direction" flag. So we should NOT invert atan2().
  const _movementVectorAngleCW = (fromXY, toXY) => {
    try {
      const [fx, fy] = canvas.grid.getCenter(fromXY.x, fromXY.y);
      const [tx, ty] = canvas.grid.getCenter(toXY.x, toXY.y);
      const dx = tx - fx;
      const dy = ty - fy;
      if (Math.hypot(dx, dy) < 1) return null;

      const deg = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
      return normalizeDegrees(deg);
    } catch (_) {
      return null;
    }
  };

  // Quantize an angle to the nearest facing step (60° on hex, 90° on square).
  // This makes forward/back checks stable on hex grids and avoids pixel-rounding noise.
  const _isForwardOrBackwardTranslation = (tokenDoc, fromXY, toXY, { facingDeg = null } = {}) => {
    const ang = _movementVectorAngleCW(fromXY, toXY);
    if (ang == null) return true;

    const step = getFacingStepDegrees();
    const moveFacing = _quantizeToFacingStep(ang, step);

    // Use the same facing source as About Face when available.
    const facing = (facingDeg == null) ? getTokenFacingDegrees(tokenDoc) : normalizeDegrees(facingDeg);

    // How many facing-steps separate the token facing and the movement vector?
    const steps = facingStepsFromRotationDelta(facing, moveFacing);

    // Forward = 0 steps. Backward = 180° (3 steps on hex, 2 on square).
    const backSteps = Math.round(180 / step);

    return (steps === 0) || (steps === backSteps);
  };

  const ensureNativeFacingForToken = async (tokenDoc, { force = false } = {}) => {
    if (!tokenDoc) return null;
    const existing = _getNativeFacing(tokenDoc);
    if (!force && existing != null) return existing;

    const seeded = _quantizeToFacingStep((tokenDoc?.rotation ?? 0) + getRotationToFacingOffsetDegrees());
    try {
      await tokenDoc.setFlag(SYSTEM_ID, "facing", seeded);
    } catch (_) {
      return seeded;
    }
    return seeded;
  };

  Hooks.on("preCreateToken", (tokenDoc, data) => {
    try {
      const existing = tokenDoc?.getFlag?.(SYSTEM_ID, "facing");
      const incoming = foundry.utils.getProperty(data, getNativeFacingFlagPath());
      if (existing != null || incoming != null) return;

      const seeded = _quantizeToFacingStep((data?.rotation ?? tokenDoc?.rotation ?? 0) + getRotationToFacingOffsetDegrees());
      tokenDoc.updateSource({ flags: { [SYSTEM_ID]: { facing: seeded } } });
    } catch (_) {}
  });

  Hooks.on("preUpdateToken", (tokenDoc, changes, options) => {
    if (options?.atowFacingSync) return;

    const incomingFacing = _getNativeFacingFromChanges(changes);
    const hasRotationChange = Object.prototype.hasOwnProperty.call(changes ?? {}, "rotation");
    const hasTranslationChange =
      Object.prototype.hasOwnProperty.call(changes ?? {}, "x") ||
      Object.prototype.hasOwnProperty.call(changes ?? {}, "y");
    if (incomingFacing == null && !hasRotationChange && !hasTranslationChange) return;

    let desiredFacing = incomingFacing;
    if (desiredFacing == null) {
      const currentFacing =
        _getNativeFacing(tokenDoc) ??
        _quantizeToFacingStep((tokenDoc?.rotation ?? 0) + getRotationToFacingOffsetDegrees());

      if (hasTranslationChange) {
        const nextX = Object.prototype.hasOwnProperty.call(changes ?? {}, "x") ? changes.x : tokenDoc?.x;
        const nextY = Object.prototype.hasOwnProperty.call(changes ?? {}, "y") ? changes.y : tokenDoc?.y;
        let moveFacing = getHexMovementFacingAngleCW(
          { x: tokenDoc?.x ?? 0, y: tokenDoc?.y ?? 0 },
          { x: nextX ?? 0, y: nextY ?? 0 }
        );

        if (moveFacing == null) {
          moveFacing = _movementVectorAngleCW(
            { x: tokenDoc?.x ?? 0, y: tokenDoc?.y ?? 0 },
            { x: nextX ?? 0, y: nextY ?? 0 }
          );
        }

        desiredFacing = moveFacing == null
          ? currentFacing
          : snapToNearestLegalFacing(moveFacing, { currentFacing });
      } else {
        const rotationDelta = signedAngleDelta(tokenDoc?.rotation ?? 0, changes.rotation ?? tokenDoc?.rotation ?? 0);
        desiredFacing = _quantizeToFacingStep(currentFacing + rotationDelta);
      }
    }

    foundry.utils.setProperty(changes, getNativeFacingFlagPath(), desiredFacing);

    if (hasRotationChange || (incomingFacing != null && _nativeFacingArtRotationEnabled())) {
      changes.rotation = _nativeFacingArtRotationEnabled()
        ? desiredFacing
        : (tokenDoc?.rotation ?? 0);
    }
  });

  const FACING_INDICATOR_NAME = `${SYSTEM_ID}-facing-indicator`;

  const destroyFacingIndicator = (token) => {
    try {
      const existing = token?.getChildByName?.(FACING_INDICATOR_NAME);
      if (existing && !existing.destroyed) existing.destroy({ children: true });
    } catch (_) {}
  };

  const drawFacingIndicator = async (token) => {
    if (!token?.document) return;

    if (!game.settings.get(SYSTEM_ID, "showFacingIndicator")) {
      destroyFacingIndicator(token);
      return;
    }

    let facing = getTokenFacingDegrees(token.document);
    if (facing == null) {
      facing = await ensureNativeFacingForToken(token.document);
    }
    if (facing == null) return;

    const colorHex = String(game.settings.get(SYSTEM_ID, "facingIndicatorColor") ?? "#ff9f1c");
    const indicatorScale = Number(game.settings.get(SYSTEM_ID, "facingIndicatorScale") ?? 1) || 1;
    const color = Number.parseInt(colorHex.replace(/^#/, ""), 16);
    const width = Number(token.w ?? token.document.width ?? 0) || 0;
    const height = Number(token.h ?? token.document.height ?? 0) || 0;
    const maxSize = Math.max(width, height, 1);
    const distance = maxSize * 0.36;
    const scale = Math.max(0.35, indicatorScale) * Math.max(0.4, maxSize / 100);

    let container = token.getChildByName?.(FACING_INDICATOR_NAME) ?? null;
    if (!container || container.destroyed) {
      container = new PIXI.Container();
      container.name = FACING_INDICATOR_NAME;
      token.addChild(container);
    } else {
      container.removeChildren().forEach(child => child.destroy?.());
    }

    const graphics = new PIXI.Graphics();
    graphics.lineStyle(2, color, 0.95);
    graphics.beginFill(color, 0.55);
    graphics.moveTo(distance, 0);
    graphics.lineTo(distance - 14, -8);
    graphics.lineTo(distance - 14, 8);
    graphics.lineTo(distance, 0);
    graphics.endFill();
    graphics.moveTo(0, 0);
    graphics.lineTo(distance - 12, 0);
    graphics.scale.set(scale, scale);

    container.addChild(graphics);
    container.x = width / 2;
    container.y = height / 2;
    container.angle = facing;
    container.eventMode = "none";
    container.sortableChildren = false;
    container.visible = true;
  };

  ATOW.api.getTokenFacingDegrees = getTokenFacingDegrees;
  ATOW.api.ensureTokenFacing = ensureNativeFacingForToken;
  ATOW.api.drawFacingIndicator = drawFacingIndicator;

  Hooks.on("canvasReady", async () => {
    const tokens = Array.from(canvas?.tokens?.placeables ?? []);
    for (const token of tokens) {
      await ensureNativeFacingForToken(token.document);
      await drawFacingIndicator(token);
    }
  });

  Hooks.on("createToken", async (tokenDoc) => {
    if (!tokenDoc?.object) return;
    await ensureNativeFacingForToken(tokenDoc);
    await drawFacingIndicator(tokenDoc.object);
  });

  Hooks.on("updateToken", async (tokenDoc) => {
    if (!tokenDoc?.object) return;
    await ensureNativeFacingForToken(tokenDoc);
    await drawFacingIndicator(tokenDoc.object);
  });

  Hooks.on("refreshToken", (token) => {
    if (!token?.document) return;
    drawFacingIndicator(token);
  });



  // ------------------------------------------------
  // Mech Movement (auto-derived from Engine Rating / Tonnage)
  // ------------------------------------------------
  // Walk = floor(EngineRating / Tonnage)
  // Run  = ceil(Walk * 1.5)
  // Jump = Walk
  //
  // Notes:
  // - We only apply this to Actor type "mech".
  // - We *only* recompute when Engine or Tonnage changes (or when movement is missing).
  // - If Engine/Tonnage are invalid, we do nothing.
  const _parseEngineRating = (engineText) => {
    const raw = String(engineText ?? "");
    const m = raw.match(/(\d{2,4})/); // ratings are typically 2-4 digits
    return m ? (Number(m[1]) || 0) : 0;
  };

  const _computeBaseMoveFromEngine = (engineText, tonnage) => {
    const eng = _parseEngineRating(engineText);
    const tons = Number(tonnage ?? 0) || 0;
    if (eng <= 0 || tons <= 0) return null;

    const walk = Math.max(0, Math.floor(eng / tons));
    const run = Math.max(0, Math.ceil(walk * 1.5));
    const jump = walk;

    return { walk, run, jump };
  };

  Hooks.on("preCreateActor", (doc, data) => {
    try {
      if ((doc?.type ?? data?.type) !== "mech") return;
      const sys = data?.system ?? {};
      const mech = sys.mech ?? {};

      const mv = _computeBaseMoveFromEngine(mech.engine, mech.tonnage);
      if (!mv) return;

      data.system = data.system ?? {};
      data.system.movement = data.system.movement ?? {};
      data.system.movement.walk = mv.walk;
      data.system.movement.run = mv.run;
      data.system.movement.jump = mv.jump;
    } catch (err) {
      console.warn("AToW Battletech | preCreateActor movement derivation failed", err);
    }
  });

  Hooks.on("preUpdateActor", (actor, changes) => {
    try {
      if (actor?.type !== "mech") return;
      const sysChg = changes?.system ?? null;

      // Support both expanded objects (changes.system.mech.engine)
      // and dotted-key updates ("system.mech.engine").
      const mechChg = sysChg?.mech ?? {};
      const movementChg = sysChg?.movement ?? {};

      const engineChanging = ("engine" in mechChg) || ("system.mech.engine" in changes);
      const tonnageChanging = ("tonnage" in mechChg) || ("system.mech.tonnage" in changes);

      const explicitWalk = ("walk" in movementChg) || ("system.movement.walk" in changes);
      const explicitRun = ("run" in movementChg) || ("system.movement.run" in changes);
      const explicitJump = ("jump" in movementChg) || ("system.movement.jump" in changes);
      const movementMissingOnActor = !actor?.system?.movement || (
        actor.system.movement.walk == null && actor.system.movement.run == null && actor.system.movement.jump == null
      );

      // Only recompute when relevant inputs change, or movement is missing.
      if (!engineChanging && !tonnageChanging && !movementMissingOnActor) return;

      // Respect explicit movement updates if someone is intentionally writing them in the same update.
      if (explicitWalk || explicitRun || explicitJump) return;

      const nextEngine = engineChanging
        ? (("engine" in mechChg) ? mechChg.engine : changes["system.mech.engine"])
        : actor.system?.mech?.engine;
      const nextTonnage = tonnageChanging
        ? (("tonnage" in mechChg) ? mechChg.tonnage : changes["system.mech.tonnage"])
        : actor.system?.mech?.tonnage;

      const mv = _computeBaseMoveFromEngine(nextEngine, nextTonnage);
      if (!mv) return;

      changes.system = changes.system ?? {};
      changes.system.movement = changes.system.movement ?? {};
      changes.system.movement.walk = mv.walk;
      changes.system.movement.run = mv.run;
      changes.system.movement.jump = mv.jump;
    } catch (err) {
      console.warn("AToW Battletech | preUpdateActor movement derivation failed", err);
    }
  });

  const getMoveSpeeds = (actor) => {
    const sys = actor?.system ?? {};
    const mv = sys.movement ?? sys.move ?? sys.derived?.move ?? {};
    const baseWalk = Number(mv.walk ?? mv.Walk ?? mv.w ?? 0) || 0;
    const baseRun  = Number(mv.run  ?? mv.Run  ?? mv.r ?? 0) || 0;
    const baseJump = Number(mv.jump ?? mv.Jump ?? mv.j ?? 0) || 0;

    // Heat movement penalty (computed each turn after venting)
    const movePenalty = Number(sys.heat?.effects?.movePenalty ?? 0) || 0;

    let walk = Math.max(0, baseWalk - movePenalty);
    const computedRun = Math.max(0, Math.ceil(walk * 1.5));
    let run = (baseRun > 0) ? Math.min(computedRun, baseRun) : computedRun;
    let jump = baseJump; // (heat jump penalties can be added later if desired)

    // Leg loss movement overrides (rest of battle)
    const legLoss = Number(actor?.getFlag?.(SYSTEM_ID, "legLoss") ?? actor?.flags?.[SYSTEM_ID]?.legLoss ?? 0) || 0;
    if (legLoss >= 2) {
      walk = 0;
      run = 0;
      jump = 0;
    } else if (legLoss >= 1) {
      walk = 1;
      run = 1;
    }


    return { walk, run, jump };
  };


  // ------------------------------------------------
  // Jump Movement (click a destination; range = Jump; ends movement)
  // ------------------------------------------------

  const _isJumpJetText = (text) => {
    const t = String(text ?? "").toLowerCase();
    return t.includes("jump jet") || t.includes("jumpjet");
  };

  /**
   * Best-effort destroyed jump jet count:
   * - Uses crit-slot labels when present.
   * - Falls back to resolving UUIDs (async) when labels are blank.
   */
  const _countDestroyedJumpJets = async (actor) => {
    const crit = actor?.system?.crit ?? {};
    let destroyed = 0;

    for (const [locKey, locVal] of Object.entries(crit)) {
      const slots = locVal?.slots;
      if (!slots) continue;

      const entries = Array.isArray(slots)
        ? slots.map((v, i) => [String(i), v])
        : Object.entries(slots);

      for (const [_idxKey, slot] of entries) {
        if (!slot) continue;
        if (!slot.destroyed) continue;

        const label = String(slot.label ?? "").trim();
        if (label && _isJumpJetText(label)) {
          destroyed += 1;
          continue;
        }

        const uuid = String(slot.uuid ?? "").trim();
        if (!uuid) continue;
        try {
          const doc = await fromUuid(uuid);
          const it = (doc?.documentName === "Item") ? doc : null;
          if (it && _isJumpJetText(it.name)) destroyed += 1;
        } catch (_) {
          // ignore
        }
      }
    }

    return Math.max(0, destroyed);
  };
  const _pickCanvasPointOnce = async () => {
    return new Promise((resolve) => {
      const stage = canvas?.stage;
      if (!stage) return resolve(null);

      const onPointerDown = (ev) => {
        try {
          const btn = ev?.data?.button ?? ev?.data?.originalEvent?.button ?? 0;
          // Right-click cancels
          if (btn === 2) return resolve(null);

          const p = ev.data.getLocalPosition(stage);
          resolve({ x: p.x, y: p.y });
        } catch (_) {
          resolve(null);
        }
      };

      stage.once("pointerdown", onPointerDown);
    });
  };

  /**
   * Jump movement:
   * - Prompts the user to click a destination.
   * - Range = mech's listed Jump MP (NOT reduced by heat/leg-loss penalties).
   * - Range IS reduced by destroyed Jump Jets (each destroyed jet reduces Jump MP by 1).
   * - Applies moveMode="jump" and locks further movement for the turn.
   */
  const beginJumpMove = async ({ tokenDoc = null, actor = null } = {}) => {
    try {
      if (!canvas?.ready) {
        ui.notifications?.warn?.("Canvas is not ready.");
        return;
      }
      if (!game.combat?.started) {
        ui.notifications?.warn?.("Jump movement is only supported during combat (for now).");
        return;
      }

      // Resolve tokenDoc/actor
      const activeCombatToken = game.combat?.combatant?.token ?? null;

      if (!tokenDoc) tokenDoc = activeCombatToken;
      if (!actor) actor = tokenDoc?.actor ?? null;

      if (!tokenDoc || !actor) {
        ui.notifications?.warn?.("No active mech token found.");
        return;
      }

      // Only allow the active combatant to use jump.
      if (activeCombatToken?.id && tokenDoc.id !== activeCombatToken.id) {
        ui.notifications?.warn?.("Only the active combatant can Jump right now.");
        return;
      }

      // Jump range comes from the *listed* jump speed.
      const sys = actor?.system ?? {};
      const mv = sys.movement ?? sys.move ?? sys.derived?.move ?? {};
      const baseJump = Number(mv.jump ?? mv.Jump ?? mv.j ?? 0) || 0;

      if (baseJump <= 0) {
        ui.notifications?.warn?.("This mech has no Jump movement listed.");
        return;
      }

      const destroyedJets = await _countDestroyedJumpJets(actor);
      const maxRange = Math.max(0, baseJump - destroyedJets);
      if (maxRange <= 0) {
        ui.notifications?.warn?.("All Jump Jets are destroyed (cannot Jump)." );
        return;
      }

      // If the mech already moved/turned, jumping would create weird mixed states.
      const alreadySpent = Number(tokenDoc.getFlag(SYSTEM_ID, "mpSpentThisTurn") ?? 0) || 0;
      if (alreadySpent > 0) {
        ui.notifications?.warn?.("You have already spent movement this turn. Jump must be your full movement (use it before moving/turning).");
        return;
      }

      ui.notifications?.info?.(`Jump: click a destination within ${maxRange} spaces (right-click to cancel).`);

      // Loop until a legal destination is picked or user cancels.
      while (true) {
        const p = await _pickCanvasPointOnce();
        if (!p) return; // cancelled

        // Snap to a legal grid top-left
        let gx = p.x, gy = p.y;
        if (typeof canvas.grid.getTopLeft === "function") {
          [gx, gy] = canvas.grid.getTopLeft(p.x, p.y);
        } else {
          gx = Math.round(p.x);
          gy = Math.round(p.y);
        }

        const dist = measureGridSpaces({ x: tokenDoc.x, y: tokenDoc.y }, { x: gx, y: gy });
        if (dist > maxRange) {
          ui.notifications?.warn?.(`Destination is ${dist} spaces away (max ${maxRange}). Pick a closer hex.`);
          continue;
        }

        // Update token position + movement flags in a single update.
        const flags = {
          [SYSTEM_ID]: {
            moveMode: "jump",
            jumpedThisTurn: true,
            movementEndedThisTurn: true,

            // Treat jump distance as "spaces moved" for this turn.
            movedHexesThisTurn: dist,
            turnedThisTurn: 0,
            mpSpentThisTurn: dist,
            movedThisTurn: dist,
            spacesMovedThisTurn: dist
          }
        };

        await tokenDoc.update({ x: gx, y: gy, flags }, { atowJumpMove: true });

        // Apply the core "Jumped" status effect so attack TN modifiers are automatic.
        await setTokenStatusEffect(tokenDoc, "atow-jumped", true);
        await playSystemSfx(JUMP_JET_SFX, { volume: 0.9 });
        return;
      }
    } catch (err) {
      console.warn("AToW Battletech | Jump move failed", err);
      ui.notifications?.error?.("Jump move failed (see console).");
    }
  };

  // Expose for the mech sheet button.
  ATOW.api.beginJumpMove = beginJumpMove;


  const getMovementHeatFromMode = (moved, mode) => {
    const n = Number(moved ?? 0) || 0;
    if (n <= 0) return 0;
    const m = String(mode ?? "").toLowerCase();
    if (m === "jump" || m === "jumping") return 1;
    if (m === "run" || m === "running") return 2; // walk +1 plus run +1
    return 1; // default to walk if unknown
  };

  const getCombatStamp = (combat) => `${combat?.round ?? 0}:${combat?.turn ?? 0}`;

  Hooks.on("updateCombat", async (combat, changed) => {
    if (!("turn" in changed || "round" in changed)) return;

    const c = combat.combatant;
    const tokenDoc = c?.token;
    if (!tokenDoc) return;

    // Start of this combatant's turn: clear movement statuses and set turn start position
    await clearMoveStatuses(tokenDoc, { preserveTurnStart: true });

    const start = { x: tokenDoc.x, y: tokenDoc.y };
    await tokenDoc.setFlag("atow-battletech", "turnStart", start);
    await tokenDoc.setFlag("atow-battletech", "lastPos", start);

    // Movement spent this turn (hexes + turns)
    await tokenDoc.setFlag("atow-battletech", "movedHexesThisTurn", 0);
    await tokenDoc.setFlag("atow-battletech", "turnedThisTurn", 0);
    await tokenDoc.setFlag("atow-battletech", "movedThisTurn", 0);      // spaces moved this turn (backwards-compat)
    await tokenDoc.setFlag("atow-battletech", "spacesMovedThisTurn", 0); // alias for spaces moved (preferred name)
    await tokenDoc.setFlag("atow-battletech", "mpSpentThisTurn", 0);     // total MP spent (preferred)

    // Facing bookkeeping
    await tokenDoc.setFlag("atow-battletech", "facingStart", getTokenFacingDegrees(tokenDoc));

    // Movement heat bookkeeping (applied once per turn; may upgrade walk->run)
    await tokenDoc.setFlag("atow-battletech", "moveHeatApplied", 0);
    await tokenDoc.setFlag("atow-battletech", "moveHeatStamp", getCombatStamp(combat));

    // Stamp this token to the current combat turn, so preUpdateToken can self-heal if needed
    await tokenDoc.setFlag("atow-battletech", "turnStamp", getCombatStamp(combat));
  });


  // Clamp movement to Run speed (active combatant only)
  Hooks.on("preUpdateToken", (tokenDoc, changes, options) => {
    if (!game.combat?.started) return;
    if (options?.teleport) return;
    if (options?.atowMoveSync) return;

    const activeTokenId = game.combat?.combatant?.token?.id;
    if (activeTokenId && tokenDoc.id !== activeTokenId) return;

    // Allow our own jump teleport updates to bypass the normal movement accounting.
    if (options?.atowJumpMove) return;

    const isMove = ("x" in changes || "y" in changes);
    if (isMove && (("x" in changes) !== ("y" in changes))) return;
    const isTurn = ("rotation" in changes);
    const isNativeFacingTurn = (_getNativeFacingFromChanges(changes) != null);
    const isAboutFaceTurn = _aboutFaceActive() && (_getAboutFaceDirFromChanges(changes) != null);
    const isFacingTurn = isTurn || isNativeFacingTurn || isAboutFaceTurn;
    if (!isMove && !isFacingTurn) return;

    // If movement has been explicitly ended (e.g., after a Jump), disallow further turning or translation.
    const ended = Boolean(tokenDoc.getFlag(SYSTEM_ID, "movementEndedThisTurn"));
    if (ended) {
      if (isMove) {
        changes.x = tokenDoc.x;
        changes.y = tokenDoc.y;
      }
      if (isTurn) changes.rotation = tokenDoc.rotation;
      if (isNativeFacingTurn) {
        foundry.utils.setProperty(changes, getNativeFacingFlagPath(), _getNativeFacing(tokenDoc) ?? 0);
      }
      if (isAboutFaceTurn) {
        changes.flags = changes.flags ?? {};
        changes.flags["about-face"] = changes.flags["about-face"] ?? {};
        // Revert the About Face direction change.
        changes.flags["about-face"].direction = _getAboutFaceDir(tokenDoc) ?? 0;
      }
      ui.notifications?.warn?.("Movement already ended for this turn.");
      return;
    }

    const actor = tokenDoc.actor;
    if (!actor) return;

    const stamp = getCombatStamp(game.combat);
    const priorStamp = tokenDoc.getFlag("atow-battletech", "turnStamp") ?? null;

    // Self-heal: if we missed the turn-start hook (race) reset counters on first action of the turn.
    let movedHexes = Number(tokenDoc.getFlag("atow-battletech", "movedHexesThisTurn") ?? 0) || 0;
    movedHexes = Math.max(0, Math.round(movedHexes));
    let turned = Number(tokenDoc.getFlag("atow-battletech", "turnedThisTurn") ?? 0) || 0;

    const resetForTurn = (priorStamp !== stamp);
    if (resetForTurn) {
      movedHexes = 0;
      turned = 0;
      changes.flags = changes.flags ?? {};
      changes.flags["atow-battletech"] = changes.flags["atow-battletech"] ?? {};
      changes.flags["atow-battletech"].turnStamp = stamp;
      changes.flags["atow-battletech"].turnStart = { x: tokenDoc.x, y: tokenDoc.y };
      changes.flags["atow-battletech"].lastPos = { x: tokenDoc.x, y: tokenDoc.y };
      changes.flags["atow-battletech"].movedHexesThisTurn = 0;
      changes.flags["atow-battletech"].turnedThisTurn = 0;
      changes.flags["atow-battletech"].mpSpentThisTurn = 0;
      changes.flags["atow-battletech"].movedThisTurn = 0;
      changes.flags["atow-battletech"].spacesMovedThisTurn = 0;
      changes.flags["atow-battletech"].facingStart = getTokenFacingDegrees(tokenDoc);
    }
    const { walk, run } = getMoveSpeeds(actor);
    const maxRun = Number(run ?? 0) || 0;

    // 1) Turning cost (facing changes)
    let deltaTurns = 0;
    if (isFacingTurn) {
      const fromFacing = getTokenFacingDegrees(tokenDoc);
      const toFacing = getTokenFacingDegreesAfterChanges(tokenDoc, changes);
      deltaTurns = facingStepsFromRotationDelta(fromFacing, toFacing);

      const spentNow = movedHexes + turned;
      if (maxRun > 0 && (spentNow + deltaTurns) > maxRun) {
        // No MP remaining for turns, revert the facing change.
        if (isTurn) changes.rotation = tokenDoc.rotation;
        if (isNativeFacingTurn) {
          foundry.utils.setProperty(changes, getNativeFacingFlagPath(), _getNativeFacing(tokenDoc) ?? 0);
        }
        if (isAboutFaceTurn) {
          changes.flags = changes.flags ?? {};
          changes.flags["about-face"] = changes.flags["about-face"] ?? {};
          changes.flags["about-face"].direction = _getAboutFaceDir(tokenDoc) ?? 0;
        }
        deltaTurns = 0;
        ui.notifications?.warn?.("No movement points remaining to change facing.");
      }
    }

    // 2) Translation cost (hexes moved)
    // 2) Translation cost (hexes moved) - only for clamp/forward-back checks.
    let dest = null;
    let segmentThisMove = 0;
    if (isMove) {
      dest = {
        x: ("x" in changes) ? changes.x : tokenDoc.x,
        y: ("y" in changes) ? changes.y : tokenDoc.y
      };

      try {
        const restrictFB = game.settings.get(SYSTEM_ID, "restrictMoveForwardBackward");
        const facingForMove = getTokenFacingDegreesAfterChanges(tokenDoc, changes);
        if (restrictFB && !_isForwardOrBackwardTranslation(tokenDoc, { x: tokenDoc.x, y: tokenDoc.y }, dest, { facingDeg: facingForMove })) {
          changes.x = tokenDoc.x;
          changes.y = tokenDoc.y;
          ui.notifications?.warn?.("Only forward/back movement is allowed. Turn first, then move.");
          return;
        }
      } catch (_) {
        // ignore
      }

      const spentNow = movedHexes + turned + deltaTurns;
      const remaining = Math.max(0, maxRun - spentNow);
      const from = { x: tokenDoc.x, y: tokenDoc.y };
      const rulerTotal = measureTokenRulerSpaces(tokenDoc, from, dest);
    let segment = measureGridSpaces(from, dest);
    try {
      const measure = canvas?.grid?.measurePath;
      if (typeof measure === "function") {
        const path = measure.call(canvas.grid, [from, dest], { gridSpaces: true });
        if (path && Array.isArray(path?.segments)) {
          const total = path.segments.reduce((sum, s) => sum + (Number(s?.distance ?? 0) || 0), 0);
          if (Number.isFinite(total) && total > 0) segment = Math.round(total);
        }
      }
    } catch (_) {
      // ignore
    }
      if (Number.isFinite(rulerTotal) && rulerTotal > 0) {
        if (movedHexes <= 0) segment = rulerTotal;
        else if (rulerTotal > movedHexes) segment = rulerTotal - movedHexes;
      }
      segmentThisMove = Math.max(0, Math.round(segment));
      try {
        if (game?.[SYSTEM_ID]?.config?.debugMoveTracking) {
          const cFrom = getCenterPointFromTopLeft(from.x, from.y);
          const cTo = getCenterPointFromTopLeft(dest.x, dest.y);
          const gpFrom = getGridPosFromPixels(cFrom.x, cFrom.y);
          const gpTo = getGridPosFromPixels(cTo.x, cTo.y);
          const measure = canvas?.grid?.measurePath;
          let segTotal = null;
          if (typeof measure === "function") {
            const path = measure.call(canvas.grid, [from, dest], { gridSpaces: true });
            if (path && Array.isArray(path?.segments)) {
              segTotal = path.segments.reduce((sum, s) => sum + (Number(s?.distance ?? 0) || 0), 0);
            }
          }
          console.debug("AToW Battletech | move segment", {
            tokenId: tokenDoc.id,
            from,
            to: dest,
            gridFrom: gpFrom,
            gridTo: gpTo,
            movedHexes,
            rulerTotal,
            segmentThisMove,
            gridMeasurePath: segTotal
          });
        }
      } catch (_) {}

      if (maxRun > 0 && segmentThisMove > remaining) {
        if (segmentThisMove <= 0 || remaining <= 0) {
          changes.x = tokenDoc.x;
          changes.y = tokenDoc.y;
        } else {
          const from = new PIXI.Point(tokenDoc.x, tokenDoc.y);
          const to = new PIXI.Point(dest.x, dest.y);

          const dx = to.x - from.x;
          const dy = to.y - from.y;

        const scale = remaining / segmentThisMove;
        const clamped = new PIXI.Point(from.x + dx * scale, from.y + dy * scale);

          if (typeof canvas.grid.getTopLeft === "function") {
            const [gx, gy] = canvas.grid.getTopLeft(clamped.x, clamped.y);
            changes.x = gx;
            changes.y = gy;
          } else {
            changes.x = Math.round(clamped.x);
            changes.y = Math.round(clamped.y);
          }
        }
        ui.notifications?.warn?.("Movement limited to Run speed for this turn.");
      }
    }

    // 3) Apply movement tracking into the same update (authoritative)
    if (isMove || isFacingTurn) {
      const flags = changes.flags ?? {};
      const sysFlags = flags[SYSTEM_ID] ?? {};

      let movedHexesNext = movedHexes;
      let turnedNext = turned;

      if (isMove) {
        const finalDest = dest ?? { x: tokenDoc.x, y: tokenDoc.y };
        const segment = Math.max(0, segmentThisMove);
        movedHexesNext = Math.max(0, movedHexesNext + segment);
        sysFlags.lastPos = { x: finalDest.x, y: finalDest.y };
      }

      if (isFacingTurn) {
        turnedNext = Math.max(0, turnedNext + deltaTurns);
      }

      const mpSpentNext = Math.max(0, movedHexesNext + turnedNext);
      const mode = (walk > 0 && mpSpentNext <= walk) ? "walk" : "run";

      sysFlags.movedHexesThisTurn = movedHexesNext;
      sysFlags.turnedThisTurn = turnedNext;
      sysFlags.mpSpentThisTurn = mpSpentNext;
      sysFlags.movedThisTurn = movedHexesNext;
      sysFlags.spacesMovedThisTurn = movedHexesNext;
      sysFlags.moveMode = mode;

      flags[SYSTEM_ID] = sysFlags;
      changes.flags = flags;
    }
  });


  Hooks.on("updateToken", async (tokenDoc, changed, options) => {
    // Only track movement during combat
    if (!game.combat?.started) return;
    if (options?.atowMoveSync) return;
    const activeTokenId = game.combat?.combatant?.token?.id;
    if (activeTokenId && tokenDoc.id !== activeTokenId) return;

    // Only react to movement / turning updates
    const f = changed?.flags?.["atow-battletech"] ?? {};
    const movedOrTurned =
      ("x" in changed || "y" in changed || "rotation" in changed) ||
      ("movedThisTurn" in f) || ("mpSpentThisTurn" in f) || ("moveMode" in f) ||
      ("movedHexesThisTurn" in f) || ("turnedThisTurn" in f);
    if (!movedOrTurned) return;

    const actor = tokenDoc.actor;
    if (!actor) return;

    const { walk } = getMoveSpeeds(actor);

    // NOTE: Walk/Run to-hit modifier is based on hexes moved (not turns).
    let movedHexes = Number(tokenDoc.getFlag("atow-battletech", "movedHexesThisTurn")
      ?? tokenDoc.getFlag("atow-battletech", "movedThisTurn")
      ?? 0) || 0;
    movedHexes = Math.max(0, Math.round(movedHexes));

    // Toggle token HUD effects (walk/run) without touching flags.
    const MOVE_EFFECT_IDS = {
      walk: "atow-walked",
      run: "atow-ran",
      jump: "atow-jumped"
    };

    const clearMoveEffectsOnly = async () => {
      for (const id of Object.values(MOVE_EFFECT_IDS)) {
        await setTokenStatusEffect(tokenDoc, id, false);
      }
    };

    const applyMoveEffectsOnly = async (mode) => {
      for (const [m, id] of Object.entries(MOVE_EFFECT_IDS)) {
        const active = (m === mode);
        await setTokenStatusEffect(tokenDoc, id, active);
      }
    };

    const modeFlag = String(tokenDoc.getFlag("atow-battletech", "moveMode") ?? "").toLowerCase();

    const mpSpent = Number(tokenDoc.getFlag("atow-battletech", "mpSpentThisTurn") ?? 0) || 0;

    // If we Jumped (even if distance is 0), keep the Jump effect visible.
    if (movedHexes < 1 && mpSpent < 1 && modeFlag !== "jump") {
      await clearMoveEffectsOnly();
      return;
    }

    const mode = modeFlag || ((walk > 0 && mpSpent <= walk) ? "walk" : "run");
    await applyMoveEffectsOnly(mode);

    // Apply movement heat once per turn (based on hexes moved, not turns-in-place).
    try {
      if (actor?.type && actor.type !== "mech") {
        // Vehicles/abominations/etc do not generate movement heat.
      } else {
      const stamp = getCombatStamp(game.combat);
      const prevStamp = String(tokenDoc.getFlag("atow-battletech", "moveHeatStamp") ?? "");
      let applied = Number(tokenDoc.getFlag("atow-battletech", "moveHeatApplied") ?? 0) || 0;

      if (prevStamp !== stamp) {
        applied = 0;
        await tokenDoc.setFlag("atow-battletech", "moveHeatStamp", stamp);
        await tokenDoc.setFlag("atow-battletech", "moveHeatApplied", 0);
      }

      const desired = getMovementHeatFromMode(movedHexes, mode);
      const delta = Math.max(0, desired - applied);

      if (delta > 0) {
        const curHeat = Number((actor.system?.heat?.value ?? actor.system?.heat?.current) ?? 0) || 0;
        const nextHeat = clamp(curHeat + delta, 0, HEAT_HARD_CAP);

        // Update heat values; recompute penalties. (We intentionally do NOT re-run shutdown checks mid-turn.)
        const effects = computeHeatEffects(nextHeat);
        const priorShutdown = Boolean(actor.system?.heat?.shutdown);
        const priorShutdownInfo = actor.system?.heat?.effects?.shutdown ?? {};

        await actor.update({
          "system.heat.value": nextHeat,
          "system.heat.current": nextHeat,
          "system.heat.unvented": nextHeat,
          "system.heat.effects.unvented": nextHeat,
          "system.heat.effects.movePenalty": effects.movePenalty,
          "system.heat.effects.fireMod": effects.fireMod,
          "system.heat.shutdown": priorShutdown,
          "system.heat.effects.shutdown": { ...priorShutdownInfo, heat: nextHeat }
        });

        await tokenDoc.setFlag("atow-battletech", "moveHeatApplied", desired);
      }
      }
    } catch (err) {
      console.warn("AToW Battletech | Movement heat application failed", err);
    }

    // Refresh the mech sheet so movement status reflects live token flags.
    try {
      const sheet = actor.sheet;
      if (sheet?.rendered) sheet.render(false);
    } catch (_) {
      // ignore
    }
  });

  game[SYSTEM_ID].config._moveHookRegistered = true;

  // Heat Dissipation Automation (Turn Start)
  // -----------------------------------
  // Heat Effects (computed from remaining heat after dissipation)
  // -----------------------------------
  const computeHeatEffects = (unventedHeat) => {
    const h = Number(unventedHeat ?? 0) || 0;

    // Movement penalties (apply to Walk; Run is recomputed as 1.5x Walk)
    let movePenalty = 0;
    if (h >= 25) movePenalty = 5;
    else if (h >= 20) movePenalty = 4;
    else if (h >= 15) movePenalty = 3;
    else if (h >= 10) movePenalty = 2;
    else if (h >= 5) movePenalty = 1;

    // Fire modifiers (added to TN for weapon attacks)
    let fireMod = 0;
    if (h >= 24) fireMod = 4;
    else if (h >= 17) fireMod = 3;
    else if (h >= 13) fireMod = 2;
    else if (h >= 8) fireMod = 1;

    // Shutdown checks (avoid on X+). 30+ is automatic shutdown.
    let shutdownAuto = false;
    let shutdownAvoidTN = null;

    if (h >= 30) shutdownAuto = true;
    else if (h >= 26) shutdownAvoidTN = 10;
    else if (h >= 22) shutdownAvoidTN = 8;
    else if (h >= 18) shutdownAvoidTN = 6;
    else if (h >= 14) shutdownAvoidTN = 4;

    return { unvented: h, movePenalty, fireMod, shutdownAuto, shutdownAvoidTN };
  };

  // -----------------------------------
  // Total heat venting should use the mech's *total cooling* (engine + installed sinks + other cooling),
  // not just the base engine sinks.
  const parseEngineRating = (engineText) => {
    const m = String(engineText ?? "").match(/(\d+)/);
    const n = m ? Number(m[1]) : NaN;
    return Number.isFinite(n) ? n : null;
  };

  const isHeatSinkItemName = (name) => {
    const n = String(name ?? "").toLowerCase();
    return n.includes("heat sink") || n.includes("heatsink");
  };

  const isDoubleHeatSinkName = (name) => {
    const n = String(name ?? "").toLowerCase();
    return n.includes("double heat sink") || n.includes("double heatsink") || /\b(dhs)\b/.test(n);
  };

  const _getItemHeatDissipation = (doc, { useQuantity = true } = {}) => {
    const sys = doc?.system ?? {};
    const raw = sys.heatDissipation ?? sys.heatDiss ?? sys.dissipation ?? sys.heat?.dissipation ?? 0;
    const v = Number(raw);
    const d = Number.isFinite(v) ? v : 0;

    if (!useQuantity) return d;

    const qtyRaw = sys.quantity ?? sys.qty ?? sys.count ?? 1;
    const qty = Number(qtyRaw);
    const q = Number.isFinite(qty) ? qty : 1;
    return d * q;
  };

  const _isHeatSinkDoc = (doc) => {
    const sys = doc?.system ?? {};
    if (sys.isHeatSink === true) return true;
    return isHeatSinkItemName(doc?.name);
  };

  const _fallbackHeatDissipationFromLabel = (label, { isDouble = false } = {}) => {
    const t = String(label ?? "").toLowerCase();
    if (!t) return 0;
    if (isDoubleHeatSinkName(t) || t.includes("double")) return 2;
    if (isHeatSinkItemName(t)) return isDouble ? 2 : 1;
    return 0;
  };

  const _getCritSlotsArray = (system, locKey) => {
    const locMax = (locKey === "head" || locKey === "ll" || locKey === "rl") ? 6 : 12;
    const stored = system?.crit?.[locKey]?.slots;
    const out = Array.from({ length: locMax }, () => ({}));

    if (Array.isArray(stored)) {
      for (let i = 0; i < Math.min(locMax, stored.length); i++) out[i] = stored[i] ?? {};
      return out;
    }

    if (stored && typeof stored === "object") {
      for (const [k, v] of Object.entries(stored)) {
        const i = Number(k);
        if (!Number.isNaN(i) && i >= 0 && i < locMax) out[i] = v ?? {};
      }
    }

    return out;
  };

  const _getEngineMountedSinksUsed = (actor, { isDouble = false } = {}) => {
    const sys = actor?.system ?? {};
    const heat = sys.heat ?? {};

    const engineRating = parseEngineRating(sys?.mech?.engine ?? sys?.engine?.rating ?? sys?.engine);
    const auto = engineRating ? Math.floor(engineRating / 25) : (Number(heat.baseSinks ?? 10) || 0);

    // Newer field is heat.engineSinks (number). Legacy field is heat.engineSinksUsed (number or "auto").
    let requestedRaw = heat.engineSinks;
    if (!Number.isFinite(Number(requestedRaw))) requestedRaw = heat.engineSinksUsed;

    const requestedNum = Number(requestedRaw);
    const requested = Number.isFinite(requestedNum) ? requestedNum : auto;

    const min = (auto > 10) ? 10 : 0;
    return clamp(requested, min, auto);
  };

  const collectCoolingFromEmbeddedDocs = (docs, { isDouble = false } = {}) => {
    let sinkCount = 0;
    let sinkDissipation = 0;
    let otherDissipation = 0;

    for (const it of (docs ?? [])) {
      if (!it) continue;
      const isSink = _isHeatSinkDoc(it);

      if (isSink) {
        const qty = Number(it?.system?.quantity ?? it?.system?.qty ?? 1) || 1;
        sinkCount += Math.max(0, qty);

        const diss = _getItemHeatDissipation(it, { useQuantity: true });
        const used = (diss > 0) ? diss : (_fallbackHeatDissipationFromLabel(it?.name, { isDouble }) * qty);
        sinkDissipation += used;
      } else {
        const diss = _getItemHeatDissipation(it, { useQuantity: true });
        if (!(diss > 0)) continue;
        otherDissipation += diss;
      }
    }

    return {
      sinkCount: Math.max(0, sinkCount),
      sinkDissipation: Math.max(0, sinkDissipation),
      otherDissipation: Math.max(0, otherDissipation)
    };
  };

  const collectCoolingFromCritSlots = async (actor, { isDouble = false } = {}) => {
    const system = actor?.system ?? {};
    const locKeys = ["head", "ct", "lt", "rt", "la", "ra", "ll", "rl"];

    // Best-effort item resolution for crit-slot UUIDs.
    // In practice crit slots may store:
    // - Embedded UUIDs: Actor.<id>.Item.<id>
    // - World UUIDs:    Item.<id>
    // - Compendium UUIDs
    // We prefer resolving embedded items from the current actor first, because
    // combatants may be synthetic token actors where fromUuid can fail or resolve
    // the "base" Actor instead of the token's embedded item.
    const resolveItemFromUuid = async (uuid) => {
      const u = String(uuid ?? "").trim();
      if (!u) return null;

      // Some older data stored only the Item ID (not a UUID). Try embedded, then world.
      if (!u.includes(".")) {
        const embedded = actor?.items?.get?.(u);
        if (embedded) return embedded;
        const world = game.items?.get?.(u);
        if (world) return world;
      }

      // Embedded item UUID
      const embeddedMatch = u.match(/^Actor\.([^.]+)\.Item\.([^.]+)$/);
      if (embeddedMatch?.[2]) {
        const embedded = actor?.items?.get?.(embeddedMatch[2]);
        if (embedded) return embedded;
      }

      // World item UUID
      const worldMatch = u.match(/^Item\.([^.]+)$/);
      if (worldMatch?.[1]) {
        const world = game.items?.get?.(worldMatch[1]);
        if (world) return world;
      }

      // Compendium or other UUID
      try {
        const doc = await fromUuid(u);
        const it = (doc?.documentName === "Item") ? doc : null;
        return it;
      } catch (_) {
        return null;
      }
    };

    const starts = [];
    const uuidSet = new Set();

    for (const locKey of locKeys) {
      const slots = _getCritSlotsArray(system, locKey);
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i] ?? {};
        if (s?.partOf !== undefined && s?.partOf !== null) continue;

        const uuid = String(s?.uuid ?? "").trim();
        const label = String(s?.label ?? s?.name ?? s?.title ?? "").trim();
        if (!uuid && !label) continue;

        const span = clamp(Number(s?.span ?? 1) || 1, 1, slots.length - i);
        let destroyed = false;
        for (let j = 0; j < span; j++) destroyed ||= Boolean(slots[i + j]?.destroyed);
        if (destroyed) continue;

        if (uuid) uuidSet.add(uuid);
        starts.push({ uuid, label });
      }
    }

    const uuidToDoc = new Map();
    if (uuidSet.size) {
      const unique = Array.from(uuidSet);
      await Promise.all(unique.map(async (uuid) => {
        const doc = await resolveItemFromUuid(uuid);
        if (doc) uuidToDoc.set(uuid, doc);
      }));
    }

    let sinkCount = 0;
    let sinkDissipation = 0;
    let otherDissipation = 0;

    for (const st of starts) {
      const doc = st.uuid ? uuidToDoc.get(st.uuid) : null;
      const label = st.label || doc?.name || "";

      const declaredDiss = doc ? _getItemHeatDissipation(doc, { useQuantity: false }) : 0;
      const fallbackDiss = _fallbackHeatDissipationFromLabel(label, { isDouble });
      const diss = (declaredDiss > 0) ? declaredDiss : fallbackDiss;
      if (!(diss > 0)) continue;

      const isSink = doc ? _isHeatSinkDoc(doc) : isHeatSinkItemName(label);
      if (isSink) {
        sinkCount += 1;
        sinkDissipation += diss;
      } else {
        otherDissipation += diss;
      }
    }

    return {
      sinkCount: Math.max(0, sinkCount),
      sinkDissipation: Math.max(0, sinkDissipation),
      otherDissipation: Math.max(0, otherDissipation)
    };
  };

  const calcTotalCooling = async (actor) => {
    if (!actor) return 0;

    const sys = actor.system ?? {};
    const heat = sys.heat ?? {};

    const sinkTypeRaw = String(heat.sinkType ?? "").toLowerCase();
    const isDouble = Boolean(heat.isDouble) || sinkTypeRaw === "double" || sinkTypeRaw === "dhs" || sinkTypeRaw === "dbl";

    const engineSinksUsed = _getEngineMountedSinksUsed(actor);
    const baseCooling = engineSinksUsed * (isDouble ? 2 : 1);

    const items = Array.from(actor.items ?? []);
    const equipmentDocs = items.filter(i => ["mechEquipment"].includes(i.type));

    const embedded = collectCoolingFromEmbeddedDocs(equipmentDocs, { isDouble });
    const crit = await collectCoolingFromCritSlots(actor, { isDouble });

    // Prefer crit-slot sink dissipation when any sinks exist in crit slots (avoids double counting).
    const installedSinkDissipation = (crit.sinkCount > 0) ? crit.sinkDissipation : embedded.sinkDissipation;

    // Other cooling sources always stack.
    const otherDissipation = (crit.otherDissipation + embedded.otherDissipation);

    const total = Math.max(0, baseCooling + installedSinkDissipation + otherDissipation);
    return Math.round(total * 100) / 100;
  };



  Hooks.on("updateCombat", async (combat, changed) => {
    if (!("turn" in changed || "round" in changed)) return;

    const c = combat.combatant;
    const actor = c?.actor;
    const tokenDoc = c?.token;

    if (!actor) return;
    if (actor.type && actor.type !== "mech") return;

    const totalCooling = await calcTotalCooling(actor);
    const cur = Number((actor.system?.heat?.value ?? actor.system?.heat?.current) ?? 0) || 0;
    const max = Number(actor.system?.heat?.max ?? 30) || 30;

    // Vent heat at start of turn
    const next = clamp(cur - totalCooling, 0, HEAT_HARD_CAP);

    // Compute penalties based on remaining heat (unvented heat)
    const effects = computeHeatEffects(next);

    // Persistent shutdown state (until you add restart logic)
    let shutdown = Boolean(actor.system?.heat?.shutdown);
    let shutdownInfo = actor.system?.heat?.effects?.shutdown ?? {};

    // AUTO-STARTUP (legacy behavior): if the mech is shut down from heat, attempt to start back up at the
    // start of its turn. Manual shutdown (atow.shutdown flag) is not auto-cleared.
    const manualShutdown = _getManualShutdown(actor);
    if (shutdown && !manualShutdown) {
      shutdown = false;
      // Mark the shutdown effect payload as inactive so other parts of the system (e.g., SFX) see the transition.
      shutdownInfo = { ...(shutdownInfo ?? {}), type: "startup", heat: next, active: false, restarted: true };
    }

    // Only attempt a shutdown check if not already shut down
    if (!shutdown) {
      if (effects.shutdownAuto) {
        shutdown = true;
        shutdownInfo = { type: "auto", heat: next, avoided: false, avoidTN: null, roll: null, active: true };

        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor }),
          content: `<b>${actor.name}</b> suffers <b>AUTOMATIC SHUTDOWN</b> due to heat (30+).`
        });
      } else if (effects.shutdownAvoidTN !== null) {
        const roll = await (new Roll("2d6")).evaluate({ async: true });
        const total = roll.total ?? 0;
        const avoided = total >= effects.shutdownAvoidTN;

        shutdownInfo = {
          type: "check",
          heat: next,
          avoidTN: effects.shutdownAvoidTN,
          roll: total,
          avoided,
          active: !avoided
        };

        if (!avoided) shutdown = true;

        await roll.toMessage({
          speaker: ChatMessage.getSpeaker({ actor }),
          flavor: avoided
            ? `Heat Shutdown Check (avoid on ${effects.shutdownAvoidTN}+): <b>AVOIDED</b>`
            : `Heat Shutdown Check (avoid on ${effects.shutdownAvoidTN}+): <b>SHUTDOWN</b>`
        });
      }
    } else {
      // Keep shutdown info updated with current heat
      shutdownInfo = { ...shutdownInfo, heat: next, active: true };
    }

    await actor.update({
      "system.heat.value": next,
      "system.heat.current": next,
      "system.heat.max": max,

      // Remaining heat after venting
      "system.heat.unvented": next,

      // Total cooling (heat vented this turn)
      "system.heat.dissipation": totalCooling,

      // Store computed effects for the round/turn
      "system.heat.effects": {
        unvented: next,
        movePenalty: effects.movePenalty,
        fireMod: effects.fireMod,
        shutdown: shutdownInfo
      },

      // Persistent shutdown marker
      "system.heat.shutdown": shutdown
    });

    // Sync Shutdown + Immobile status effects (and purge legacy/core immobile) after heat processing.
    try { await _syncShutdownAndImmobileOnActorTokens(actor); } catch (_) {}

  });


  // ------------------------------------------------
  // Character Modules (Life Modules / Packages)
  // ------------------------------------------------

  const ATTR_KEY_MAP = {
    "STR": "str",
    "BOD": "bod",
    "RFL": "rfl",
    "DEX": "dex",
    "INT": "int",
    "WIL": "wil",
    "CHA": "cha"
  };

  const _normDash = (s) => String(s ?? "").replace(/\u2013|\u2014/g, "-");

  const _parseXpLines = (text) => {
    const out = [];
    const lines = String(text ?? "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const raw of lines) {
      const line = _normDash(raw);

      // Grab the first signed integer in the line (e.g., "(+100 XP)", "-25", "+10")
      const m = line.match(/([+\-]?\d+)/);
      if (!m) continue;
      const xp = Number(m[1]);
      if (!Number.isFinite(xp)) continue;

      // Key = line minus the number part and common punctuation/words
      const key = line
        .replace(m[1], "")
        .replace(/[\(\)\[\]:;,]/g, "")
        .replace(/\bXP\b/ig, "")
        .trim();

      if (!key) continue;
      out.push({ key, xp });
    }
    return out;
  };

  const _parseAttrReqLines = (text) => {
    const out = [];
    const lines = String(text ?? "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const raw of lines) {
      const line = _normDash(raw).toUpperCase();
      const m = line.match(/^([A-Z]{3})\s*(>=|>|=)?\s*(-?\d+)\s*$/);
      if (!m) continue;
      out.push({ attr: m[1], op: m[2] || ">=", value: Number(m[3]) });
    }
    return out;
  };

  const _meetsReq = (actor, req) => {
    const attrs = actor?.system?.attributes ?? {};
    const a = String(req.attr ?? "").toUpperCase();
    const key = ATTR_KEY_MAP[a];
    if (!key) return true; // ignore unknown requirement

    const cur = Number(attrs?.[key]?.value ?? 0) || 0;
    const v = Number(req.value ?? 0) || 0;
    const op = req.op ?? ">=";

    if (op === ">") return cur > v;
    if (op === "=") return cur === v;
    return cur >= v;
  };

  const _ensurePools = (xp) => {
    const next = foundry.utils.duplicate(xp ?? {});
    next.total = Number(next.total ?? 0) || 0;
    next.spent = Number(next.spent ?? 0) || 0;

    next.pools = next.pools ?? {};
    next.pools.attributes = next.pools.attributes ?? { str: 0, bod: 0, rfl: 0, dex: 0, int: 0, wil: 0, cha: 0 };
    for (const k of ["str","bod","rfl","dex","int","wil","cha"]) next.pools.attributes[k] = Number(next.pools.attributes[k] ?? 0) || 0;

    next.pools.skills = next.pools.skills ?? {};
    next.pools.traits = next.pools.traits ?? {};
    next.pools.unallocated = Number(next.pools.unallocated ?? 0) || 0;
    return next;
  };

  const _addToMap = (obj, key, delta) => {
    const k = String(key ?? "").trim();
    if (!k) return;
    const cur = Number(obj[k] ?? 0) || 0;
    obj[k] = cur + (Number(delta ?? 0) || 0);
  };

  const _applyBiographySlot = async (actor, moduleItem) => {
    const t = String(moduleItem.system?.moduleType ?? "").toLowerCase();
    const name = moduleItem.name ?? "";

    // Ensure array exists
    const mods = Array.isArray(actor.system?.biographyModules) ? [...actor.system.biographyModules] : Array.from({ length: 10 }, () => "");
    while (mods.length < 10) mods.push("");

    if (t === "affiliation") {
      await actor.update({ "system.affiliation": name });
      return;
    }

    const setAt = (idx) => {
      const i = Math.max(0, Math.min(9, Number(idx)));
      mods[i] = name;
    };

    if (t === "earlychildhood") setAt(0);
    else if (t === "latechildhood") setAt(1);
    else if (t === "highereducation") setAt(2);
    else if (t === "reallife") setAt(3);
    else {
      const empty = mods.findIndex((v, i) => i >= 2 && !String(v ?? "").trim());
      setAt(empty >= 0 ? empty : 2);
    }

    await actor.update({ "system.biographyModules": mods });
  };

  const _promptFlexibleAllocations = async (moduleItem) => {
    const flex = moduleItem.system?.flexible ?? {};
    const picks = Number(flex.picks ?? 0) || 0;
    const amount = Number(flex.amount ?? 0) || 0;

    if (picks <= 0 || amount === 0) return [];

    const allowed = [];
    if (flex.allowAttributes) allowed.push("attribute");
    if (flex.allowTraits) allowed.push("trait");
    if (flex.allowSkills) allowed.push("skill");
    if (!allowed.length) return [];

    const attrOptions = Object.keys(ATTR_KEY_MAP).map(a => `<option value="${a}">${a}</option>`).join("");

    const rows = Array.from({ length: picks }).map((_, i) => `
      <div class="flex-row" data-idx="${i}">
        <label>Pick ${i + 1}</label>
        <select class="flex-type">
          ${allowed.map(t => `<option value="${t}">${t}</option>`).join("")}
        </select>
        <select class="flex-attr">${attrOptions}</select>
        <input class="flex-name" type="text" placeholder="Trait/Skill name" style="display:none;" />
      </div>
    `).join("");

    const content = `
      <div class="atow-flex-dialog">
        <p>Allocate <b>${amount >= 0 ? "+" : ""}${amount} XP</b> for each pick.</p>
        ${rows}
      </div>
      <style>
        .atow-flex-dialog .flex-row { display:grid; grid-template-columns: 70px 110px 90px 1fr; gap: 8px; align-items:center; margin: 6px 0; }
        .atow-flex-dialog label { font-weight:700; }
      </style>
    `;

    return new Promise((resolve) => {
      const dlg = new Dialog({
        title: "Allocate Flexible XP",
        content,
        buttons: {
          ok: {
            label: "Apply",
            callback: (html) => {
              const out = [];
              const els = html[0].querySelectorAll(".flex-row");
              for (const row of els) {
                const type = row.querySelector(".flex-type")?.value;
                if (type === "attribute") {
                  const a = row.querySelector(".flex-attr")?.value;
                  if (a) out.push({ type, target: a });
                } else {
                  const name = row.querySelector(".flex-name")?.value?.trim();
                  if (name) out.push({ type, target: name });
                }
              }
              resolve(out);
            }
          },
          cancel: { label: "Cancel", callback: () => resolve(null) }
        },
        default: "ok",
        render: (html) => {
          const root = html[0];
          root.querySelectorAll(".flex-row").forEach(row => {
            const sel = row.querySelector(".flex-type");
            const attrSel = row.querySelector(".flex-attr");
            const nameIn = row.querySelector(".flex-name");

            const sync = () => {
              const t = sel.value;
              if (t === "attribute") {
                attrSel.style.display = "";
                nameIn.style.display = "none";
              } else {
                attrSel.style.display = "none";
                nameIn.style.display = "";
                nameIn.placeholder = (t === "skill") ? "Skill name (e.g. Running)" : "Trait name (e.g. Fit)";
              }
            };

            sel.addEventListener("change", sync);
            sync();
          });
        }
      });
      dlg.render(true);
    });
  };

  const applyCharacterModuleToActor = async (actor, moduleItem) => {
    if (!actor || actor.type !== "character") return;

    if (moduleItem.getFlag?.(SYSTEM_ID, "applied")) return;

    const prereq = moduleItem.system?.prereq ?? {};
    const requiredAff = String(prereq.affiliation ?? "any").trim();
    if (requiredAff && requiredAff.toLowerCase() !== "any") {
      const actorAff = String(actor.system?.affiliation ?? "").trim();
      if (actorAff !== requiredAff) {
        ui.notifications?.warn?.(`Prerequisite failed: requires affiliation "${requiredAff}".`);
        return;
      }
    }

    const reqs = _parseAttrReqLines(prereq.attributesText);
    for (const r of reqs) {
      if (!_meetsReq(actor, r)) {
        ui.notifications?.warn?.(`Prerequisite failed: ${r.attr}${r.op}${r.value}.`);
        return;
      }
    }

    const xp = _ensurePools(actor.system?.xp ?? {});
    const pools = xp.pools;

    let awardedTotal = 0;

    for (const g of _parseXpLines(moduleItem.system?.fixed?.attributesText)) {
      const a = String(g.key ?? "").toUpperCase().trim().slice(0,3);
      const k = ATTR_KEY_MAP[a];
      if (!k) continue;
      pools.attributes[k] = Number(pools.attributes[k] ?? 0) + g.xp;
      awardedTotal += g.xp;
    }

    for (const g of _parseXpLines(moduleItem.system?.fixed?.skillsText)) {
      _addToMap(pools.skills, g.key, g.xp);
      awardedTotal += g.xp;
    }

    for (const g of _parseXpLines(moduleItem.system?.fixed?.traitsText)) {
      _addToMap(pools.traits, g.key, g.xp);
      awardedTotal += g.xp;
    }

    const flex = moduleItem.system?.flexible ?? {};
    const picks = Number(flex.picks ?? 0) || 0;
    const amount = Number(flex.amount ?? 0) || 0;

    if (picks > 0 && amount !== 0) {
      const allocs = await _promptFlexibleAllocations(moduleItem);
      if (allocs === null) {
        ui.notifications?.info?.("Flexible XP allocation cancelled. Module not applied.");
        return;
      }

      let appliedCount = 0;

      for (const a of allocs) {
        if (a.type === "attribute") {
          const k = ATTR_KEY_MAP[String(a.target ?? "").toUpperCase()];
          if (!k) continue;
          pools.attributes[k] = Number(pools.attributes[k] ?? 0) + amount;
          awardedTotal += amount;
          appliedCount += 1;
        } else if (a.type === "skill") {
          _addToMap(pools.skills, a.target, amount);
          awardedTotal += amount;
          appliedCount += 1;
        } else if (a.type === "trait") {
          _addToMap(pools.traits, a.target, amount);
          awardedTotal += amount;
          appliedCount += 1;
        }
      }

      const remaining = Math.max(0, picks - appliedCount);
      if (remaining > 0) {
        pools.unallocated = Number(pools.unallocated ?? 0) + (remaining * amount);
        awardedTotal += (remaining * amount);
      }
    }

    const moduleCost = Number(moduleItem.system?.moduleCost ?? 0) || 0;
    xp.total = Number(xp.total ?? 0) + awardedTotal;
    xp.spent = Number(xp.spent ?? 0) + moduleCost;

    await actor.update({ "system.xp": xp });

    await _applyBiographySlot(actor, moduleItem);

    await moduleItem.setFlag(SYSTEM_ID, "applied", true);

    ui.notifications?.info?.(`Applied Module: ${moduleItem.name} (Awarded ${awardedTotal >= 0 ? "+" : ""}${awardedTotal} XP, Spent ${moduleCost} XP).`);
  };

  Hooks.on("createItem", async (item, options, userId) => {
    try {
      if (userId !== game.userId) return;
      if (!item || item.type !== "characterModule") return;

      const actor = item.parent;
      if (!actor || actor.documentName !== "Actor" || actor.type !== "character") return;

      if (item.getFlag?.(SYSTEM_ID, "applied")) return;

      await applyCharacterModuleToActor(actor, item);
    } catch (err) {
      console.warn("AToW Battletech | Applying Character Module failed", err);
      ui.notifications?.error?.("Failed to apply Character Module (see console).");
    }
  });

  ATOW.api.applyCharacterModuleToActor = applyCharacterModuleToActor;


});

Hooks.once("ready", () => {
  console.log(`${SYSTEM_ID} | Ready`);

  // Movement hooks are registered during init; skip re-registering here.
  if (game?.[SYSTEM_ID]?.config?._moveHookRegistered) return;

  // ------------------------------------------------
  // Combat Movement Automation (Walk/Run/Jump effects)
  // ------------------------------------------------
  const MOVE_EFFECT_IDS = {
    walk: "atow-walked",
    run: "atow-ran",
    jump: "atow-jumped"
  };

  const clearMoveStatuses = async (tokenDoc, { preserveTurnStart = false } = {}) => {
    if (!tokenDoc) return;
    for (const id of Object.values(MOVE_EFFECT_IDS)) {
      await setTokenStatusEffect(tokenDoc, id, false);
    }
    await tokenDoc.unsetFlag("atow-battletech", "moveMode");
    await tokenDoc.unsetFlag("atow-battletech", "movedThisTurn");
    if (!preserveTurnStart) await tokenDoc.unsetFlag("atow-battletech", "turnStart");
  };

  const setMoveStatus = async (tokenDoc, mode) => {
    if (!tokenDoc) return;
    // disable all, then enable one
    for (const [m, id] of Object.entries(MOVE_EFFECT_IDS)) {
      const active = (m === mode);
      await setTokenStatusEffect(tokenDoc, id, active);
    }
    await tokenDoc.setFlag("atow-battletech", "moveMode", mode);
  };

  const getMoveSpeeds = (actor) => {
    const sys = actor?.system ?? {};
    const mv = sys.movement ?? sys.move ?? sys.derived?.move ?? {};
    let walk = Number(mv.walk ?? mv.Walk ?? mv.w ?? 0) || 0;
    let run  = Number(mv.run  ?? mv.Run  ?? mv.r ?? 0) || 0;
    let jump = Number(mv.jump ?? mv.Jump ?? mv.j ?? 0) || 0;

    // Leg loss movement overrides (rest of battle)
    const legLoss = Number(actor?.getFlag?.(SYSTEM_ID, "legLoss") ?? actor?.flags?.[SYSTEM_ID]?.legLoss ?? 0) || 0;
    if (legLoss >= 2) {
      walk = 0;
      run = 0;
      jump = 0;
    } else if (legLoss >= 1) {
      walk = 1;
      run = 1;
    }

    return { walk, run, jump };
  };

  Hooks.on("updateCombat", async (combat, changed) => {
    if (!("turn" in changed || "round" in changed)) return;

    const c = combat.combatant;
    const tokenDoc = c?.token;
    if (!tokenDoc) return;

    // Start of this combatant's turn: clear movement statuses and set turn start position
    await clearMoveStatuses(tokenDoc, { preserveTurnStart: true });
    await tokenDoc.setFlag("atow-battletech", "turnStart", { x: tokenDoc.x, y: tokenDoc.y });
  });

  



  // -----------------------------------
  // Heat Dissipation Automation (Turn Start)
  // -----------------------------------
  const calcTotalHeatSinks = (actor) => {
    if (!actor) return 0;
    const sys = actor.system ?? {};
    const heat = sys.heat ?? {};
    const baseSinks = Number(heat.baseSinks ?? 10) || 0;

    const items = actor.items ?? [];
    let extra = 0;

    for (const it of items) {
      if (!["mechEquipment"].includes(it.type)) continue;
      const n = (it.name ?? "").toLowerCase();
      const qty = Number(it.system?.quantity ?? it.system?.qty ?? 1) || 1;

      if (n.includes("double heat sink") || n.includes("dbl heat sink") || n.includes("dh sink") || n.includes("double heatsink")) extra += 2 * qty;
      else if (n.includes("heat sink") || n.includes("heatsink")) extra += 1 * qty;
    }

    return Math.max(0, baseSinks + extra);
  };

  Hooks.on("updateCombat", async (combat, changed) => {
    if (!("turn" in changed || "round" in changed)) return;

    const c = combat.combatant;
    const actor = c?.actor;
    if (!actor) return;

    // Only apply to mech actors (adjust if your type name differs)
    if (actor.type && actor.type !== "mech") return;

    const totalSinks = calcTotalHeatSinks(actor);
    const cur = Number((actor.system?.heat?.value ?? actor.system?.heat?.current) ?? 0) || 0;
    const max = Number(actor.system?.heat?.max ?? 30) || 30;

    // Fallback: if this legacy hook ever runs, vent at least by total sink count
    // to avoid crashing on an undefined variable.
    const totalCooling = Number(actor.system?.heat?.dissipation ?? 0) || totalSinks;
    const next = clamp(cur - totalCooling, 0, max);
    if (next !== cur) await actor.update({ "system.heat.value": next, "system.heat.current": next, "system.heat.max": max, "system.heat.dissipation": totalCooling });
  });

});

/* -------------------------------------------- */
/* Settings                                     */
/* -------------------------------------------- */

function registerSystemSettings() {
  game.settings.register(SYSTEM_ID, "defaultTN", {
    name: "Default Target Number",
    hint: "The default Target Number (TN) used when none is provided.",
    scope: "world",
    config: true,
    type: Number,
    default: 8
  });

  game.settings.register(SYSTEM_ID, "showRollDetails", {
    name: "Show Roll Details",
    hint: "If enabled, chat cards include formula breakdown and margin of success/failure when a TN is supplied.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });


  game.settings.register(SYSTEM_ID, "floatingCrits", {
    name: "Floating Criticals (Optional Rule)",
    hint: "If enabled, when a TAC opportunity occurs (hit location roll of 2), reroll hit location and apply any TAC/critical hits to the rerolled location. If the reroll is also 2, it does not grant another TAC chance.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });


  game.settings.register(SYSTEM_ID, "restrictMoveForwardBackward", {
    name: "Restrict Mech Translation to Forward/Backward",
    hint: "If enabled, a mech may only translate forward or backward relative to its current facing. Lateral movement requires turning first.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(SYSTEM_ID, "rotateTokenArtWithFacing", {
    name: "Rotate Token Art With Facing",
    hint: "If enabled, token artwork rotates when facing changes. If disabled, the system tracks facing separately and shows it with the facing indicator.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false
  });

  game.settings.register(SYSTEM_ID, "showFacingIndicator", {
    name: "Show Facing Indicator",
    hint: "Display a built-in facing arrow on tokens using the system's native Battletech facing.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(SYSTEM_ID, "facingIndicatorColor", {
    name: "Facing Indicator Color",
    hint: "Choose the color used by the built-in facing arrow.",
    scope: "world",
    config: true,
    type: new foundry.data.fields.ColorField({ nullable: false, initial: "#ff9f1c" }),
    default: "#ff9f1c"
  });

  game.settings.register(SYSTEM_ID, "facingIndicatorScale", {
    name: "Facing Indicator Scale",
    hint: "Adjust the size of the built-in facing arrow.",
    scope: "world",
    config: true,
    type: Number,
    default: 1,
    range: {
      min: 0.5,
      max: 2,
      step: 0.05
    }
  });
}

/* -------------------------------------------- */
/* Templates                                    */
/* -------------------------------------------- */

async function preloadHandlebarsTemplates() {
  const paths = [
    `systems/${SYSTEM_ID}/templates/character-sheet.hbs`,
    `systems/${SYSTEM_ID}/templates/abomination-sheet.hbs`,
    `systems/${SYSTEM_ID}/templates/skill-sheet.hbs`,
    `systems/${SYSTEM_ID}/templates/trait-sheet.hbs`,
    `systems/${SYSTEM_ID}/templates/item-sheet.hbs`,
    `systems/${SYSTEM_ID}/templates/mech-sheet.hbs`,
    `systems/${SYSTEM_ID}/templates/wheeledvehicle-sheet.hbs`,
    `systems/${SYSTEM_ID}/templates/mech-weapon.hbs`,
    `systems/${SYSTEM_ID}/templates/mech-equipment.hbs`,
    `systems/${SYSTEM_ID}/templates/character-weapon.hbs`,
    `systems/${SYSTEM_ID}/templates/character-armor.hbs`,
    `systems/${SYSTEM_ID}/templates/character-module.hbs`,
    `systems/${SYSTEM_ID}/templates/character-equipment.hbs`
  ];

  await foundry.applications.handlebars.loadTemplates(paths);
}

/* -------------------------------------------- */
/* Handlebars Helpers                           */
/* -------------------------------------------- */

function registerHandlebarsHelpers() {
  // Simple equality helper: (ifEq a b) ... (else) ...
  Handlebars.registerHelper("ifEq", function (a, b, options) {
    return (a === b) ? options.fn(this) : options.inverse(this);
  });

  // Format signed numbers: +2, -1, 0
  Handlebars.registerHelper("signed", function (n) {
    const num = Number(n ?? 0);
    if (Number.isNaN(num)) return "0";
    return num > 0 ? `+${num}` : `${num}`;
  });
}

/* -------------------------------------------- */
/* Rolling                                      */
/* -------------------------------------------- */

/**
 * Generic AToW-style check: 2d6 + modifier vs TN
 * - If tn is omitted, we use the system defaultTN setting.
 * - If tn is null, we don’t evaluate success/failure (just show the roll).
 */
async function rollCheck({
  actor = null,
  label = "Check",
  modifier = 0,
  tn = undefined,         // undefined => use default setting, null => no TN comparison
  flavor = ""
} = {}) {
  const useTN = (tn === undefined) ? game.settings.get(SYSTEM_ID, "defaultTN") : tn;

  // Leg loss penalty: +5 TN to Pilot checks (we apply to any TN-based check rolled by the mech actor).
  let finalTN = useTN;
  if (finalTN !== null && finalTN !== undefined && actor) {
    const legLoss = Number(actor.getFlag?.(SYSTEM_ID, "legLoss") ?? actor.flags?.[SYSTEM_ID]?.legLoss ?? 0) || 0;
    if (legLoss >= 1) finalTN = Number(finalTN) + 5;
  }

  const mod = Number(modifier ?? 0);
  const formula = `2d6 + ${mod}`;
  const roll = await (new Roll(formula)).evaluate();

  const showDetails = game.settings.get(SYSTEM_ID, "showRollDetails");

  let outcomeText = "";
  if (finalTN !== null && finalTN !== undefined) {
    const total = roll.total ?? 0;
    const margin = total - finalTN;
    const success = margin >= 0;
    outcomeText = showDetails
      ? ` | TN ${finalTN} → <b>${success ? "SUCCESS" : "FAIL"}</b> (${success ? "+" : ""}${margin})`
      : ` | TN ${finalTN} → <b>${success ? "SUCCESS" : "FAIL"}</b>`;
  }

  const speaker = ChatMessage.getSpeaker({ actor: actor ?? undefined });

  return roll.toMessage({
    speaker,
    flavor: `${flavor || label}${outcomeText}`
  });
}
