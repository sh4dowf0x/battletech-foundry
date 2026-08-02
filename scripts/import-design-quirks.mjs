/**
 * Import BattleMech design quirks from design-quirks.txt into the system's
 * Mech Equipment compendium.
 *
 * Run from Foundry's developer console while logged in as a GM:
 *
 * await import("/systems/atow-battletech/scripts/import-design-quirks.mjs")
 *   .then(module => module.importDesignQuirks());
 *
 * The importer is safe to run again. It updates quirks previously imported
 * from the text file (and matching mechQuirk items) instead of duplicating
 * them.
 */

const SYSTEM_ID = "atow-battletech";
const DEFAULT_PACK_ID = `${SYSTEM_ID}.mech-equipment`;
const DEFAULT_SOURCE_URL = `/systems/${SYSTEM_ID}/design-quirks.txt`;
const IMPORT_VERSION = 1;

function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isUppercaseHeading(value) {
  const text = String(value ?? "").trim();
  if (!text || text.startsWith("(") || text.length > 100) return false;

  const letters = text.replace(/[^A-Za-z]/g, "");
  return Boolean(letters) && letters === letters.toUpperCase();
}

function readHeading(lines, index) {
  const text = lines[index]?.trim() ?? "";
  const previous = lines[index - 1]?.trim() ?? "";
  if (previous || !isUppercaseHeading(text)) return null;

  let heading = text;
  let endIndex = index;
  const next = lines[index + 1]?.trim() ?? "";

  if (!heading.includes("(") && next.startsWith("(")) {
    do {
      endIndex += 1;
      heading += ` ${lines[endIndex].trim()}`;
    } while (!heading.includes(")") && endIndex + 1 < lines.length);
  }

  heading = normalizeWhitespace(heading);
  const match = heading.match(/^(.+?)\s*\((.+)\)$/);
  if (!match) {
    return {
      title: heading,
      costExpression: "",
      endIndex
    };
  }

  return {
    title: normalizeWhitespace(match[1]),
    costExpression: normalizeWhitespace(match[2]),
    endIndex
  };
}

function titleCaseQuirkName(value) {
  let name = String(value ?? "").toLocaleLowerCase();
  name = name.replace(/(^|[\s/-])([a-z])/g, (_, boundary, letter) => {
    return `${boundary}${letter.toLocaleUpperCase()}`;
  });

  return name
    .replace(/\bAc\b/g, "AC")
    .replace(/\bEm\b/g, "EM")
    .replace(/\b(To|Or|And|Of|The)\b/g, word => word.toLocaleLowerCase())
    .replace(/[’']mech\b/gi, match => `${match[0]}Mech`);
}

function formatCostExpression(value) {
  const expression = normalizeWhitespace(value);
  if (!expression) return "Not specified";

  return expression
    .toLocaleLowerCase()
    .replace(/\b(short|medium|long)\b/g, word => {
      return word[0].toLocaleUpperCase() + word.slice(1);
    });
}

function pointsFromCostExpression(value) {
  const expression = normalizeWhitespace(value);
  const numbers = [...expression.matchAll(/\d+/g)]
    .map(match => Number(match[0]))
    .filter(Number.isFinite)
    .map(points => Math.min(5, Math.max(0, points)));

  // A selectable cost uses its lowest listed value as the compendium
  // template. A cost of "VARIES" has no numeric default and starts at 0.
  return numbers.length ? Math.min(...numbers) : 0;
}

function normalizeDescription(lines) {
  const paragraphs = [];
  let current = [];

  const flush = () => {
    const paragraph = normalizeWhitespace(current.join(" "));
    if (paragraph) paragraphs.push(paragraph);
    current = [];
  };

  for (const line of lines) {
    const text = line.trim();
    if (!text) {
      flush();
      continue;
    }
    current.push(text);
  }
  flush();

  return paragraphs.join("\n\n");
}

function importKey(polarity, name) {
  const slug = String(name ?? "")
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${polarity}:${slug}`;
}

export function parseDesignQuirks(sourceText) {
  const lines = String(sourceText ?? "").replace(/\r/g, "").split("\n");
  const quirks = [];
  let polarity = null;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index].trim();

    if (line === "POSITIVE DESIGN QUIRKS") {
      polarity = "positive";
      index += 1;
      continue;
    }
    if (line === "NEGATIVE DESIGN QUIRKS") {
      polarity = "negative";
      index += 1;
      continue;
    }
    if (!polarity) {
      index += 1;
      continue;
    }

    const heading = readHeading(lines, index);
    if (!heading) {
      index += 1;
      continue;
    }

    const descriptionLines = [];
    let nextIndex = heading.endIndex + 1;

    while (nextIndex < lines.length) {
      const candidate = lines[nextIndex].trim();
      if (candidate === "POSITIVE DESIGN QUIRKS" || candidate === "NEGATIVE DESIGN QUIRKS") break;
      if (readHeading(lines, nextIndex)) break;
      descriptionLines.push(lines[nextIndex]);
      nextIndex += 1;
    }

    const name = titleCaseQuirkName(heading.title);
    const rulesText = normalizeDescription(descriptionLines);
    const costText = formatCostExpression(heading.costExpression);

    quirks.push({
      key: importKey(polarity, name),
      name,
      polarity,
      points: pointsFromCostExpression(heading.costExpression),
      costExpression: heading.costExpression,
      description: `Point Cost: ${costText}${rulesText ? `\n\n${rulesText}` : ""}`
    });

    index = nextIndex;
  }

  return quirks;
}

function itemDataForQuirk(quirk) {
  return {
    name: quirk.name,
    type: "mechQuirk",
    system: {
      polarity: quirk.polarity,
      points: quirk.points,
      description: quirk.description
    },
    flags: {
      [SYSTEM_ID]: {
        designQuirkImport: {
          key: quirk.key,
          source: "design-quirks.txt",
          version: IMPORT_VERSION,
          costExpression: quirk.costExpression
        }
      }
    }
  };
}

export async function importDesignQuirks({
  packId = DEFAULT_PACK_ID,
  sourceUrl = DEFAULT_SOURCE_URL,
  sourceText = null,
  dryRun = false
} = {}) {
  if (!globalThis.game?.user?.isGM) {
    throw new Error("A GM user must run the design quirk importer.");
  }

  let text = sourceText;
  if (text === null) {
    const response = await fetch(sourceUrl, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Could not load ${sourceUrl}: HTTP ${response.status}`);
    }
    text = await response.text();
  }

  const quirks = parseDesignQuirks(text);
  if (!quirks.length) throw new Error("No design quirks were found in the source text.");

  const duplicateKeys = quirks
    .map(quirk => quirk.key)
    .filter((key, index, all) => all.indexOf(key) !== index);
  if (duplicateKeys.length) {
    throw new Error(`Duplicate design quirks found: ${[...new Set(duplicateKeys)].join(", ")}`);
  }

  if (dryRun) {
    return {
      total: quirks.length,
      positive: quirks.filter(quirk => quirk.polarity === "positive").length,
      negative: quirks.filter(quirk => quirk.polarity === "negative").length,
      quirks
    };
  }

  const pack = game.packs.get(packId);
  if (!pack) throw new Error(`Compendium "${packId}" was not found.`);
  if (pack.documentName !== "Item") {
    throw new Error(`Compendium "${packId}" is not an Item compendium.`);
  }

  const existing = await pack.getDocuments();
  const byImportKey = new Map();
  const byName = new Map();

  for (const item of existing) {
    if (item.type !== "mechQuirk") continue;
    const key = item.getFlag(SYSTEM_ID, "designQuirkImport")?.key;
    if (key) byImportKey.set(key, item);
    byName.set(String(item.name ?? "").trim().toLocaleLowerCase(), item);
  }

  const creates = [];
  const updates = [];

  for (const quirk of quirks) {
    const data = itemDataForQuirk(quirk);
    const existingItem = byImportKey.get(quirk.key)
      ?? byName.get(quirk.name.trim().toLocaleLowerCase());

    if (existingItem) updates.push({ _id: existingItem.id, ...data });
    else creates.push(data);
  }

  const wasLocked = Boolean(pack.locked);
  if (wasLocked) await pack.configure({ locked: false });

  try {
    if (updates.length) {
      await pack.documentClass.updateDocuments(updates, { pack: pack.collection });
    }
    if (creates.length) {
      await pack.documentClass.createDocuments(creates, { pack: pack.collection });
    }
  } finally {
    if (wasLocked) await pack.configure({ locked: true });
  }

  const summary = {
    total: quirks.length,
    created: creates.length,
    updated: updates.length,
    positive: quirks.filter(quirk => quirk.polarity === "positive").length,
    negative: quirks.filter(quirk => quirk.polarity === "negative").length,
    packId
  };

  ui.notifications.info(
    `Design quirks imported: ${summary.created} created, ${summary.updated} updated.`
  );
  console.info(`${SYSTEM_ID} | Design quirk import complete`, summary);
  return summary;
}
