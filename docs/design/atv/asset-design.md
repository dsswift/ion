# ATV Asset Design: "Ion Works"

Design authority for every visual asset in the Agent Team Visualizer's shipped theme pack. Sprite production does not begin on any asset until its spec in this document is complete. Every generated asset is reviewed against its "expected look" line before it enters the pack.

## Theme statement

**Ion Works** is a charged-particle research studio: a sleek mission-control office where agent teams do their work. Clean lines, warm wood surfaces against cool graphite structure, and soft technological glow accents. The mood is focused and professional with quiet personality in the details: a plasma globe on a desk, a neon sign over the coffee bar, server LEDs blinking ion blue.

The set must read as designed, not assembled. Every asset draws from one master palette, obeys the same light and outline rules, and shares the same tile discipline.

## Master palette

All assets use only these colors (plus full transparency). The palette is the single source of continuity across the set. Values are grouped by role.

### Structure (graphite and slate)

| Name | Hex | Use |
|---|---|---|
| ink-outline | `#1a1d24` | All outlines. Never pure black. |
| shadow-cool | `#14161c` | Cast shadows, darkest recesses |
| graphite-900 | `#232733` | Wall panel dark, monitor bezels |
| graphite-700 | `#2e3442` | Wall panel mid, desk frames |
| graphite-500 | `#3d4557` | Structural mid-tone |
| slate-400 | `#566073` | Metal furniture mid |
| slate-300 | `#6f7a90` | Metal highlights, trim |
| slate-200 | `#97a1b5` | Light metal, keyboard keys |
| slate-100 | `#c3cbdb` | Brightest structural highlight |

### Wood and warm surfaces

| Name | Hex | Use |
|---|---|---|
| wainscot-brown | `#5c4530` | Dark wood trim, chair legs |
| birch-dark | `#7a5a3a` | Wood shadow tone |
| birch-mid | `#a97e52` | Primary desk/floor wood |
| birch-light | `#cfa877` | Wood highlight |
| birch-pale | `#e8cfa4` | Brightest wood, paper stacks |
| plaster-warm | `#d9cfc0` | Warm wall plaster |

### Ion accent family (cyan to violet)

Every glowing element (screens, status LEDs, energy details, the coffee-bar neon) uses this family and nothing else.

| Name | Hex | Use |
|---|---|---|
| ion-cyan-bright | `#57e6ff` | Screen highlights, brightest glow cores |
| ion-cyan | `#2bb8e6` | Primary screen tone, LED base |
| ion-blue | `#3d7bff` | Secondary glow, UI elements on screens |
| ion-indigo | `#6a5cff` | Deep glow transitions |
| ion-violet | `#9a4dff` | Plasma details, neon sign |
| ion-magenta-glow | `#c96bff` | Plasma globe filaments, rare accents |

### Status and paper

| Name | Hex | Use |
|---|---|---|
| status-green | `#3ecf6e` | Done/ok signals, waiting-bubble check |
| status-amber | `#ffb340` | Permission-bubble dots, warning lights |
| status-red | `#ff5252` | Error-bubble mark, alert LEDs |
| paper-white | `#f2f5fa` | Paper, bubble fill, mug ceramic |

### Organics and fabric

| Name | Hex | Use |
|---|---|---|
| leaf-dark | `#2e6b3a` | Plant shadow foliage |
| leaf-mid | `#4a9950` | Primary foliage |
| leaf-light | `#7cc46a` | Foliage highlight |
| fabric-blue | `#3e5a8c` | Sofa/chair upholstery |
| fabric-red | `#8c3e4a` | Accent cushions |
| metal-dark | `#4a505e` | Appliance bodies |
| metal-light | `#8b93a6` | Appliance highlights |
| soil-brown | `#4a3524` | Plant pots soil |
| terracotta | `#b06a45` | Plant pots |

## Continuity rules

1. **Light source: top-left.** Highlights on top and left faces, shadows on bottom and right. No exceptions across the set.
2. **Outlines: ink-outline (`#1a1d24`), never pure black.** Exterior silhouettes always outlined. Interior detail lines use the next-darker palette tone of the local material instead of the outline color where a softer read is needed.
3. **Dithering: low and consistent.** A single 2x2 checker dither is allowed for large-surface shading transitions (floors, walls, sofa cushions). No gradient fills. No dithering on objects smaller than 2x2 tiles.
4. **Tile alignment: 16 px grid.** Every asset's footprint is a whole number of tiles. Tall items may overdraw upward beyond their footprint (a bookshelf occupies 1x1 tiles but its image is 16x32); they never overdraw sideways or downward.
5. **Glow discipline.** Emissive pixels come only from the ion accent family or status colors. Glow is drawn as 1 px halo of the accent at reduced saturation, not as a blur.
6. **Department tinting is runtime, not baked.** Tintable assets (rugs, door trim, desk lamps, character clothing layers) are drawn in neutral slate tones; the renderer multiplies the department accent color over designated tint regions. Department accent colors come from the agent color resolution in `desktop/src/renderer/lib/agent-helpers.ts` (`getAgentColor` / `AGENT_COLORS`); they are not duplicated in this document or in pack data.
7. **No text in sprites** except the coffee-bar neon sign ("ION") and screen glyphs abstracted to bars/blocks. Real letterforms do not survive 16 px.

## Character specification

- Frame size: 16x16 px. The body occupies roughly 12 px height; head 6 px with 1 px outline; feet anchored 1 px above frame bottom.
- Proportions: 2-heads-tall chibi. Readable silhouette first; costume detail second.
- Animations ship as horizontal strip PNGs, one file per animation, frames left to right:

| Animation | Frames | File | Notes |
|---|---|---|---|
| idle | 1 | `idle.png` | Facing down |
| walk-down | 4 | `walk-down.png` | Contact, pass, contact, pass |
| walk-up | 4 | `walk-up.png` | |
| walk-right | 4 | `walk-right.png` | Left is runtime-mirrored |
| typing | 2 | `typing.png` | Seated at desk, hands alternate |
| reading | 2 | `reading.png` | Seated, page turn |
| stretch | 2 | `stretch.png` | Optional; falls back to idle |
| slump | 1 | `slump.png` | Optional; error posture, falls back to idle |

- Tinting: characters declaring `tintable: true` draw their primary clothing layer in slate-300/slate-400; the renderer tints that region with the department accent. Skin, hair, and outline are never tinted.
- Role silhouettes:
  - **manager**: blazer with visible lapels, upright posture, distinct hair shape. Reads as "in charge" at a glance.
  - **lead**: senior look; layered top (cardigan/vest), holds a tablet in idle.
  - **specialist**: six planned variants differing in hair silhouette, top style, and one personal accessory (headphones, glasses, cap, mug, lanyard, hoodie-up).

### Character roster (designed now; produced across two passes)

| Id | Roles | Pass | Expected look |
|---|---|---|---|
| `mgr-blazer` | manager | 1* | Navy-slate blazer, confident stance, short combed hair |
| `lead-cardigan` | lead, specialist | 2 | Warm cardigan over shirt, tablet in hand |
| `spec-headphones` | specialist | 2 | Over-ear headphones, hoodie |
| `spec-glasses` | specialist | 2 | Round glasses, tucked shirt |
| `spec-cap` | specialist | 2 | Backwards cap, tee |
| `spec-mug` | specialist | 2 | Carries a paper-white mug in idle |
| `spec-lanyard` | specialist | 2 | Badge lanyard, rolled sleeves |
| `spec-hoodie` | specialist | 2 | Hood up, relaxed slouch |

*Pass 1 ships a single tintable character with `roles: ["manager", "lead", "specialist"]` so every seat can be cast from one sheet, differentiated by accent tinting, until the full roster lands. The Pass 1 character uses the `mgr-blazer` look.

## Pets

| Id | Pass | Behavior | Expected look |
|---|---|---|---|
| `volt-cat` | 1 | wander | Small cat in ion-cyan/graphite tones, glowing cyan eyes, tail tip glows |
| `robo-vac` | 2 | wander | Flat round vacuum robot, single ion-blue status LED, subtle motion lines |

Pet animations: `idle` (1), `walk-down` / `walk-up` / `walk-right` (2 frames each, left mirrored).

## Furniture inventory

Category values: `work`, `mail`, `relax`, `manager`, `decor`. Footprints in tiles; image height may exceed footprint height for tall items (anchor: bottom-left). Rotation schemes: `none` (one orientation), `2-way` (`front` + `side` variants), `3-way-mirror` (`down`, `up`, `right`; left mirrored).

### Work zone

| Id | Footprint | Rotation | States/frames | Pass | Expected look |
|---|---|---|---|---|---|
| `desk` | 2x1 | 2-way | - | 1 | Birch top, graphite legs, cable notch |
| `standing-desk` | 2x1 | 2-way | - | 2 | Taller silhouette, visible lift column |
| `pc` | 1x1 (on surface) | none | on/off | 1 | Monitor with ion-cyan screen when on, dark when off |
| `dual-monitor` | 2x1 (on surface) | none | on/off | 2 | Two angled ion-cyan screens |
| `chair-ergo` | 1x1 | 3-way-mirror | - | 1 | Graphite frame, fabric-blue seat, headrest |
| `chair-wood` | 1x1 | 3-way-mirror | - | 2 | Simple birch chair |
| `server-rack` | 1x1 (tall, 16x32) | none | 2 frames animated | 1 | Graphite cabinet, blinking ion-blue LED column |
| `whiteboard` | 2x1 wall | none | - | 1 | Paper-white board, abstract ion-blue diagram marks |
| `kanban-board` | 2x1 wall | none | - | 2 | Three columns of tiny colored cards |
| `bookshelf` | 1x1 (tall, 16x32) | none | - | 2 | Birch shelf, book spines in muted palette tones |

### Mail zone

| Id | Footprint | Rotation | States/frames | Pass | Expected look |
|---|---|---|---|---|---|
| `mail-station` | 2x1 (tall, 32x32) | none | - | 1 | Pigeonhole grid, paper-white envelopes visible |
| `package-stack` | 1x1 | none | - | 2 | Two stacked parcels, birch-pale tape |
| `outbox-desk` | 2x1 | 2-way | - | 2 | Desk with tray of outgoing envelopes |
| `notice-board` | 2x1 wall | none | - | 2 | Cork tone with pinned notes |

### Relax zone

| Id | Footprint | Rotation | States/frames | Pass | Expected look |
|---|---|---|---|---|---|
| `sofa` | 2x1 | 3-way-mirror | - | 1 | Fabric-blue two-seater, two seat tiles |
| `coffee-bar` | 2x1 (tall, 32x32) | none | 2 frames animated | 2 | Counter with machine, steam wisp, violet neon "ION" sign |
| `espresso-machine` | 1x1 (on surface) | none | 2 frames animated | 2 | Chrome body, drip animation |
| `coffee-table` | 1x1 | none | - | 2 | Low birch table, two mugs |
| `small-table` | 1x1 | none | - | 2 | Round cafe table |
| `bench` | 2x1 | 3-way-mirror | - | 2 | Cushioned bench, fabric-red cushions |
| `arcade-cabinet` | 1x1 (tall, 16x32) | none | 2 frames animated | 2 | Graphite cabinet, animated ion screen |
| `water-cooler` | 1x1 (tall, 16x24) | none | - | 2 | Blue bottle, paper cups |
| `snack-shelf` | 1x1 (tall, 16x32) | none | - | 2 | Shelf with colorful snack boxes |

### Manager's office

| Id | Footprint | Rotation | States/frames | Pass | Expected look |
|---|---|---|---|---|---|
| `exec-desk` | 3x1 | 2-way | - | 1 | Wide dark-birch desk, leather inlay, name plate |
| `exec-chair` | 1x1 | 3-way-mirror | - | 2 | High-back graphite chair |
| `large-painting` | 2x1 wall | none | - | 2 | Abstract ion-gradient artwork, birch frame |
| `plasma-globe` | 1x1 (on surface) | none | 2 frames animated | 2 | Glass sphere, ion-magenta filaments |
| `trophy-shelf` | 2x1 wall | none | - | 2 | Small trophies and framed awards |

### Decor

| Id | Footprint | Rotation | States/frames | Pass | Expected look |
|---|---|---|---|---|---|
| `plant-small` | 1x1 | none | - | 1 | Terracotta pot, three-leaf sprout |
| `plant-large` | 1x1 (tall, 16x32) | none | - | 2 | Floor plant, layered foliage |
| `plant-hanging` | 1x1 wall | none | - | 2 | Wall-mounted trailing plant |
| `wall-clock` | 1x1 wall | none | 2 frames animated | 2 | Round clock, ticking second hand |
| `painting-a` | 1x1 wall | none | - | 2 | Small abstract piece, cyan family |
| `painting-b` | 1x1 wall | none | - | 2 | Small abstract piece, violet family |
| `floor-lamp` | 1x1 (tall, 16x32) | none | on/off | 2 | Slim graphite pole, warm glow when on |
| `bin` | 1x1 | none | - | 2 | Slate waste bin, crumpled paper |

## Floors

Single 16x16 tiles. Tintable floors are drawn in neutral slate and tinted at runtime with the department accent.

| Id | Pass | Tintable | Expected look |
|---|---|---|---|
| `plank-birch` | 1 | no | Warm birch planks, subtle grain |
| `carpet-neutral` | 1 | yes | Low-pile carpet, slate weave texture |
| `plank-dark` | 2 | no | Wainscot-brown planks |
| `tile-slate` | 2 | no | Cool slate tiles with grout lines |
| `concrete` | 2 | no | Smooth graphite concrete, hairline cracks |

The proposal's department-tinted carpet variants are realized at runtime by tinting `carpet-neutral`; no per-department carpet PNGs exist.

## Walls

Auto-tiling sets: one horizontal strip of 16 tiles (256x16 px), indexed by 4-bit adjacency mask (bit 1 = wall to the north, 2 = east, 4 = south, 8 = west). Wall tiles are 16x16 and drawn with interior-facing trim.

| Id | Pass | Expected look |
|---|---|---|
| `graphite-panel` | 1 | Graphite-700 panels, thin ion-blue trim line at two-thirds height |
| `plaster-wainscot` | 2 | Warm plaster upper, birch wainscot lower |

Door trim on department rooms is a 1 px tint region on the doorway tiles, tinted with the department accent at runtime.

## Speech bubbles

16x16 px, paper-white fill, ink outline, tail bottom-left. Each is one PNG.

| Id | Pass | Content |
|---|---|---|
| `waiting` | 1 | status-green checkmark |
| `permission` | 1 | Three status-amber dots |
| `error` | 1 | status-red exclamation mark |
| `dispatch` | 1 | Small envelope, birch-pale with graphite fold lines |

## Room dressing

Which assets belong to which zone type, and placement rules, are specified in [room-dressing-guide.md](room-dressing-guide.md). Dressing templates ship as data inside the theme pack (`dressing/*.json`), following that guide.

## Production notes

- Master art is produced at high resolution and downscaled to final frame dimensions with nearest-neighbor sampling, then quantized to the master palette. Final committed PNGs contain only palette colors plus transparency.
- Every asset is validated against its manifest dimensions at pack load; a mismatch is a skipped asset and a logged error, so dimension discipline here is a hard contract.
- A continuity pass over the assembled sheet (all assets side by side) is required before any pack update is committed: check light direction, outline weight, palette compliance, and relative scale.
