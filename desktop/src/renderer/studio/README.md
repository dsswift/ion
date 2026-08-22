# Ion Studio shell

An alternative desktop shell (formerly the Ion Studio / Studio): the
overlay's real chrome around a conversation-centric workspace, with the
pixel-art office canvas as its visualizer surface. Read
[ADR-021](../../../../docs/architecture/adr/021-studio-shell-mirror-store.md)
before changing anything here.

| Piece | Where |
|---|---|
| Layout root (mirror boot, panes, keymap, palette) | `StudioShell.tsx` |
| Left dock (inbox / explorer / git views) | `StudioLeftSidebar.tsx`, `inbox/` |
| Center (conversation, composer, dispatch split, bottom terminal) | `StudioCenter.tsx`, `DispatchSplitPane.tsx` |
| Right surface (conversation-specific tabs plus global pinned diff/plan/visualizer and Notification tabs) | `StudioSurface.tsx`, `surface/` |
| Pane geometry plus conversation-keyed surface persistence | `layout/useStudioLayout.ts`, `surface/surface-store.ts` |
| Keymap (fixed defaults, focus contexts, capture phase) | `keymap/` |
| Window title bar (breadcrumb, compose, pane controls) | `StudioTitleBar.tsx`, `chrome/`, `inbox/ProjectPicker.tsx` |
| Visualizer canvas (engine host, tooltips, toolbar) | `visualizer/VisualizerRoot.tsx` |
| Mirror store boot + owner sync | `state/secondary-store.ts`, `state/hydrate-tabs.ts` |
| Action classification (parity mechanism 2) | `../../shared/studio-mirror-actions.ts` + `state/__tests__/mirror-parity.test.ts` |
| Telemetry (odometers/dashboards/export) | `visualizer/state/stats.ts` |
| Replay ring | `visualizer/state/recorder.ts` |
| Sim / render / overlays | `visualizer/engine/` (`scene-fx.ts`, `render-overlays.ts` for new passes) |
| Procedural office generation | `visualizer/generation/` (seeded PRNG only — no Date.now/Math.random) |
| Theme packs | `visualizer/theme/` + `desktop/resources/studio/themes/` |

Rules that bite:
- New store action? Classify it in `studio-mirror-actions.ts` or the parity test fails.
- New main-process event push? Route through `broadcast()` or `make check-studio-parity` fails.
- Workspace controls read `worktreeOperations` and `worktreePipeline` from the mirrored store. Do not create local busy flags or local refresh loops. The operation ledger is the source of truth for pending work and locks in both windows.
- A recovered bench conflict keeps its returned bench directory and opens the shared `ConflictsDialog`. Successful Abort and Continue report completion through `completeConflictOperation(directory, verb)` so all controls release together.
- New shared surface? Mount the overlay's component on the mirror store — never build a bespoke Studio widget for something the overlay already has.
- Surface state belongs to its conversation. Only Diff, Plan, and Visualizer can be global user pins. A workspace Notification is a separate global slot that follows every conversation until close. Panel geometry stays global, while visibility can follow the current surface or restore per conversation.
- The bottom terminal tray and its shell pool belong to the active conversation. Switching conversations restores that conversation's open or closed tray and its shells. Terminal height remains global window geometry.
