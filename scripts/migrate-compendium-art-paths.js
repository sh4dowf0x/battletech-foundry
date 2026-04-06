const SYSTEM_ID = "atow-battletech";
const PACK_NAMES = [
  "combat-vehicles",
  "tro-3025",
  "tro-3050",
  "tro-custom-mechs",
  "character-creation",
  "mech-equipment",
  "abominations"
];

const OLD_PREFIX = "assets/";
const NEW_PREFIX = `systems/${SYSTEM_ID}/assets/`;
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "svg"]);

function normalizeName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/['.`]/g, "")
    .replace(/\bii\b/g, "2")
    .replace(/\biii\b/g, "3")
    .replace(/\biv\b/g, "4")
    .replace(/\bv\b/g, "5")
    .replace(/\b2c\b/g, "2c")
    .replace(/\b2\b/g, "2")
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function getPackCategory(packName) {
  if (packName === "combat-vehicles") return "vehicle";
  if (packName === "abominations") return "abomination";
  if (packName.startsWith("tro-")) return "mech";
  return null;
}

async function browseAssets(path) {
  const result = await FilePicker.browse("data", path);
  let files = [...result.files];
  for (const dir of result.dirs) {
    files = files.concat(await browseAssets(dir));
  }
  return files;
}

async function buildAssetIndex() {
  const files = await browseAssets(`systems/${SYSTEM_ID}/assets`);
  const images = files
    .filter(file => IMAGE_EXTENSIONS.has(file.split(".").pop()?.toLowerCase()))
    .map(file => {
      const name = file.split("/").pop() ?? file;
      const category =
        file.includes("/vehicle-art/") ? "vehicle" :
        file.includes("/abomination-art/") ? "abomination" :
        file.includes("/mech-art/") ? "mech" :
        null;

      const baseName = name.replace(/\.[^.]+$/, "");
      const withoutPrefix = baseName
        .replace(/^mech-/, "")
        .replace(/^vehicle-/, "")
        .replace(/^abomination-/, "");

      return {
        path: file,
        category,
        normalized: normalizeName(withoutPrefix),
        baseName
      };
    });

  return images;
}

function scoreAssetMatch(normalizedActorName, asset) {
  if (!normalizedActorName || !asset?.normalized) return -1;
  if (asset.normalized === normalizedActorName) return 100;
  if (asset.normalized.startsWith(normalizedActorName)) return 90;
  if (normalizedActorName.startsWith(asset.normalized)) return 80;
  if (asset.normalized.includes(normalizedActorName)) return 70;
  if (normalizedActorName.includes(asset.normalized)) return 60;
  return -1;
}

function findBestActorImage(doc, packName, assetIndex) {
  const category = getPackCategory(packName);
  if (!category) return null;

  const normalizedActorName = normalizeName(doc.name);
  const candidates = assetIndex.filter(asset => asset.category === category);

  let best = null;
  let bestScore = -1;
  for (const asset of candidates) {
    const score = scoreAssetMatch(normalizedActorName, asset);
    if (score > bestScore) {
      best = asset;
      bestScore = score;
    }
  }

  return bestScore >= 60 ? best?.path ?? null : null;
}

function rewriteAssetPath(path) {
  if (typeof path !== "string") return null;
  if (!path.startsWith(OLD_PREFIX)) return null;
  return `${NEW_PREFIX}${path.slice(OLD_PREFIX.length)}`;
}

function collectDocumentUpdate(doc, packName, assetIndex) {
  const update = {};

  let newImg = rewriteAssetPath(doc.img);
  if (doc.documentName === "Actor") {
    newImg = findBestActorImage(doc, packName, assetIndex) ?? newImg;
  }
  if (newImg) update.img = newImg;

  const finalImg = newImg ?? doc.img;
  if (doc.documentName === "Actor" && typeof finalImg === "string" && finalImg.length) {
    update["prototypeToken.texture.src"] = finalImg;
    update["prototypeToken.img"] = finalImg;
  } else {
    const tokenTexture = doc.prototypeToken?.texture?.src;
    const newTokenTexture = rewriteAssetPath(tokenTexture);
    if (newTokenTexture) update["prototypeToken.texture.src"] = newTokenTexture;

    const legacyTokenImg = doc.prototypeToken?.img;
    const newLegacyTokenImg = rewriteAssetPath(legacyTokenImg);
    if (newLegacyTokenImg) update["prototypeToken.img"] = newLegacyTokenImg;
  }

  return update;
}

function collectEmbeddedItemUpdates(actor) {
  const updates = [];

  for (const item of actor.items) {
    const newImg = rewriteAssetPath(item.img);
    if (!newImg) continue;
    updates.push({ _id: item.id, img: newImg });
  }

  return updates;
}

async function maybeUnlockPack(pack) {
  if (!pack.locked) return false;
  await pack.configure({ locked: false });
  return true;
}

async function migratePack(packName, assetIndex) {
  const pack = game.packs.get(`${SYSTEM_ID}.${packName}`);
  if (!pack) {
    console.warn(`Pack not found: ${SYSTEM_ID}.${packName}`);
    return { packName, documentsUpdated: 0, embeddedItemsUpdated: 0, missing: true };
  }

  let relock = false;
  try {
    relock = await maybeUnlockPack(pack);
  } catch (error) {
    console.warn(`Could not unlock ${pack.collection}; trying anyway.`, error);
  }

  const docs = await pack.getDocuments();
  let documentsUpdated = 0;
  let embeddedItemsUpdated = 0;

  for (const doc of docs) {
    const update = collectDocumentUpdate(doc, packName, assetIndex);
    if (Object.keys(update).length) {
      await doc.update(update);
      documentsUpdated += 1;
    }

    if (doc.documentName === "Actor" && doc.items?.size) {
      const itemUpdates = collectEmbeddedItemUpdates(doc);
      if (itemUpdates.length) {
        await doc.updateEmbeddedDocuments("Item", itemUpdates);
        embeddedItemsUpdated += itemUpdates.length;
      }
    }
  }

  if (relock) {
    try {
      await pack.configure({ locked: true });
    } catch (error) {
      console.warn(`Could not relock ${pack.collection}.`, error);
    }
  }

  return { packName, documentsUpdated, embeddedItemsUpdated, missing: false };
}

async function runMigration() {
  const results = [];
  const assetIndex = await buildAssetIndex();

  for (const packName of PACK_NAMES) {
    results.push(await migratePack(packName, assetIndex));
  }

  console.table(results);

  const changedDocs = results.reduce((sum, r) => sum + r.documentsUpdated, 0);
  const changedItems = results.reduce((sum, r) => sum + r.embeddedItemsUpdated, 0);
  const missing = results.filter(r => r.missing).map(r => r.packName);

  const summary = [
    `Updated ${changedDocs} compendium documents`,
    `updated ${changedItems} embedded item images`
  ];

  if (missing.length) summary.push(`missing packs: ${missing.join(", ")}`);

  ui.notifications?.info(summary.join("; "));
  return results;
}

runMigration();
