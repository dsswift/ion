---
title: Graph View
description: Configurable, metadata-driven graph visualization of a Markdown corpus in Ion Studio.
---

# Graph View

Graph View is an Ion Studio surface that renders a Markdown corpus as a graph of documents and the relationships between them, driven entirely by the corpus's own YAML front matter and body links.

## 1. What it is for

A file tree shows containment only. It cannot show that two documents share a subject, that one supersedes another, or that a set of documents clusters around a topic. Those relationships live in front matter and in link text, not in directory structure. Graph View reads them and draws them.

No metadata vocabulary is hardcoded. Corpora disagree on field names (`id` vs `uid`, `topic` vs `area`), so fields are discovered at runtime and bound by the operator. Graph View owns the generic mechanism; the corpus owns the vocabulary.

The design baseline is **10,000 documents**, with 100,000 as the long-horizon target. Every structural decision below (rendering, layout persistence, level of detail, coarsening) exists to hold that range.

### Non-goals

- Rendering the corpus as prose. That is the Files/editor surface.
- Editing front matter from the graph. Graph View is read-only: a navigation and analysis tool, not an authoring surface.
- Engine or SDK involvement. Graph View touches no engine wire, no SDK, and no hook. It reads local Markdown files and renders them, like the Files surface.

## 2. Placement

Graph View is a Studio surface singleton (`desktop/src/renderer/studio/`), alongside `files` and `visualizer`: a first-class navigable surface, not a modal or a panel attached to another surface. It does not share a render stack with the `visualizer` surface, whose physics and draw loop are built for live agent activity rather than documents.

**iOS**: Graph View is Studio-only. A force-directed, multi-channel-encoded graph over thousands of nodes has no interaction model and no chrome space on a phone screen. iOS has no Graph View. A scoped-down mobile rendering (a single node's local neighborhood at fixed small N) would be a distinct surface with its own design, not a port of this one.

## 3. The corpus

### 3.1 Corpus index

The corpus index is the data layer. It scans every configured corpus root for `.md` files, parses each file's YAML front matter into a raw field bag, extracts body links (wikilinks `[[target]]` and `[[target|label]]`, and Markdown links `[label](target.md)`), and produces one flat node/edge table for the whole corpus.

The index has no opinion about field names. It emits the raw front-matter bag plus resolved link lists; every layer above it (identity, edges, encoding) reads that bag by configured field name, never a hardcoded one.

The index is **live**. Each root is watched, and a changed file re-parses and re-diffs only its own nodes and edges rather than the whole corpus, which is what keeps editing responsive at corpus scale.

**Live watching degrades visibly, never silently.** On a machine where the native watcher module is unavailable, the graph still opens from a correct cold scan, but the surface shows a persistent, non-blocking chrome notice that live updates are off — the graph is a point-in-time read rather than a live one. Degradation is tracked **per root**: when the module is present but one root's watch subscription fails or later errors, the corpus is `partial` — live for the other roots — and the same notice names how many roots are off and which ones. There is no code path where a stale graph looks indistinguishable from a live one.

### 3.2 Multiple roots

Graph View is **enabled by default, for every conversation**. Unlike almost every other Graph View setting, the primary root is not something the operator must configure to get a working graph: it follows the conversation's own project directory. Open a conversation in `cloudops` and the primary root is `cloudops`; open one in a worktree and the primary root is that worktree's directory. There is no opt-in step. The effective corpus is the union of:

- **The primary root**: the working directory of the conversation's active tab. Resolved automatically — no configuration required — unless the project's own `.ion/settings.json` sets `desktop.graphView.corpusRoots`, in which case that explicit list replaces the automatic default for that project.
- **Zero or more additional roots**: local directories the operator configures in `~/.ion/settings.json` to join every project's graph. They use the same front-matter vocabulary and link conventions as the primary root, so cross-root identity and link resolution stay uniform.
- **Any additional roots** the operator adds for their own reasons (another repository they maintain, a second corpus), in either scope.

Roots are configured as an array. The full `desktop.graphView` block also
carries identity/label/group/edge/hover field bindings, curated field
metadata, saved views, section-node and neighborhood-depth settings — see
[settings.json § Graph View](../configuration/settings-json.md#graph-view) for
the complete field reference. A project that wants to override the automatic
primary root — to point at a subdirectory, or at an entirely different
corpus — sets its own `corpusRoots`:

```json
{
  "desktop": {
    "graphView": {
      "corpusRoots": [
        { "path": "~/notes", "label": "Personal Notes" },
        { "path": "~/reference", "label": "Reference Corpus" }
      ]
    }
  }
}
```

Roots are **additive, never override-by-collision**. Two roots are simply two directories contributing nodes to one graph; they do not compete for an identity the way a theme pack id does, so there is no winner to resolve. The one exception is the automatic primary root itself: a project that sets its own `corpusRoots` opts out of the automatic default for that project's contribution, rather than adding to it.

**An empty or missing root is silently ignored.** A root that resolves to a directory with no `.md` files contributes nothing: no warning, no error state, no broken-link noise.

**Roots are live while Graph View is open.** Changes beneath a configured root are handled by the ordinary file-watch path: a new subdirectory is incrementally indexed like any other change, and a disappearing one removes its nodes and edges like a deleted file. No polling is needed.

**Cross-root identity and edges are not a special case.** Identity resolves by the configured identity field's value, which is unique across the organization by convention, never by which root a file lives under. An edge from a primary-root document to a bundle-root document is exactly as valid as one between two primary-root documents.

**Root is an encoding and filter dimension.** "Which root did this node come from" is a structural attribute available without any front matter, so an operator can color or shape nodes by root to separate their own writing from subscribed org knowledge at a glance.

**Every root is read-only.** Graph View is read-only by design regardless of root.

## 4. Node identity and labels

- **Identity**: a configured front-matter field (default `id`). A document lacking the field falls back to its **path** as identity. A document is never dropped, and never merged with an unrelated document of the same title.
- **Label**: a separately configured field (default `title`), resolved independently of identity, falling back to the filename when absent.
- Identity resolution is **corpus-wide, not per-root**: the same field and the same fallback apply uniformly across every root.
- **Identity collisions are surfaced, never merged.** Two documents claiming the same identity value is a corpus defect the graph shows rather than silently resolves: the first document in scan order keeps the identity, every later claimant falls back to its own path, and the collision is recorded and exposed through a canvas-chrome badge — the same "guaranteed discoverability without permanent real estate" pattern as broken links (§ 5).

## 5. Edges

Edges come from body wikilinks, body Markdown links, front-matter reference fields, and the front-matter supersession fields:

| Source | Directed? | Resolution |
|---|---|---|
| Body wikilinks `[[target]]` | No | Target resolved against identity field, then path, then unambiguous filename |
| Body Markdown links `[label](path.md)` | No | Resolved by path, relative to the linking document's directory |
| Front-matter reference fields (`edgeFields`, e.g. `relates`) | No | Same resolution as wikilinks; a quoted wikilink form (`"[[alpha]]"`) has its brackets stripped |
| Front-matter `supersedes` / `superseded-by` | **Yes** | Carries both a link and the target's identity; identity resolves first, link text is the fallback |

Every field named in `edgeFields` produces an edge the same way; `supersedes`
and `superseded-by` are singled out only for direction. A corpus that adds a
custom field to `edgeFields` gets an undirected edge from it — direction is
never configurable, because it is structural rather than a data-driven
encoding.

**Supersession renders distinctly**: directed arrowhead, with a color and line style separating it from association edges (relates, wikilinks, Markdown links), which render undirected. This distinction is fixed rather than configurable, because it is structural (directed vs. undirected) rather than a data-driven encoding.

### Dangling edges

An edge whose target does not resolve is **never silently dropped**. Hiding unresolved links is the specific failure mode this design rejects: a corpus's broken references are exactly the thing an operator opens the graph to find.

- An unresolved target renders as a **dimmed, dashed stub node** at the edge's destination: muted fill, dashed border, broken-link glyph, spatially anchored so the document holding the bad reference is unambiguous.
- A **badge in the canvas chrome** ("N broken links") gives guaranteed discoverability without permanent real estate. Clicking it opens an ephemeral popover listing every dangling edge with a jump-to-source link. There is no docked panel.

## 6. Encoding channels

### Independent channels, not modes

**Color, shape, and size are three independent channels**, each bindable to any available dimension. There is no single "encoding mode" switch. An operator sees three simultaneous facts per node (for example color by type, shape by status, size by connection count), each independently rebindable. A fixed mode always misses someone's fourth dimension, and hardcoding which dimensions matter would put a corpus's opinion into the mechanism.

Edges get the same three-channel model (thickness, opacity, color), bindable to:

- **Link multiplicity**: count of distinct link instances between the same two documents.
- **Edge recency**: how recently the link was authored or last seen.
- **Corpus rarity**: inverse frequency of the edge's source field across the corpus, so a rare custom relationship field stands out against ubiquitous `relates` edges.
- **Tag/topic overlap**: degree of shared facet between the two connected documents, where that metadata exists.
- **Cross-root**: whether the edge spans two roots. A boolean rather than a magnitude, so it binds naturally to color or line style rather than thickness, and answers "how much does my own work actually connect to shared org knowledge" without cross-referencing node color per edge.

### Available dimensions

The bindable list is corpus-derived and live: the index enumerates every front-matter field name it has seen, so the binding UI never offers a hardcoded set. Two families are always available regardless of metadata:

- **Structural**, computed from the graph itself: degree, cluster membership, centrality/hub rank, orphan status.
- **Document-mechanical**, available with zero metadata: path, root, file size, modification time.

A corpus may **curate** the discovered list (friendly display names, explicit ordering, exclusion of noisy fields) without narrowing what the scan discovers. Curation is additive polish, not a gate.

### Value types

Each binding's value type is auto-detected with a manual override: numeric renders as a color gradient or size scale, string as a categorical palette, date-shaped as a sequential scale. The override exists because detection is a heuristic (a numeric-looking string the operator wants treated categorically), and the resolved type is stored with the binding rather than re-inferred on every render.

### Missing values

**A missing value always renders as a distinct unknown.** There is no "don't apply this channel" toggle. Every channel has some default appearance, so a channel that opts out would draw a missing-data node identically to a present-data node whose value happens to equal that default. That is the one thing an analytical view must never do. Each channel has an unambiguous unknown treatment instead: a fixed neutral gray for color, a fixed dot for shape, a fixed small size.

An operator who wants those documents gone uses a filter. A filter removes a node; an encoding channel never approximates absence as a value.

## 7. Structural analytics

Structural metrics are exposed through the same channel mechanism as everything else, not as a separate subsystem.

- **Centrality/hub ranking** is an encoding dimension bindable to size or color, not a separate ranked-list UI.
- **Orphan (zero-edge) detection** is a structural dimension available for both filtering and encoding. Orphans draw smaller and fainter than linked documents, and the filter panel's **Show orphans** toggle withholds them outright; the toggle travels with a saved view.
- **Cluster/community detection** has three operator-selectable renderings:
  1. **Hull** (default): a padded, rounded convex-hull region per cluster, tinted with the cluster's categorical colour. A hull too sparse to be a region (area per member far above the median) is not drawn. Reads best when the layout has separated clusters spatially.
  2. **Border-tint**: a colored ring per node, no filled region. For dense corpora where overlapping hulls at several thousand nodes turn muddy.
  3. **Off**: rely on layout-driven spatial clustering alone.

## 8. Filtering

A filter panel independent of the encoding channels: encoding controls *how* a visible node looks, filtering controls *whether* it is visible at all.

Filters work in both directions on the same controls, not as two modes: **exclusionary** ("hide everything of type X") and **inclusionary** ("show only documents tagged Y"). Filterable axes are document type, tag/topic, date range, orphan/degree, root, and any discovered front-matter field. A rule matches a whole value by default, or a **prefix** of it, which is how "everything under `sections/staff/`" is said against a path whose every value is unique.

Three visibility facts sit beside the rule list, so a rule edit can never reveal them by accident: **Show orphans**, **Show broken links** (the dangling stubs; the badge reports them either way), and the nodes the operator **hid one at a time** from the context menu or with `H`, restored together.

**A list-valued field matches on membership.** A `tags:` block is a list, so a rule hits when any member equals any rule value; a scalar field is treated as a one-member list, so both share a single comparison. Comparing the joined list against a rule value would make the inclusionary example above impossible for every document carrying more than one tag, which is most of them.

The same expansion governs encoding: a categorical channel bound to a list-valued field builds its domain from the member values, not from the joined array, and a node draws from its first member. A domain keyed on the joined array would enumerate co-occurrence combinations rather than the corpus's real values, so two documents sharing a topic would share an appearance only when their entire tag sets matched.

### Tags

Tags have three operator-selected treatments. The field they read is `tagField` (default `tags`), configured like identity and label rather than hardcoded:

1. **Off**: no tag involvement in the graph at all. The tag field is withheld from the binding and filter catalogs, so it cannot be encoded or filtered on. Without that withholding, `off` and `filter` would be the same setting under two names.
2. **Nodes**: each distinct tag value is its own graph node, with documents edging into it. Implemented by folding `tagField` into `groupFields` for that build, reusing the group mechanism rather than a second grouping path.
3. **Filter** (default): tags are filterable and bindable but never render as nodes. This needs no model change, because filtering and encoding read front matter directly. It is the default because a corpus's tag count routinely dwarfs its document count, so tag nodes are an opt-in structural choice rather than a starting point.

## 9. Layout and navigation

- **Opening scope**: the local neighborhood centered on the document the operator most recently had open in the editor, not the whole corpus. Opening onto an unreadable full-corpus force layout is the default worth avoiding; the operator expands outward from there. With no such document, or one absent from the corpus, scope falls back to the whole corpus.

  The anchor is the **last file tab activated**, recorded when it is activated, rather than whichever tab is active when the graph opens. In the Studio surface the graph and the editor are tabs in one strip, so opening the graph *makes the graph active*: reading the active tab asks "is the graph a file", always answers no, and silently opens every graph on the whole corpus. Recording on activation is what makes this scope reachable at all. The anchor is per conversation, memory-only, and forgotten when the last tab showing that file closes.
- **Layout**: a force-directed seed computed once, off the main thread, then a **warm simulation** that pauses when settled and wakes when disturbed. A run stops when the graph **converges** — mean per-tick movement, normalized by the graph's own extent, stays below a threshold for a run of ticks — not on a stopwatch; a short minimum and a long backstop exist only as guards, and the stop reason, the free-node count, and where the run's time went (worker versus main-thread write-back, per round trip) are logged. The simulation never reseeds and never replays a budget.
- **Forces**: the layout's parameters — centre force, repel force, link force, damping — are sliders in a Forces panel, with two presets: **Lobes** (the default: communities as separate lobes with branches and peninsulas) and **Compact** (a round, centre-pulled arrangement). A change reaches the warm simulation without a restart, and forces travel with a saved view so a corpus can ship its shape.
- **Drag**: the grabbed node is held at the cursor and the simulation wakes **for its neighbourhood only** — the nodes within two hops — so its neighbours are pulled by the real link forces and whatever is in the way is pushed aside by real repulsion, while everything outside that neighbourhood is held. On release the node stays where the hand left it (it rejoins the simulation unless pinned) and only that neighbourhood, plus what the node now touches, settles. The confinement is known by construction: an earlier design let the whole graph move during the drag and inferred the settle set from displacement, which freed every node on every drop. Every settled position **persists with the saved view it belongs to** — a session with no saved view relayouts on its next open.
- **Layer toggles** that add nodes (topic nodes, anchors, sections) place the additions beside their neighbours and run the simulation confined to them, so the arrangement the operator has is not re-laid out around a few new nodes.
- **Pins**: a node can be pinned in place from the inspector. A pinned node is left where it is by the simulation, stays put when released from a drag, and holds its ground through the first layout's overlap relaxation. Pins travel with a saved view.
- **Camera**: zoom is bounded at both ends so an unbounded wheel can never lose the operator, and every scope change re-frames the viewport on what is now visible. A **Fit** control frames the visible set (or the whole corpus in corpus scope). A search hit is brought into view, not merely selected.
- **Minimap**: a small overview in the stage's corner draws every visible node and the current viewport; clicking it centres the camera there. It is present only while the viewport shows less than the whole graph.
- **Search**: a search box jumps directly to a node by title, identity, or path and moves the camera to it. Full-corpus force layouts are not reliably scannable by eye at scale, so visual browsing is never the only way to find a document.
- **Local graph controls**: a neighborhood's depth is a stepper in both directions (one to five hops), and its links can be followed **out** (what these documents link to), **in** (what links to them), or both. Direction reads every edge's stored source and target, so it is meaningful on a wikilink as much as on a supersession.

### Session lifetime

A graph session is **parked, not destroyed, when the operator navigates away**. Switching conversations holds the whole live state in memory (model, settled layout, camera, selection, filters, bindings, pins) and returning resumes it exactly, with no rescan and no layout replay. Rebuilding on every switch is what made a graph replay its opening animation each time it was looked at.

A session is keyed by **directory, not by conversation**, because a graph is a picture of a directory's files. Two conversations open on the same checkout share one session and see the same graph; a worktree is a different path and gets its own, which is correct since its files genuinely differ. This mirrors the main process, where the corpus index already caches one scan and one watcher per root path with reference counting.

The park is **memory-only and window-local by design**. Nothing is written to disk: a parked session holds a live graphology instance and a settled force layout, derived state whose only value is that recomputing it is expensive. A window reload or an application quit loses it, and the cost is a rebuild rather than any data.

A session is released when the operator **closes the graph tab**, and only when no other conversation still has one open on that same directory. Release is also what hands the corpus subscription back to the main process; parking deliberately keeps it, so the scan stays warm and live file edits keep flowing into the parked model.


## 10. Interaction model

Analytical-first, not navigation-first. The graph is a place to inspect relationships and metadata; jumping to a file is an escape hatch rather than the primary action.

- **Single click** on a node selects and emphasizes it, glides the camera to it at the current zoom, and opens an inspector showing every analytical field for that node: bound channel values, structural metrics, and all discovered front matter. A click on a collapsed cluster opens it and frames its members.
- **Shift+click** adds a node to the selection or removes it. With several nodes selected the inspector leads with the count and a list that narrows back to one.
- **Emphasis**: while anything is selected, the selected nodes and their immediate neighbours keep full strength and everything else draws dimmed, labels included. This is focus-by-emphasis, the counterpart to scope's focus-by-hiding: the whole picture stays, but the part under inspection reads first. Dimming fades a node's colour rather than replacing it, so a bound encoding still reads through.
- **Double-click** on a node drills in. From corpus scope it enters that node's neighborhood at the configured depth; from inside a neighborhood it pulls that node's own neighbours into the scope and keeps them — exploration grows outward from where the operator is looking, one node at a time, alongside the declarative depth. **Shift+double-click** (or `C`) collapses that expansion again: exactly what only it added leaves, and what the anchor or another expansion still reaches stays.
- **Click off** any node clears the selection and hides the inspector.
- **Hover** is the primary reading gesture. The neighbourhood is one hop, the same BFS scope uses, so hovering a hub lights that hub and its immediate neighbours and nothing further. **Dimming darkens toward the stage background; it never lowers alpha.** Sigma blends premultiplied, so translucent lines stack where they cross: at a 15% alpha dim, twenty crossing edges compose to about 96% of full strength and a dense cluster refuses to recede at all, which made hovering one node read as the whole graph lighting up when 6% of it was emphasised. An opaque dim looks the same at any density. The moment the pointer enters a node its neighbourhood stays lit and everything else fades — eased over a few frames rather than snapped — with no camera move and no inspector; the pointer leaving fades it back. After a short delay a lightweight quick-peek popover appears, with no change to selection state. Hovering an **edge** peeks the claim it makes: its kind, the field that produced it, and its two ends.
- **Right-click** on a node or the stage opens a context menu with the same verbs the keyboard offers: open, pin, expand or collapse, fit the neighbourhood, hide, collapse a community while coarsened; on the stage, fit, show the whole corpus, restore hidden nodes, collapse every opened community.
- **⌘/Ctrl+click** opens the underlying file in the editor, as does **Enter** with a selection; **Escape** clears the selection. `F` fits, `P` pins, `E` expands, `C` collapses, `H` hides the newest selected node. Plain click and double-click are reserved for graph inspection and navigation, so an ordinary click never unexpectedly leaves the graph.

## 11. Rendering and scale

The data layer and the render layer are separate: **graphology** holds the graph structure and supplies the algorithms (community detection, centrality, force-directed layout with an off-main-thread variant), and **sigma.js** renders it in WebGL.

Two properties of that split carry the design rather than merely implementing it:

- **Reducer-driven drawing.** Each node's and edge's visual properties are computed at draw time from its bound attributes. This *is* the multi-channel encoding mechanism of § 6: the reducer reads whatever field the operator bound, and rendering code contains no field names at all.
- **GPU-instanced rendering.** WebGL instancing removes the per-node draw-call ceiling that a 2D canvas renderer imposes, and viewport culling skips off-screen nodes entirely rather than drawing them simply. Custom node programs supply the non-circle shapes the shape channel needs while staying instanced.

Cluster hulls are drawn on a camera-synced overlay layer that tracks pan and zoom.

Scale is held on two axes with different cost profiles:

| Axis | Cost profile | How it is held |
|---|---|---|
| **Layout** (arranging nodes in space) | One-time, then on disturbance | Computed off the main thread, then persisted **with a saved view**, so a later load of that saved view pays nothing. Between disturbances the simulation is paused, so a settled graph costs nothing per frame; a drag wakes it for the region it disturbs and it pauses again on convergence. |
| **Render** (every frame during pan, zoom, hover, highlight) | Continuous | WebGL instancing plus viewport culling |

**Level of detail** is a secondary lever: zoomed out, nodes draw as simple dots and only hubs (the top of the degree distribution) keep a label; zooming in progressively restores detail, each node earning its label once it is drawn large enough. A node's radius grows with the square root of the zoom, so nodes come forward like features on a map as the operator zooms in. Labels sit centred under their node on a translucent plate. Every node stays present and traversable at all times, so this scales rendered *detail* with what is on screen, not the corpus with what is drawable.

**Edges are opaque and straight by default.** Sigma composites with premultiplied alpha, so a translucent edge token accumulates wherever edges cross — twenty edges over one pixel reached most of a pale colour and every hub drew as a solid fan. The unbound edge tokens are opaque, a few steps above the stage background, so a hub with twenty edges is exactly as bright as one; alpha is reserved for the states that genuinely mean "fainter" (the opacity channel, dimming, orphans). A lone edge draws straight; only a pair joined both ways or by more than one field curves, so the two lines read as two. The default node colour is neutral so that bound colour, when the operator asks for it, is what carries hue.

**Edge kinds are drawn apart, and node-mediated ties are drawn on demand.** A curated document link (a wikilink, a Markdown link, a front-matter reference) draws at full strength, as does a document's tie to its own section. A tie mediated by a shared node (a topic, an anchor) does not draw at all until it is asked for: the shared node is a star joined to every document carrying its value, so on a real corpus turning topic nodes on added six times the corpus's own link count and the stage rendered as one white mass in which the actual document links could not be read. The shared node keeps its job as an **attractor** — the edges stay in the graph, the simulation still pulls its members into a visible cluster, and the hull still draws around them — while the lines appear only for the node under the pointer or in the selection. Grouping is shown by position, which is what a shared value means; membership is shown on request. An author's claim and a coincidence a shared node produced never read as the same line, and the edge's kind and source field are bindable dimensions for the colour, thickness, and opacity channels.

**Coarsening** is the structural lever for the extreme end. Past a zoom threshold, a dense cluster's members collapse into a single synthetic count node and expand back on zoom-in or click. This genuinely reduces what is drawn rather than simplifying it, and is built on the same community detection as § 7. The threshold sits high enough that it does not visibly engage in the low thousands.

## 12. Configuration

All Graph View configuration lives in `settings.json` under `desktop.graphView`: corpus roots, identity and label field bindings, curated field metadata, and saved views. There is no dedicated `graph-view.json`. Ion configures the worktree, the desktop, or the engine; Graph View is desktop configuration, and a corpus does not need a second config file beside `.ion/engine.json` for one surface.

| Scope | File | Holds |
|---|---|---|
| Project | `.ion/settings.json` in the corpus root | What ships with the corpus: corpus roots, identity/label bindings, curated fields, project saved views. Checked into version control, so anyone opening that corpus gets working defaults. |
| User | `~/.ion/settings.json` | Private to the operator: their own saved views and any roots they add locally. Available across every corpus they open. |

Both scopes use the identical `desktop.graphView` shape. They are not merged field-by-field beyond the corpus-root union of § 3.2. Saved views in particular are **kept separate by source**: a project view and a user view with the same name both appear, disambiguated by source, rather than one overriding the other.

### Project scope is field-allowlisted

`settings.json` carries a broad `desktop` key of user-only escape hatches. A project-level file that deep-merged into `desktop.*` would make the entire desktop configuration surface corpus-overridable by accident, and would silently capture every `desktop.*` key added in future. Only Graph View's own configuration is ever settable from a corpus.

The project loader enforces that structurally rather than by convention:

- It extracts **only** the fields named in the `GRAPH_VIEW_PROJECT_FIELDS` allowlist under `desktop.graphView` (`desktop/src/shared/graph-view-types.ts` is the authority for the list). This is a typed allowlist, not a deep merge of the `desktop` object.
- Anything else in the project file, whether a different `desktop.*` key, an unrecognized field under `desktop.graphView`, or any top-level key, is ignored and logged. A corpus cannot set unrelated desktop preferences, and cannot introduce a not-yet-allowlisted `graphView` field just by naming it.
- Making a new Graph View field project-configurable is a deliberate addition to that allowlist, never something that follows implicitly from the field existing in user scope.
- The restriction applies only to project scope. `~/.ion/settings.json` keeps its full `desktop.*` surface, because the operator controls that file and anyone who can write to a corpus's `.ion/` directory can ship its project config.

### Saved views

A saved view captures **encoding bindings, active filters, the layer toggles (topic treatment, section nodes, promoted anchors), the visibility facts, the force parameters, persisted node positions, and pinned nodes**. It does not capture camera position or pan/zoom: a view loads into a fresh navigation state.

Loading a view that carries **no** positions re-lays the graph out from a fresh seed. The arrangement on screen was settled against the previous view's filters, node set, and forces, so keeping it would show the new view's data in the old view's shape — nodes a filter has just revealed sitting wherever they last happened to be, and holes where it hid others. A view that **does** carry positions is the opposite case: that layout is the view, captured deliberately, so it is applied and left alone.

A position or pin is written only for a node with a **durable identity**. A document with no identity is keyed by its path for one read; a section's identity is derived from its heading and ordinal; a dangling stub is named by the reference that failed. None of those may be persisted, because the next read may key the same thing differently and a stored reference would then dangle, so they are dropped at capture and the count is logged.

A corpus names one of them in `defaultView` to choose what an operator opens on, which is applied once when the corpus first loads, before the opening scope is chosen — a view carries the filters and pinned positions that the scope decision reads. A name matching no saved view is logged and skipped rather than failing the load, because a corpus can ship a default whose view a later edit renamed, and a graph that refuses to open is worse than one that opens unstyled. Loading a view later, by hand, is the same code path.

See [settings.json § Graph View](../configuration/settings-json.md#graph-view) for the full saved-view field shape and a worked example.
