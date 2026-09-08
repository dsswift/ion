---
title: Profile Configuration
description: How to define and use engine profiles in settings.json.
sidebar_position: 4
---

# Profile Configuration

Profiles let you define named sets of engine configuration -- extension directories and display names -- and switch between them. Profiles are stored in `~/.ion/settings.json`, separate from `engine.json`.

## File location

`~/.ion/settings.json`

## Structure

```json
{
  "engineProfiles": [
    {
      "id": "default",
      "name": "Default",
      "extensions": ["~/.ion/extensions/default"]
    }
  ]
}
```

The engine reads the `engineProfiles` array (with `harnessProfiles` as a legacy fallback).

## Profile fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier for the profile. Used for programmatic lookups. |
| `name` | string | Yes | Display name. Also used for lookup -- you can reference a profile by either `id` or `name`. |
| `extensions` | string[] | Yes | Paths to extension directories for this profile. Tilde (`~`) is expanded to the user's home directory. |

## How profiles are resolved

When a client starts a session, it can specify a profile by name or ID. The engine calls `FindProfile()`, which searches the `engineProfiles` array and returns the first match on either `name` or `id`.

If no profile is specified, behavior depends on the client. The desktop app typically selects a default profile on the user's behalf.

## Multiple profiles

Define multiple profiles to switch between different extension sets:

```json
{
  "engineProfiles": [
    {
      "id": "coding",
      "name": "Coding",
      "extensions": ["~/.ion/extensions/coding"]
    },
    {
      "id": "research",
      "name": "Research",
      "extensions": [
        "~/.ion/extensions/coding",
        "~/.ion/extensions/research-tools"
      ]
    },
    {
      "id": "minimal",
      "name": "Minimal",
      "extensions": []
    }
  ]
}
```

Model selection is handled by the `model_select` hook or per-prompt overrides, not by the profile.

## Desktop power-user overrides

The `desktop` key in `settings.json` holds desktop-harness-specific overrides. These keys are **not** exposed in the renderer Settings UI — they are power-user escape hatches for advanced scenarios. Edit `~/.ion/settings.json` directly.

**Posture**: settings.json only, no renderer UI. Per [ADR-004](../architecture/adr/004-enter-plan-mode-prose-in-harness.md)'s "Future considerations" section: "doing so would commit Ion to a UX register (multi-line editable text with placeholder validation, 'reset to default' affordance, cross-platform iOS textarea parity) it has not designed for."

### Plan mode framing overrides

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `desktop.planModePrompt` | string | `PLAN_MODE_PROMPT` constant in `prompt-pipeline.ts` | Full system prompt injected at the start of each plan-mode run. Replaces the desktop's reference prose verbatim. Empty or absent uses the desktop default. |
| `desktop.planModeSparseReminder` | string | `PLAN_MODE_SPARSE_REMINDER` constant in `prompt-pipeline.ts` | Per-turn sparse reminder injected every `planModeReminderInterval` turns during plan-mode runs. Replaces the desktop's reference text verbatim. Empty or absent uses the desktop default. |

Both keys follow the same precedence as their wire-contract counterparts (`RunOptions.PlanModePrompt` and `RunOptions.PlanModeSparseReminder`): harness-supplied value > engine default. The desktop reads these keys at session start and passes the non-empty values through on every `send_prompt` dispatch.

**Example**: Suppress the plan-mode prose entirely for a minimal planning workflow:

```json
{
  "engineProfiles": [...],
  "desktop": {
    "planModePrompt": "You are in planning mode. Write a plan to the plan file, then call ExitPlanMode.",
    "planModeSparseReminder": "Plan mode active. End with ExitPlanMode or AskUserQuestion."
  }
}
```

Cross-reference:
- [ADR-004](../architecture/adr/004-enter-plan-mode-prose-in-harness.md) — the policy/mechanism boundary that motivates these knobs
- [Plan mode prose overrides](../sessions/lifecycle.md#plan-mode-prose-overrides) — the three-layer precedence (RunOptions → hook → engine default)
- [client-commands.md#send_prompt](../protocol/client-commands.md#send_prompt) — the wire fields these settings populate

## Desktop browser preview shield

Ion Desktop stores `browserPreviewNetworkShield` in `~/.ion/settings.json`. It defaults to `true`.

When enabled, a local document opened in the Studio Browser Surface cannot load network resources until the user allows them from that preview. This setting sets the default. It does not override an explicit per-preview decision.

```json
{
  "browserPreviewNetworkShield": true
}
```

See [ADR-030](../architecture/adr/030-embedded-browser-surface.md) for browser session modes and partition ownership.

## Desktop browser tools

Ion Desktop stores `studioPlaywrightEnabled` in `~/.ion/settings.json`. It
defaults to `true`. A missing or malformed value reads as `true`, so a damaged
settings file does not remove a feature.

When enabled, and when Ion Studio is the active interface, agents can drive the
Chromium tab in their conversation's Studio Surface panel. Each conversation
exposes exactly one Agent-linked browser tab.

```json
{
  "studioPlaywrightEnabled": true
}
```

Turning this off withdraws the tools only. Browser tabs, sessions, logins,
device emulation, and recorded diagnostics are left as they are, and a later
change re-advertises the tools without restarting any conversation.

Diagnostic limits (retained request count, body size, output caps) are
implementation constants rather than settings. They exist to bound
main-process memory, not to express an operator preference.

## Graph View

Graph View configuration lives under `desktop.graphView` in two scopes: the
operator's own `~/.ion/settings.json` (user scope, full field surface) and
`<projectPath>/.ion/settings.json` (project scope, a typed allowlist). There
is no dedicated `graph-view.json` — Ion configures the worktree, the desktop,
or the engine, and Graph View is desktop configuration.

```json
{
  "desktop": {
    "graphView": {
      "corpusRoots": [
        { "path": "~/orion", "label": "My Ops Repo" },
        { "path": "~/.orion/knowledge", "label": "Subscribed Knowledge" }
      ],
      "identityField": "id",
      "labelField": "title",
      "tagField": "tags",
      "groupFields": ["topic"],
      "edgeFields": ["relates", "supersedes", "superseded-by"],
      "hoverFields": ["status"],
      "curatedFields": [
        { "field": "status", "displayName": "Status", "order": 0 }
      ],
      "promotedFields": [
        { "field": "path", "depth": 2 },
        { "field": "orn", "split": { "separator": ":", "index": 3 } }
      ],
      "sectionNodes": false,
      "sectionTopicsField": "sections",
      "neighborhoodDepth": 1,
      "defaultView": "Ops Overview",
      "savedViews": []
    }
  }
}
```

Graph View is **enabled by default**. When the project scope does not set
`corpusRoots`, it defaults to the conversation's own project directory (its
active tab's working directory, worktree or otherwise) — no configuration is
required to get a working graph. Setting `corpusRoots` at project scope
replaces that automatic default for that project; user-scope roots (e.g.
subscribed knowledge bundles) always union in on top regardless. The only
case that stays unavailable — no Graph entry in the Studio "+" menu, no
Graph View IPC handler doing disk work — is a conversation with no real
project directory at all.

### Field reference

| Field | Type | Default | Description |
|-------|------|---------|--------------|
| `corpusRoots` | array | the conversation's project directory | Directories to scan for `.md` files. A bare string is accepted as shorthand for `{ path }`. A leading `~` is expanded. Roots are additive across scopes — never override-by-collision — except that setting this at project scope (even to `[]`) replaces the automatic project-directory default for that project. |
| `identityField` | string | `"id"` | Front-matter field read as a document's identity. Falls back to the document's absolute path when absent. |
| `labelField` | string | `"title"` | Front-matter field read as a document's label. Falls back to the filename when absent. |
| `tagField` | string | `"tags"` | Front-matter field holding a document's tags. Bound rather than hardcoded because corpora disagree (`tags`, `topics`, `keywords`). Drives the `nodes` tag treatment and is filterable by member value. |
| `groupFields` | string[] | `[]` | Front-matter fields whose values become shared group nodes. |
| `edgeFields` | string[] | `["relates", "supersedes", "superseded-by"]` | Front-matter fields read as references. Only `supersedes`/`superseded-by` are directed — direction is structural, not configurable. |
| `hoverFields` | string[] | `[]` | Fields shown in the hover quick-peek. Empty shows label, kind, and degree instead. |
| `curatedFields` | array | `[]` | Additive display polish for discovered fields: `{ field, displayName?, order?, hidden? }`. Never narrows what the corpus scan discovers. |
| `promotedFields` | array | `[]` | Note-descriptive properties the operator may draw as **anchor nodes** at view time. Each entry is `{ field, depth?, split? }` (a bare string is `{ field }`). `field` is a front-matter name or `path` for the document's directory relative to its corpus root. `depth` keeps that many leading `/`-separated segments of a hierarchical value. `split: { separator, index }` first divides the raw value and takes one segment (an ORN's scope, say). Promotion is off until turned on in the Filters panel's Layers section, and each anchor value must gather at least two documents and fewer than nine in ten of the documents carrying the property, or it is suppressed and reported. |
| `sectionNodes` | boolean | `false` | When true, `## Heading` sections become their own graph nodes. A view-time toggle seeded from this value: the operator can switch it in the Filters panel and a saved view carries it. A section's identity is its document, its heading text, and its ordinal among identical headings; it is derived at read time and never persisted. |
| `sectionTopicsField` | string | `"sections"` | The front-matter field carrying per-section topics: a list of `{ heading, ordinal?, ...fields }` mappings. When section nodes are on, a section whose entry declares a value of a group field (the tag field under the `nodes` treatment, or any `groupFields` entry) takes that value over from its document, so a container document's unrelated parts never fabricate a shared subject. An entry naming a heading the document lacks is counted in the log and ignored. |
| `neighborhoodDepth` | integer 1-5 | `1` | Default opening-scope hop count from the document open in the active editor. |
| `defaultView` | string | `""` | Name of the saved view applied when the corpus first loads. Empty applies none. A name matching no saved view is logged and ignored, never a load failure. |
| `savedViews` | array | `[]` | See "Saved views" below. |

### Resolution across scopes

- **Scalars** (`identityField`, `labelField`, `tagField`, `sectionNodes`, `sectionTopicsField`, `neighborhoodDepth`, `defaultView`): user scope wins when set, else project scope, else the default. The operator's own machine outranks a corpus that ships an opinion.
- **Lists** (`corpusRoots`, `groupFields`, `edgeFields`, `hoverFields`, `curatedFields`, `promotedFields`): user scope replaces the project list wholesale when set — lists are never element-merged.
- **`corpusRoots`** is the one field that is genuinely additive: project roots then user roots, de-duplicated by resolved absolute path, project order first. "Project roots" is the project's own configured `corpusRoots` when set, else the conversation's project directory by default.
- **`savedViews`** is a concatenation, never a merge — see below.

### Project scope is field-allowlisted

A project's `.ion/settings.json` may set **only** the fields named above under
`desktop.graphView` — the allowlist is `GRAPH_VIEW_PROJECT_FIELDS`
(`desktop/src/shared/graph-view-types.ts`). Any other key — a different
`desktop.*` preference, an unrecognized field under `graphView`, or any
top-level key outside `desktop` — is dropped and logged at DEBUG with its key
name. A corpus checked into version control can never set an operator's
unrelated desktop preferences, and cannot introduce a not-yet-allowlisted
`graphView` field just by naming it.

### Saved views

A saved view captures encoding bindings, active filters, tag treatment,
cluster rendering, the orphan and broken-link toggles, the section-node
toggle, the promoted anchor fields that are on, the force parameters, every
dragged node position, and the pinned node set. It does **not** capture
camera position — a view always loads into a fresh navigation state. Every
field past `filters` is optional: a view saved before a toggle existed
restores that toggle's "everything shown" or configured default, `forces`
absent means the built-in Lobes shape, and `pinned` absent clears the pins.
A pin or position for a node that no longer exists is dropped on load and
counted in the log.

`positions` and `pinned` never hold a provisional or derived identity: a
document keyed by its path (no identity field), a section, or a dangling
stub is dropped at save time and counted in the log, because the next read
may key the same thing differently.

```json
{
  "name": "Ops Overview",
  "bindings": {
    "nodeColor": { "dimension": { "source": "frontMatter", "field": "status" }, "valueType": "categorical" },
    "nodeShape": { "dimension": null, "valueType": "categorical" },
    "nodeSize": { "dimension": { "source": "structural", "metric": "degree" }, "valueType": "numeric" },
    "edgeColor": { "dimension": null, "valueType": "categorical" },
    "edgeThickness": { "dimension": null, "valueType": "categorical" },
    "edgeOpacity": { "dimension": null, "valueType": "categorical" }
  },
  "filters": [
    { "dimension": { "source": "mechanical", "property": "path" }, "mode": "include", "values": ["/repo/sections/"], "match": "prefix" }
  ],
  "tagTreatment": "off",
  "clusterRendering": "hull",
  "showOrphans": true,
  "showDangling": false,
  "sectionNodes": false,
  "promotedFields": ["path"],
  "forces": { "gravity": 0.05, "scalingRatio": 8, "edgeWeightInfluence": 1, "damping": 1 },
  "positions": {
    "alpha": { "x": 120.5, "y": -40.2 }
  },
  "pinned": ["alpha"]
}

A filter rule's `match` is `exact` (the default: whole-value equality, by
membership for a list-valued field) or `prefix` (the member starts with the
rule value, for "everything under this path"). An edge rule may read the
`origin` (`wikilink`, `markdown-link`, `front-matter`, `group`, `anchor`,
`section`) or `field` edge dimensions to tell a curated link from a
node-mediated tie.
```

A corpus points `defaultView` at one of these by name to choose what an
operator opens on. The name resolves against the concatenated list, so a
project or a user view can be the default; when both scopes hold that name
the project one wins, matching the concatenation order. A name matching
nothing is logged and skipped, because a corpus can ship a default whose
view a later edit renamed and a graph that refuses to open is worse than one
that opens unstyled.

Saved views from both scopes appear in one list, each labelled by source. A
project view and a user view with the same name both appear — neither
overrides the other. Rename and delete apply to user views only; a project
view's actions are absent from the menu, not disabled, because the desktop
never writes a project-scoped view. An operator who wants to ship a view
edits the corpus's `.ion/settings.json` directly, which is what version
control is for.

