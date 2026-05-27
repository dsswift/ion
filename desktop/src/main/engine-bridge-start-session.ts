import type { EngineBridge } from './engine-bridge'
import { log as _log } from './logger'
import type { EngineConfig } from '../shared/types'

function log(msg: string): void { _log('engine-bridge', msg) }

/**
 * startSession — bridge attach handshake.
 *
 * Lives in its own file because the bridge's primary class file is at
 * its 600-line cap and this handshake is the natural seam: it sequences
 * three independent steps (session-id injection from prior conversation,
 * `start_session` dispatch, post-start reconcile) that don't touch any
 * other bridge state.
 *
 * Why a post-start reconcile:
 *
 * The engine's `start_session` is idempotent. When a desktop attaches to
 * an engine that already has this session loaded (daemon reuse, desktop
 * reinstall, reconnect after socket flap), the engine returns a bare
 * `{ ok: true }` immediately — it does not re-emit the in-flight state
 * (active agents, pending AskUserQuestion / ExitPlanMode denials, last
 * context %, etc.). Without an explicit snapshot request, the desktop
 * has no way to populate its renderer-side state for an
 * already-running session.
 *
 * `ReconcileState` (engine/internal/session/manager.go) is the canonical
 * reconnect handshake. It re-emits `engine_agent_state` and
 * `engine_status` (including the pending PermissionDenials field) on
 * the same key. The renderer's engine-event-slice already translates
 * those snapshots into `tab.permissionDenied`, agent rows, footer
 * values, etc. — so calling reconcile after start_session closes the
 * "card never re-appears after desktop reinstall" gap end-to-end.
 *
 * Lifecycle / idempotence:
 *
 *   - We register the session in `activeSessions` BEFORE the dispatch
 *     so reconnect logic (_reRegisterSessions) sees it on the next
 *     socket recovery.
 *   - Reconcile is fire-and-forget. The engine's `reconcile_state`
 *     handler doesn't return a body; the snapshot arrives as ordinary
 *     `engine_*` events on the existing event subscription. The renderer
 *     subscribes once at bridge wireup, so it picks them up automatically.
 *   - On a start_session failure we skip reconcile — the session isn't
 *     known to the engine yet, so there's nothing to snapshot. Logged so
 *     the failure-then-no-reconcile path is reconstructable from logs.
 *
 * Logging:
 *
 * Every step is logged at INFO with the session key and resolved config
 * highlights so the attach cycle is reconstructable from `~/.ion/desktop.log`
 * without a debugger. Both branches of the post-start conditional log —
 * "requesting reconcile_state post-start" or "skipping reconcile (start
 * failed: ...)" — so a grep for `reconcile_state` covers every attach.
 */
export async function startSession(
  bridge: EngineBridge,
  key: string,
  config: EngineConfig,
): Promise<{ ok: boolean; error?: string }> {
  const entry = bridge.activeSessions.get(key)
  // If we have a tracked conversationId from a previous session lifecycle,
  // inject it into the config so the engine can resume the conversation.
  // This is the same idempotence affordance the engine relies on: a fresh
  // start_session call with a prior sessionId is a resume, not a new
  // conversation.
  if (entry?.conversationId && !config.sessionId) {
    config = { ...config, sessionId: entry.conversationId }
  }
  log(`startSession: key=${key} model=${config.model} sessionId=${config.sessionId ?? 'none'}`)

  // Register BEFORE dispatch so _reRegisterSessions on socket recovery
  // sees this session even if start_session is still in flight at the
  // moment of a reconnect.
  bridge.activeSessions.set(key, { config, conversationId: entry?.conversationId })

  await bridge.connect()
  const result = await bridge._sendWithResult({ cmd: 'start_session', key, config })

  // Post-start reconcile handshake. See the docblock at the top of this
  // file for the full rationale — the short version is "tell the engine
  // to re-emit its current snapshot so a freshly-attached desktop
  // populates state for an already-running session, including pending
  // AskUserQuestion / ExitPlanMode denials."
  if (result.ok) {
    log(`startSession: key=${key} requesting reconcile_state post-start`)
    bridge.sendReconcileState(key)
  } else {
    log(`startSession: key=${key} skipping reconcile (start failed: ${result.error ?? 'unknown'})`)
  }
  return result
}
