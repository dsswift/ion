# ADR-021: ATV Shell — Mirror Store and Overlay↔ATV Parity

## Status

Accepted.

## Context

The Agent Team Visualizer began as a floating companion window rendering a pixel-art office of agent teams. It has grown into an **alternative desktop shell**: a standalone window carrying the same first-class chrome as the overlay (tab strip, conversation view, input bar, notifications, settings) around the office canvas. That makes the overlay and the ATV **two clients in one process**, and raises the same parity obligation the desktop↔iOS pair carries: not every feature exists in both, but a feature that exists in both must be the same in both.

The overlay's renderer is more than a UI: it is the **owner** — the session-store source of truth, the tabs/settings persister, the iOS snapshot source, and the prompt pipeline executor. The ATV cannot simply run a second copy of that store; verified failure modes include dual persistence writers racing on `tabs.json`, snapshot-poller ambiguity, active-tab divergence, and duplicated side effects.

## Decision — surface ≠ owner; the ATV runs a MIRROR store

The ATV window boots the **real** `sessionStore` + `preferencesStore` in mirror mode. Rich components (TabStrip, ConversationView, InputBar, FileExplorer/FileEditor, NotificationsPanel, SettingsDialog, PermissionCard…) then work in the ATV as-is, because they read the same hooks.

Mirror discipline (each rule fixes a verified breakage):

1. **Single writer.** `isMirrorWindow()` (entry-path detection, `renderer/lib/window-role.ts`) gates `setupPersistence()`: the mirror never persists tabs/settings, never registers `__ionForceFlushTabs`, never runs the stuck-tab watchdog. Pinned by test.
2. **Owner-executed mutations.** Every store action is classified in `shared/atv-mirror-actions.ts`: `FORWARDED_ACTIONS` (owner-durable mutations — tabs, groups, worktrees, the prompt pipeline) are swapped for IPC forwarders in the mirror (`atv:call-action` → validated in main → `atv:exec-action` → owner executes → `atv:action-result` → the mirror's promise resolves with the owner's return value); `MIRROR_LOCAL_ACTIONS` (per-window UI, stateless engine pass-throughs, event ingestion) run locally, each with a written justification. The forwarder is a round trip rather than fire-and-forget because the store actions are `async` and call sites chain on that: a mirror caller does `const result = await store.retireWorktree(…)` and must get the owner's real answer. A `void`-returning forwarder turned every `.then`/`.catch`/`await` into a `TypeError` inside a click handler, and TypeScript could not catch it (the overrides are installed through `setState(… as never)`, so call sites still see the store's promise-returning types). The reply envelope's `ok` describes the ROUND TRIP, never the action's own success — a domain result rides through in `value`, while a transport fault (no owner window, no reply before main's deadline) resolves `undefined` and is logged. Pinned by test on both sides.
3. **Non-event state syncs by owner push.** Tab metadata rides `atv:publish-tabs-sync` → main cache → `atv:tabs-sync` push (+ boot pull); the mirror hydrates via a pure mapping (`renderer/atv/state/hydrate-tabs.ts`) with no owner side effects. Preferences ride `ion:settings-changed` pushes emitted by the single settings funnel (`persistAndBroadcastSettings`). The owner's active tab is authoritative (`atv:active-tab` round-trip).
4. **Full event stream while open.** `broadcast()` forwards the complete normalized stream (+ tab-status/errors/settings) to the open ATV window; the main-process ATV cache keeps its canvas-relevant subset for closed-window backfill.
5. **Cross-surface permission reconcile.** `respondToPermission` (engine-control-plane) is the single choke point for answers from the overlay, iOS, and the ATV; it resolves the cached pending queue and pushes `atv:permission-resolved` so every surface converges instantly. The shared clearing predicate lives in `shared/permission-clear.ts`.

### Launch surfaces

`launchSurface` ('overlay' | 'atv' | 'both') picks what the user sees at startup; the enterprise/operator `surfacePolicy` ('both' | 'overlay-only' | 'atv-only') gates which surfaces exist at all. "Overlay disabled" means the glass never *shows* — the owner renderer still runs hidden. Resolution is pure (`main/surface-launch.ts`). The future evolution path — hoisting ownership into a dedicated hidden host window so no surface is privileged — is out of scope until it has user-visible benefit.

## Parity enforcement (automatic, not aspirational)

1. **Reuse is the parity system.** A surface shared by both clients is ONE component reading the same store. Bespoke ATV widgets are permitted only for canvas-coupled surfaces (marquee, inspector, control bar).
2. **Forwarder completeness gate.** `renderer/atv/state/__tests__/mirror-parity.test.ts` enumerates the live store and fails on any unclassified, stale, or double-classified action.
3. **Broadcast parity gate.** `make check-atv-parity` (CI: quality.yml) fails any direct `webContents.send` in `desktop/src/main` outside the documented owner-only allowlist — new event pushes reach both clients by default.

## Consequences

- Shared components ship to both windows in one edit; no dual maintenance.
- Adding a store action forces an explicit parity classification (test failure otherwise).
- The full-stream forward doubles structured-clone cost only while the ATV window is open.
- Mirror drafts (input text) are deliberately window-local; everything durable converges through the owner.
