/**
 * Client-tool declaration synchronizer for the Studio browser tools.
 *
 * Browser-tool availability is not static: it depends on the
 * `studioPlaywrightEnabled` setting and on which UI is active, and both can
 * change while conversations are running. The engine learns a session's tool
 * list at `start_session`, so a change has to be pushed rather than waited for.
 *
 * Re-asserting `start_session` with the same key is the engine's documented,
 * idempotent way to replace `ToolGateConfig` wholesale. It applies to FUTURE
 * runs; a run already in flight keeps the snapshot it captured, which is the
 * behavior we want — a model mid-turn does not have tools vanish from under it.
 *
 * What this must never do is stop or restart a session. That would discard
 * conversation state to change a tool list, which is a far larger side effect
 * than the setting the operator just toggled.
 */
import { log as _log, warn as _warn } from './logger'
import { engineBridge } from './state'
import { toolGateSessionConfig } from './tool-gate-responder'

const TAG = 'studio-browser-tool-sync'

interface AvailabilityInputs {
  activeUi?: unknown
  studioPlaywrightEnabled?: unknown
}

/** Effective availability, computed the same way the responder computes it. */
export function browserToolsAvailable(settings: AvailabilityInputs): boolean {
  return settings.activeUi === 'studio' && settings.studioPlaywrightEnabled !== false
}

/**
 * Re-assert the tool declaration for every live desktop-owned session.
 *
 * Called when the setting or the active UI changes. Sessions that fail to
 * re-assert are logged individually: one wedged session must not stop the rest
 * from converging, and a silent skip would leave a conversation advertising
 * tools the responder will refuse.
 */
export function syncBrowserToolDeclarations(reason: string): void {
  const config = toolGateSessionConfig()
  const toolNames = config.clientTools?.map((tool) => tool.name) ?? []
  const sessions = [...engineBridge.activeSessions.entries()]
  if (sessions.length === 0) {
    _log(TAG, 'no live sessions to resync', { reason, tool_count: toolNames.length })
    return
  }

  let resynced = 0
  for (const [key, entry] of sessions) {
    try {
      // The FULL config is re-sent with the new toolGate. Sending a partial
      // config would drop model, cwd, and permission settings the session was
      // started with.
      // Fire-and-forget: the resync must not block the settings write, and a
      // per-session failure is logged rather than propagated.
      void Promise.resolve(engineBridge.startSession(key, { ...entry.config, toolGate: config }))
        .catch((err: unknown) => _warn(TAG, 'session tool declaration resync rejected', { key, reason, error: String(err) }))
      resynced += 1
    } catch (err) {
      _warn(TAG, 'session tool declaration resync failed', { key, reason, error: String(err) })
    }
  }
  _log(TAG, 'client tool declarations resynced', {
    reason,
    session_count: sessions.length,
    resynced,
    tool_count: toolNames.length,
  })
}

/**
 * React to a settings write.
 *
 * Only the two keys that change effective availability trigger a resync;
 * re-asserting every session on every unrelated settings write would be a
 * lot of engine traffic for no behavioral difference.
 */
export function handleSettingsChangeForBrowserTools(
  next: Record<string, unknown>,
  prev: Record<string, unknown> | null,
): void {
  const before = prev ? browserToolsAvailable(prev) : null
  const after = browserToolsAvailable(next)
  if (before === after) return
  syncBrowserToolDeclarations(
    `availability ${before === null ? 'initialised' : before ? 'revoked' : 'granted'}`,
  )
}
