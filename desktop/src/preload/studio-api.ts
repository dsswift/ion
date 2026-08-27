/**
 * Preload bridge surface for the Ion Studio.
 *
 * Kept in its own module (spread into the main `api` object in index.ts) so
 * the primary preload file stays under the repo file-size cap and the Studio window
 * surface has one seam. The same preload serves both the main renderer and
 * the Studio window; the main renderer simply never calls these.
 */
import { ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/types'
import type { BrowserSessionMode } from '../shared/studio-surface-types'
import type { StudioBrowserCommandEnvelope, StudioBrowserCommandResult } from '../shared/studio-browser-types'
import type { StudioGetStateResult, StudioHistoryReplace, StudioRawPackBundle, StudioSettings, StudioTabListEntry, StudioTabState, StudioThemeListEntry, StudioUserMessageEcho, StudioWorktreeSnapshot } from '../shared/types-studio'

export interface StudioApi {
  /** Current runtime platform, used to reserve native title-bar control space. */
  platform: NodeJS.Platform;
  /** Set native window-control overlay colors on platforms that use it. */
  studioSetTitleBarOverlay(color: string, symbolColor: string): Promise<boolean>
  /** Native full-screen state controls renderer title-bar insets. */
  onStudioWindowChrome(callback: (state: { fullScreen: boolean }) => void): () => void
  /** Open (or focus) the Studio window. Fire-and-forget. */
  studioOpen(): void
  /**
   * Pull the active tab and its cached agent/dispatch state. Pass a tabId to
   * target a specific tab; omit for the current active tab.
   */
  studioGetState(tabId?: string): Promise<StudioGetStateResult | null>
  /** Read the Studio window-scoped settings (theme, pin, zoom, seeds). */
  studioGetSettings(): Promise<StudioSettings>
  /** Write one Studio-scoped setting. Key must be a Studio window key; returns false on rejection. */
  studioSetSetting(key: string, value: unknown): Promise<boolean>
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
  /**
   * Active-tab pushes from main: fires on every tab switch in the main
   * renderer (and once on Studio open) with the tab's cached state snapshot and
   * the tab's engineProfileId (extension seed scope; null = plain tab).
   */
  onStudioActiveTab(callback: (tabId: string, state: StudioTabState, profileId: string | null) => void): () => void
  /** Conversation list for the Studio window toolbar picker. */
  studioListTabs(): Promise<StudioTabListEntry[]>
  /** Switch the desktop's active tab (and thereby the Studio window target). */
  studioFocusTab(tabId: string): void
  /** Open an agent's dispatch detail in the desktop (switches tab first). */
  studioFocusAgent(tabId: string, agentName: string): void
  /** Main-renderer side: agent selections arriving from the Studio window. */
  onStudioFocusAgent(callback: (tabId: string, agentName: string) => void): () => void
  /** Main-renderer side: Studio window opened/closed (launcher-button indicator). */
  onStudioWindowState(callback: (open: boolean) => void): () => void
  /**
   * Mirror-store forwarding (Studio window): route an owner-durable store action
   * to the overlay renderer for execution AND return what it produced. Action
   * must be in FORWARDED_ACTIONS; args must be structured-cloneable.
   *
   * The envelope's `ok` describes the ROUND TRIP, not the action's own success:
   * `ok: true` carries the owner's return value in `value` (which may itself be
   * a `{ ok: false }` domain result), and `ok: false` means the call never
   * concluded — rejected, no owner window, or no reply before the deadline.
   * It never rejects.
   */
  studioCallAction(action: string, args: unknown[]): Promise<{ ok: boolean; value?: unknown; error?: string }>
  /**
   * Owner-renderer side: forwarded actions arriving from the Studio mirror.
   *
   * `callId` is present only for `studioCallAction` round trips; when set, the
   * owner must reply exactly once via `studioActionResult(callId, value)`.
   */
  onStudioExecAction(callback: (action: string, args: unknown[], callId?: string) => void): () => void
  /** Owner-renderer side: return a called action's value to the waiting mirror. */
  studioActionResult(callId: string, value: unknown): void
  /** Owner-renderer side: publish the persisted tabs snapshot for the mirror. */
  studioPublishTabsSync(snapshot: unknown): void
  /** Studio side: boot pull of the last published tabs snapshot (null = none yet). */
  studioGetTabsSync(): Promise<unknown | null>
  /** Studio side: live tab-metadata snapshots pushed after every owner persist. */
  onStudioTabsSync(callback: (snapshot: unknown) => void): () => void
  /** Owner-renderer side: publish a complete worktree and bench snapshot. */
  studioPublishWorktreeSync(snapshot: Omit<StudioWorktreeSnapshot, 'revision'>): void
  /** Studio side: boot pull of the last owner-published worktree snapshot. */
  studioGetWorktreeSync(): Promise<StudioWorktreeSnapshot | null>
  /** Studio side: live worktree and bench snapshots from the owner renderer. */
  onStudioWorktreeSync(callback: (snapshot: StudioWorktreeSnapshot) => void): () => void
  /** Studio side: a permission was answered on some surface — clear it locally. */
  onStudioPermissionResolved(callback: (tabId: string, questionId: string) => void): () => void
  /** Resolve a dropped File's filesystem path (sandboxed renderers can't read File.path). */
  getPathForFile(file: File): string
  /** Surface the overlay glass from the Studio window (palette cross-link). */
  studioShowOverlay(): void
  /** Save a composed office-snapshot PNG (save dialog). True on success. */
  studioExportImage(png: ArrayBuffer): Promise<boolean>
  /** Save a recorded office clip (webm, save dialog). True on success. */
  studioExportVideo(webm: ArrayBuffer): Promise<boolean>
  /** Studio side: user prompt submitted on some surface — insert into the mirror transcript. */
  onStudioUserMessageEcho(callback: (tabId: string, echo: StudioUserMessageEcho) => void): () => void
  /** Studio side: a successful engine rewind committed a new message list for
   *  one instance — replace the pane instance's messages wholesale. */
  onStudioHistoryReplace(callback: (payload: StudioHistoryReplace) => void): () => void
  /** Live per-tab summaries (campus view). */
  studioGetAllStatus(): Promise<Array<{ tabId: string; state: string; working: number; error: number; total: number; pendingPermissions: number }>>
  /**
   * Main-renderer side: picker selections arriving from the Studio window
   * (route to the tab slice's selectTab).
   */
  onStudioFocusTab(callback: (tabId: string) => void): () => void
  /** List discovered theme packs (id, name, source root). */
  studioListThemes(): Promise<StudioThemeListEntry[]>
  /** Read every JSON manifest in a pack, raw (renderer validates). Null for unknown packs. */
  studioReadThemeBundle(packId: string): Promise<StudioRawPackBundle | null>
  /** Read raw asset bytes (PNG) inside a pack. Returns null on invalid path. */
  studioReadThemeAsset(packId: string, relPath: string): Promise<ArrayBuffer | null>
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
  studioOpen: () => ipcRenderer.send(IPC.STUDIO_OPEN),
  studioGetState: (tabId) => ipcRenderer.invoke(IPC.STUDIO_GET_STATE, tabId),
  studioGetSettings: () => ipcRenderer.invoke(IPC.STUDIO_GET_SETTINGS),
  studioSetSetting: (key, value) => ipcRenderer.invoke(IPC.STUDIO_SET_SETTING, key, value),
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
  onStudioActiveTab: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, state: StudioTabState, profileId: string | null) =>
      callback(tabId, state, profileId ?? null)
    ipcRenderer.on(IPC.STUDIO_ACTIVE_TAB, handler)
    return () => ipcRenderer.removeListener(IPC.STUDIO_ACTIVE_TAB, handler)
  },
  studioListTabs: () => ipcRenderer.invoke(IPC.STUDIO_LIST_TABS),
  studioFocusTab: (tabId) => ipcRenderer.send(IPC.STUDIO_FOCUS_TAB, tabId),
  studioFocusAgent: (tabId, agentName) => ipcRenderer.send(IPC.STUDIO_FOCUS_AGENT, tabId, agentName),
  onStudioFocusAgent: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, agentName: string) => callback(tabId, agentName)
    ipcRenderer.on(IPC.STUDIO_FOCUS_AGENT, handler)
    return () => ipcRenderer.removeListener(IPC.STUDIO_FOCUS_AGENT, handler)
  },
  onStudioFocusTab: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, tabId: string) => callback(tabId)
    ipcRenderer.on(IPC.STUDIO_FOCUS_TAB, handler)
    return () => ipcRenderer.removeListener(IPC.STUDIO_FOCUS_TAB, handler)
  },
  onStudioWindowState: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, open: boolean) => callback(open === true)
    ipcRenderer.on(IPC.STUDIO_WINDOW_STATE, handler)
    return () => ipcRenderer.removeListener(IPC.STUDIO_WINDOW_STATE, handler)
  },
  studioCallAction: (action, args) => ipcRenderer.invoke(IPC.STUDIO_CALL_ACTION, action, args),
  studioShowOverlay: () => ipcRenderer.send(IPC.STUDIO_SHOW_OVERLAY),
  studioExportImage: (png) => ipcRenderer.invoke(IPC.STUDIO_EXPORT_IMAGE, png),
  studioGetAllStatus: () => ipcRenderer.invoke(IPC.STUDIO_GET_ALL_STATUS),
  studioExportVideo: (webm) => ipcRenderer.invoke(IPC.STUDIO_EXPORT_VIDEO, webm),
  onStudioUserMessageEcho: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, echo: StudioUserMessageEcho) => callback(tabId, echo)
    ipcRenderer.on(IPC.STUDIO_USER_MESSAGE_ECHO, handler)
    return () => ipcRenderer.removeListener(IPC.STUDIO_USER_MESSAGE_ECHO, handler)
  },
  onStudioHistoryReplace: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, payload: StudioHistoryReplace) => callback(payload)
    ipcRenderer.on(IPC.STUDIO_HISTORY_REPLACE, handler)
    return () => ipcRenderer.removeListener(IPC.STUDIO_HISTORY_REPLACE, handler)
  },
  studioPublishTabsSync: (snapshot) => ipcRenderer.send(IPC.STUDIO_PUBLISH_TABS_SYNC, snapshot),
  studioGetTabsSync: () => ipcRenderer.invoke(IPC.STUDIO_GET_TABS_SYNC),
  onStudioTabsSync: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, snapshot: unknown) => callback(snapshot)
    ipcRenderer.on(IPC.STUDIO_TABS_SYNC, handler)
    return () => ipcRenderer.removeListener(IPC.STUDIO_TABS_SYNC, handler)
  },
  studioPublishWorktreeSync: (snapshot) => ipcRenderer.send(IPC.STUDIO_PUBLISH_WORKTREE_SYNC, snapshot),
  studioGetWorktreeSync: () => ipcRenderer.invoke(IPC.STUDIO_GET_WORKTREE_SYNC),
  onStudioWorktreeSync: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, snapshot: StudioWorktreeSnapshot) => callback(snapshot)
    ipcRenderer.on(IPC.STUDIO_WORKTREE_SYNC, handler)
    return () => ipcRenderer.removeListener(IPC.STUDIO_WORKTREE_SYNC, handler)
  },
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  onStudioPermissionResolved: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, questionId: string) => callback(tabId, questionId)
    ipcRenderer.on(IPC.STUDIO_PERMISSION_RESOLVED, handler)
    return () => ipcRenderer.removeListener(IPC.STUDIO_PERMISSION_RESOLVED, handler)
  },
  onStudioExecAction: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, action: string, args: unknown[], callId?: string) =>
      callback(action, Array.isArray(args) ? args : [], callId)
    ipcRenderer.on(IPC.STUDIO_EXEC_ACTION, handler)
    return () => ipcRenderer.removeListener(IPC.STUDIO_EXEC_ACTION, handler)
  },
  studioActionResult: (callId, value) => ipcRenderer.send(IPC.STUDIO_ACTION_RESULT, callId, value),
  studioListThemes: () => ipcRenderer.invoke(IPC.STUDIO_LIST_THEMES),
  studioReadThemeBundle: (packId) => ipcRenderer.invoke(IPC.STUDIO_READ_THEME_BUNDLE, packId),
  studioReadThemeAsset: (packId, relPath) =>
    ipcRenderer.invoke(IPC.STUDIO_READ_THEME_ASSET, packId, relPath),
}
