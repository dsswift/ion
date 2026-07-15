# ATV Agent Frontmatter Vocabulary

Agents can declare their Agent Team Visualizer presence directly in their `.md` frontmatter. The engine preserves every unrecognized frontmatter key in the discovered agent's metadata map; a harness that publishes agent state forwards the `atv-*` subset (plus `parentAgent`) onto its agent-state metadata, and the ATV interprets them. The engine itself has no opinion on any of these keys.

## Resolution cascade

Each layer degrades gracefully to the next; publishing nothing still yields a working office.

1. **`atv-*` keys** — explicit per-agent declarations (this vocabulary).
2. **`parentAgent` metadata** — automatic org structure: parents of individual contributors head department rooms with a corner office; agents whose direct reports are all themselves parents (chiefs over leads) are detected as executives when no `atv-seat` says otherwise. Publishers should fall back to the static frontmatter `parent` when no runtime dispatch chain exists — idle rosters carry the org chart too.
3. **Dispatch attribution** — `dispatchParentId` walking, for rosters that publish no org metadata.
4. **Nothing** — guest: a hot desk in the remote-work office, or a couch and a laptop.

## Keys

| Key | Value | Effect |
|---|---|---|
| `atv-office` | office id (string) | Agents sharing the id share one department room. The room's lead is the member the others name as `parentAgent`, else the first member by name. |
| `atv-seat` | `executive` \| `private-office` | `executive` seats the agent in the executive wing — a dedicated hallway holding the CEO's (orchestrator's) office and every executive office. This is the source of truth for wing membership: top-level rank alone does not qualify. It also OVERRIDES the corner office: an executive who leads a team of specialists still gets their department room, but without the corner pocket — their desk is the wing office. `private-office` gives a private staff office on a normal hallway and opts a structurally-detected chief OUT of the wing. Other seat classes are implied by structure: leads get the corner office inside their department room; ICs get cluster desks; unknown agents get hot desks. |
| `atv-wing` | wing name (string) | Named hallway wing: offices sharing a wing name generate on their OWN dedicated hallway (e.g. a `consultants` wing of private offices, or a department wing). A lead's wing pulls its whole department room onto that hallway. `atv-seat: executive` implies wing `executive`, so the executive wing needs no separate key. |
| `atv-visible` | `always` \| `never` | `never` removes the agent from the office entirely — the operator's override on top of whatever the harness publishes. `always` is a publisher contract: include the agent in every agent-state publication even while idle, so its desk and character are present from the first frame (the ion-dev control room publishes the full static roster this way by default). |
| `atv-character` | character id from the active theme pack | Pins the agent to a specific character sheet so it always has the same face. Falls back to seeded casting when the active pack has no such character. |
| `atv-color` | `#rrggbb` | Accent override for the agent's tinting (clothing layer, and the department accent when the agent leads a room). |
| `atv-meeting` | meeting id (string) | Runtime metadata (not frontmatter): rows sharing a non-empty id convene in a meeting room while the id is set; clearing it sends attendees back to work. Published per agent-state row by the harness when it runs a meeting. |

All keys are optional and independent. Values are plain strings (frontmatter scalars).

## Example

```yaml
---
name: dev-lead
description: Development department lead
parent: chief-of-innovation
atv-office: development
atv-character: lead-cardigan
atv-color: "#8c5ac8"
---
```

## Publisher contract (harness side)

A harness that wants its roster visualized publishes, per agent-state row:

- `parentAgent` — the parent agent's name (org structure), when known.
- Every `atv-*` frontmatter key, copied verbatim into the row's metadata.
- The full known roster (idle agents included) — the office allocates a dedicated workstation for every published agent at session start. Idle rows with `visibility: ephemeral` remain hidden in list-style consumers that filter by visibility, so publishing the full roster does not clutter other surfaces.
