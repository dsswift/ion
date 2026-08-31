/**
 * Client-tool declaration synchronizer for the Studio-only tool set.
 *
 * Studio-only tool availability is not static: the browser tools depend on the
 * `studioPlaywrightEnabled` setting AND on which UI is active, and RenderChart
 * depends on the active UI alone. Both inputs change while conversations are
 * running. The engine learns a session's tool list at `start_session`, so a
 * change has to be pushed rather than waited for.
 *
 * Re-asserting `start_session` with the same key is the engine's documented,
 * idempotent way to replace `ToolGateConfig` wholesale. It applies to FUTURE
 * runs; a run already in flight keeps the snapshot it captured, which is the
 * behavior we want — a model mid-turn does not have tools vanish from under it.
 *
 * What this must never do is stop or restart a session. That would discard
 * conversation state to change a tool list, which is a far larger side effect
 * than the setting the operator just toggled.
 *
 * This module was browser-specific (`studio-browser-tool-sync`) until charts
 * arrived. It is now the single seam for every Studio-gated client tool, so a
 * future Studio tool needs no third resync path — only an entry in
 * `toolGateSessionConfig`.
 */
import { log as _log, warn as _warn } from "./logger";
import { engineBridge } from "./state";
import { toolGateSessionConfig } from "./tool-gate-responder";

const TAG = "studio-client-tool-sync";

interface AvailabilityInputs {
  activeUi?: unknown;
  studioPlaywrightEnabled?: unknown;
}

/** Effective browser-tool availability, computed the same way the responder computes it. */
export function browserToolsAvailable(settings: AvailabilityInputs): boolean {
  return (
    settings.activeUi === "studio" && settings.studioPlaywrightEnabled !== false
  );
}

/**
 * Effective chart-tool availability.
 *
 * Studio-active is the whole condition: a Chart Output renders in the shared
 * Conversation View, but only the Studio presentation is a place the operator
 * can work with one. Note that PREVIOUSLY SAVED charts still render in the
 * Overlay — this governs whether the model may create a NEW one.
 */
export function chartToolsAvailable(settings: AvailabilityInputs): boolean {
  return settings.activeUi === "studio";
}

/**
 * Every input that changes any Studio-gated tool's availability.
 *
 * One list, so adding a Studio tool with a new gate cannot forget to trigger a
 * resync. `activeUi` gates both families; `studioPlaywrightEnabled` gates only
 * the browser set.
 */
function availabilitySignature(settings: AvailabilityInputs): string {
  return `${browserToolsAvailable(settings) ? "b" : "-"}${chartToolsAvailable(settings) ? "c" : "-"}`;
}

/**
 * Re-assert the tool declaration for every live desktop-owned session.
 *
 * Called when a gating setting or the active UI changes. Sessions that fail to
 * re-assert are logged individually: one wedged session must not stop the rest
 * from converging, and a silent skip would leave a conversation advertising
 * tools the responder will refuse.
 */
export function syncClientToolDeclarations(reason: string): void {
  const config = toolGateSessionConfig();
  const toolNames = config.clientTools?.map((tool) => tool.name) ?? [];
  const sessions = [...engineBridge.activeSessions.entries()];
  if (sessions.length === 0) {
    _log(TAG, "no live sessions to resync", {
      reason,
      tool_count: toolNames.length,
    });
    return;
  }

  let resynced = 0;
  for (const [key, entry] of sessions) {
    try {
      // The FULL config is re-sent with the new toolGate. Sending a partial
      // config would drop model, cwd, and permission settings the session was
      // started with.
      // Fire-and-forget: the resync must not block the settings write, and a
      // per-session failure is logged rather than propagated.
      void Promise.resolve(
        engineBridge.startSession(key, { ...entry.config, toolGate: config }),
      ).catch((err: unknown) =>
        _warn(TAG, "session tool declaration resync rejected", {
          key,
          reason,
          error: String(err),
        }),
      );
      resynced += 1;
    } catch (err) {
      _warn(TAG, "session tool declaration resync failed", {
        key,
        reason,
        error: String(err),
      });
    }
  }
  _log(TAG, "client tool declarations resynced", {
    reason,
    session_count: sessions.length,
    resynced,
    tool_count: toolNames.length,
  });
}

/**
 * React to a settings write.
 *
 * Only a change in effective availability triggers a resync; re-asserting
 * every session on every unrelated settings write would be a lot of engine
 * traffic for no behavioral difference.
 */
export function handleSettingsChangeForClientTools(
  next: Record<string, unknown>,
  prev: Record<string, unknown> | null,
): void {
  const after = availabilitySignature(next);
  if (prev === null) {
    syncClientToolDeclarations("availability initialised");
    return;
  }
  const before = availabilitySignature(prev);
  if (before === after) return;
  syncClientToolDeclarations(`availability changed ${before} → ${after}`);
}
