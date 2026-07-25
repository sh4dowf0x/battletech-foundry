// Canonical A Time of War Master Skills List complexity reference.
// Codes: SB = Simple-Basic, SA = Simple-Advanced,
//        CB = Complex-Basic, CA = Complex-Advanced.

export const SKILL_CLASSIFICATION_REFERENCE_VERSION = 1;

export const SKILL_CLASSIFICATION_REFERENCE = Object.freeze({
  "acrobatics": "SB",
  "acting": "CB",
  "administration": "SA",
  "animal handling": "SB",
  "appraisal": "CB",
  "archery": "SB",
  "art": "CA",
  "artillery": "SA",
  "career": "SB",
  "climbing": "SB",
  "communications": "SB",
  "computers": "CA",
  "cryptography": "CA",
  "demolitions": "CA",
  "disguise": "SB",
  "driving": "SA",
  "escape artist": "CA",
  "forgery": "SA",
  "gunnery": "SA",
  "interest": "CA",
  "interrogation": "CA",
  "investigation": "CA",
  "language": "SA",
  "leadership": "SA",
  "martial arts": "SA",
  "medtech": "SB",
  "melee weapons": "SA",
  "navigation": "SB",
  "negotiation": "CB",
  "perception": "SB",
  "piloting": "SA",
  "prestidigitation": "SA",
  "protocol": "CA",
  "running": "SB",
  "science": "CA",
  "security systems": "CA",
  "sensor operations": "SA",
  "small arms": "SB",
  "stealth": "SA",
  "strategy": "CA",
  "streetwise": "CB",
  "support weapons": "SB",
  "surgery": "CA",
  "survival": "CA",
  "swimming": "SB",
  "tactics": "CA",
  "technician": "CA",
  "thrown weapons": "SB",
  "tracking": "SA",
  "training": "CA",
  "zero-g operations": "SB"
});

export function normalizeSkillReferenceName(name) {
  return String(name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function classificationFromCode(code = "SB") {
  const normalized = /^(?:S|C)(?:A|B)$/.test(String(code).trim().toUpperCase())
    ? String(code).trim().toUpperCase()
    : "SB";
  return {
    actionComplexity: normalized.startsWith("C") ? "complex" : "simple",
    trainingCategory: normalized.endsWith("A") ? "advanced" : "basic",
    code: normalized
  };
}

export function getReferencedSkillClassification(skillOrName) {
  const name = typeof skillOrName === "string" ? skillOrName : skillOrName?.name;
  const code = SKILL_CLASSIFICATION_REFERENCE[normalizeSkillReferenceName(name)];
  return code ? classificationFromCode(code) : null;
}

export function getEffectiveSkillClassification(skill) {
  const system = skill?.system ?? skill ?? {};
  const referenceVersion = Number(system.classificationReferenceVersion ?? 0) || 0;
  const referenced = getReferencedSkillClassification(skill);
  if (referenced && referenceVersion < SKILL_CLASSIFICATION_REFERENCE_VERSION) return referenced;

  const actionComplexity = String(system.actionComplexity ?? system.complexity ?? "").trim().toLowerCase();
  const trainingCategory = String(system.trainingCategory ?? system.training ?? "").trim().toLowerCase();
  const storedCode = [system.complexityCode, system.c, system.check, system.categoryShort]
    .map(value => String(value ?? "").trim().toUpperCase())
    .find(value => /^(?:S|C)(?:A|B)$/.test(value) && value !== "SB");
  if (!referenced && referenceVersion < SKILL_CLASSIFICATION_REFERENCE_VERSION
    && actionComplexity === "simple" && trainingCategory === "basic" && storedCode) {
    return classificationFromCode(storedCode);
  }
  if (["simple", "complex"].includes(actionComplexity) && ["basic", "advanced"].includes(trainingCategory)) {
    return {
      actionComplexity,
      trainingCategory,
      code: `${actionComplexity === "complex" ? "C" : "S"}${trainingCategory === "advanced" ? "A" : "B"}`
    };
  }

  const anyStoredCode = [system.complexityCode, system.c, system.check, system.categoryShort]
    .map(value => String(value ?? "").trim().toUpperCase())
    .find(value => /^(?:S|C)(?:A|B)$/.test(value));
  return anyStoredCode ? classificationFromCode(anyStoredCode) : (referenced ?? classificationFromCode("SB"));
}

export function getSkillClassificationReferenceUpdate(skill) {
  const reference = getReferencedSkillClassification(skill);
  if (!reference) return null;
  return {
    "system.actionComplexity": reference.actionComplexity,
    "system.trainingCategory": reference.trainingCategory,
    "system.complexityCode": reference.code,
    "system.c": reference.code,
    "system.classificationReferenceVersion": SKILL_CLASSIFICATION_REFERENCE_VERSION
  };
}
