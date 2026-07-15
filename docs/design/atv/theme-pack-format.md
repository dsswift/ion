# ATV Theme Pack Format

The Agent Team Visualizer renders its office from a **theme pack**: a self-contained directory of sprites, manifests, and dressing templates. Nothing in ATV code enumerates characters, pets, furniture, floors, or walls; the pools are whatever the active pack's manifests declare. This document is the authoring contract for pack creators.

## Locations and discovery

| Location | Role |
|---|---|
| `desktop/resources/atv/themes/<pack-id>/` | Packs shipped with Ion desktop |
| `~/.ion/atv/themes/<pack-id>/` | User-installed packs |

ATV scans both roots at startup. Every directory containing a valid `theme.json` is a candidate pack. Invalid entries (schema violations, missing files, sprite dimension mismatches) are logged and skipped per asset; a pack only fails to load when it yields no usable base set. The shipped theme loads through the same public loader path as a user pack; there is no special-casing.

The active theme is chosen in desktop settings (default `ion-works`) and in the ATV toolbar's theme picker.

## Directory layout

```
<pack-id>/
  theme.json
  characters/<id>/manifest.json + *.png
  pets/<id>/manifest.json + *.png
  furniture/<id>/manifest.json + *.png
  floors/<id>/manifest.json + <id>.png
  walls/<id>/manifest.json + tiles.png
  bubbles/manifest.json + *.png
  dressing/<zone>.json
```

All paths inside manifests are relative to the manifest's own directory. Absolute paths and `..` segments are rejected.

## `theme.json`

```json
{
  "id": "ion-works",
  "name": "Ion Works",
  "version": "1.0.0",
  "extends": null,
  "tileSize": 16,
  "palette": ["#1a1d24", "#232733", "..."],
  "continuity": {
    "lightSource": "top-left",
    "outline": "#1a1d24",
    "dither": "low"
  }
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string (kebab-case) | yes | Pack identity. Directory name must match. |
| `name` | string | yes | Display name |
| `version` | string (semver) | yes | Pack version |
| `extends` | string or null | no | Extend mode: merge onto the named base pack |
| `tileSize` | number | yes | Tile edge in pixels. The shipped theme uses 16. Must match the base pack when extending. |
| `palette` | string[] (hex) | yes | Master palette, informational and used by tooling |
| `continuity` | object | no | Free-form continuity metadata for authors and tooling |

### Extend vs replace

- **Replace (standalone)**: `extends` absent or null. The pack fully defines the theme. It must contain at least: one character with the `manager` role, one floor, one wall set, all four bubbles, one seat-capable furniture item, and a `department` dressing template. Anything less and the pack is rejected as an active theme (it may still be valid as a base for extension).
- **Extend**: `"extends": "<base-id>"`. The pack's assets merge into the base pack's pools. An entry whose `id` collides with a base entry **overrides** it; new ids are added. Dressing templates merge per zone file (an extending pack's `dressing/department.json` replaces the base's). One level of extension is supported; an extending pack cannot itself be extended.

## Character manifest (`characters/<id>/manifest.json`)

```json
{
  "id": "mgr-blazer",
  "name": "Manager",
  "roles": ["manager", "lead", "specialist"],
  "tintable": true,
  "animations": {
    "idle":       { "file": "idle.png",       "frames": 1 },
    "walk-down":  { "file": "walk-down.png",  "frames": 4 },
    "walk-up":    { "file": "walk-up.png",    "frames": 4 },
    "walk-right": { "file": "walk-right.png", "frames": 4 },
    "typing":     { "file": "typing.png",     "frames": 2 },
    "reading":    { "file": "reading.png",    "frames": 2 },
    "stretch":    { "file": "stretch.png",    "frames": 2 },
    "slump":      { "file": "slump.png",      "frames": 1 }
  }
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Unique within the merged pool |
| `name` | string | yes | Display name |
| `roles` | string[] | yes | Any of `manager`, `lead`, `specialist`. Casting draws by role. |
| `tintable` | boolean | yes | Whether the accent tint layer applies |
| `animations` | map | yes | `idle`, `walk-down`, `walk-up`, `walk-right`, `typing`, `reading` are required; `stretch` and `slump` are optional and fall back to `idle` |

Each animation file is a horizontal strip: width = `frames * tileSize`, height = `tileSize`. Frames play left to right. Walking left is runtime-mirrored from `walk-right`.

## Pet manifest (`pets/<id>/manifest.json`)

```json
{
  "id": "volt-cat",
  "name": "Volt",
  "behavior": "wander",
  "animations": {
    "idle":       { "file": "idle.png",       "frames": 1 },
    "walk-down":  { "file": "walk-down.png",  "frames": 2 },
    "walk-up":    { "file": "walk-up.png",    "frames": 2 },
    "walk-right": { "file": "walk-right.png", "frames": 2 }
  }
}
```

`behavior` selects a built-in behavior class; `wander` is the only class defined by this version of the format. Strip dimensions follow the character rule.

## Furniture manifest (`furniture/<id>/manifest.json`)

```json
{
  "id": "desk",
  "name": "Desk",
  "category": "work",
  "footprintW": 2,
  "footprintH": 1,
  "width": 32,
  "height": 16,
  "rotationScheme": "2-way",
  "images": { "front": "front.png", "side": "side.png" },
  "states": null,
  "frames": 1,
  "isSurface": true,
  "seatTiles": [],
  "canPlaceOnWalls": false,
  "canPlaceOnSurfaces": false,
  "backgroundTiles": false,
  "tintRegion": false
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id`, `name` | string | yes | Identity and display name |
| `category` | string | yes | `work`, `mail`, `relax`, `manager`, `decor` |
| `footprintW/H` | number | yes | Tiles occupied on the floor grid |
| `width`, `height` | number | yes | Pixel size of one frame image. `width = footprintW * tileSize`. `height` may exceed `footprintH * tileSize` for tall items (anchored bottom-left, overdraw upward only). |
| `rotationScheme` | string | yes | `none`, `2-way` (`front`, `side` image keys), `3-way-mirror` (`down`, `up`, `right`; left runtime-mirrored) |
| `images` | map | yes | Variant key to file. `none` scheme uses the single key `default`. For `side` and `right` variants of rotated items, `width`/`height` swap according to the rotated footprint. |
| `states` | map or null | no | State-group name to file (e.g. `{ "on": "on.png", "off": "off.png" }`). Stateful items use `states` instead of `images` variants; state files follow the `default` orientation. |
| `frames` | number | no (default 1) | Animation frame count. Files with `frames > 1` are horizontal strips of frame width `width`. |
| `isSurface` | boolean | no | Other items with `canPlaceOnSurfaces` may sit on top |
| `seatTiles` | array | no | Seating positions: `{ "x": 0, "y": 0, "dir": "down" }` offsets within the footprint. Non-empty marks the item seat-capable. |
| `canPlaceOnWalls` | boolean | no | Item mounts on wall tiles (whiteboards, clocks) |
| `canPlaceOnSurfaces` | boolean | no | Item may be placed on an `isSurface` item (pc on desk) |
| `backgroundTiles` | boolean | no | Item draws behind characters even on its own row (rugs, floor markings) |
| `tintRegion` | boolean | no | Item contains the neutral-slate tint layer for department accents |

Validation rules: exactly one of `images`/`states` populated per orientation model above; every referenced file must exist and match the declared dimensions (times `frames` for strips).

## Floor manifest (`floors/<id>/manifest.json`)

```json
{ "id": "plank-birch", "name": "Birch Plank", "file": "plank-birch.png", "tintable": false }
```

The file is a single `tileSize` x `tileSize` tile. `tintable: true` floors are drawn in neutral slate and receive the department accent at runtime.

## Wall manifest (`walls/<id>/manifest.json`)

```json
{ "id": "graphite-panel", "name": "Graphite Panel", "file": "tiles.png" }
```

`tiles.png` is a horizontal strip of 16 tiles (`16 * tileSize` wide, `tileSize` tall), indexed by 4-bit adjacency mask: bit 1 = wall to the north, bit 2 = east, bit 4 = south, bit 8 = west. Index 0 is an isolated pillar; index 15 is a four-way junction.

## Bubbles manifest (`bubbles/manifest.json`)

```json
{
  "waiting": "waiting.png",
  "permission": "permission.png",
  "error": "error.png",
  "dispatch": "dispatch.png"
}
```

All four keys are required. Each file is one `tileSize` x `tileSize` frame.

## Dressing template (`dressing/<zone>.json`)

One file per zone: `department.json`, `manager.json`, `mail.json`, `break.json`, `meeting.json`, `lobby.json`, `corridor.json`. The `corridor` template's `floor` is applied to hallway tiles (not a room); give it a floor no room template uses so hallways stay visually distinct. Design rationale in [room-dressing-guide.md](room-dressing-guide.md).

```json
{
  "zone": "department",
  "floor": "carpet-neutral",
  "required": [
    { "id": "desk", "perSeat": true },
    { "id": "chair-ergo", "perSeat": true },
    { "id": "pc", "perSeat": true },
    { "category": "work", "wallItem": true, "count": 1 }
  ],
  "optional": [
    { "id": "server-rack", "weight": 2, "max": 1 },
    { "id": "plant-small", "weight": 3, "max": 2 },
    { "category": "decor", "weight": 1, "max": 3 }
  ],
  "density": 0.15
}
```

| Field | Meaning |
|---|---|
| `zone` | Must match the filename |
| `floor` | Floor id for the room (falls back to the first floor in the pool if absent from the pack) |
| `required` | Entries by `id` or `category`; `perSeat: true` multiplies by the room's seat count; `count` places a fixed number; `wallItem: true` restricts selection to wall-mounted items |
| `optional` | Weighted pool with per-room `max`; drawn by the seeded generator until `density` is reached |
| `density` | Fraction of free floor tiles optional items may occupy |

Required entries referencing an id absent from the merged pool are logged and treated as category entries when a category is given, otherwise skipped; the generator never crashes on a sparse pack.

## Validation summary

At load, per asset: manifest parses, schema fields present and typed, referenced files exist, decoded image dimensions match the declared geometry. Failures log with the pack id, asset id, and reason, then skip that asset. The pack-level minimums (see extend vs replace) are checked after per-asset validation.
