const SYSTEM_ID = "atow-battletech";
const GALAXY_FLAG = "galaxyMap";
const SYSTEM_NOTE_FLAG = "galaxySystem";
const ROUTE_OVERLAY_NAME = "atow-galaxy-travel-route";
const SHARED_ROUTE_FLAG = "travelRoute";
const MAX_JUMP_DISTANCE = 30;
const DAYS_PER_JUMP = 7;

const TRAVEL_COSTS = Object.freeze({
  inexpensive: { label: "Inexpensive", perJump: 1000 },
  moderate: { label: "Moderate", perJump: 5000 },
  expensive: { label: "Expensive", perJump: 10000 }
});

const state = {
  overlay: null,
  route: null
};

function isGalaxyMapScene(scene = canvas?.scene ?? game?.scenes?.active) {
  const value = scene?.getFlag?.(SYSTEM_ID, GALAXY_FLAG)?.enabled ?? scene?.flags?.[SYSTEM_ID]?.[GALAXY_FLAG]?.enabled;
  return value === true || value === 1 || String(value).toLowerCase() === "true";
}

function isGalaxySystemNote(note) {
  const data = note?.getFlag?.(SYSTEM_ID, SYSTEM_NOTE_FLAG) ?? note?.flags?.[SYSTEM_ID]?.[SYSTEM_NOTE_FLAG];
  return Boolean(data?.system);
}

function escapeHTML(value) {
  if (foundry?.utils?.escapeHTML) return foundry.utils.escapeHTML(String(value ?? ""));
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function pixelsPerDistanceUnit(scene = canvas?.scene ?? game?.scenes?.active) {
  const direct = Number(scene?.dimensions?.distancePixels ?? (canvas?.scene?.id === scene?.id ? canvas?.dimensions?.distancePixels : null));
  if (Number.isFinite(direct) && direct > 0) return direct;
  const gridSize = Number(canvas?.grid?.size ?? scene?.grid?.size);
  const gridDistance = Number(scene?.grid?.distance);
  if (Number.isFinite(gridSize) && gridSize > 0 && Number.isFinite(gridDistance) && gridDistance > 0) {
    return gridSize / gridDistance;
  }
  return 1;
}

export function collectGalaxyTravelSystems(scene = canvas?.scene ?? game?.scenes?.active) {
  if (!scene || !isGalaxyMapScene(scene)) return [];
  const scale = pixelsPerDistanceUnit(scene);
  return Array.from(scene.notes?.contents ?? scene.notes ?? [])
    .filter(isGalaxySystemNote)
    .map(note => {
      const x = Number(note.x);
      const y = Number(note.y);
      const journalName = game?.journal?.get?.(note.entryId)?.name;
      return {
        id: note.id,
        name: String(note.text ?? journalName ?? note.id).trim(),
        x: x / scale,
        y: y / scale,
        point: { x, y }
      };
    })
    .filter(node => node.name && Number.isFinite(node.x) && Number.isFinite(node.y))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function routeDistance(a, b) {
  return Math.hypot(Number(b.x) - Number(a.x), Number(b.y) - Number(a.y));
}

function buildNavigationGraph(nodes, maxJumpDistance) {
  const graph = new Map(nodes.map(node => [node.id, []]));
  const buckets = new Map();
  const bucketKey = (x, y) => `${x}:${y}`;
  const bucketSize = maxJumpDistance;

  for (const node of nodes) {
    const bx = Math.floor(node.x / bucketSize);
    const by = Math.floor(node.y / bucketSize);
    const key = bucketKey(bx, by);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(node);
  }

  for (const node of nodes) {
    const bx = Math.floor(node.x / bucketSize);
    const by = Math.floor(node.y / bucketSize);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const candidate of buckets.get(bucketKey(bx + dx, by + dy)) ?? []) {
          if (String(candidate.id).localeCompare(String(node.id)) <= 0) continue;
          const distance = routeDistance(node, candidate);
          if (distance > maxJumpDistance + 1e-6) continue;
          graph.get(node.id).push({ id: candidate.id, distance });
          graph.get(candidate.id).push({ id: node.id, distance });
        }
      }
    }
  }
  return graph;
}

function compareQueueEntries(a, b) {
  return (a.jumps - b.jumps) || (a.distance - b.distance);
}

function heapPush(heap, value) {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareQueueEntries(heap[parent], value) <= 0) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = value;
}

function heapPop(heap) {
  if (!heap.length) return null;
  const root = heap[0];
  const last = heap.pop();
  if (!heap.length) return root;
  let index = 0;
  while (true) {
    const left = (index * 2) + 1;
    const right = left + 1;
    if (left >= heap.length) break;
    let child = left;
    if (right < heap.length && compareQueueEntries(heap[right], heap[left]) < 0) child = right;
    if (compareQueueEntries(last, heap[child]) <= 0) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = last;
  return root;
}

/**
 * Find the fewest-jump route. Total traveled distance breaks ties between
 * routes with the same number of jumps.
 */
export function calculateGalaxyRoute(nodes, startId, endId, maxJumpDistance = MAX_JUMP_DISTANCE) {
  const validNodes = Array.from(nodes ?? []).filter(node => node?.id != null && Number.isFinite(node.x) && Number.isFinite(node.y));
  const byId = new Map(validNodes.map(node => [String(node.id), node]));
  const startKey = String(startId ?? "");
  const endKey = String(endId ?? "");
  const start = byId.get(startKey);
  const end = byId.get(endKey);
  if (!start || !end || !(maxJumpDistance > 0)) return null;
  if (startKey === endKey) return { nodes: [start], segments: [], jumps: 0, distance: 0, directDistance: 0 };

  const graph = buildNavigationGraph(validNodes.map(node => ({ ...node, id: String(node.id) })), maxJumpDistance);
  const best = new Map([[startKey, { jumps: 0, distance: 0, previous: null, edgeDistance: 0 }]]);
  const queue = [];
  heapPush(queue, { id: startKey, jumps: 0, distance: 0 });

  while (queue.length) {
    const current = heapPop(queue);
    const known = best.get(current.id);
    if (!known || current.jumps !== known.jumps || Math.abs(current.distance - known.distance) > 1e-6) continue;
    if (current.id === endKey) break;

    for (const edge of graph.get(current.id) ?? []) {
      const jumps = current.jumps + 1;
      const distance = current.distance + edge.distance;
      const existing = best.get(edge.id);
      const improves = !existing || jumps < existing.jumps || (jumps === existing.jumps && distance < existing.distance - 1e-6);
      if (!improves) continue;
      best.set(edge.id, { jumps, distance, previous: current.id, edgeDistance: edge.distance });
      heapPush(queue, { id: edge.id, jumps, distance });
    }
  }

  if (!best.has(endKey)) return null;
  const routeIds = [];
  let cursor = endKey;
  while (cursor) {
    routeIds.push(cursor);
    cursor = best.get(cursor)?.previous ?? null;
  }
  routeIds.reverse();
  const routeNodes = routeIds.map(id => byId.get(id));
  const segments = routeNodes.slice(1).map((node, index) => ({
    from: routeNodes[index],
    to: node,
    distance: routeDistance(routeNodes[index], node)
  }));
  return {
    nodes: routeNodes,
    segments,
    jumps: segments.length,
    distance: segments.reduce((total, segment) => total + segment.distance, 0),
    directDistance: routeDistance(start, end)
  };
}

function clearGalaxyRoute({ destroy = false } = {}) {
  if (state.overlay && !state.overlay.destroyed) {
    if (destroy) state.overlay.destroy({ children: true });
    else state.overlay.removeChildren().forEach(child => child.destroy?.({ children: true }));
  }
  if (destroy) state.overlay = null;
  state.route = null;
}

function ensureRouteOverlay() {
  if (!canvas?.ready || !canvas?.interface) return null;
  if (state.overlay && !state.overlay.destroyed) return state.overlay;
  const overlay = new PIXI.Container();
  overlay.name = ROUTE_OVERLAY_NAME;
  overlay.eventMode = "none";
  overlay.interactiveChildren = false;
  overlay.zIndex = 60;
  canvas.interface.sortableChildren = true;
  canvas.interface.addChild(overlay);
  state.overlay = overlay;
  return overlay;
}

export function drawGalaxyRoute(route) {
  clearGalaxyRoute();
  if (!route?.nodes?.length || !isGalaxyMapScene()) return false;
  const overlay = ensureRouteOverlay();
  if (!overlay) return false;
  state.route = route;

  const points = route.nodes.map(node => node.point).filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y));
  if (points.length !== route.nodes.length) return false;
  const graphics = new PIXI.Graphics();
  if (points.length > 1) {
    graphics.lineStyle(13, 0x05070a, 0.92);
    graphics.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) graphics.lineTo(point.x, point.y);
    graphics.lineStyle(5, 0x55e7ff, 1);
    graphics.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) graphics.lineTo(point.x, point.y);
  }

  points.forEach((point, index) => {
    const endpoint = index === 0 || index === points.length - 1;
    const color = index === 0 ? 0x68e879 : index === points.length - 1 ? 0xffd75a : 0xffffff;
    graphics.beginFill(0x05070a, 1);
    graphics.drawCircle(point.x, point.y, endpoint ? 13 : 10);
    graphics.endFill();
    graphics.beginFill(color, 1);
    graphics.drawCircle(point.x, point.y, endpoint ? 8 : 6);
    graphics.endFill();
  });
  overlay.addChild(graphics);

  for (const segment of route.segments ?? []) {
    const text = new PIXI.Text(`${segment.distance.toFixed(1)} LY`, {
      fontFamily: CONFIG?.defaultFontFamily ?? "Arial",
      fontSize: 26,
      fill: 0x55e7ff,
      stroke: 0x05070a,
      strokeThickness: 5,
      fontWeight: "700"
    });
    text.anchor.set(0.5);
    text.position.set((segment.from.point.x + segment.to.point.x) / 2, (segment.from.point.y + segment.to.point.y) / 2);
    text.eventMode = "none";
    overlay.addChild(text);
  }
  return true;
}

function sharedRouteData(scene = canvas?.scene ?? game?.scenes?.active) {
  return scene?.getFlag?.(SYSTEM_ID, GALAXY_FLAG)?.[SHARED_ROUTE_FLAG]
    ?? scene?.flags?.[SYSTEM_ID]?.[GALAXY_FLAG]?.[SHARED_ROUTE_FLAG]
    ?? null;
}

function routeFromSharedData(data, scene = canvas?.scene ?? game?.scenes?.active) {
  const ids = Array.isArray(data?.nodeIds) ? data.nodeIds.map(String) : [];
  if (!ids.length) return null;
  const systems = collectGalaxyTravelSystems(scene);
  const byId = new Map(systems.map(system => [String(system.id), system]));
  const nodes = ids.map(id => byId.get(id));
  if (nodes.some(node => !node)) return null;
  const segments = nodes.slice(1).map((node, index) => ({
    from: nodes[index],
    to: node,
    distance: routeDistance(nodes[index], node)
  }));
  return {
    nodes,
    segments,
    jumps: segments.length,
    distance: segments.reduce((total, segment) => total + segment.distance, 0),
    directDistance: nodes.length > 1 ? routeDistance(nodes[0], nodes.at(-1)) : 0
  };
}

function drawSharedGalaxyRoute(scene = canvas?.scene ?? game?.scenes?.active) {
  if (!scene || scene.id !== canvas?.scene?.id || !isGalaxyMapScene(scene)) {
    clearGalaxyRoute();
    return null;
  }
  const route = routeFromSharedData(sharedRouteData(scene), scene);
  if (!route) {
    clearGalaxyRoute();
    return null;
  }
  drawGalaxyRoute(route);
  return route;
}

async function gmSetSharedGalaxyRoute(sceneId, request = null) {
  if (!game.user?.isGM) return { ok: false, reason: "Only a GM may update a shared galaxy route." };
  const scene = game.scenes?.get?.(String(sceneId ?? ""));
  if (!scene || !isGalaxyMapScene(scene)) return { ok: false, reason: "The Galaxy Map Scene could not be found." };
  const root = `flags.${SYSTEM_ID}.${GALAXY_FLAG}`;

  if (!request?.startId || !request?.endId) {
    await scene.update({ [`${root}.-=${SHARED_ROUTE_FLAG}`]: null }, { atowGalaxyTravelRoute: true });
    return { ok: true, cleared: true };
  }

  const systems = collectGalaxyTravelSystems(scene);
  const route = calculateGalaxyRoute(systems, request.startId, request.endId, MAX_JUMP_DISTANCE);
  if (!route) return { ok: false, reason: "No route could be found using jumps of 30 LY or less." };
  const costTier = Object.hasOwn(TRAVEL_COSTS, request.costTier) ? request.costTier : "moderate";
  const data = {
    version: 1,
    nodeIds: route.nodes.map(node => String(node.id)),
    startId: String(request.startId),
    endId: String(request.endId),
    costTier,
    updatedAt: Date.now()
  };
  await scene.update({ [`${root}.${SHARED_ROUTE_FLAG}`]: data }, { atowGalaxyTravelRoute: true });
  return { ok: true, route: data };
}

async function requestSharedGalaxyRoute(request = null) {
  const scene = canvas?.scene ?? game?.scenes?.active;
  if (!scene || !isGalaxyMapScene(scene)) return { ok: false, reason: "No Galaxy Map Scene is active." };
  if (game.user?.isGM) return gmSetSharedGalaxyRoute(scene.id, request);
  const socket = game?.[SYSTEM_ID]?.socket;
  if (!socket) return { ok: false, reason: "The AToW socket connection is not ready." };
  try {
    return await socket.executeAsGM("gmSetSharedGalaxyRoute", scene.id, request);
  } catch (error) {
    console.warn(`${SYSTEM_ID} | Failed to share galaxy route`, error);
    return { ok: false, reason: "An active GM is required to share a galaxy route." };
  }
}

async function clearSharedGalaxyRoute() {
  const result = await requestSharedGalaxyRoute(null);
  if (!result?.ok) {
    ui.notifications?.error?.(result?.reason ?? "Could not clear the shared galaxy route.");
    return false;
  }
  clearGalaxyRoute();
  return true;
}

function currency(value) {
  return `${new Intl.NumberFormat(game?.i18n?.lang ?? "en-US").format(Math.round(value))} C-bills`;
}

function activateSystemSearch(dialog) {
  const root = dialog?.element instanceof HTMLElement ? dialog.element : dialog?.element?.[0];
  if (!root) return;
  for (const search of root.querySelectorAll("[data-system-search]")) {
    const select = root.querySelector(`select[name="${search.dataset.systemSearch}"]`);
    const count = search.closest(".atow-galaxy-system-picker")?.querySelector("[data-system-count]");
    if (!select) continue;
    const filter = () => {
      const query = String(search.value ?? "").trim().toLocaleLowerCase();
      let visible = 0;
      let firstVisible = null;
      for (const option of select.options) {
        const matches = !query || String(option.textContent ?? "").toLocaleLowerCase().includes(query);
        option.hidden = !matches;
        option.disabled = !matches;
        if (matches) {
          visible += 1;
          firstVisible ??= option;
        }
      }
      if (select.selectedOptions[0]?.disabled || select.selectedIndex < 0) {
        select.value = firstVisible?.value ?? "";
      }
      if (count) count.textContent = `${visible} system${visible === 1 ? "" : "s"}`;
    };
    search.addEventListener("input", filter);
    filter();
  }
}

async function showRouteResult(route, selectedCost) {
  const chosen = TRAVEL_COSTS[selectedCost] ?? TRAVEL_COSTS.moderate;
  const days = route.jumps * DAYS_PER_JUMP;
  const routeText = route.segments.map(segment => `
    <li><span><strong>${escapeHTML(segment.from.name)}</strong> → <strong>${escapeHTML(segment.to.name)}</strong></span>
      <span>${segment.distance.toFixed(1)} LY</span></li>`).join("");
  const costs = Object.values(TRAVEL_COSTS).map(cost => `
    <tr class="${cost === chosen ? "selected" : ""}"><td>${cost.label}</td><td>${currency(cost.perJump)}</td><td>${currency(cost.perJump * route.jumps)}</td></tr>`).join("");

  await foundry.applications.api.DialogV2.prompt({
    window: { title: "Galaxy Travel Route" },
    position: { width: 620 },
    content: `
      <div class="standard-form atow-galaxy-route-result">
        <div class="atow-galaxy-route-summary">
          <strong>${route.jumps} jump${route.jumps === 1 ? "" : "s"}</strong>
          <span>${route.distance.toFixed(1)} LY traveled</span>
          <span>${days} days</span>
          <span>${currency(chosen.perJump * route.jumps)} (${chosen.label})</span>
        </div>
        <p class="hint">Travel time assumes one seven-day recharge cycle per jump. In-system transit time is not included.</p>
        <ol class="atow-galaxy-route-legs">${routeText || `<li>${escapeHTML(route.nodes[0]?.name)} — already at destination</li>`}</ol>
        <table>
          <thead><tr><th>Fare</th><th>Per Jump</th><th>Trip Total</th></tr></thead>
          <tbody>${costs}</tbody>
        </table>
      </div>`,
    ok: { label: "Close", icon: "fas fa-check" },
    rejectClose: false,
    modal: true
  });
}

export async function openGalaxyTravelCalculator() {
  const scene = canvas?.scene ?? game?.scenes?.active;
  if (!scene || !isGalaxyMapScene(scene)) {
    ui.notifications?.warn?.("Galaxy travel routes can only be calculated on a Galaxy Map Scene.");
    return null;
  }
  const systems = collectGalaxyTravelSystems(scene);
  if (systems.length < 2) {
    ui.notifications?.warn?.("At least two galaxy systems are required to calculate a route.");
    return null;
  }

  const systemOptions = selectedId => systems.map(system =>
    `<option value="${escapeHTML(system.id)}"${system.id === selectedId ? " selected" : ""}>${escapeHTML(system.name)}</option>`
  ).join("");
  const result = await foundry.applications.api.DialogV2.input({
    window: { title: "Galaxy Travel Calculator" },
    position: { width: 760 },
    content: `
      <div class="standard-form atow-galaxy-travel-dialog">
        <div class="atow-galaxy-travel-pickers">
          <div class="atow-galaxy-system-picker">
            <label>Starting System</label>
            <input type="search" data-system-search="startId" placeholder="Search starting systems…" autocomplete="off" />
            <select name="startId" size="8">${systemOptions(systems[0]?.id)}</select>
            <small data-system-count>${systems.length} systems</small>
          </div>
          <div class="atow-galaxy-system-picker">
            <label>Destination</label>
            <input type="search" data-system-search="endId" placeholder="Search destination systems…" autocomplete="off" />
            <select name="endId" size="8">${systemOptions(systems[1]?.id)}</select>
            <small data-system-count>${systems.length} systems</small>
          </div>
        </div>
        <div class="form-group"><label>Travel Cost</label><div class="form-fields"><select name="costTier">
          <option value="inexpensive">Inexpensive — 1,000 C-bills per jump</option>
          <option value="moderate" selected>Moderate — 5,000 C-bills per jump</option>
          <option value="expensive">Expensive — 10,000 C-bills per jump</option>
        </select></div></div>
        <p class="hint">Routes use inhabited systems as jump points, with a maximum jump distance of ${MAX_JUMP_DISTANCE} LY.</p>
      </div>`,
    ok: { label: "Calculate Route", icon: "fas fa-route" },
    render: (_event, dialog) => activateSystemSearch(dialog),
    rejectClose: false,
    modal: true
  });
  if (!result) return null;
  const validIds = new Set(systems.map(system => system.id));
  if (!validIds.has(String(result.startId ?? "")) || !validIds.has(String(result.endId ?? ""))) {
    ui.notifications?.warn?.("Choose a valid starting system and destination.");
    return null;
  }
  if (String(result.startId) === String(result.endId)) {
    ui.notifications?.warn?.("Choose two different systems.");
    return null;
  }

  const route = calculateGalaxyRoute(systems, result.startId, result.endId, MAX_JUMP_DISTANCE);
  if (!route) {
    clearGalaxyRoute();
    ui.notifications?.error?.("No route could be found using jumps of 30 LY or less.");
    return null;
  }
  const shared = await requestSharedGalaxyRoute({
    startId: String(result.startId),
    endId: String(result.endId),
    costTier: String(result.costTier ?? "moderate")
  });
  if (!shared?.ok) {
    ui.notifications?.error?.(shared?.reason ?? "Could not share the galaxy route.");
    return null;
  }
  drawGalaxyRoute(route);
  await showRouteResult(route, String(result.costTier ?? "moderate"));
  return route;
}

function registerGalaxyTravelControls(controls) {
  if (!controls || !isGalaxyMapScene()) return;
  const group = Array.isArray(controls)
    ? controls.find(control => control?.name === "tokens")
    : controls.tokens;
  if (!group?.tools) return;

  const calculateTool = {
    name: "atowGalaxyTravel",
    title: "Galaxy Travel Calculator",
    icon: "fas fa-route",
    order: 3.1,
    button: true,
    onChange: (_event, active) => {
      if (active !== false) openGalaxyTravelCalculator();
    }
  };
  const clearTool = {
    name: "atowClearGalaxyTravel",
    title: "Clear Galaxy Travel Route",
    icon: "fas fa-xmark",
    order: 3.2,
    button: true,
    onChange: (_event, active) => {
      if (active !== false) clearSharedGalaxyRoute();
    }
  };

  if (Array.isArray(group.tools)) group.tools.push(calculateTool, clearTool);
  else {
    group.tools[calculateTool.name] = calculateTool;
    group.tools[clearTool.name] = clearTool;
  }
}

export function registerAtowGalaxyTravelTools(namespace = null) {
  const api = {
    calculate: calculateGalaxyRoute,
    collectSystems: collectGalaxyTravelSystems,
    open: openGalaxyTravelCalculator,
    draw: drawGalaxyRoute,
    clear: clearSharedGalaxyRoute,
    clearLocal: clearGalaxyRoute,
    maxJumpDistance: MAX_JUMP_DISTANCE,
    daysPerJump: DAYS_PER_JUMP,
    costs: TRAVEL_COSTS
  };
  if (namespace?.api) namespace.api.galaxyTravel = api;

  Hooks.on("getSceneControlButtons", registerGalaxyTravelControls);
  Hooks.on("canvasReady", () => {
    clearGalaxyRoute({ destroy: true });
    drawSharedGalaxyRoute(canvas?.scene);
  });
  Hooks.on("updateScene", (scene, changed) => {
    if (scene?.id !== canvas?.scene?.id) return;
    const root = `flags.${SYSTEM_ID}.${GALAXY_FLAG}`;
    const paths = Object.keys(foundry.utils.flattenObject(changed ?? {}));
    if (!paths.some(path => (path === root) || (path.startsWith(root) && path.includes(SHARED_ROUTE_FLAG)))) return;
    drawSharedGalaxyRoute(scene);
  });
  Hooks.on("deleteScene", scene => {
    if (scene?.id === canvas?.scene?.id) clearGalaxyRoute({ destroy: true });
  });
}

export function registerATOWGalaxyTravelSockets(existingSocket = null) {
  const socketlibApi = globalThis.socketlib;
  if (!existingSocket && !socketlibApi?.registerSystem) {
    console.warn(`${SYSTEM_ID} | socketlib is not available; shared galaxy routes are disabled.`);
    return null;
  }
  const socket = existingSocket ?? socketlibApi.registerSystem(SYSTEM_ID);
  if (!socket) return null;
  if (!socket.functions?.has?.("gmSetSharedGalaxyRoute")) {
    socket.register("gmSetSharedGalaxyRoute", gmSetSharedGalaxyRoute);
  }
  game[SYSTEM_ID] = game[SYSTEM_ID] ?? {};
  game[SYSTEM_ID].socket = socket;
  return socket;
}
