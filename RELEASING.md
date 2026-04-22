# Releasing `atow-battletech`

This system currently uses GitHub and Foundry's `system.json` manifest.

## Recommended Release Pattern

Use tagged GitHub releases like `v0.0.2`, `v0.0.3`, etc.

Keep these two release assets on every GitHub Release:

- `system.json`
- `atow-battletech.zip`

## One-Time Manifest URL Switch

After the first proper GitHub Release is created, update `system.json` so these fields use release assets instead of the moving `main` branch:

```json
"manifest": "https://github.com/sh4dowf0x/battletech-foundry/releases/latest/download/system.json",
"download": "https://github.com/sh4dowf0x/battletech-foundry/releases/latest/download/atow-battletech.zip"
```

That lets Foundry always install and update from the newest published release.

Important:
- Do not switch to these URLs until the first release exists and contains both files.
- Once switched, keep the asset filenames exactly the same on every release.

## Release Steps

1. Update version numbers.
   - `system.json` -> `"version"`
   - `atow-battletech.js` header comment if you want it kept in sync

2. Commit and push to `main`.

3. Create and push the annotated tag:

```powershell
git tag -a v0.0.2 -m "Release v0.0.2"
git push origin v0.0.2
```

4. Build a release zip of the system folder contents.
   - The zip should contain the system files at the root of the archive.
   - The zip should not contain the parent folder above the system.

5. On GitHub, open:
   - `https://github.com/sh4dowf0x/battletech-foundry/releases`

6. Draft a new release from tag `v0.0.2`.

7. Upload these assets to the release:
   - `system.json`
   - `atow-battletech.zip`

8. Publish the release.

## Zip Notes

The uploaded `atow-battletech.zip` should expand into the system directory contents directly, for example:

```text
system.json
atow-battletech.js
module/
templates/
styles/
packs/
assets/
lang/
```

Not this:

```text
atow-battletech/system.json
atow-battletech/module/
...
```

## Current State

Current tagged-release target:

- Version: `0.0.2`
- Tag: `v0.0.2`
