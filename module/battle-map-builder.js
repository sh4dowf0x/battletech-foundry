const SYSTEM_ID = "atow-battletech";
const BATTLE_MAP_FLAG = "battleMap";
const TERRAIN_TILE_FLAG = "battleMapTerrain";
const RULES_TERRAIN_FLAG = "terrain";
const TERRAIN_PALETTE_TEMPLATE = `systems/${SYSTEM_ID}/templates/battle-map-terrain-palette.hbs`;

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

// A traditional sheet is 17 hex rows high and spans 16 flat-top column
// strides horizontally (15 playable columns plus the clipped edge columns).
// Foundry requires an integer grid size, so 125 px gives an exact 2125 px
// height and a 1732.05 px theoretical width, rounded to 1732 px.
const MAP_SHEET_WIDTH = 1732;
const MAP_SHEET_HEIGHT = 2125;
const MAP_GRID_SIZE = 125;
const BATTLE_MAP_VERSION = 5;

const TERRAIN_SETS = (() => {
  const desert = {
    label: "Desert",
    background: `systems/${SYSTEM_ID}/assets/terrain/desert-1.webp`,
    pieces: {
      lightWoods: {
        label: "Light Woods",
        category: "Woods",
        description: "+1 MP to enter; intervening woods affect line of sight.",
        icon: "fas fa-tree",
        src: `systems/${SYSTEM_ID}/assets/terrain/desert-lightwoods-1.webp`,
        sources: [1, 2, 3, 4, 5].map(number =>
          `systems/${SYSTEM_ID}/assets/terrain/desert-lightwoods-${number}.webp`),
        width: 122,
        height: 117,
        sort: 140,
        randomRotation: true,
        terrainType: "light-woods",
        exclusiveGroup: "woods"
      },
      heavyWoods: {
        label: "Heavy Woods",
        category: "Woods",
        description: "+2 MP to enter; dense intervening woods affect line of sight.",
        icon: "fas fa-tree",
        src: `systems/${SYSTEM_ID}/assets/terrain/desert-heavywoods-1.webp`,
        sources: [1, 2, 3].map(number =>
          `systems/${SYSTEM_ID}/assets/terrain/desert-heavywoods-${number}.webp`),
        width: 122,
        height: 117,
        sort: 140,
        randomRotation: true,
        terrainType: "heavy-woods",
        exclusiveGroup: "woods"
      },
      summerLightWoods: {
        label: "Summer Light Woods",
        category: "Woods",
        description: "+1 MP to enter; intervening woods affect line of sight. Random summer variant.",
        icon: "fas fa-tree",
        src: `systems/${SYSTEM_ID}/assets/terrain/summer-lightwoods-1.webp`,
        sources: [1, 2, 3].map(number =>
          `systems/${SYSTEM_ID}/assets/terrain/summer-lightwoods-${number}.webp`),
        width: 146,
        height: 132,
        sort: 140,
        randomRotation: true,
        terrainType: "light-woods",
        exclusiveGroup: "woods"
      },
      summerHeavyWoods: {
        label: "Summer Heavy Woods",
        category: "Woods",
        description: "+2 MP to enter; dense intervening woods affect line of sight. Random summer variant.",
        icon: "fas fa-tree",
        src: `systems/${SYSTEM_ID}/assets/terrain/summer-heavywoods-1.webp`,
        sources: [1, 2, 3].map(number =>
          `systems/${SYSTEM_ID}/assets/terrain/summer-heavywoods-${number}.webp`),
        width: 146,
        height: 132,
        sort: 140,
        randomRotation: true,
        terrainType: "heavy-woods",
        exclusiveGroup: "woods"
      },
      deciduousLightWoods: {
        label: "Deciduous Light Woods",
        category: "Woods",
        description: "+1 MP to enter; intervening woods affect line of sight. Random deciduous variant and rotation.",
        icon: "fas fa-tree",
        src: `systems/${SYSTEM_ID}/assets/terrain/deciduous.-lightwoods-1.webp`,
        sources: [1, 2, 3, 4].map(number =>
          `systems/${SYSTEM_ID}/assets/terrain/deciduous.-lightwoods-${number}.webp`),
        width: 146,
        height: 132,
        sort: 140,
        randomRotation: true,
        terrainType: "light-woods",
        exclusiveGroup: "woods"
      },
      deciduousHeavyWoods: {
        label: "Deciduous Heavy Woods",
        category: "Woods",
        description: "+2 MP to enter; dense intervening woods affect line of sight. Random deciduous variant and rotation.",
        icon: "fas fa-tree",
        src: `systems/${SYSTEM_ID}/assets/terrain/deciduous.-heavywoods-1.webp`,
        sources: [1, 2, 3].map(number =>
          `systems/${SYSTEM_ID}/assets/terrain/deciduous.-heavywoods-${number}.webp`),
        width: 146,
        height: 132,
        sort: 140,
        randomRotation: true,
        terrainType: "heavy-woods",
        exclusiveGroup: "woods"
      },
      normalLightWoods: {
        label: "Normal Light Woods",
        category: "Woods",
        description: "+1 MP to enter; intervening woods affect line of sight. Random normal variant and rotation.",
        icon: "fas fa-tree",
        src: `systems/${SYSTEM_ID}/assets/terrain/normal-lightwoods-1.webp`,
        sources: [1, 2, 3].map(number =>
          `systems/${SYSTEM_ID}/assets/terrain/normal-lightwoods-${number}.webp`),
        width: 146,
        height: 132,
        sort: 140,
        randomRotation: true,
        terrainType: "light-woods",
        exclusiveGroup: "woods"
      },
      normalHeavyWoods: {
        label: "Normal Heavy Woods",
        category: "Woods",
        description: "+2 MP to enter; dense intervening woods affect line of sight. Random normal variant and rotation.",
        icon: "fas fa-tree",
        src: `systems/${SYSTEM_ID}/assets/terrain/normal-heavywoods-1.webp`,
        sources: [1, 2, 3].map(number =>
          `systems/${SYSTEM_ID}/assets/terrain/normal-heavywoods-${number}.webp`),
        width: 146,
        height: 132,
        sort: 140,
        randomRotation: true,
        terrainType: "heavy-woods",
        exclusiveGroup: "woods"
      },
      rockTriangle: {
        label: "Rock Formation",
        category: "Rocks",
        description: "Three-hex rough terrain. The selected hex is the left point of the formation.",
        icon: "fas fa-mountain",
        src: `systems/${SYSTEM_ID}/assets/terrain/desert-rock-3hex-triagle-1.webp`,
        width: 224,
        height: 231,
        anchorX: 0.25,
        anchorY: 0.5,
        sort: 100,
        footprint: "triangle-right",
        terrainType: "rough",
        exclusiveGroup: "ground"
      },
      rockSingle: {
        label: "Rocks",
        category: "Rocks",
        description: "Single-hex rock formation; treated as rough terrain.",
        icon: "fas fa-mountain",
        src: `systems/${SYSTEM_ID}/assets/terrain/desert-rock-1hex-1.webp`,
        sources: [1, 2, 3].map(number =>
          `systems/${SYSTEM_ID}/assets/terrain/desert-rock-1hex-${number}.webp`),
        width: 122,
        height: 117,
        sort: 100,
        terrainType: "rough",
        exclusiveGroup: "ground"
      },
      roughSingle: {
        label: "Rough Terrain",
        category: "Ground",
        description: "Single-hex rough ground; costs additional MP to enter.",
        icon: "fas fa-hill-rockslide",
        src: `systems/${SYSTEM_ID}/assets/terrain/desert-roughterrain-1.webp`,
        sources: [1, 2, 3].map(number =>
          `systems/${SYSTEM_ID}/assets/terrain/desert-roughterrain-${number}.webp`),
        width: 122,
        height: 117,
        sort: 100,
        terrainType: "rough",
        exclusiveGroup: "ground"
      },
      hill24: {
        label: "Large Hill",
        category: "Elevation",
        description: "A 24-hex level-1 hill. The selected hex anchors the left side of the formation.",
        icon: "fas fa-mountain-sun",
        src: `systems/${SYSTEM_ID}/assets/terrain/general-hill-24hex-1.webp`,
        width: 511,
        height: 710,
        sort: 40,
        centerOnFootprint: true,
        footprint: {
          type: "column-counts",
          counts: [4, 5, 6, 5, 4],
          starts: [0, -1, -1, -1, 0]
        },
        terrainType: "elevation-1",
        exclusiveGroup: "elevation"
      },
      hill12Triangle: {
        label: "Triangular Hill",
        category: "Elevation",
        description: "A 12-hex level-1 hill. The selected hex anchors the broad left side; press R to rotate.",
        icon: "fas fa-mountain-sun",
        src: `systems/${SYSTEM_ID}/assets/terrain/general-hill-12hex-1.webp`,
        width: 371,
        height: 440,
        sort: 40,
        centerOnFootprint: true,
        footprint: {
          type: "column-counts",
          counts: [3, 4, 3, 2],
          starts: [0, -1, 0, 0]
        },
        terrainType: "elevation-1",
        exclusiveGroup: "elevation"
      },
      hill7Small: {
        label: "Small Hill",
        category: "Elevation",
        description: "A seven-hex mound whose selected center hex is level 1; the surrounding six hexes are visual slopes.",
        icon: "fas fa-mountain-sun",
        src: `systems/${SYSTEM_ID}/assets/terrain/general-hill-7hex-1.webp`,
        width: 232,
        height: 233,
        sort: 40,
        centerOnFootprint: true,
        footprint: {
          type: "hex-radius",
          radius: 1
        },
        rulesAnchorOnly: true,
        terrainType: "elevation-1",
        exclusiveGroup: "elevation"
      },
      roadSingleHex: {
        label: "Road",
        category: "Roads",
        description: "A full-hex straight road segment. Press R to rotate it in 60-degree increments.",
        icon: "fas fa-road",
        src: `systems/${SYSTEM_ID}/assets/terrain/general-1hex-road-1.webp`,
        // Match the native flat-top hex with a small bleed so neighboring
        // road segments meet cleanly at the shared boundary.
        width: 146,
        height: 126,
        fit: "fill",
        sort: 120,
        terrainType: "road",
        exclusiveGroup: "road"
      },
      roadTurnSingleHex: {
        label: "Road Turn",
        category: "Roads",
        description: "A full-hex road bend. Press R to rotate it in 60-degree increments.",
        icon: "fas fa-road",
        src: `systems/${SYSTEM_ID}/assets/terrain/general-1hex-road-turn-1.webp`,
        width: 146,
        height: 126,
        fit: "fill",
        sort: 120,
        terrainType: "road",
        exclusiveGroup: "road"
      },
      concreteGround: {
        label: "Concrete",
        category: "Ground Cover",
        description: "Full-hex concrete ground cover. Adjacent placements connect without gaps.",
        icon: "fas fa-border-all",
        src: `systems/${SYSTEM_ID}/assets/terrain/general-ground-1hex-concrete-1.webp`,
        sources: [1, 2, 3].map(number =>
          `systems/${SYSTEM_ID}/assets/terrain/general-ground-1hex-concrete-${number}.webp`),
        // A 125 px Foundry flat-top hex is 144.34 x 125 px. The extra pixel
        // of bleed prevents transparent anti-aliased seams between neighbors.
        width: 146,
        height: 126,
        fit: "fill",
        sort: 20,
        terrainType: "concrete",
        exclusiveGroup: "ground-cover"
      },
      concreteGroundEdge: {
        label: "Concrete Edge",
        category: "Ground Cover",
        description: "A partial concrete boundary hex. Press R to rotate the exposed edge.",
        icon: "fas fa-border-style",
        src: `systems/${SYSTEM_ID}/assets/terrain/general-ground-1hex-concrete-edge-1.webp`,
        width: 146,
        height: 126,
        fit: "fill",
        sort: 20,
        terrainType: "concrete",
        exclusiveGroup: "ground-cover"
      },
      wallSingleHex: {
        label: "Wall",
        category: "Structures",
        description: "A one-hex wall segment. Press R to rotate it in 60-degree increments.",
        icon: "fas fa-grip-lines-vertical",
        src: `systems/${SYSTEM_ID}/assets/terrain/general-1hex-wall-1.webp`,
        width: 146,
        height: 126,
        fit: "fill",
        sort: 180,
        terrainType: "wall",
        exclusiveGroup: "wall"
      },
      wallCornerSingleHex: {
        label: "Wall Corner",
        category: "Structures",
        description: "A one-hex wall corner. Press R to rotate it in 60-degree increments.",
        icon: "fas fa-vector-square",
        src: `systems/${SYSTEM_ID}/assets/terrain/general-1hex-wall-corner-1.webp`,
        width: 146,
        height: 126,
        fit: "fill",
        sort: 180,
        terrainType: "wall",
        exclusiveGroup: "wall"
      },
      wallGateSingleHex: {
        label: "Wall Gate",
        category: "Structures",
        description: "A one-hex wall section with a gate. Press R to rotate it in 60-degree increments.",
        icon: "fas fa-dungeon",
        src: `systems/${SYSTEM_ID}/assets/terrain/general-1hex-wall-gate-1.webp`,
        width: 146,
        height: 126,
        fit: "fill",
        sort: 180,
        terrainType: "wall-gate",
        exclusiveGroup: "wall"
      },
      wallGateCornerSingleHex: {
        label: "Corner Wall Gate",
        category: "Structures",
        description: "A one-hex corner wall section with a gate. Press R to rotate it in 60-degree increments.",
        icon: "fas fa-dungeon",
        src: `systems/${SYSTEM_ID}/assets/terrain/general-1hex-wall-gate-corner-1.webp`,
        width: 146,
        height: 126,
        fit: "fill",
        sort: 180,
        terrainType: "wall-gate",
        exclusiveGroup: "wall"
      },
      buildingTriangle: {
        label: "Three-Hex Building",
        category: "Structures",
        description: "A triangular three-hex building. The selected hex is its right point; press R to rotate.",
        icon: "fas fa-building",
        src: `systems/${SYSTEM_ID}/assets/terrain/general-3hex-building-1.webp`,
        width: 212,
        height: 232,
        anchorX: 0.75,
        anchorY: 0.5,
        sort: 200,
        footprint: "triangle-left",
        terrainType: "building",
        exclusiveGroup: "building"
      },
      buildingSingleHex: {
        label: "One-Hex Building",
        category: "Structures",
        description: "A one-hex building. Press R to rotate it in 60-degree increments.",
        icon: "fas fa-building",
        src: `systems/${SYSTEM_ID}/assets/terrain/general-1hex-building-1.webp`,
        width: 146,
        height: 126,
        sort: 200,
        terrainType: "building",
        exclusiveGroup: "building"
      },
      buildingTwoHex: {
        label: "Two-Hex Building",
        category: "Structures",
        description: "A two-hex building. The selected hex anchors one end; press R to rotate.",
        icon: "fas fa-building",
        src: `systems/${SYSTEM_ID}/assets/terrain/general-2hex-building-1.webp`,
        width: 228,
        height: 178,
        sort: 200,
        centerOnFootprint: true,
        alignToFootprint: true,
        // The building's long axis is drawn at +30 degrees in its source image.
        // Rotate that axis onto the line joining its two occupied hex centers.
        sourceAxisDegrees: 30,
        footprint: "adjacent-upper-right",
        terrainType: "building",
        exclusiveGroup: "building"
      },
      assetContainers: {
        label: "Containers",
        category: "Assets / Props",
        description: "Freely placed decorative containers. These have no terrain rules.",
        icon: "fas fa-box",
        src: `systems/${SYSTEM_ID}/assets/terrain/general-asset-container-1.webp`,
        sources: [1, 2, 3].map(number =>
          `systems/${SYSTEM_ID}/assets/terrain/general-asset-container-${number}.webp`),
        width: 131,
        height: 114,
        sort: 220,
        terrainType: "asset",
        freePlacement: true,
        noRules: true
      },
      assetEquipment: {
        label: "Equipment",
        category: "Assets / Props",
        description: "Freely placed decorative equipment. These have no terrain rules.",
        icon: "fas fa-screwdriver-wrench",
        src: `systems/${SYSTEM_ID}/assets/terrain/general-asset-equipment-1.webp`,
        sources: [1, 2, 3, 4, 5].map(number =>
          `systems/${SYSTEM_ID}/assets/terrain/general-asset-equipment-${number}.webp`),
        width: 131,
        height: 114,
        sort: 220,
        terrainType: "asset",
        freePlacement: true,
        noRules: true
      },
      assetLift: {
        label: "Lift",
        category: "Assets / Props",
        description: "A freely placed decorative lift. This has no terrain rules.",
        icon: "fas fa-elevator",
        src: `systems/${SYSTEM_ID}/assets/terrain/general-asset-lift-1.webp`,
        width: 131,
        height: 114,
        sort: 220,
        terrainType: "asset",
        freePlacement: true,
        noRules: true
      },
      assetPillars: {
        label: "Pillars",
        category: "Assets / Props",
        description: "Freely placed decorative pillars. These have no terrain rules.",
        icon: "fas fa-monument",
        src: `systems/${SYSTEM_ID}/assets/terrain/general-asset-pillar-1.webp`,
        sources: [1, 2, 3].map(number =>
          `systems/${SYSTEM_ID}/assets/terrain/general-asset-pillar-${number}.webp`),
        width: 131,
        height: 114,
        sort: 220,
        terrainType: "asset",
        freePlacement: true,
        noRules: true
      },
      assetPlatforms: {
        label: "Platforms",
        category: "Assets / Props",
        description: "Freely placed decorative platforms. These have no terrain rules.",
        icon: "fas fa-layer-group",
        src: `systems/${SYSTEM_ID}/assets/terrain/general-asset-platform-1.webp`,
        sources: [1, 2, 3].map(number =>
          `systems/${SYSTEM_ID}/assets/terrain/general-asset-platform-${number}.webp`),
        width: 131,
        height: 114,
        sort: 220,
        terrainType: "asset",
        freePlacement: true,
        noRules: true
      },
      assetTanks: {
        label: "Storage Tanks",
        category: "Assets / Props",
        description: "Freely placed decorative tanks. These have no terrain rules.",
        icon: "fas fa-database",
        src: `systems/${SYSTEM_ID}/assets/terrain/general-asset-tank-1.webp`,
        sources: [1, 2, 3].map(number =>
          `systems/${SYSTEM_ID}/assets/terrain/general-asset-tank-${number}.webp`),
        width: 131,
        height: 114,
        sort: 220,
        terrainType: "asset",
        freePlacement: true,
        noRules: true
      },
      assetVehicles: {
        label: "Small Vehicles",
        category: "Assets / Props",
        description: "Freely placed decorative vehicles. These have no terrain rules.",
        icon: "fas fa-truck",
        src: `systems/${SYSTEM_ID}/assets/terrain/general-asset-vehicle-1.webp`,
        sources: [1, 2, 3].map(number =>
          `systems/${SYSTEM_ID}/assets/terrain/general-asset-vehicle-${number}.webp`),
        width: 131,
        height: 114,
        sort: 220,
        terrainType: "asset",
        freePlacement: true,
        noRules: true
      }
    }
  };
  return Object.freeze({
    desert,
    desert2: {
      label: "Desert 2",
      background: `systems/${SYSTEM_ID}/assets/terrain/desert-2.webp`,
      pieces: desert.pieces
    },
    grasslands: {
      label: "Grasslands",
      background: `systems/${SYSTEM_ID}/assets/terrain/grasslands-1.webp`,
      pieces: desert.pieces
    }
  });
})();

const state = {
  enabled: false,
  tool: "lightWoods",
  category: "All",
  placing: false,
  controlsQueued: false,
  preview: null,
  previewRequest: 0,
  rotationSteps: 0,
  lastPointerPoint: null,
  freePlacementSource: null
};

function battleMapData(scene = canvas?.scene ?? null) {
  return scene?.getFlag?.(SYSTEM_ID, BATTLE_MAP_FLAG)
    ?? scene?.flags?.[SYSTEM_ID]?.[BATTLE_MAP_FLAG]
    ?? null;
}

export function isBattleMapScene(scene = canvas?.scene ?? null) {
  return Boolean(battleMapData(scene)?.enabled);
}

function escapeHTML(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function queueControlsRender() {
  if (state.controlsQueued) return;
  state.controlsQueued = true;
  window.setTimeout(() => {
    state.controlsQueued = false;
    ui?.controls?.render?.({ reset: true });
  }, 0);
}

function hexGridType() {
  return CONST?.GRID_TYPES?.HEXODDQ ?? 4;
}

function backgroundTiles(terrainSet, sheetsX, sheetsY) {
  const tiles = [];
  for (let row = 0; row < sheetsY; row += 1) {
    for (let column = 0; column < sheetsX; column += 1) {
      tiles.push({
        x: column * MAP_SHEET_WIDTH,
        y: row * MAP_SHEET_HEIGHT,
        width: MAP_SHEET_WIDTH,
        height: MAP_SHEET_HEIGHT,
        rotation: 0,
        alpha: 1,
        hidden: false,
        locked: true,
        overhead: false,
        sort: -1000,
        // Tile x/y are top-left document coordinates. Foundry's Tile mesh is
        // positioned from its center, so the normal 0.5 texture anchor keeps
        // the image aligned with those bounds. An anchor of 0 shifts the
        // rendered image down/right by half its size.
        texture: { src: terrainSet.background, fit: "fill", anchorX: 0.5, anchorY: 0.5 },
        flags: {
          [SYSTEM_ID]: {
            battleMapBackground: true
          }
        }
      });
    }
  }
  return tiles;
}

export async function createBattleMap({ name, terrain = "desert", sheetsX = 1, sheetsY = 1 } = {}) {
  if (!game.user?.isGM) {
    ui.notifications?.warn?.("Only a GM can create BattleTech battle maps.");
    return null;
  }
  const terrainSet = TERRAIN_SETS[terrain] ?? TERRAIN_SETS.desert;
  const columns = Math.max(1, Math.min(3, Math.floor(Number(sheetsX) || 1)));
  const rows = Math.max(1, Math.min(3, Math.floor(Number(sheetsY) || 1)));
  const sceneName = String(name ?? "").trim() || `${terrainSet.label} Battle Map ${columns}x${rows}`;
  const width = MAP_SHEET_WIDTH * columns;
  const height = MAP_SHEET_HEIGHT * rows;

  const scene = await Scene.create({
    name: sceneName,
    navigation: true,
    width,
    height,
    padding: 0,
    backgroundColor: "#1d120d",
    grid: {
      type: hexGridType(),
      size: MAP_GRID_SIZE,
      distance: 1,
      units: "hexes",
      color: "#000000",
      alpha: 1
    },
    flags: {
      [SYSTEM_ID]: {
        [BATTLE_MAP_FLAG]: {
          enabled: true,
          terrain,
          sheetsX: columns,
          sheetsY: rows,
          sheetWidth: MAP_SHEET_WIDTH,
          sheetHeight: MAP_SHEET_HEIGHT,
          gridSize: MAP_GRID_SIZE,
          hexesTallPerSheet: 17,
          version: BATTLE_MAP_VERSION
        }
      }
    }
  });
  if (!scene) return null;

  await scene.createEmbeddedDocuments("Tile", backgroundTiles(terrainSet, columns, rows), {
    atowBattleMapBuilder: true
  });
  await scene.view?.();
  ui.notifications?.info?.(`${sceneName} created: ${columns}x${rows} ${terrainSet.label} map sheets.`);
  return scene;
}

export async function promptCreateBattleMap() {
  if (!game.user?.isGM) return null;
  const terrainOptions = Object.entries(TERRAIN_SETS)
    .map(([key, value]) => `<option value="${escapeHTML(key)}">${escapeHTML(value.label)}</option>`)
    .join("");
  const sizeOptions = [1, 2, 3].map(value => `<option value="${value}">${value}</option>`).join("");
  const content = `
    <form class="atow-battle-map-create">
      <p>Create a tiled BattleTech map using 17-hex-tall map sheets.</p>
      <div class="form-group">
        <label>Scene Name</label>
        <div class="form-fields"><input type="text" name="name" placeholder="Desert Battlefield"></div>
      </div>
      <div class="form-group">
        <label>Terrain Set</label>
        <div class="form-fields"><select name="terrain">${terrainOptions}</select></div>
      </div>
      <div class="form-group">
        <label>Sheets Wide</label>
        <div class="form-fields"><select name="sheetsX">${sizeOptions}</select></div>
      </div>
      <div class="form-group">
        <label>Sheets Tall</label>
        <div class="form-fields"><select name="sheetsY">${sizeOptions}</select></div>
      </div>
      <p class="hint">Examples: 1x3, 2x2, 3x1, or up to 3x3.</p>
    </form>`;

  return new Promise(resolve => {
    new Dialog({
      title: "Create BattleTech Battle Map",
      content,
      buttons: {
        create: {
          icon: '<i class="fas fa-map"></i>',
          label: "Create Map",
          callback: async html => {
            const form = html[0]?.querySelector?.("form.atow-battle-map-create");
            const data = new FormData(form);
            resolve(await createBattleMap({
              name: data.get("name"),
              terrain: data.get("terrain"),
              sheetsX: data.get("sheetsX"),
              sheetsY: data.get("sheetsY")
            }));
          }
        },
        cancel: { label: "Cancel", callback: () => resolve(null) }
      },
      default: "create",
      close: () => resolve(null)
    }).render(true);
  });
}

function canvasPoint(event) {
  const global = event?.global ?? event?.data?.global;
  if (!global) return null;
  try {
    return canvas.stage.toLocal(global);
  } catch (_) {
    return { x: Number(global.x) || 0, y: Number(global.y) || 0 };
  }
}

function gridCenter(point) {
  if (!point || !canvas?.grid) return point;
  try {
    const offset = canvas.grid.getOffset(point);
    const center = canvas.grid.getCenterPoint(offset);
    if (center && Number.isFinite(center.x) && Number.isFinite(center.y)) {
      return { point: center, key: `${offset.i},${offset.j}`, offset };
    }
  } catch (_) {}
  return { point, key: `${Math.round(point.x)},${Math.round(point.y)}` };
}

function offsetKey(offset) {
  if (!offset || !Number.isFinite(Number(offset.i)) || !Number.isFinite(Number(offset.j))) return null;
  return `${Math.trunc(Number(offset.i))},${Math.trunc(Number(offset.j))}`;
}

function rotatedFootprint(cells, snapped) {
  const steps = ((Math.trunc(Number(state.rotationSteps) || 0) % 6) + 6) % 6;
  if (!steps || !snapped?.offset || !canvas?.grid?.getCube || !canvas.grid.cubeToOffset) return cells;
  try {
    const anchor = canvas.grid.getCube(snapped.offset);
    return cells.map(cell => {
      const cube = canvas.grid.getCube(cell.offset);
      let q = Number(cube.q) - Number(anchor.q);
      let r = Number(cube.r) - Number(anchor.r);
      let s = Number(cube.s) - Number(anchor.s);
      for (let step = 0; step < steps; step += 1) [q, r, s] = [-s, -q, -r];
      const offset = canvas.grid.cubeToOffset({
        q: Number(anchor.q) + q,
        r: Number(anchor.r) + r,
        s: Number(anchor.s) + s
      });
      return { offset, key: offsetKey(offset), point: canvas.grid.getCenterPoint(offset) };
    });
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Could not rotate terrain footprint`, error);
    return cells;
  }
}

function finalizeFootprint(cells, snapped) {
  return rotatedFootprint(cells, snapped).filter(cell => cell.key
    && Number.isFinite(cell.point?.x) && Number.isFinite(cell.point?.y)
    && cell.point.x >= 0 && cell.point.x <= Number(canvas.scene?.width ?? Infinity)
    && cell.point.y >= 0 && cell.point.y <= Number(canvas.scene?.height ?? Infinity));
}

function footprintForPiece(piece, snapped) {
  const cells = [{ key: snapped.key, point: snapped.point, offset: snapped.offset }];
  if (!piece?.footprint || !snapped?.offset || !canvas?.grid) return finalizeFootprint(cells, snapped);

  try {
    if (piece.footprint?.type === "column-counts") {
      const counts = Array.isArray(piece.footprint.counts) ? piece.footprint.counts : [];
      const starts = Array.isArray(piece.footprint.starts) ? piece.footprint.starts : [];
      const shaped = [];
      for (let column = 0; column < counts.length; column += 1) {
        const count = Math.max(0, Math.floor(Number(counts[column]) || 0));
        const start = Math.trunc(Number(starts[column]) || 0);
        for (let row = 0; row < count; row += 1) {
          const offset = { i: Number(snapped.offset.i) + start + row, j: Number(snapped.offset.j) + column };
          const point = canvas.grid.getCenterPoint(offset);
          const key = offsetKey(offset);
          if (!key || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) continue;
          shaped.push({ key, point, offset });
        }
      }
      return finalizeFootprint(shaped, snapped);
    }

    if (piece.footprint?.type === "offset-rectangle") {
      const columns = Math.max(1, Math.floor(Number(piece.footprint.columns) || 1));
      const rows = Math.max(1, Math.floor(Number(piece.footprint.rows) || 1));
      const rectangle = [];
      for (let column = 0; column < columns; column += 1) {
        for (let row = 0; row < rows; row += 1) {
          const offset = { i: Number(snapped.offset.i) + row, j: Number(snapped.offset.j) + column };
          const point = canvas.grid.getCenterPoint(offset);
          const key = offsetKey(offset);
          if (!key || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) continue;
          rectangle.push({ key, point, offset });
        }
      }
      return finalizeFootprint(rectangle, snapped);
    }

    if (piece.footprint?.type === "hex-radius") {
      const radius = Math.max(0, Math.floor(Number(piece.footprint.radius) || 0));
      if (radius === 1) {
        const flower = [
          ...cells,
          ...(canvas.grid.getAdjacentOffsets?.(snapped.offset) ?? []).map(offset => ({
            offset,
            key: offsetKey(offset),
            point: canvas.grid.getCenterPoint(offset)
          }))
        ];
        return finalizeFootprint(flower, snapped);
      }
      return finalizeFootprint(cells, snapped);
    }

    if (!["triangle-right", "triangle-left", "adjacent-upper-right"].includes(piece.footprint)) {
      return finalizeFootprint(cells, snapped);
    }
    const neighbors = (canvas.grid.getAdjacentOffsets?.(snapped.offset) ?? [])
      .map(offset => ({ offset, point: canvas.grid.getCenterPoint(offset), key: offsetKey(offset) }))
      .filter(cell => cell.key && Number.isFinite(cell.point?.x) && Number.isFinite(cell.point?.y))
      .filter(cell => piece.footprint === "triangle-left"
        ? cell.point.x < snapped.point.x - 1
        : cell.point.x > snapped.point.x + 1)
      .sort((a, b) => a.point.y - b.point.y);
    if (piece.footprint === "adjacent-upper-right" && neighbors.length) cells.push(neighbors[0]);
    else if (neighbors.length >= 2) cells.push(neighbors[0], neighbors[neighbors.length - 1]);
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Could not calculate multi-hex terrain footprint`, error);
  }
  return finalizeFootprint(cells, snapped);
}

function terrainTileFlag(tile) {
  return tile?.getFlag?.(SYSTEM_ID, TERRAIN_TILE_FLAG)
    ?? tile?.flags?.[SYSTEM_ID]?.[TERRAIN_TILE_FLAG]
    ?? null;
}

function terrainTileHexKeys(tile) {
  const flag = terrainTileFlag(tile);
  const keys = Array.isArray(flag?.hexKeys) ? flag.hexKeys : [flag?.hexKey];
  return keys.map(key => String(key ?? "")).filter(Boolean);
}

function terrainTileRuleHexKeys(tile) {
  const flag = terrainTileFlag(tile);
  const keys = Array.isArray(flag?.ruleHexKeys) ? flag.ruleHexKeys : terrainTileHexKeys(tile);
  return keys.map(key => String(key ?? "")).filter(Boolean);
}

function tileContainsPoint(tile, point) {
  const width = Number(tile?.width ?? 0) || 0;
  const height = Number(tile?.height ?? 0) || 0;
  if (!width || !height || !point) return false;
  const centerX = Number(tile.x ?? 0) + (width / 2);
  const centerY = Number(tile.y ?? 0) + (height / 2);
  const angle = -(Number(tile.rotation ?? 0) || 0) * (Math.PI / 180);
  const dx = Number(point.x) - centerX;
  const dy = Number(point.y) - centerY;
  const localX = (dx * Math.cos(angle)) - (dy * Math.sin(angle));
  const localY = (dx * Math.sin(angle)) + (dy * Math.cos(angle));
  return Math.abs(localX) <= width / 2 && Math.abs(localY) <= height / 2;
}

function topAssetAtPoint(scene, point) {
  return (scene?.tiles?.contents ?? [])
    .filter(tile => terrainTileFlag(tile)?.terrainType === "asset" && tileContainsPoint(tile, point))
    .sort((a, b) => Number(b.sort ?? 0) - Number(a.sort ?? 0))[0] ?? null;
}

function terrainPieceGroup(terrainSet, flag) {
  return String(flag?.exclusiveGroup ?? terrainSet?.pieces?.[flag?.piece]?.exclusiveGroup ?? "");
}

function clearVisualRuleForType(entry, terrainType) {
  const next = { ...(entry ?? {}) };
  if (terrainType === "light-woods" || terrainType === "heavy-woods") {
    delete next.woods;
    delete next.visualTileWoods;
  } else if (terrainType === "rough") {
    delete next.rough;
    delete next.visualTileRough;
  } else if (terrainType === "elevation-1") {
    delete next.elevation;
    delete next.visualTileElevation;
  } else if (terrainType === "road") {
    delete next.road;
    delete next.visualTileRoad;
  } else if (terrainType === "concrete") {
    delete next.groundCover;
    delete next.visualTileGroundCover;
  } else if (terrainType === "wall" || terrainType === "wall-gate") {
    delete next.wall;
    delete next.wallGate;
    delete next.visualTileWall;
  } else if (terrainType === "building") {
    delete next.building;
    delete next.visualTileBuilding;
  }
  return next;
}

function isRulesTerrainEmpty(entry) {
  return !entry?.woods && !entry?.waterDepth && !entry?.elevation && !entry?.rough
    && !entry?.road && !entry?.groundCover && !entry?.wall && !entry?.building;
}

async function removeTerrainTiles(scene, tiles) {
  const unique = [...new Map(tiles.filter(Boolean).map(tile => [tile.id, tile])).values()];
  if (!unique.length) return false;
  const removedIds = new Set(unique.map(tile => tile.id));
  const survivors = (scene.tiles?.contents ?? []).filter(tile => !removedIds.has(tile.id));
  const rulesTerrain = foundry.utils.deepClone(scene.getFlag?.(SYSTEM_ID, RULES_TERRAIN_FLAG) ?? {});
  for (const tile of unique) {
    const flag = terrainTileFlag(tile);
    for (const key of terrainTileRuleHexKeys(tile)) {
      const stillRepresented = survivors.some(other => {
        const otherFlag = terrainTileFlag(other);
        return otherFlag?.terrainType === flag?.terrainType && terrainTileRuleHexKeys(other).includes(key);
      });
      if (stillRepresented) continue;
      const next = clearVisualRuleForType(rulesTerrain[key], flag?.terrainType);
      if (isRulesTerrainEmpty(next)) delete rulesTerrain[key];
      else rulesTerrain[key] = next;
    }
  }
  await scene.deleteEmbeddedDocuments("Tile", unique.map(tile => tile.id), { atowBattleMapBuilder: true });
  await scene.setFlag(SYSTEM_ID, RULES_TERRAIN_FLAG, rulesTerrain);
  return true;
}

function terrainSetForScene(scene) {
  const key = String(battleMapData(scene)?.terrain ?? "desert");
  return TERRAIN_SETS[key] ?? TERRAIN_SETS.desert;
}

function terrainPiecesForScene(scene = canvas?.scene ?? null) {
  return Object.entries(terrainSetForScene(scene)?.pieces ?? {}).map(([key, piece]) => ({ key, ...piece }));
}

function randomPieceSource(piece, previousSources = []) {
  const sources = Array.isArray(piece?.sources) && piece.sources.length ? piece.sources : [piece?.src].filter(Boolean);
  if (!sources.length) return null;
  const previous = new Set(previousSources.map(source => String(source ?? "")));
  const choices = sources.length > 1 ? sources.filter(source => !previous.has(source)) : sources;
  const pool = choices.length ? choices : sources;
  return pool[Math.floor(Math.random() * pool.length)];
}

function requiredFootprintCells(piece) {
  if (piece?.footprint?.type === "column-counts") {
    return piece.footprint.counts.reduce((sum, count) => sum + Math.max(0, Math.floor(Number(count) || 0)), 0);
  }
  if (piece?.footprint?.type === "offset-rectangle") {
    return Math.max(1, Number(piece.footprint.columns) || 1) * Math.max(1, Number(piece.footprint.rows) || 1);
  }
  if (piece?.footprint?.type === "hex-radius") {
    const radius = Math.max(0, Math.floor(Number(piece.footprint.radius) || 0));
    return 1 + (3 * radius * (radius + 1));
  }
  if (piece?.footprint === "adjacent-upper-right") return 2;
  return piece?.footprint ? 3 : 1;
}

function pieceVisualCenter(piece, snapped, footprint) {
  const anchor = piece?.centerOnFootprint
    ? {
        x: (Math.min(...footprint.map(cell => cell.point.x)) + Math.max(...footprint.map(cell => cell.point.x))) / 2,
        y: (Math.min(...footprint.map(cell => cell.point.y)) + Math.max(...footprint.map(cell => cell.point.y))) / 2
      }
    : snapped.point;
  const anchorX = Number.isFinite(Number(piece?.anchorX)) ? Number(piece.anchorX) : 0.5;
  const anchorY = Number.isFinite(Number(piece?.anchorY)) ? Number(piece.anchorY) : 0.5;
  const center = {
    x: anchor.x + (piece.width * (0.5 - anchorX)),
    y: anchor.y + (piece.height * (0.5 - anchorY))
  };
  if (piece?.centerOnFootprint || !state.rotationSteps) return center;
  const angle = (state.rotationSteps * 60 * Math.PI) / 180;
  const dx = center.x - snapped.point.x;
  const dy = center.y - snapped.point.y;
  return {
    x: snapped.point.x + (dx * Math.cos(angle)) - (dy * Math.sin(angle)),
    y: snapped.point.y + (dx * Math.sin(angle)) + (dy * Math.cos(angle))
  };
}

function pieceRotationDegrees(piece, footprint, rotationSteps = state.rotationSteps) {
  if (piece?.alignToFootprint && footprint?.length === 2) {
    const [first, second] = footprint;
    const dx = Number(second?.point?.x) - Number(first?.point?.x);
    const dy = Number(second?.point?.y) - Number(first?.point?.y);
    if (Number.isFinite(dx) && Number.isFinite(dy) && (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01)) {
      const footprintAngle = Math.atan2(dy, dx) * (180 / Math.PI);
      return footprintAngle - (Number(piece.sourceAxisDegrees) || 0);
    }
  }
  return rotationSteps * 60;
}

function destroyPlacementPreview() {
  state.previewRequest += 1;
  const container = state.preview?.container;
  if (container && !container.destroyed) container.destroy({ children: true });
  state.preview = null;
}

function drawFootprintPreview(container, footprint, valid, erase = false) {
  const graphics = new PIXI.Graphics();
  const color = erase ? 0xe15b4f : (valid ? 0x8de26b : 0xe15b4f);
  graphics.lineStyle(4, color, 0.95);
  graphics.beginFill(color, erase ? 0.2 : 0.13);
  for (const cell of footprint) {
    try {
      const vertices = canvas.grid.getVertices?.(cell.offset);
      if (Array.isArray(vertices) && vertices.length) {
        graphics.drawPolygon(vertices.flatMap(vertex => [vertex.x, vertex.y]));
      }
    } catch (_) {}
  }
  graphics.endFill();
  container.addChild(graphics);
}

async function updatePlacementPreview(point) {
  if (!state.enabled || !isBattleMapScene() || !point || !canvas?.interface) {
    destroyPlacementPreview();
    return;
  }
  const scene = canvas.scene;

  if (state.tool === "erase") {
    const asset = topAssetAtPoint(scene, point);
    const snapped = gridCenter(point);
    if (!snapped?.point || !snapped?.key) return;
    const previewKey = asset ? `asset:${asset.id}` : `hex:${snapped.key}`;
    if (state.preview?.tool === "erase" && state.preview?.hexKey === previewKey) return;
    destroyPlacementPreview();
    if (asset) {
      const container = new PIXI.Container();
      container.eventMode = "none";
      container.zIndex = 95;
      canvas.interface.sortableChildren = true;
      canvas.interface.addChild(container);
      const graphics = new PIXI.Graphics();
      graphics.lineStyle(4, 0xe15b4f, 0.95);
      graphics.beginFill(0xe15b4f, 0.15);
      graphics.drawRect(Number(asset.x), Number(asset.y), Number(asset.width), Number(asset.height));
      graphics.endFill();
      graphics.pivot.set(Number(asset.x) + (Number(asset.width) / 2), Number(asset.y) + (Number(asset.height) / 2));
      graphics.position.set(Number(asset.x) + (Number(asset.width) / 2), Number(asset.y) + (Number(asset.height) / 2));
      graphics.rotation = (Number(asset.rotation ?? 0) || 0) * (Math.PI / 180);
      container.addChild(graphics);
      state.preview = { container, tool: "erase", hexKey: previewKey, source: null };
      return;
    }
    const tile = (scene.tiles?.contents ?? [])
      .filter(candidate => terrainTileHexKeys(candidate).includes(snapped.key))
      .sort((a, b) => Number(b.sort ?? 0) - Number(a.sort ?? 0))[0];
    const footprint = tile
      ? terrainTileHexKeys(tile).map(key => {
          const [i, j] = key.split(",").map(Number);
          const offset = { i, j };
          return { key, offset, point: canvas.grid.getCenterPoint(offset) };
        })
      : [snapped];
    const container = new PIXI.Container();
    container.eventMode = "none";
    container.zIndex = 95;
    canvas.interface.sortableChildren = true;
    canvas.interface.addChild(container);
    drawFootprintPreview(container, footprint, Boolean(tile), true);
    state.preview = { container, tool: "erase", hexKey: previewKey, source: null };
    return;
  }

  const piece = terrainSetForScene(scene).pieces?.[state.tool];
  if (!piece) {
    destroyPlacementPreview();
    return;
  }
  if (piece.freePlacement) {
    const previewKey = `${Math.round(point.x)},${Math.round(point.y)}`;
    if (state.preview?.tool === state.tool && state.preview?.sprite && state.preview?.container?.destroyed === false) {
      state.preview.hexKey = previewKey;
      state.preview.sprite.position.set(point.x, point.y);
      return;
    }
    destroyPlacementPreview();
    const request = ++state.previewRequest;
    const source = state.freePlacementSource ?? randomPieceSource(piece);
    state.freePlacementSource = source;
    const container = new PIXI.Container();
    container.eventMode = "none";
    container.zIndex = 95;
    canvas.interface.sortableChildren = true;
    canvas.interface.addChild(container);
    state.preview = { container, tool: state.tool, hexKey: previewKey, source, valid: true };
    if (!source) return;
    try {
      const texture = await foundry.canvas.loadTexture(source);
      if (request !== state.previewRequest || state.preview?.container !== container || container.destroyed) return;
      const sprite = new PIXI.Sprite(texture);
      sprite.anchor.set(0.5, 0.5);
      sprite.position.set(point.x, point.y);
      sprite.width = piece.width;
      sprite.height = piece.height;
      sprite.rotation = (state.rotationSteps * 60 * Math.PI) / 180;
      sprite.alpha = 0.65;
      container.addChild(sprite);
      state.preview.sprite = sprite;
    } catch (error) {
      console.warn(`${SYSTEM_ID} | Could not load prop placement preview ${source}`, error);
    }
    return;
  }
  const snapped = gridCenter(point);
  if (!snapped?.point || !snapped?.key) return;
  if (state.preview?.tool === state.tool && state.preview?.hexKey === snapped.key) return;

  destroyPlacementPreview();
  const request = ++state.previewRequest;
  const footprint = footprintForPiece(piece, snapped);
  const valid = footprint.length === requiredFootprintCells(piece);
  const footprintKeys = footprint.map(cell => cell.key);
  const terrainSet = terrainSetForScene(scene);
  const pieceGroup = String(piece.exclusiveGroup ?? "");
  const priorSources = (scene.tiles?.contents ?? []).filter(tile => {
    const flag = terrainTileFlag(tile);
    if (!terrainTileHexKeys(tile).some(key => footprintKeys.includes(key))) return false;
    return flag?.piece === state.tool
      || (pieceGroup && terrainPieceGroup(terrainSet, flag) === pieceGroup);
  }).map(tile => tile.texture?.src);
  const source = randomPieceSource(piece, priorSources);
  const previewRotationSteps = piece.randomRotation ? Math.floor(Math.random() * 6) : state.rotationSteps;
  const container = new PIXI.Container();
  container.eventMode = "none";
  container.zIndex = 95;
  canvas.interface.sortableChildren = true;
  canvas.interface.addChild(container);
  drawFootprintPreview(container, footprint, valid);
  state.preview = { container, tool: state.tool, hexKey: snapped.key, source, valid, rotationSteps: previewRotationSteps };

  if (!source) return;
  try {
    const texture = await foundry.canvas.loadTexture(source);
    if (request !== state.previewRequest || state.preview?.container !== container || container.destroyed) return;
    const sprite = new PIXI.Sprite(texture);
    sprite.anchor.set(0.5, 0.5);
    const center = pieceVisualCenter(piece, snapped, footprint);
    sprite.position.set(center.x, center.y);
    sprite.width = piece.width;
    sprite.height = piece.height;
    sprite.rotation = (pieceRotationDegrees(piece, footprint, previewRotationSteps) * Math.PI) / 180;
    sprite.alpha = valid ? 0.58 : 0.28;
    sprite.tint = valid ? 0xffffff : 0xff7777;
    container.addChildAt(sprite, 0);
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Could not load terrain placement preview ${source}`, error);
  }
}

export class AToWBattleMapTerrainPalette extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(
    super.DEFAULT_OPTIONS,
    {
      id: "atow-battle-map-terrain-palette",
      classes: ["atow-battle-map-terrain-palette"],
      position: { width: 540, height: 480 },
      window: {
        title: "Battle Map Terrain",
        icon: "fa-solid fa-mountain-sun",
        resizable: true
      }
    },
    { inplace: false }
  );

  static PARTS = {
    main: { template: TERRAIN_PALETTE_TEMPLATE, root: true }
  };

  static #instance = null;

  static get instance() {
    AToWBattleMapTerrainPalette.#instance ??= new AToWBattleMapTerrainPalette();
    return AToWBattleMapTerrainPalette.#instance;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const scene = canvas?.scene ?? null;
    const terrainSet = terrainSetForScene(scene);
    context.isBattleMap = isBattleMapScene(scene);
    context.enabled = state.enabled;
    context.selectedTool = state.tool;
    context.terrainLabel = terrainSet?.label ?? "Terrain";
    const allPieces = terrainPiecesForScene(scene);
    const categoryNames = [...new Set(allPieces.map(piece => piece.category).filter(Boolean))];
    if (state.category !== "All" && !categoryNames.includes(state.category)) state.category = "All";
    context.categories = ["All", ...categoryNames].map(category => ({
      label: category,
      value: category,
      count: category === "All" ? allPieces.length : allPieces.filter(piece => piece.category === category).length,
      selected: state.category === category
    }));
    context.pieces = allPieces
      .filter(piece => state.category === "All" || piece.category === state.category)
      .map(piece => ({
      ...piece,
      selected: state.tool === piece.key
      }));
    context.activeCategory = state.category;
    context.eraseSelected = state.tool === "erase";
    return context;
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const root = this.element;
    if (!root) return;

    root.querySelectorAll("[data-terrain-category]").forEach(button => {
      button.addEventListener("click", () => {
        state.category = String(button.dataset.terrainCategory ?? "All");
        this.render({ force: true });
      });
    });
    root.querySelectorAll("[data-terrain-piece]").forEach(button => {
      button.addEventListener("click", () => {
        selectTool(String(button.dataset.terrainPiece ?? ""));
        this.render({ force: true });
      });
    });
    root.querySelector("[data-terrain-erase]")?.addEventListener("click", () => {
      selectTool("erase");
      this.render({ force: true });
    });
    root.querySelector("[data-terrain-toggle]")?.addEventListener("click", () => {
      setEnabled(!state.enabled);
      queueControlsRender();
      this.render({ force: true });
    });
  }
}

export function openTerrainPalette() {
  if (!game.user?.isGM) return null;
  if (!isBattleMapScene()) {
    ui.notifications?.warn?.("Open a BattleTech battle-map scene before using the terrain palette.");
    return null;
  }
  return AToWBattleMapTerrainPalette.instance.render({ force: true });
}

async function placeTerrainPiece(scene, point) {
  const terrainSet = terrainSetForScene(scene);
  const piece = terrainSet.pieces[state.tool];
  if (!piece) return false;
  if (piece.freePlacement) {
    const previewSource = state.preview?.tool === state.tool ? state.preview.source : null;
    const source = previewSource ?? randomPieceSource(piece);
    if (!source) return false;
    const placementId = foundry.utils.randomID();
    await scene.createEmbeddedDocuments("Tile", [{
      x: Math.round(point.x - (piece.width / 2)),
      y: Math.round(point.y - (piece.height / 2)),
      width: piece.width,
      height: piece.height,
      rotation: state.rotationSteps * 60,
      alpha: 1,
      hidden: false,
      locked: false,
      overhead: false,
      sort: Number(piece.sort ?? 220) || 220,
      texture: { src: source, fit: piece.fit ?? "contain", anchorX: 0.5, anchorY: 0.5 },
      flags: {
        [SYSTEM_ID]: {
          [TERRAIN_TILE_FLAG]: {
            piece: state.tool,
            terrainType: "asset",
            variant: source,
            placementId,
            freePlacement: true,
            rotationSteps: state.rotationSteps
          }
        }
      }
    }], { atowBattleMapBuilder: true });
    state.freePlacementSource = null;
    return true;
  }
  const snapped = gridCenter(point);
  if (!snapped?.point) return false;
  const footprint = footprintForPiece(piece, snapped);
  const requiredCells = requiredFootprintCells(piece);
  if (footprint.length < requiredCells) {
    ui.notifications?.warn?.(`There is not enough map space to place this ${requiredCells}-hex terrain piece here.`);
    return false;
  }
  const footprintKeys = footprint.map(cell => cell.key);
  const pieceGroup = String(piece.exclusiveGroup ?? "");

  const existing = (scene.tiles?.contents ?? []).filter(tile => {
    const flag = terrainTileFlag(tile);
    if (!terrainTileHexKeys(tile).some(key => footprintKeys.includes(key))) return false;
    if (piece.allowOverlap) return flag?.piece === state.tool && flag?.hexKey === snapped.key;
    return flag?.piece === state.tool
      || (pieceGroup && terrainPieceGroup(terrainSet, flag) === pieceGroup);
  });
  const previewSource = state.preview?.tool === state.tool && state.preview?.hexKey === snapped.key
    ? state.preview.source
    : null;
  const source = previewSource ?? randomPieceSource(piece, existing.map(tile => tile.texture?.src));
  if (!source) return false;

  if (existing.length) {
    await removeTerrainTiles(scene, existing);
  }

  const placementId = foundry.utils.randomID();
  const visualCenter = pieceVisualCenter(piece, snapped, footprint);
  const ruleHexKeys = piece.rulesAnchorOnly ? [snapped.key] : footprintKeys;
  const placementRotationSteps = state.preview?.tool === state.tool && state.preview?.hexKey === snapped.key
    ? Number(state.preview.rotationSteps ?? state.rotationSteps)
    : (piece.randomRotation ? Math.floor(Math.random() * 6) : state.rotationSteps);
  const visualRotation = pieceRotationDegrees(piece, footprint, placementRotationSteps);

  await scene.createEmbeddedDocuments("Tile", [{
    x: Math.round(visualCenter.x - (piece.width / 2)),
    y: Math.round(visualCenter.y - (piece.height / 2)),
    width: piece.width,
    height: piece.height,
    rotation: visualRotation,
    alpha: 1,
    hidden: false,
    locked: false,
    overhead: false,
    sort: Number(piece.sort ?? 100) || 100,
    texture: { src: source, fit: piece.fit ?? "contain", anchorX: 0.5, anchorY: 0.5 },
    flags: {
      [SYSTEM_ID]: {
        [TERRAIN_TILE_FLAG]: {
          piece: state.tool,
          terrainType: piece.terrainType,
          variant: source,
          placementId,
          exclusiveGroup: pieceGroup,
          rotationSteps: placementRotationSteps,
          visualRotation,
          hexKey: snapped.key,
          hexKeys: footprintKeys,
          ruleHexKeys
        }
      }
    }
  }], { atowBattleMapBuilder: true });
  const rulesTerrain = foundry.utils.deepClone(scene.getFlag?.(SYSTEM_ID, RULES_TERRAIN_FLAG) ?? {});
  for (const key of ruleHexKeys) {
    const current = { ...(rulesTerrain[key] ?? {}) };
    if (piece.terrainType === "light-woods" || piece.terrainType === "heavy-woods") {
      current.woods = piece.terrainType === "heavy-woods" ? "heavy" : "light";
      current.visualTileWoods = true;
    } else if (piece.terrainType === "rough") {
      current.rough = true;
      current.visualTileRough = true;
    } else if (piece.terrainType === "elevation-1") {
      current.elevation = 1;
      current.visualTileElevation = true;
    } else if (piece.terrainType === "road") {
      current.road = true;
      current.visualTileRoad = true;
    } else if (piece.terrainType === "concrete") {
      current.groundCover = "concrete";
      current.visualTileGroundCover = true;
    } else if (piece.terrainType === "wall") {
      current.wall = true;
      current.visualTileWall = true;
    } else if (piece.terrainType === "wall-gate") {
      current.wall = true;
      current.wallGate = true;
      current.visualTileWall = true;
    } else if (piece.terrainType === "building") {
      current.building = true;
      current.visualTileBuilding = true;
    }
    rulesTerrain[key] = current;
  }
  await scene.setFlag(SYSTEM_ID, RULES_TERRAIN_FLAG, rulesTerrain);
  return true;
}

async function eraseTerrainPiece(scene, point) {
  const asset = topAssetAtPoint(scene, point);
  if (asset) return removeTerrainTiles(scene, [asset]);
  const snapped = gridCenter(point);
  if (!snapped?.key) return false;
  const tiles = (scene.tiles?.contents ?? [])
    .filter(tile => terrainTileHexKeys(tile).includes(snapped.key))
    .sort((a, b) => Number(b.sort ?? 0) - Number(a.sort ?? 0));
  return removeTerrainTiles(scene, tiles.length ? [tiles[0]] : []);
}

export async function repairBattleMapTiles(scene = canvas?.scene ?? null) {
  if (!scene || !game.user?.isGM || !isBattleMapScene(scene)) return false;
  const data = battleMapData(scene) ?? {};
  const columns = Math.max(1, Math.min(3, Math.floor(Number(data.sheetsX) || 1)));
  const rows = Math.max(1, Math.min(3, Math.floor(Number(data.sheetsY) || 1)));
  const expectedWidth = MAP_SHEET_WIDTH * columns;
  const expectedHeight = MAP_SHEET_HEIGHT * rows;
  const priorSheetWidth = Math.max(1, Number(data.sheetWidth) || MAP_SHEET_WIDTH);
  const priorSheetHeight = Math.max(1, Number(data.sheetHeight) || MAP_SHEET_HEIGHT);
  const backgroundTiles = (scene.tiles?.contents ?? [])
    .filter(tile => Boolean(tile.getFlag?.(SYSTEM_ID, "battleMapBackground")
      ?? tile.flags?.[SYSTEM_ID]?.battleMapBackground))
    .sort((a, b) => (Number(a.y) - Number(b.y)) || (Number(a.x) - Number(b.x)));
  const updates = [];
  for (const [backgroundIndex, tile] of backgroundTiles.entries()) {
    const inferredColumn = Math.max(0, Math.min(columns - 1,
      Math.round((Number(tile.x) || 0) / priorSheetWidth)));
    const inferredRow = Math.max(0, Math.min(rows - 1,
      Math.round((Number(tile.y) || 0) / priorSheetHeight)));
    const fallbackColumn = backgroundIndex % columns;
    const fallbackRow = Math.floor(backgroundIndex / columns);
    const column = backgroundTiles.length === columns * rows ? fallbackColumn : inferredColumn;
    const row = backgroundTiles.length === columns * rows ? fallbackRow : inferredRow;
    updates.push({
      _id: tile.id,
      x: column * MAP_SHEET_WIDTH,
      y: row * MAP_SHEET_HEIGHT,
      width: MAP_SHEET_WIDTH,
      height: MAP_SHEET_HEIGHT,
      "texture.anchorX": 0.5,
      "texture.anchorY": 0.5
    });
  }
  for (const tile of scene.tiles?.contents ?? []) {
    const isBackground = Boolean(tile.getFlag?.(SYSTEM_ID, "battleMapBackground")
      ?? tile.flags?.[SYSTEM_ID]?.battleMapBackground);
    const isTerrain = Boolean(tile.getFlag?.(SYSTEM_ID, TERRAIN_TILE_FLAG)
      ?? tile.flags?.[SYSTEM_ID]?.[TERRAIN_TILE_FLAG]);
    if (isBackground || !isTerrain) continue;
    if (Number(tile.texture?.anchorX) === 0.5 && Number(tile.texture?.anchorY) === 0.5) continue;
    updates.push({
      _id: tile.id,
      "texture.anchorX": 0.5,
      "texture.anchorY": 0.5
    });
  }
  if (updates.length) await scene.updateEmbeddedDocuments("Tile", updates, { atowBattleMapBuilder: true });
  const sceneNeedsUpdate = Number(scene.width) !== expectedWidth
    || Number(scene.height) !== expectedHeight
    || Number(scene.grid?.size) !== MAP_GRID_SIZE
    || Number(scene.grid?.alpha) !== 1
    || Number(data.version ?? 0) < BATTLE_MAP_VERSION
    || Number(data.sheetWidth ?? 0) !== MAP_SHEET_WIDTH
    || Number(data.sheetHeight ?? 0) !== MAP_SHEET_HEIGHT;
  if (sceneNeedsUpdate) {
    await scene.update({
      width: expectedWidth,
      height: expectedHeight,
      "grid.size": MAP_GRID_SIZE,
      "grid.alpha": 1,
      [`flags.${SYSTEM_ID}.${BATTLE_MAP_FLAG}`]: {
        ...data,
        sheetsX: columns,
        sheetsY: rows,
        sheetWidth: MAP_SHEET_WIDTH,
        sheetHeight: MAP_SHEET_HEIGHT,
        gridSize: MAP_GRID_SIZE,
        hexesTallPerSheet: 17,
        version: BATTLE_MAP_VERSION
      }
    }, { atowBattleMapBuilder: true });
  }
  if (updates.length || sceneNeedsUpdate) {
    ui.notifications?.info?.(`BattleTech battle map updated to ${columns}x${rows} sheets at ${MAP_SHEET_WIDTH}x${MAP_SHEET_HEIGHT} pixels each.`);
  }
  return updates.length > 0 || sceneNeedsUpdate;
}

async function onPointerDown(event) {
  if (!state.enabled || state.placing || !game.user?.isGM || !isBattleMapScene()) return;
  const button = Number(event?.button ?? event?.data?.button ?? 0);
  // Preserve Foundry's normal right/middle-click panning behavior.
  if (button !== 0) return;
  const point = canvasPoint(event);
  if (!point) return;
  state.lastPointerPoint = point;
  state.placing = true;
  try {
    if (state.tool === "erase") await eraseTerrainPiece(canvas.scene, point);
    else await placeTerrainPiece(canvas.scene, point);
    event?.stopPropagation?.();
    event?.preventDefault?.();
  } finally {
    state.placing = false;
    destroyPlacementPreview();
    updatePlacementPreview(point).catch(error => console.warn(`${SYSTEM_ID} | Terrain preview refresh failed`, error));
  }
}

function onPointerMove(event) {
  if (!state.enabled || !game.user?.isGM || !isBattleMapScene()) return;
  const point = canvasPoint(event);
  if (!point) return;
  state.lastPointerPoint = point;
  updatePlacementPreview(point).catch(error => console.warn(`${SYSTEM_ID} | Terrain preview failed`, error));
}

function onPointerOut() {
  state.lastPointerPoint = null;
  destroyPlacementPreview();
}

function keyboardTargetAcceptsText(event) {
  const target = event?.target;
  return target instanceof HTMLElement && (target.isContentEditable
    || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

function onTerrainKeyDown(event) {
  if (!state.enabled || state.tool === "erase" || !isBattleMapScene() || keyboardTargetAcceptsText(event)) return;
  if (event.code !== "KeyR" || event.repeat) return;
  event.preventDefault();
  event.stopPropagation();
  state.rotationSteps = (state.rotationSteps + 1) % 6;
  const point = state.lastPointerPoint;
  destroyPlacementPreview();
  if (point) updatePlacementPreview(point).catch(error => {
    console.warn(`${SYSTEM_ID} | Rotated terrain preview failed`, error);
  });
}

function unbindCanvas() {
  canvas?.stage?.off?.("pointerdown", onPointerDown);
  canvas?.stage?.off?.("pointermove", onPointerMove);
  canvas?.stage?.off?.("pointerout", onPointerOut);
  destroyPlacementPreview();
}

function bindCanvas() {
  unbindCanvas();
  if (!state.enabled || !isBattleMapScene()) return;
  canvas.stage.eventMode = "static";
  canvas.stage.interactive = true;
  canvas.stage.on("pointerdown", onPointerDown);
  canvas.stage.on("pointermove", onPointerMove);
  canvas.stage.on("pointerout", onPointerOut);
}

function setEnabled(enabled) {
  state.enabled = Boolean(enabled) && isBattleMapScene();
  bindCanvas();
  return state.enabled;
}

function selectTool(tool) {
  const validTools = new Set(["erase", ...terrainPiecesForScene().map(piece => piece.key)]);
  if (!validTools.has(tool)) return state.tool;
  if (state.tool !== tool) state.rotationSteps = 0;
  if (state.tool !== tool) state.freePlacementSource = null;
  state.tool = tool;
  state.enabled = true;
  destroyPlacementPreview();
  bindCanvas();
  queueControlsRender();
  return tool;
}

function buildControl() {
  const battleMap = isBattleMapScene();
  const tools = {
    createBattleMap: {
      name: "createBattleMap",
      title: "Create a tiled BattleTech battle map",
      icon: "fas fa-map",
      order: 1,
      button: true,
      onChange: (_event, active) => { if (active) promptCreateBattleMap(); }
    }
  };
  if (battleMap) {
    tools.terrainPalette = {
      name: "terrainPalette",
      title: "Open the battle-map terrain palette",
      icon: "fas fa-mountain-sun",
      order: 2,
      button: true,
      onChange: (_event, active) => { if (active) openTerrainPalette(); }
    };
    tools.erase = {
      name: "erase",
      title: "Erase a placed battle-map terrain piece",
      icon: "fas fa-eraser",
      order: 3,
      active: state.enabled && state.tool === "erase",
      onChange: (_event, active) => { if (active !== false) selectTool("erase"); }
    };
    tools.repairTiles = {
      name: "repairTiles",
      title: "Repair alignment of tiles created by the prototype",
      icon: "fas fa-screwdriver-wrench",
      order: 4,
      button: true,
      onChange: (_event, active) => { if (active) repairBattleMapTiles(); }
    };
  }
  return {
    name: "atowBattleMapBuilder",
    title: "BattleTech Battle Map Builder",
    icon: "fas fa-map-location-dot",
    order: 101,
    visible: Boolean(game.user?.isGM),
    activeTool: battleMap ? (state.tool === "erase" ? "erase" : "terrainPalette") : "createBattleMap",
    tools,
    onChange: (_event, active) => setEnabled(Boolean(active)),
    onToolChange: (_event, tool) => {
      if (tool?.name === "erase") selectTool(tool.name);
    }
  };
}

function registerSceneControl(controls) {
  if (!controls || !game.user?.isGM) return;
  const control = buildControl();
  if (Array.isArray(controls)) {
    controls.push({ ...control, layer: "controls", tools: Object.values(control.tools) });
    return;
  }
  controls[control.name] = control;
}

export function registerAtowBattleMapBuilder(namespace = null) {
  if (namespace?.api) {
    namespace.api.battleMapBuilder = {
      create: createBattleMap,
      promptCreate: promptCreateBattleMap,
      isBattleMapScene,
      repairTiles: repairBattleMapTiles,
      terrainSets: TERRAIN_SETS,
      openTerrainPalette,
      setEnabled,
      selectTool
    };
  }
  if (globalThis.__ATOW_BATTLE_MAP_BUILDER_REGISTERED__) return;
  globalThis.__ATOW_BATTLE_MAP_BUILDER_REGISTERED__ = true;
  document.addEventListener("keydown", onTerrainKeyDown, true);
  Hooks.on("getSceneControlButtons", registerSceneControl);
  Hooks.on("canvasReady", () => {
    state.enabled = false;
    state.placing = false;
    bindCanvas();
    queueControlsRender();
    if (game.user?.isGM && isBattleMapScene() && Number(battleMapData()?.version ?? 0) < BATTLE_MAP_VERSION) {
      repairBattleMapTiles().catch(error => console.warn(`${SYSTEM_ID} | Battle-map tile repair failed`, error));
    }
  });
}
