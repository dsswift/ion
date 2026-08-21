# ADR-021: Studio Shell — Mirror Store and Overlay↔Studio Parity

> **Renamed 2026-08:** the Agent Team Visualizer (ATV) window became **Ion Studio**. The mirror-store architecture is unchanged; the visualizer canvas is now one surface inside the Studio shell. Code moved from `renderer/atv/` to `renderer/studio/` (canvas under `renderer/studio/visualizer/`), IPC channels from `atv:*` to `studio:*`, settings keys from `atv*` to `studio*` (one-shot boot migration in `main/settings-migration-studio.ts`), and the parity gate to `make check-studio-parity`.

## Status

Accepted.

## Context

The Agent Team Visualizer began as a floating companion window rendering a pixel-art office of agent teams. It has grown into an **alternative desktop shell**: a standalone window carrying the same first-class chrome as the overlay (tab strip, conversation view, input bar, notifications, settings) around the office canvas. That makes the overlay and the Studio shell **two clients in one process**, and raises the same parity obligation the desktop↔iOS pair carries: not every feature exists in both, but a feature that exists in both must be the same in both.

The overlay's renderer is more than a UI: it is the **owner** — the session-store source of truth, the tabs/settings persister, the iOS snapshot source, and the prompt pipeline executor. The Studio window cannot simply run a second copy of that store; verified failure modes include dual persistence writers racing on `tabs.json`, snapshot-poller ambiguity, active-tab divergence, and duplicated side effects.

## Decision — surface ≠ owner; the Studio shell runs a MIRROR store

The Studio window boots the **real** `sessionStore` + `preferencesStore` in mirror mode. Rich components (TabStrip, ConversationView, InputBar, FileExplorer/FileEditor, NotificationsPanel, SettingsDialog, PermissionCard…) then work in the Studio shell as-is, because they read the same hooks.

Mirror discipline (each rule fixes a verified breakage):

1. **Single writer.** `isMirrorWindow()` (entry-path detection, `renderer/lib/window-role.ts`) gates `setupPersistence()`: the mirror never persists tabs/settings, never registers `__ionForceFlushTabs`, never runs the stuck-tab watchdog. Pinned by test.
2. **Owner-executed mutations.** Every store action is classified in `shared/studio-mirror-actions.ts`: `FORWARDED_ACTIONS` (owner-durable mutations — tabs, groups, worktrees, the prompt pipeline) are swapped for IPC forwarders in the mirror (`studio:call-action` → validated in main → `studio:exec-action` → owner executes → `studio:action-result` → the mirror's promise resolves with the owner's return value); `MIRROR_LOCAL_ACTIONS` (per-window UI, stateless engine pass-throughs, event ingestion) run locally, each with a written justification. The forwarder is a round trip rather than fire-and-forget because the store actions are `async` and call sites chain on that: a mirror caller does `const result = await store.retireWorktree(…)` and must get the owner's real answer. A `void`-returning forwarder turned every `.then`/`.catch`/`await` into a `TypeError` inside a click handler, and TypeScript could not catch it (the overrides are installed through `setState(… as never)`, so call sites still see the store's promise-returning types). The reply envelope's `ok` describes the ROUND TRIP, never the action's own success — a domain result rides through in `value`, while a transport fault (no owner window, no reply before main's deadline) resolves `undefined` and is logged. Pinned by test on both sides.
3. **Non-event state syncs by owner push.** Tab metadata rides `studio:publish-tabs-sync` → main cache → `studio:tabs-sync` push (+ boot pull); the mirror hydrates via a pure mapping (`renderer/studio/state/hydrate-tabs.ts`) with no owner side effects. Preferences ride `ion:settings-changed` pushes emitted by the single settings funnel (`persistAndBroadcastSettings`). The owner's active tab is authoritative (`studio:active-tab` round-trip).
4. **Full event stream while open.** `broadcast()` forwards the complete normalized stream (+ tab-status/errors/settings) to the open Studio window; the main-process Studio cache keeps its canvas-relevant subset for closed-window backfill.
5. **Cross-surface permission reconcile.** `respondToPermission` (engine-control-plane) is the single choke point for answers from the overlay, iOS, and the Studio shell; it resolves the cached pending queue and pushes `studio:permission-resolved` so every surface converges instantly. The shared clearing predicate lives in `shared/permission-clear.ts`.
6. **Workspace operation reconcile.** Shared worktree controls derive pending state and locks from the mirrored `worktreeOperations` ledger and `worktreePipeline`, not component-local promises or refresh loops. A recovered bench conflict retains the returned bench directory until the shared `ConflictsDialog` closes. Its Abort or Continue reports completion with `completeConflictOperation(directory, verb)`, which releases all related controls from one owner state transition.

### Launch surfaces

### Single-UI exclusivity (D1)

`activeUi` ('overlay' | 'studio') picks the ONE conversation UI — there is no 'both'. Legacy `launchSurface`/`surfacePolicy` values still resolve for managed settings pushed mid-cycle ('atv'→studio, 'both'→overlay); the boot migration (`main/settings-migration-studio.ts`) rewrites the file one-way. The enterprise lock is the MDM `customFields['ion-desktop'].activeUiPolicy` blob (`shared/enterprise-active-ui-policy.ts`), enforced at three points on the theme-policy precedent: the resolver clamps, `persistAndBroadcastSettings()` strips locked writes, and the Settings "Interface" picker renders managed-locked.

"Overlay inactive" means the glass never *shows* — the owner renderer still runs hidden (it is the session-store owner in both modes). Flipping `activeUi` is a LIVE switch (`main/active-ui.ts`): the active UI closes, the other opens, global shortcuts re-register, and the tray rebuilds with the inactive UI's items ABSENT, not greyed. `Option+Space` has surface-specific native behavior: Overlay hides/shows its glass; Studio minimizes/restores its normal window, retaining current native position, dimensions, and maximized state. The owner renderer never restarts; conversations and in-flight runs are uninterrupted. Resolution is pure (`main/surface-launch.ts`).

This removes by construction: shared-`selectTab` two-window fighting, cross-window dirty-buffer loss, and per-window terminal ownership confusion. The visualizer is a clean break: it exists only as a Studio surface tab — no standalone visualizer window.

### Terminals: main-owned attach model (D2)

Ptys are owned by the main process with server-side scrollback (`terminalScrollback`, accumulated unconditionally in `broadcast()`), lifecycle records that outlive the pty (exit retains buffer + exit code), and an attach protocol (`TERMINAL_ATTACH`: history snapshot + live stream, respawn-on-demand, dead-cwd fallback to `~` with a visible notice). Renderers are pure attach clients: unmount detaches, only explicit tab close destroys. Surface terminals (`studio:` namespace) persist across app restarts via `main/studio-terminal-persistence.ts`; conversation terminals keep riding `PersistedTab.terminalBuffers`. Terminals therefore survive window closes, live mode switches, and app restarts.

## Parity enforcement (automatic, not aspirational)

1. **Reuse is the parity system.** A surface shared by both clients is ONE component reading the same store. Bespoke Studio widgets are permitted only for canvas-coupled surfaces (marquee, inspector, control bar).
2. **Forwarder completeness gate.** `renderer/studio/state/__tests__/mirror-parity.test.ts` enumerates the live store and fails on any unclassified, stale, or double-classified action.
3. **Broadcast parity gate.** `make check-studio-parity` (CI: quality.yml) fails any direct `webContents.send` in `desktop/src/main` outside the documented owner-only allowlist — new event pushes reach both clients by default.

## Consequences

- Shared components ship to both windows in one edit; no dual maintenance.
- Adding a store action forces an explicit parity classification (test failure otherwise).
- The full-stream forward doubles structured-clone cost only while the Studio window is open.
- Mirror drafts (input text) are deliberately window-local; everything durable converges through the owner.
