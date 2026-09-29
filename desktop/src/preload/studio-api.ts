/**
 * Preload bridge surface for the Ion Studio.
 *
 * Kept in its own module (spread into the main `api` object in index.ts) so
 * the primary preload file stays under the repo file-size cap and the Studio window
 * surface has one seam. The same preload serves both the main renderer and
 * the Studio window; the main renderer simply never calls these.
 */
import { ipcRenderer, webUtils } from 'electron'
import type { NearbyStudioServer } from '@ion/shared/types-nearby'
import { IPC } from '@ion/shared/types'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import type { ConnectionPhaseSnapshot } from '../shared/types-connections'
import type { BrowserSessionMode } from '@ion/shared/studio-surface-types'
import type { StudioBrowserCommandEnvelope, StudioBrowserCommandResult } from '@ion/shared/studio-browser-types'
import type { SshAddEnvironmentProgress, SshAddEnvironmentResult } from '@ion/shared/types-ssh-environment'
import type { EnvironmentTarget } from '@ion/shared/types-environments'
import type { ExportFileOptions, ExportFileResult, ImportFileResult, TransferLanding, TransferProgress } from '@ion/shared/types-transfer'

/** Subscribers to host frames; see `onHostFrame` for why one IPC listener serves them all. */
const hostFrameSubscribers = new Set<(environmentId: string, frame: StudioFrame) => void>()
function hostFrameFanOut(_e: Electron.IpcRendererEvent, payload: { environmentId: string; frame: StudioFrame }): void {
  // Copy first: a subscriber may unsubscribe (or subscribe) while we iterate.
  for (const cb of [...hostFrameSubscribers]) cb(payload.environmentId, payload.frame)
}

export interface StudioApi {
  /** Current runtime platform, used to reserve native title-bar control space. */
  platform: NodeJS.Platform;
  /** Set native window-control overlay colors on platforms that use it. */
  studioSetTitleBarOverlay(color: string, symbolColor: string): Promise<boolean>
  /** Native full-screen state controls renderer title-bar insets. */
  onStudioWindowChrome(callback: (state: { fullScreen: boolean }) => void): () => void
  /** D6: lift the offline block for one browser preview partition. */
  studioPreviewAllowNetwork(partition: string): Promise<boolean>
  /**
   * Create (or reuse) the main-process browser view for a tab.
   *
   * The body is a WebContentsView rather than a <webview> element because
   * Playwright cannot attach to a `webview` CDP target. The renderer therefore
   * gets no element back — it measures geometry and calls the bounds channel.
   */
  studioBrowserViewEnsure(conversationId: string, instanceId: string, url: string, partition: string): Promise<boolean>
  /** Position the view over the area the renderer measured for its body. */
  studioBrowserViewBounds(conversationId: string, instanceId: string, bounds: { x: number; y: number; width: number; height: number }, visible: boolean): void
  studioBrowserViewNavigate(conversationId: string, instanceId: string, url: string): Promise<boolean>
  studioBrowserViewAction(conversationId: string, instanceId: string, action: 'back' | 'forward' | 'reload'): Promise<boolean>
  studioBrowserViewClose(conversationId: string, instanceId: string): Promise<boolean>
  /**
   * Where the on-screen popovers are, in window coordinates.
   *
   * Browser guests are main-process views that paint above all page content, so
   * a DOM popover cannot be stacked over one. Main shrinks the view out from
   * under these rectangles rather than hiding it, which would blank the whole
   * page behind a small menu.
   */
  studioBrowserPopoverRects(rects: Array<{ x: number; y: number; width: number; height: number }>): void
  /** The guest navigated or retitled itself; used to drive the URL bar. */
  onStudioBrowserViewState(callback: (state: {
    conversationId: string
    instanceId: string
    url: string
    title: string
    canGoBack: boolean
    canGoForward: boolean
  }) => void): () => void
  /**
   * Receive correlated browser commands from main (ensure/close/reveal/status
   * /emulate). The handler MUST answer exactly once through
   * `studioBrowserCommandResult` with the same callId, or main resolves the
   * command as a timeout refusal.
   */
  onStudioBrowserCommand(callback: (envelope: StudioBrowserCommandEnvelope) => void): () => void
  /** Answer one browser command. */
  studioBrowserCommandResult(result: StudioBrowserCommandResult): void
  /**
   * A link the operator cmd-clicked inside a Surface browser guest. Chromium
   * reports it as a new-tab disposition, which the webview policy denies as a
   * popup, so main forwards it here to become a real Surface tab.
   */
  onStudioBrowserOpenUrl(callback: (url: string) => void): () => void
  /** Set the browser session policy for one Surface tab. */
  studioBrowserSetSessionMode(instanceId: string, mode: BrowserSessionMode): Promise<boolean>
  /** Enable or restore the network shield for one isolated browser tab. */
  studioBrowserSetNetworkShield(instanceId: string, enabled: boolean): Promise<boolean>
  /** Resolve a dropped File's filesystem path (sandboxed renderers can't read File.path). */
  getPathForFile(file: File): string
  /** Save a composed office-snapshot PNG (save dialog). True on success. */
  studioExportImage(png: ArrayBuffer): Promise<boolean>
  /** Save a recorded office clip (webm, save dialog). True on success. */
  studioExportVideo(webm: ArrayBuffer): Promise<boolean>

  // ─── StudioHost bridge (spec 12) ───────────────────────────────────────
  /** Relays one Studio wire frame to an environment's connection, unchanged. */
  hostSendFrame(environmentId: string, frame: StudioFrame): void
  /** Every frame the broker relayed from any environment. */
  onHostFrame(callback: (environmentId: string, frame: StudioFrame) => void): () => void
  /** The current phase of every known environment connection. */
  hostGetConnections(): Promise<ConnectionPhaseSnapshot[]>
  /** Live connection phase snapshots (pushed on every transition). */
  onHostConnections(callback: (snapshot: ConnectionPhaseSnapshot[]) => void): () => void
  /** Reads `desktop.json` (device-local settings; never over the Studio wire). */
  hostGetDeviceSettings(): Promise<Record<string, unknown>>
  /** Writes one device-local setting. */
  hostSetDeviceSetting(key: string, value: unknown): Promise<void>
  /** Native "choose a file" dialog. Null when cancelled. */
  hostPickFile(options?: { multiple?: boolean; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string[] | null>
  /** Asks main to connect one non-local environment (spec 13): main resolves the transport and stored credential. */
  hostConnectEnvironment(environmentId: string, label: string, target: EnvironmentTarget): Promise<{ ok: boolean; error?: string }>
  /** Completes a pasted pairing link against its server (spec 13): main runs the key exchange and stores the secret; the renderer receives only the catalog target. */
  hostPairEnvironment(link: string, label?: string): Promise<{ ok: true; target: EnvironmentTarget } | { ok: false; error: string }>
  /** The SSH door (spec 13): main installs the Studio server on `destination` over ssh, tunnels to it, pairs, and returns the `via: 'ssh'` target. */
  hostSshAddEnvironment(destination: string, label?: string): Promise<SshAddEnvironmentResult>
  /** One bounded look at the LAN for Studio Servers that made themselves discoverable. */
  hostBrowseNearby(): Promise<NearbyStudioServer[]>
  /** Stage transitions and installer lines while `hostSshAddEnvironment` runs. */
  onHostSshProgress(callback: (progress: SshAddEnvironmentProgress) => void): () => void
  /** Asks main to disconnect one environment's connection (closedByUser — no auto-retry). */
  hostDisconnectEnvironment(environmentId: string): void
  /** Asks main to re-arm the backoff ladder and reconnect immediately. */
  hostRestartEnvironment(environmentId: string): void
  /** Reads back one environment's cached last-welcome frame (spec 13 env-cache), or null when absent. */
  hostGetEnvCache(environmentId: string): Promise<{ welcome: StudioFrame; cachedAt: number } | null>
  /** Requests `transfer.export` on `environmentId` for `tabId` and receives the archive into a local temp file (spec 15). */
  hostTransferExportToFile(environmentId: string, tabId: string, targetEnvironmentId: string, options?: ExportFileOptions): Promise<ExportFileResult>
  /** Streams a local file to `environmentId`'s `transfer.import` and deletes it afterward, success or failure (spec 15). */
  hostTransferImportFromFile(environmentId: string, tabId: string, filePath: string, landing?: TransferLanding | null): Promise<ImportFileResult>
  /** Byte-level progress for every in-flight export/import, keyed by the source tab id (spec 15). */
  onHostTransferProgress(callback: (progress: TransferProgress) => void): () => void
  /** Abandons the in-flight export/import for `tabId`. Resolves to whether there was one. */
  hostTransferCancel(tabId: string): Promise<boolean>
}

export const studioApi: StudioApi = {
  platform: process.platform,
  studioSetTitleBarOverlay: (color, symbolColor) =>
    ipcRenderer.invoke(IPC.STUDIO_SET_TITLE_BAR_OVERLAY, color, symbolColor),
  onStudioWindowChrome: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, state: { fullScreen: boolean }) =>
      callback({ fullScreen: state?.fullScreen === true })
    ipcRenderer.on(IPC.STUDIO_WINDOW_CHROME, handler)
    return () => ipcRenderer.removeListener(IPC.STUDIO_WINDOW_CHROME, handler)
  },
  studioPreviewAllowNetwork: (partition) => ipcRenderer.invoke(IPC.STUDIO_PREVIEW_ALLOW_NETWORK, partition),
  studioBrowserViewEnsure: (conversationId, instanceId, url, partition) =>
    ipcRenderer.invoke(IPC.STUDIO_BROWSER_VIEW_ENSURE, conversationId, instanceId, url, partition),
  studioBrowserViewBounds: (conversationId, instanceId, bounds, visible) =>
    ipcRenderer.send(IPC.STUDIO_BROWSER_VIEW_BOUNDS, conversationId, instanceId, bounds, visible),
  studioBrowserViewNavigate: (conversationId, instanceId, url) =>
    ipcRenderer.invoke(IPC.STUDIO_BROWSER_VIEW_NAVIGATE, conversationId, instanceId, url),
  studioBrowserViewAction: (conversationId, instanceId, action) =>
    ipcRenderer.invoke(IPC.STUDIO_BROWSER_VIEW_ACTION, conversationId, instanceId, action),
  studioBrowserViewClose: (conversationId, instanceId) =>
    ipcRenderer.invoke(IPC.STUDIO_BROWSER_VIEW_CLOSE, conversationId, instanceId),
  studioBrowserPopoverRects: (rects) => ipcRenderer.send(IPC.STUDIO_BROWSER_POPOVER_RECTS, rects),
  onStudioBrowserViewState: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, s: Parameters<typeof callback>[0]) => callback(s)
    ipcRenderer.on(IPC.STUDIO_BROWSER_VIEW_STATE, handler)
    return () => ipcRenderer.removeListener(IPC.STUDIO_BROWSER_VIEW_STATE, handler)
  },
  onStudioBrowserCommand: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, envelope: StudioBrowserCommandEnvelope) => callback(envelope)
    ipcRenderer.on(IPC.STUDIO_BROWSER_COMMAND, handler)
    return () => ipcRenderer.removeListener(IPC.STUDIO_BROWSER_COMMAND, handler)
  },
  studioBrowserCommandResult: (result) => ipcRenderer.send(IPC.STUDIO_BROWSER_COMMAND_RESULT, result),
  onStudioBrowserOpenUrl: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, url: string) => callback(url)
    ipcRenderer.on(IPC.STUDIO_BROWSER_OPEN_URL, handler)
    return () => ipcRenderer.removeListener(IPC.STUDIO_BROWSER_OPEN_URL, handler)
  },
  studioBrowserSetSessionMode: (instanceId, mode) => ipcRenderer.invoke(IPC.STUDIO_BROWSER_SET_SESSION_MODE, instanceId, mode),
  studioBrowserSetNetworkShield: (instanceId, enabled) => ipcRenderer.invoke(IPC.STUDIO_BROWSER_SET_NETWORK_SHIELD, instanceId, enabled),
  studioExportImage: (png) => ipcRenderer.invoke(IPC.STUDIO_EXPORT_IMAGE, png),
  studioExportVideo: (webm) => ipcRenderer.invoke(IPC.STUDIO_EXPORT_VIDEO, webm),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  hostSendFrame: (environmentId, frame) => ipcRenderer.send(IPC.STUDIO_SEND, { environmentId, frame }),
  onHostFrame: (callback) => {
    // One ipcRenderer listener fans out to every subscriber. Each bridged
    // shell call subscribes for the life of its own request, so a dozen
    // concurrent calls (the Studio boot burst) used to register a dozen
    // ipcRenderer listeners and trip MaxListenersExceededWarning on every
    // launch; the warning read like a leak and hid real ones.
    hostFrameSubscribers.add(callback)
    if (hostFrameSubscribers.size === 1) ipcRenderer.on(IPC.STUDIO_FRAME, hostFrameFanOut)
    return () => {
      hostFrameSubscribers.delete(callback)
      if (hostFrameSubscribers.size === 0) ipcRenderer.removeListener(IPC.STUDIO_FRAME, hostFrameFanOut)
    }
  },
  hostGetConnections: () => ipcRenderer.invoke(IPC.STUDIO_CONNECTIONS),
  onHostConnections: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, snapshot: ConnectionPhaseSnapshot[]) => callback(snapshot)
    ipcRenderer.on(IPC.STUDIO_CONNECTIONS, handler)
    return () => ipcRenderer.removeListener(IPC.STUDIO_CONNECTIONS, handler)
  },
  hostGetDeviceSettings: () => ipcRenderer.invoke(IPC.STUDIO_DEVICE_SETTINGS_GET),
  hostSetDeviceSetting: (key, value) => ipcRenderer.invoke(IPC.STUDIO_DEVICE_SETTINGS_SET, key, value),
  hostPickFile: (options) => ipcRenderer.invoke(IPC.STUDIO_PICK_FILE, options),
  hostConnectEnvironment: (environmentId, label, target) =>
    ipcRenderer.invoke(IPC.HOST_CONNECT_ENVIRONMENT, environmentId, label, target),
  hostPairEnvironment: (link, label) => ipcRenderer.invoke(IPC.HOST_PAIR_ENVIRONMENT, link, label),
  hostSshAddEnvironment: (destination, label) => ipcRenderer.invoke(IPC.HOST_SSH_ADD_ENVIRONMENT, destination, label),
  hostBrowseNearby: () => ipcRenderer.invoke(IPC.HOST_BROWSE_NEARBY),
  onHostSshProgress: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, progress: SshAddEnvironmentProgress) => callback(progress)
    ipcRenderer.on(IPC.HOST_SSH_PROGRESS, handler)
    return () => ipcRenderer.removeListener(IPC.HOST_SSH_PROGRESS, handler)
  },
  hostDisconnectEnvironment: (environmentId) => ipcRenderer.send(IPC.HOST_DISCONNECT_ENVIRONMENT, environmentId),
  hostRestartEnvironment: (environmentId) => ipcRenderer.send(IPC.HOST_RESTART_ENVIRONMENT, environmentId),
  hostGetEnvCache: (environmentId) => ipcRenderer.invoke(IPC.HOST_GET_ENV_CACHE, environmentId),
  hostTransferExportToFile: (environmentId, tabId, targetEnvironmentId, options) =>
    ipcRenderer.invoke(IPC.HOST_TRANSFER_EXPORT_TO_FILE, environmentId, tabId, targetEnvironmentId, options ?? {}),
  hostTransferImportFromFile: (environmentId, tabId, filePath, landing) =>
    ipcRenderer.invoke(IPC.HOST_TRANSFER_IMPORT_FROM_FILE, environmentId, tabId, filePath, landing ?? null),
  hostTransferCancel: (tabId) => ipcRenderer.invoke(IPC.HOST_TRANSFER_CANCEL, tabId),
  onHostTransferProgress: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, progress: TransferProgress) => callback(progress)
    ipcRenderer.on(IPC.HOST_TRANSFER_PROGRESS, handler)
    return () => ipcRenderer.removeListener(IPC.HOST_TRANSFER_PROGRESS, handler)
  },
}
