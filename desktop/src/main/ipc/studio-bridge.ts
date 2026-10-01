/**
 * studio-bridge — the IPC surface over the connections Broker (spec 12).
 *
 * Three channels, all pass-through: `studio:frame` (main -> renderer, a frame
 * the broker received from some environment's server), `studio:send`
 * (renderer -> main, a frame to relay to an environment unchanged), and
 * `studio:connections` (main -> renderer, a phase snapshot array pushed on
 * every transition and once on subscribe). This module never interprets a
 * `studio_action` payload — it is a transport, not a decision point.
 *
 * Frames reach the Studio window directly (not through `broadcast()`): the
 * `StudioHost` it mounts needs the same live wire a remote environment uses,
 * and this file is on `check-server-parity.sh`'s main-process-only allowlist
 * for exactly that reason (spec 12 §Relevant Files).
 */
import type { ExportFileOptions, TransferLanding } from '@ion/shared/types-transfer'
import { ipcMain, dialog, BrowserWindow, shell } from 'electron'
import { IPC } from '@ion/shared/types'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import type { EnvironmentTarget } from '@ion/shared/types-environments'
import { broker as _broker } from '../connections/broker-instance'
import { ownRelayIdentity } from '../connections/own-identity'
import type { ConnectionPhaseSnapshot } from '../connections/phases'
import { connectEnvironment, disconnectEnvironment, restartEnvironment } from '../connections/environment-connect'
import { pairEnvironment, type ServerSignIn } from '../connections/pairing'
import { signInToServer } from '../connections/server-sign-in'
import { clearBearerSignInCooldown } from '../connections/server-bearer'
import { addEnvironmentOverSsh } from '../connections/ssh/ssh-add-environment'
import { browseNearby } from '../connections/nearby-browser'
import { sshTunnels } from '../connections/ssh/ssh-tunnel-instance'
import { portForwards } from '../connections/port-forward-instance'
import { hostname } from 'os'
import { exportToFile, importFromFile, onTransferProgress, cancelTransfer } from '../connections/transfer'
import { state } from '../state'
import { readDeviceSettings, updateDeviceSetting } from '../device-settings'
import { writeEnvCache, readEnvCache } from '../env-cache'
import { debug as _debug, log as _log, warn as _warn } from '../logger'
import { sanitizeDialogFilters } from '@ion/server/ipc-validation'
import { relayServerStartupReport } from '../startup-coordinator'
import { maybeBeacon } from '../studio-beacon'
import { notifyTelemetryHealth } from '../telemetry-health-notifier'
import { openStudioWindow } from '../studio-window-manager'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import type { NormalizedEvent } from '@ion/shared/types'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('studio-bridge', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('studio-bridge', msg, fields)
}
function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('studio-bridge', msg, fields)
}

/** One broker instance for the whole process; every window shares it. */
export const broker = _broker

/** Environment labels, kept alongside the broker's phase-only view for the connections snapshot. */
const environmentLabels = new Map<string, string>()

function pushToWindows(channel: string, ...args: unknown[]): void {
  const win = state.studioWindow
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

function connectionsSnapshot(): ConnectionPhaseSnapshot[] {
  const phases = broker.allPhases()
  return Object.entries(phases).map(([environmentId, phase]) => ({
    environmentId,
    label: environmentLabels.get(environmentId) ?? environmentId,
    phase,
  }))
}

function pushConnectionsSnapshot(): void {
  pushToWindows(IPC.STUDIO_CONNECTIONS, connectionsSnapshot())
}

/** Registers a target's label so the connections snapshot can show it before any window asks. */
export function registerEnvironmentLabel(environmentId: string, label: string): void {
  environmentLabels.set(environmentId, label)
}

let wired = false

/**
 * Wires the broker's frame/phase events to the IPC channels and registers
 * the renderer-facing handlers. Idempotent — safe to call once at boot.
 */
export function registerStudioBridgeIpc(): void {
  if (wired) {
    warn('registerStudioBridgeIpc: already wired; ignoring duplicate call')
    return
  }
  wired = true

  broker.onFrame((environmentId, frame) => {
    if (frame.type === 'studio_welcome') writeEnvCache(environmentId, frame)
    // The LOCAL server's restore progress feeds the splash; every other
    // frame is pass-through (see the module comment).
    relayServerStartupReport(environmentId, frame)
    // Attention beacon (dock bounce + title prefix when a permission or plan
    // arrives while Studio is open but unfocused). It used to hook the main
    // process's own normalized-event broadcast, which no longer exists; the
    // local server's frames are where those events reach this process now.
    if (environmentId === LOCAL_ENVIRONMENT_ID && frame.type === 'studio_event' && frame.channel === 'ion:normalized-event') {
      const payload = frame.payload as [string, NormalizedEvent] | undefined
      if (Array.isArray(payload) && payload[1]) maybeBeacon(payload[1])
    }
    // Telemetry delivery health: the local server decides what is worth a
    // notification; this desktop decides whether to show one.
    notifyTelemetryHealth(environmentId, frame)
    // A deep link needs its confirmation dialog on screen: the server asks,
    // this process owns the window.
    if (environmentId === LOCAL_ENVIRONMENT_ID && frame.type === 'studio_event' && frame.channel === 'ion:deeplink-present') {
      openStudioWindow('deeplink confirmation')
    }
    pushToWindows(IPC.STUDIO_FRAME, { environmentId, frame })
  })

  broker.onPhase((_environmentId, _phase) => {
    pushConnectionsSnapshot()
  })

  ipcMain.on(IPC.STUDIO_SEND, (_event, payload: unknown) => {
    if (!isSendPayload(payload)) {
      warn('studio:send: malformed payload; dropping', { payload_type: typeof payload })
      return
    }
    // DEBUG: one line per frame Studio sends; a malformed or failed send
    // logs at WARN.
    debug('studio:send: relaying frame', { environment_id: payload.environmentId, frame_type: payload.frame.type })
    broker.send(payload.environmentId, payload.frame)
  })

  ipcMain.handle(IPC.STUDIO_CONNECTIONS, () => {
    log('studio:connections: snapshot requested')
    return connectionsSnapshot()
  })

  ipcMain.handle(IPC.STUDIO_PICK_FILE, async (event, opts: { multiple?: boolean; filters?: unknown } | undefined) => {
    const sender = BrowserWindow.fromWebContents(event.sender)
    const properties: Array<'openFile' | 'multiSelections'> = ['openFile']
    if (opts?.multiple) properties.push('multiSelections')
    const filters = sanitizeDialogFilters(opts?.filters)
    if (opts?.filters != null && !filters) {
      warn('studio:pick-file: rejected invalid filters')
      return null
    }
    const options = { properties, ...(filters ? { filters } : {}) }
    const result = process.platform === 'darwin' || !sender
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(sender, options)
    if (result.canceled) {
      log('studio:pick-file: cancelled')
      return null
    }
    log('studio:pick-file: selected', { count: result.filePaths.length })
    return result.filePaths
  })

  ipcMain.handle(IPC.STUDIO_DEVICE_SETTINGS_GET, () => {
    log('studio:device-settings-get: read')
    return readDeviceSettings()
  })

  ipcMain.handle(IPC.STUDIO_DEVICE_SETTINGS_SET, (_event, key: string, value: unknown) => {
    log('studio:device-settings-set: write', { key })
    updateDeviceSetting(key, value)
  })

  ipcMain.handle(IPC.HOST_CONNECT_ENVIRONMENT, async (_event, environmentId: string, label: string, target: EnvironmentTarget) => {
    registerEnvironmentLabel(environmentId, label)
    log('studio:host-connect-environment: connect requested', { environment_id: environmentId, kind: target.kind })
    // The person asked, so a sign-in that was abandoned earlier may open the browser again.
    clearBearerSignInCooldown(environmentId)
    try {
      await connectEnvironment(environmentId, label, target)
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      warn('studio:host-connect-environment: connect failed', { environment_id: environmentId, error: message })
      return { ok: false, error: message }
    }
  })

  ipcMain.handle(IPC.HOST_PAIR_ENVIRONMENT, async (_event, link: unknown, label: unknown) => {
    if (typeof link !== 'string' || !link) {
      warn('studio:host-pair-environment: refused, link is not a string')
      return { ok: false, error: 'Paste a pairing link.' }
    }
    const wanted = typeof label === 'string' ? label : undefined
    log('studio:host-pair-environment: pairing requested', { link_length: link.length, has_label: !!wanted })
    // The server's own sign-in app, not this machine's identity: the person must be the same subject
    // the server's browser sign-in and the phone produce.
    const signIn = (server: ServerSignIn): Promise<string> => signInToServer(server, { openUrl: (url) => shell.openExternal(url) })
    const result = await pairEnvironment({ link, label: wanted }, `desktop ${hostname()}`, await ownRelayIdentity(_broker, LOCAL_ENVIRONMENT_ID), signIn)
    if (result.ok) {
      registerEnvironmentLabel(result.target.environmentId ?? result.target.url, result.target.label)
      log('studio:host-pair-environment: paired', { environment_id: result.target.environmentId, label: result.target.label })
    } else {
      warn('studio:host-pair-environment: pairing failed', { error: result.error })
    }
    return result
  })

  ipcMain.handle(IPC.HOST_BROWSE_NEARBY, async () => {
    log('studio:host-browse-nearby: requested')
    const servers = await browseNearby()
    log('studio:host-browse-nearby: answered', { found: servers.length })
    return servers
  })

  ipcMain.handle(IPC.HOST_SSH_ADD_ENVIRONMENT, async (_event, destination: unknown, label: unknown) => {
    if (typeof destination !== 'string' || !destination.trim()) {
      warn('studio:host-ssh-add-environment: refused, destination is not a string')
      return { ok: false, error: 'Enter a host to connect to.' }
    }
    const wanted = typeof label === 'string' ? label : undefined
    log('studio:host-ssh-add-environment: requested', { destination, has_label: !!wanted })
    const result = await addEnvironmentOverSsh({
      destinationInput: destination,
      label: wanted,
      tunnels: sshTunnels,
      onProgress: (progress) => pushToWindows(IPC.HOST_SSH_PROGRESS, progress),
    })
    if (result.ok) {
      registerEnvironmentLabel(result.target.environmentId ?? result.target.url, result.target.label)
      log('studio:host-ssh-add-environment: added', { environment_id: result.target.environmentId, label: result.target.label })
    } else {
      warn('studio:host-ssh-add-environment: failed', { destination, error: result.error })
    }
    return result
  })

  ipcMain.on(IPC.HOST_DISCONNECT_ENVIRONMENT, (_event, environmentId: string) => {
    log('studio:host-disconnect-environment: disconnect requested', { environment_id: environmentId })
    portForwards.stopEnvironment(environmentId)
    disconnectEnvironment(environmentId)
  })

  ipcMain.on(IPC.HOST_RESTART_ENVIRONMENT, (_event, environmentId: string) => {
    log('studio:host-restart-environment: restart requested', { environment_id: environmentId })
    restartEnvironment(environmentId)
  })

  ipcMain.handle(IPC.HOST_GET_ENV_CACHE, (_event, environmentId: string) => {
    log('studio:host-get-env-cache: read requested', { environment_id: environmentId })
    return readEnvCache(environmentId)
  })

  onTransferProgress((progress) => {
    pushToWindows(IPC.HOST_TRANSFER_PROGRESS, progress)
  })

  ipcMain.handle(IPC.HOST_TRANSFER_EXPORT_TO_FILE, (_event, environmentId: string, tabId: string, targetEnvironmentId: string, options: unknown) => {
    const exportOptions = options && typeof options === 'object' ? (options as ExportFileOptions) : {}
    log('studio:host-transfer-export-to-file: requested', { environment_id: environmentId, tab_id: tabId, target_environment_id: targetEnvironmentId, include_source_branch: exportOptions.includeSourceBranch === true, known_tips: exportOptions.knownTips?.length ?? 0 })
    return exportToFile(environmentId, tabId, targetEnvironmentId, exportOptions)
  })

  ipcMain.handle(IPC.HOST_TRANSFER_IMPORT_FROM_FILE, (_event, environmentId: string, tabId: string, filePath: string, landing: TransferLanding | null) => {
    log('studio:host-transfer-import-from-file: requested', { environment_id: environmentId, tab_id: tabId, file_path: filePath, landing_kind: landing?.kind ?? '' })
    return importFromFile(environmentId, tabId, filePath, landing ?? null)
  })

  ipcMain.handle(IPC.HOST_TRANSFER_CANCEL, (_event, tabId: string) => {
    log('studio:host-transfer-cancel: requested', { tab_id: tabId })
    return cancelTransfer(tabId)
  })

  portForwards.onChange((forwards) => {
    pushToWindows(IPC.HOST_PORT_FORWARDS, forwards)
  })

  ipcMain.handle(IPC.HOST_PORT_FORWARDS, () => {
    log('studio:host-port-forwards: list requested')
    return portForwards.list()
  })

  ipcMain.handle(IPC.HOST_PORT_FORWARD_START, (_event, environmentId: unknown, remotePort: unknown) => {
    log('studio:host-port-forward-start: requested', { environment_id: String(environmentId), remote_port: String(remotePort) })
    return portForwards.start(environmentId as string, remotePort as number)
  })

  ipcMain.handle(IPC.HOST_PORT_FORWARD_STOP, (_event, environmentId: unknown, remotePort: unknown) => {
    log('studio:host-port-forward-stop: requested', { environment_id: String(environmentId), remote_port: String(remotePort) })
    if (typeof environmentId !== 'string' || typeof remotePort !== 'number') return false
    return portForwards.stop(environmentId, remotePort)
  })

  log('studio-bridge: wired broker to IPC')
}

function isSendPayload(v: unknown): v is { environmentId: string; frame: StudioFrame } {
  if (!v || typeof v !== 'object') return false
  const p = v as { environmentId?: unknown; frame?: unknown }
  return typeof p.environmentId === 'string' && !!p.frame && typeof p.frame === 'object' && typeof (p.frame as { type?: unknown }).type === 'string'
}

/** TEST ONLY. Resets the module-level wiring guard so a fresh registration can run in the next test. */
export function _resetStudioBridgeForTest(): void {
  wired = false
  environmentLabels.clear()
}
