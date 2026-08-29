import {
  SKILL_CLASSIFICATION_REFERENCE,
  getEffectiveSkillClassification,
  normalizeSkillReferenceName
} from "./skill-classifications.js";

export const NATURAL_APTITUDE_DICE_FORMULA = "3d6kh2";

function titleCaseSkill(name) {
  return String(name ?? "")
    .split(/\s+/g)
    .map(word => word ? `${word[0].toUpperCase()}${word.slice(1)}` : "")
    .join(" ")
    .replace(/Zero-g/gi, "Zero-G");
}

export function isTraitActive(traitOrSystem) {
  const system = traitOrSystem?.system ?? traitOrSystem ?? {};
  const tp = Number(system.tp ?? 0) || 0;
  const xp = Number(system.cost ?? 0) || 0;
  const threshold = tp * 100;
  return tp < 0 ? xp <= threshold : xp >= threshold;
}

export function getNaturalAptitudeKind(traitOrName) {
  const name = String(typeof traitOrName === "string" ? traitOrName : traitOrName?.name ?? "").trim();
  if (!/\bnatural\s+aptitude\b/i.test(name)) return null;
  if (/\bca\s*\/\s*sa\b/i.test(name)) return "advanced";
  if (/\bcb\s*\/\s*sb\b/i.test(name)) return "basic";
  return null;
}

export function getNaturalAptitudeSkillChoices(traitOrName) {
  const kind = getNaturalAptitudeKind(traitOrName);
  if (!kind) return [];
  const suffix = kind === "advanced" ? "A" : "B";
  return Object.entries(SKILL_CLASSIFICATION_REFERENCE)
    .filter(([, code]) => String(code).endsWith(suffix))
    .map(([name]) => ({ value: name, label: titleCaseSkill(name) }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

export function getNaturalAptitudeSelectedSkill(trait) {
  return String(
    trait?.system?.naturalAptitudeSkill
    ?? trait?.system?.selectedSkill
    ?? ""
  ).trim();
}

export function getActiveNaturalAptitude(actor, skill) {
  if (!actor || !skill) return null;
  const skillName = normalizeSkillReferenceName(skill.name);
  if (!skillName) return null;

  const skillClassification = getEffectiveSkillClassification(skill);
  const skillKind = skillClassification.trainingCategory === "advanced" ? "advanced" : "basic";
  const traits = actor.items?.contents ?? Array.from(actor.items ?? []);

  return traits.find(trait => {
    if (!['trait', 'characterTrait'].includes(trait?.type)) return false;
    const kind = getNaturalAptitudeKind(trait);
    if (!kind || kind !== skillKind || !isTraitActive(trait)) return false;
    return normalizeSkillReferenceName(getNaturalAptitudeSelectedSkill(trait)) === skillName;
  }) ?? null;
}

