# ATV Room Dressing Guide

How the procedural office generator furnishes rooms. This guide defines the zone types, what belongs in each, and the placement rules that make generated rooms look intentional. Dressing templates ship as data in the theme pack (`dressing/*.json`, schema in [theme-pack-format.md](theme-pack-format.md)); this document is the design rationale those templates encode.

## Zone types

| Zone | Created for | Occupants |
|---|---|---|
| `department` | Each lead that has dispatched specialists | The lead plus its specialists |
| `manager` | Always exactly one | The orchestrator's manager character |
| `mail` | Always exactly one | Unstaffed; dispatch-envelope flavor |
| `break` | Always exactly one | Done/resting characters, overflow hot desks, pets |
| `meeting` | One; two for large orgs | Agents convened via `atv-meeting` metadata |
| `lobby` | Always exactly one (the arrivals room) | Newly appearing agents walk in from here |
| `corridor` | The connective spine | Walkers in transit only — characters never stop or loiter on corridor tiles, and the corridor floor must differ from every room floor so hallways read as hallways |

## Placement rules (apply to every zone)

1. **Walkability is never sacrificed.** Every seat, door, and interactive tile must remain reachable after dressing. The generator re-validates reachability after placement; a dressing choice that blocks a path is discarded and re-rolled.
2. **Furniture backs to walls.** Tall items (shelves, racks, lamps) and wall-mounted items prefer wall-adjacent tiles. Free-standing decor may sit inside the room body only if the room has spare area.
3. **Desks cluster; decor scatters.** Work desks form aligned clusters (same orientation, one tile of aisle between rows). Decor uses seeded scatter with a minimum spacing of one tile from other decor.
4. **One accent per room.** The department accent tints the room's carpet region, door trim, and one desk lamp equivalent. Accents never tint structural walls or shared corridor floor.
5. **Density scales with room size.** Small rooms get required items only; larger rooms add optional items up to the template's density cap so big rooms do not feel empty.

## Zone compositions

### Department room

- Required: one head desk for the lead (desk + chair + pc, distinct position, facing the room), one desk cluster sized to the specialist count (desk + chair + pc per seat), one whiteboard or kanban wall item.
- Optional weighted: server-rack, bookshelf, plant-small/plant-large, bin, wall clock, paintings.
- Carpet: tintable carpet region under the desk cluster, tinted with the department accent.
- The head desk faces the cluster so the lead "oversees" the team.

### Manager's office

- Required: exec-desk + exec-chair (or best available chair) + pc, centered on the back wall, facing the door.
- Optional weighted: large-painting, trophy-shelf, plasma-globe (on desk), plant-large, floor-lamp.
- Sized generously relative to occupancy: one occupant, executive floor area.

### Mail room

- Required: mail-station against a wall, one outbox-desk or package-stack.
- Optional: notice-board, bin, plant-small.
- Positioned adjacent to the corridor near the manager's office: dispatch envelopes flow from here in the visualization's fiction.

### Break room

- Required: sofa (or bench) with reachable seat tiles, coffee source (coffee-bar or espresso-machine on small-table), water-cooler when available.
- Optional weighted: arcade-cabinet, snack-shelf, coffee-table, plants, paintings.
- Hot desks: when the roster outgrows department seating, the generator places overflow desk+chair pairs here first, then in corridor alcoves.

### Corridor

- Kept clear by default. Optional sparse decor (plant-small, notice-board on walls, bin) at low density, never narrowing the walkable width below two tiles.

## Template weighting model

Each `dressing/<zone>.json` template lists:

- `required`: items (by id or category) that must place, with per-seat multipliers where applicable. A required item that cannot place (room too small) triggers a room-size retry at generation time, not a silent omission.
- `optional`: weighted entries (by id or category) with per-room maximums. The generator draws from this pool with the seeded PRNG until the density cap is reached.
- `density`: fraction of free floor tiles that optional items may occupy (0 to 1).

Because templates are pack data, a theme can restyle not just sprites but how rooms are furnished. The generator core (partitioning, reachability, seat assignment) is theme-agnostic and never hardcodes item ids.
