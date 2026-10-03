/**
 * ElectronStudioHost — the `StudioHost` implementation for the desktop.
 *
 * The `host*` methods are thin pass-throughs onto the `studio:*` IPC channels
 * `ipc/studio-bridge.ts` owns. `shell` is the interesting one.
 *
 * `shell` used to be a live passthrough onto the preload bridge, so every
 * file, git, terminal and settings call the desktop renderer made ran inside
 * the Electron main process -- against the same `@ion/server` code the Studio
 * wire reaches, but by a different route. That left two paths to one
 * implementation, and only a browser client ever took the wire, so gaps in it
 * went unnoticed until a browser client finally hit them.
 *
 * Now `shell` is the same `createBridgedShell` a browser builds, over the same
 * `studio_action` round trip, aimed at the Environment that owns whatever the
 * call concerns (`studio/connection/tab-environment.ts#resolveShellEnvironment`:
 * a terminal key or tab id names its owner, a path names the active
 * conversation's server, anything else is the local server). The desktop is
 * connected to every Environment at once (ADR-033), so there is no
 * "current" server -- each call is routed by its own subject. The preload
 * remains the FALLBACK for verbs the table does not carry -- native dialogs,
 * Finder, screen capture, tray, auto-update, and the `host*` relay methods
 * themselves. Those are exactly the verbs that need an operating system,
 * which is the one thing a browser lacks and this client has.
 */
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import type { NearbyStudioServer } from '@ion/shared/types-nearby'
import type { IonAPI } from '../../preload/ionapi'
import type { ShellApi } from './shell-api'
import type { ConnectionPhaseSnapshot } from '../../shared/types-connections'
import type { EnvironmentTarget } from '@ion/shared/types-environments'
import type { SshAddEnvironmentProgress, SshAddEnvironmentResult } from '@ion/shared/types-ssh-environment'
import type { ExportFileOptions, ExportFileResult, ImportFileResult, TransferLanding, TransferProgress } from '@ion/shared/types-transfer'
import type { Capability, PortForwardHost, StudioHost, FileDialogFilter } from './StudioHost'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { resolveShellEnvironment, activeTabEnvironmentId } from '../studio/connection/tab-environment'
import { BRIDGED_CAPABILITIES, type ShellSubscribeScope } from './browser-shell-bridge'
import { StudioActionFailure } from '@ion/shared/studio-wire/action-failure'
import { createBridgedShell } from './bridged-shell'
import { rWarn } from '../rendererLogger'
import { developerSurfaceBlock } from '@ion/shared/developer-surfaces'
import { policyStore } from '../studio/connection/policy-store'

/** Matches `host-actions.ts` so a bridged call fails the same way any other studio_action does. */
const BRIDGED_CALL_TIMEOUT_MS = 30_000

/**
 * What this host can do that a browser Studio client cannot: an operating
 * system. Every entry here names a verb or surface that needs Electron
 * (native dialogs, tray, updater, deep links, native window chrome, the
 * Playwright browser runtime, the splash window) or a local transport
 * (`local`, `relay`).
 *
 * The list shrinks and never grows: a name leaves it when the verb it gates
 * gains a `studio_action` path and moves to `BRIDGED_CAPABILITIES`, which
 * both hosts then report. `__tests__/electron-host-capabilities.test.ts`
 * pins the current contents so a regression back toward an Electron-only
 * route fails CI rather than surfacing as a dark feature in a browser tab.
 */
export const NATIVE_CAPABILITIES: readonly Capability[] = [
  'openExternal', 'pickFile', 'pickDirectory', 'clipboardWriteImage',
  'browser', 'deeplink', 'tray', 'notifications', 'local', 'relay',
  'terminal', 'git', 'files', 'questions', 'graph', 'updates',
  'webApplicationOpen',
  'startupReport', 'windowShown', 'nativeWindowChrome',
  'nativeShell',
]

/** The full set: the native set plus everything the wire already serves on any host. */
export const CAPABILITIES: readonly Capability[] = [
  ...NATIVE_CAPABILITIES,
  ...(BRIDGED_CAPABILITIES as readonly Capability[]),
]

export class ElectronStudioHost implements StudioHost {
  /**
   * The raw preload bridge. Resolved on every access (not cached) so a test's
   * `window.ion` stub, installed after this host is constructed, is honored.
   *
   * Internal: the relay methods below and the `shell` fallback. Call sites go
   * through `shell`, which routes bridged verbs over the wire.
   */
  private get preload(): IonAPI {
    return window.ion
  }

  readonly shell: ShellApi = createBridgedShell({
    invoke: (action, args, timeoutMs) => this.invokeBridged(action, args, timeoutMs),
    subscribe: (channel, cb, scope) => this.subscribeChannel(channel, cb, scope),
    sendOneWay: (action, args) => this.sendBridgedOneWay(action, args),
    // An unbridged verb is one that needs this machine, and Electron has it.
    fallback: (name) => (this.preload as unknown as Record<string, unknown> | undefined)?.[name],
    // Writes land on the preload object, exactly where they landed when
    // `shell` was that object.
    assign: (name, value) => {
      const preload = this.preload as unknown as Record<string, unknown> | undefined
      if (!preload) return false
      preload[name] = value
      return true
    },
  })

  send(environmentId: string, frame: StudioFrame): void {
    this.preload.hostSendFrame(environmentId, frame)
  }

  onFrame(cb: (environmentId: string, frame: StudioFrame) => void): () => void {
    return this.preload.onHostFrame(cb)
  }

  /** One bridged verb as a `studio_action` against the Environment its arguments name, correlated by id. */
  private invokeBridged(action: string, args: unknown[], timeoutMs: number = BRIDGED_CALL_TIMEOUT_MS): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID()
      const environmentId = resolveShellEnvironment(args)
      if (this.surfaceDisabled(action, environmentId)) {
        reject(new StudioActionFailure(`${action} is not available for this conversation`, 'surface_disabled'))
        return
      }
      // Declared before both closures reference it: `onFrame` can deliver a
      // reply synchronously, so a `const` assigned afterwards would still be
      // in its temporal dead zone when the handler runs.
      let unsubscribe: () => void = () => { /* replaced below */ }
      const timeout = setTimeout(() => {
        unsubscribe()
        rWarn('ElectronStudioHost', 'bridged shell call timed out', { action, id })
        reject(new Error(`${action} timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      unsubscribe = this.onFrame((envId, frame) => {
        if (envId !== environmentId || frame.type !== 'studio_action_result' || frame.id !== id) return
        clearTimeout(timeout)
        unsubscribe()
        if (frame.ok) resolve(frame.value)
        else {
          const failure = frame.refusal ?? frame.error
          reject(new StudioActionFailure(failure?.message ?? `${action} failed`, failure?.code))
        }
      })

      this.send(environmentId, { type: 'studio_action', id, action, args })
    })
  }

  /** Send-and-forget, for the verbs the preload sends rather than invokes. */
  private sendBridgedOneWay(action: string, args: unknown[]): void {
    const environmentId = resolveShellEnvironment(args)
    if (this.surfaceDisabled(action, environmentId)) return
    this.send(environmentId, { type: 'studio_action', id: crypto.randomUUID(), action, args })
  }

  /**
   * True when `action` belongs to a developer surface that is off for
   * `environmentId`. The server refuses what it does not offer; this also
   * holds a call this desktop's own device policy rules out, which a server
   * it is only visiting cannot know about.
   */
  private surfaceDisabled(action: string, environmentId: string): boolean {
    const blocked = developerSurfaceBlock(action, policyStore.developerSurfacesFor(environmentId))
    if (!blocked) return false
    rWarn('ElectronStudioHost', 'bridged shell call held: developer surface disabled', { action, environment_id: environmentId, surfaces: blocked })
    return true
  }

  /**
   * Attach a bridged `on*` listener to the `studio_event` channel that feeds
   * it, from the Environments its `scope` names (`ShellSubscribeScope`).
   * `active` is evaluated at DELIVERY time, so one subscription follows the
   * active conversation wherever it lives without re-registering.
   */
  private subscribeChannel(channel: string, cb: (payload: unknown, environmentId: string) => void, scope: ShellSubscribeScope): () => void {
    return this.onFrame((envId, frame) => {
      if (frame.type !== 'studio_event' || frame.channel !== channel) return
      if (scope === 'local' && envId !== LOCAL_ENVIRONMENT_ID) return
      if (scope === 'active' && envId !== activeTabEnvironmentId()) return
      // `tab` and `all` pass every Environment; `all` consumers key by the id.
      cb(frame.payload, envId)
    })
  }

  async connections(): Promise<ConnectionPhaseSnapshot[]> {
    return this.preload.hostGetConnections()
  }

  onConnections(cb: (snapshot: ConnectionPhaseSnapshot[]) => void): () => void {
    return this.preload.onHostConnections(cb)
  }

  async deviceSettings(): Promise<Record<string, unknown>> {
    return this.preload.hostGetDeviceSettings()
  }

  async setDeviceSetting(key: string, value: unknown): Promise<void> {
    const result = await this.preload.hostSetDeviceSetting(key, value)
    if (!result.ok) throw new Error(`${result.code}: ${result.message} (class: ${result.class})`)
  }

  capabilities(): Capability[] {
    return [...CAPABILITIES]
  }

  async openExternal(url: string): Promise<boolean> {
    try {
      return await this.shell.openExternal(url)
    } catch (err) {
      rWarn('ElectronStudioHost', 'openExternal failed', { url, error: (err as Error).message })
      return false
    }
  }

  async pickFile(options?: { multiple?: boolean; filters?: FileDialogFilter[] }): Promise<string[] | null> {
    return this.preload.hostPickFile(options)
  }

  async pickSavePath(defaultPath?: string, defaultFileName?: string, filters?: FileDialogFilter[]): Promise<{ filePath: string | null; error?: string }> {
    return this.shell.fsSaveDialog(defaultPath, defaultFileName, filters)
  }

  async faviconFor(hostname: string): Promise<string | null> {
    return this.shell.getFavicon(hostname)
  }

  async pickDirectory(): Promise<string | null> {
    return this.shell.selectDirectory()
  }

  async connectEnvironment(environmentId: string, label: string, target: EnvironmentTarget): Promise<{ ok: boolean; error?: string }> {
    return this.preload.hostConnectEnvironment(environmentId, label, target)
  }

  async pairEnvironment(link: string, label?: string): Promise<{ ok: true; target: EnvironmentTarget } | { ok: false; error: string }> {
    return this.preload.hostPairEnvironment(link, label)
  }

  async sshAddEnvironment(destination: string, label?: string): Promise<SshAddEnvironmentResult> {
    return this.preload.hostSshAddEnvironment(destination, label)
  }

  async browseNearby(): Promise<NearbyStudioServer[]> {
    return this.preload.hostBrowseNearby()
  }

  onSshProgress(cb: (progress: SshAddEnvironmentProgress) => void): () => void {
    return this.preload.onHostSshProgress(cb)
  }

  disconnectEnvironment(environmentId: string): void {
    this.preload.hostDisconnectEnvironment(environmentId)
  }

  restartEnvironment(environmentId: string): void {
    this.preload.hostRestartEnvironment(environmentId)
  }

  async getEnvCache(environmentId: string): Promise<{ welcome: StudioFrame; cachedAt: number } | null> {
    return this.preload.hostGetEnvCache(environmentId)
  }

  async exportToFile(environmentId: string, tabId: string, targetEnvironmentId: string, options?: ExportFileOptions): Promise<ExportFileResult> {
    return this.preload.hostTransferExportToFile(environmentId, tabId, targetEnvironmentId, options)
  }

  async importFromFile(environmentId: string, tabId: string, filePath: string, landing?: TransferLanding | null): Promise<ImportFileResult> {
    return this.preload.hostTransferImportFromFile(environmentId, tabId, filePath, landing ?? null)
  }

  onTransferProgress(cb: (progress: TransferProgress) => void): () => void {
    return this.preload.onHostTransferProgress(cb)
  }

  async cancelTransfer(tabId: string): Promise<boolean> {
    return this.preload.hostTransferCancel(tabId)
  }

  readonly portForward: PortForwardHost = {
    list: () => this.preload.hostPortForwards(),
    onChange: (cb) => this.preload.onHostPortForwards(cb),
    start: (environmentId, remotePort) => this.preload.hostPortForwardStart(environmentId, remotePort),
    stop: (environmentId, remotePort) => this.preload.hostPortForwardStop(environmentId, remotePort),
  }
}
