# Mech Sheet Audit

Date: 2026-04-22

Files audited:

- `module/mech-sheet.js`
- `templates/mech-sheet.hbs`
- `styles/mech-sheet.css`

Backup copies exist in:

- `backup/mech-sheet.js.old`
- `backup/mech-sheet.hbs.old`
- `backup/mech-sheet.css.old`

## Goal

Prepare the mech sheet for a safe V2 conversion by identifying:

- major feature zones
- high-risk interactions
- data prepared in JS but not rendered in the template
- DOM/event drift
- likely dead or redundant code

## High-Level Assessment

The mech sheet is too large to convert safely as a single rewrite.

Current size:

- `module/mech-sheet.js`: ~183 KB
- `templates/mech-sheet.hbs`: ~42 KB
- `styles/mech-sheet.css`: ~19 KB

The sheet currently combines three responsibilities in one file:

1. actor/system automation and hooks
2. sheet data preparation
3. sheet DOM event wiring and drag/drop behavior

This makes a direct V2 rewrite risky because visual changes can easily break unrelated gameplay behavior.

## Feature Map

### 1. Global hooks and automation

This lives in the same file as the sheet class and includes:

- combat updates
- token updates
- actor updates
- ready/canvas hooks
- status syncing

Notable area:

- `module/mech-sheet.js:2730-3308`

Recommendation:

- Leave this logic alone during the first V2 pass.
- Do not mix hook cleanup with UI conversion.

### 2. Sheet data preparation

Primary `getData()` block:

- `module/mech-sheet.js:3331+`

Major data sections prepared:

- tonnage + structure profile
- derived movement
- TSM state
- jump jets
- crit-derived weapons/loadout
- pilot helpers
- tonnage breakdown
- ammo bins
- armor helpers
- structure helpers
- crit-slot presentation helpers
- heat helpers
- status entries

### 3. DOM-driven sheet interactions

Primary listener block:

- `module/mech-sheet.js:4307+`

Major interactive zones:

- loadout table
- attack launch
- drag/drop into crit/loadout zones
- armor/structure/heat pip editing
- crit slot clear/destroy/CASE
- tonnage/engine/tech-base sync

## Template Zones

The template breaks naturally into these migration sections:

1. Header / mech identity
   - `templates/mech-sheet.hbs:257`

2. Mech Data
   - chassis/model/tonnage/weight/max armor/tech base/role/engine/movement
   - `templates/mech-sheet.hbs:269`

3. Weapons / Equipment loadout
   - `templates/mech-sheet.hbs:368`

4. Ammunition
   - `templates/mech-sheet.hbs:430`

5. Warrior data + portrait
   - `templates/mech-sheet.hbs:466`

6. Armor / structure / heat
   - `templates/mech-sheet.hbs:520`

7. Critical hit table
   - `templates/mech-sheet.hbs:676`

8. Tonnage + status bottom panels
   - `templates/mech-sheet.hbs:1087`

These should be treated as separate migration targets, not one monolithic redesign.

## Highest-Risk Areas

### Crit-slot drag/drop

Most fragile behavior in the sheet.

Location:

- `module/mech-sheet.js:4444`

Why risky:

- uses exact DOM selectors and `data-*` attributes
- handles multi-slot components
- handles continuation slots
- enforces Artemis / TSM / MASC restrictions
- writes directly into `system.crit.*.slots.*`

V2 recommendation:

- preserve the current crit-slot DOM classes and `data-crit-*` attributes initially
- do not redesign crit markup in the first V2 milestone

### Loadout row behavior

Location:

- listeners: `module/mech-sheet.js:4313-4317`
- handlers: `module/mech-sheet.js:4743-4827`

Why risky:

- left click attacks
- right click opens item sheet
- drag start depends on `data-item-uuid`
- row structure assumes `.we-row`

V2 recommendation:

- preserve `.we-row`, `.we-attack`, `.item-delete`, and `data-item-*` attributes initially

### Engine / tonnage sync logic

Locations:

- `module/mech-sheet.js:4656+`
- `module/mech-sheet.js:4697+`

Why risky:

- updates movement, structure, max armor, weight, XL side torso crits
- easy to accidentally trigger too often or not at all if DOM field names change

V2 recommendation:

- keep the exact field names and change events in the first pass

## Strong Signs of Bloat or Drift

### 1. `context` values prepared but not rendered by template

These are populated in `getData()` but do not appear to be used in `templates/mech-sheet.hbs`:

- `context.weapons`
- `context.equipment`
- `context.otherItems`
- `context.physicalAttacks`
- `context.jumpJets`
- `context.derivedMoveBase`
- `context.tsm`

Notes:

- These are not automatically safe to delete.
- They may still be useful for debugging, future features, or macros.
- But they are strong candidates for review and possible pruning.

### 2. Likely stale edit path for loadout items

Evidence:

- Template still renders `.item-edit` links:
  - `templates/mech-sheet.hbs:395`
- Method still exists:
  - `module/mech-sheet.js:4743`
- No listener is bound for `.item-edit` in `activateListeners()`

Interpretation:

- `_onItemEdit` looks orphaned or partially replaced by row click/right-click behavior.

Recommendation:

- Confirm whether direct item-name click is supposed to open sheet or attack.
- If not needed, remove `_onItemEdit` and the `.item-edit` anchor in a cleanup pass.

### 3. Inline `<style>` block inside the template

Evidence:

- `templates/mech-sheet.hbs:2+`

Interpretation:

- Some CSS has already leaked into the template rather than staying in `styles/mech-sheet.css`.

Recommendation:

- For V2, move these styles into `mech-sheet-v2.css`.
- Keep visual rules out of the template wherever possible.

### 4. Duplicate or overlapping presentation data

Examples:

- `context.derivedMove` is rendered, while `context.derivedMoveBase` appears to be retained only for helper state
- `context.loadout` is rendered, but `context.weapons`, `context.equipment`, and `context.otherItems` are also built

Interpretation:

- Some data structures may only exist because the sheet evolved over time.

Recommendation:

- In the V2 track, decide on one canonical rendered collection per UI zone.

## DOM Contract To Preserve In First V2 Pass

These selectors should survive unchanged initially:

- `.we-row`
- `.we-attack`
- `.item-delete`
- `.drop-zone`
- `.track-box`
- `.armor-pip`
- `.structure-pip`
- `.heat-pip`
- `.crit-slot`
- `.crit-dot`
- `.crit-clear`
- `.crit-destroy`
- `.crit-add-case`

These data attributes should also survive unchanged:

- `data-item-id`
- `data-item-uuid`
- `data-drop-zone`
- `data-crit-loc`
- `data-crit-index`
- `data-part-of`
- `data-track`
- `data-value`
- `data-pip`
- `data-crit-hit`
- `data-crit-value`

## Recommended Migration Plan

### Phase 1: Parallel V2 shell

Create:

- `module/mech-sheet-v2.js`
- `templates/mech-sheet-v2.hbs`
- `styles/mech-sheet-v2.css`

Register the V2 sheet separately and do not make it default yet.

Goal:

- open the same mech successfully in V2
- keep the same markup structure and selectors
- preserve all interactions

### Phase 2: Parity check

Manual regression list:

1. Open mech actor
2. Change tonnage
3. Change engine rating
4. Edit armor pips
5. Edit structure pips
6. Edit heat
7. Drag equipment into loadout
8. Drag weapon/equipment into crit slot
9. Remove crit item
10. Toggle crit destroyed state
11. Add CASE
12. Launch attack from loadout row
13. Right click loadout row to open item sheet
14. Open portrait file picker

### Phase 3: Cleanup pass

After parity is proven, review for removal:

- orphaned `_onItemEdit`
- unused context collections
- template inline styles
- duplicated intermediate data structures

### Phase 4: Visual redesign

Only after parity and cleanup:

- redesign layout
- modernize panels
- reduce clutter
- split sections into more intentional V2 regions

## Recommendation For The Next Concrete Step

Do not redesign the current mech sheet yet.

Next best move:

1. clone current mech sheet into `*-v2` files
2. register V2 mech sheet separately
3. make the first V2 version behavior-identical to current sheet
4. only then begin cleanup and redesign

This gives the safest path to:

- preserving current functionality
- identifying dead code with confidence
- avoiding a catastrophic break during conversion
