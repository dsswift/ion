import { log as _log } from '../../logger'
import { engineBridge } from '../../state'
import type { RemoteCommand } from '../protocol'
import { useSessionStore } from '../../store/sessionStore'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

/** Per-device voice configuration (sent by iOS). */
const deviceVoiceConfig = new Map<string, { enabled: boolean; mode: 'client' | 'desktop'; systemPrompt?: string }>()

/**
 * Record one client's voice configuration. Keyed by the client's id, which is
 * the same value on both wires (a phone's device id is its credentials
 * client id), so a prompt submitted on either reads the config set on either.
 */
export function setVoiceConfig(clientId: string, config: { enabled: boolean; mode: 'client' | 'desktop'; systemPrompt?: string }): void {
  log('voice_config', { device_id: clientId, enabled: config.enabled, mode: config.mode, has_prompt: !!config.systemPrompt })
  deviceVoiceConfig.set(clientId, { enabled: config.enabled, mode: config.mode, systemPrompt: config.systemPrompt })
}

export function getVoiceSystemPrompt(deviceId: string): string | undefined {
  const cfg = deviceVoiceConfig.get(deviceId)
  if (!cfg || !cfg.enabled || cfg.mode !== 'desktop') return undefined
  return cfg.systemPrompt
}

export function handleEngineAbort(cmd: Extract<RemoteCommand, { type: 'desktop_engine_abort' }>): void {
  const hKey = cmd.tabId
  engineBridge.sendAbort(hKey)
}

/**
 * Reset an engine instance's session to a clean state without removing
 * the instance pane. Stops the engine session keyed by bare tabId and
 * asks the renderer to wipe per-instance state Maps. Used by the
 * iOS "Implement, clear context" flow on engine tabs — the engine-instance
 * equivalent of `reset_tab_session` for the CLI session plane.
 *
 * `reset_tab_session` already exists and routes through `sessionPlane.resetTabSession`
 * (which calls `bridge.stopSession(tabId)` with bare tabId). Engine tabs use
 * the same bare tabId key, so both paths call `bridge.stopSession` with the
 * same key shape.
 */
export async function handleResetEngineSession(cmd: Extract<RemoteCommand, { type: 'desktop_reset_engine_session' }>): Promise<void> {
  const key = cmd.tabId
  log('reset_engine_session', { tab_id: cmd.tabId, key })
  await engineBridge.stopSession(key)
  log('reset_engine_session: stop complete', { key })
  // Wipe the store's per-instance state Maps (messages, status, agent-state,
  // dialogs, etc.) and seed a fresh "Session started" divider.
  try {
    ;(useSessionStore.getState() as unknown as { resetEngineInstance: (tabId: string, instanceId: string) => void })
      .resetEngineInstance(cmd.tabId, cmd.instanceId)
    log('reset_engine_session: store state wiped', { key })
  } catch (err) {
    log('reset_engine_session: store wipe failed', { key, error: (err as Error).message })
  }
}
