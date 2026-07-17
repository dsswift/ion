/**
 * Preload bridge surface for the Agent Team Visualizer.
 *
 * Kept in its own module (spread into the main `api` object in index.ts) so
 * the primary preload file stays under the repo file-size cap and the ATV
 * surface has one seam. The same preload serves both the main renderer and
 * the ATV window; the main renderer simply never calls these.
 */
import { ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/types'
import type { AtvGetStateResult, AtvRawPackBundle, AtvSettings, AtvTabListEntry, AtvTabState, AtvThemeListEntry } from '../shared/types-atv'

export interface AtvApi {
  /** Open (or focus) the ATV window. Fire-and-forget. */
  atvOpen(): void
  /**
   * Pull the active tab and its cached agent/dispatch state. Pass a tabId to
   * target a specific tab; omit for the current active tab.
   */
  atvGetState(tabId?: string): Promise<AtvGetStateResult | null>
  /** Read the ATV-scoped settings (theme, pin, zoom, seeds). */
  atvGetSettings(): Promise<AtvSettings>
  /** Write one ATV-scoped setting. Key must be an ATV key; returns false on rejection. */
  atvSetSetting(key: string, value: unknown): Promise<boolean>
  /**
   * Active-tab pushes from main: fires on every tab switch in the main
   * renderer (and once on ATV open) with the tab's cached state snapshot and
   * the tab's engineProfileId (extension seed scope; null = plain tab).
   */
  onAtvActiveTab(callback: (tabId: string, state: AtvTabState, profileId: string | null) => void): () => void
  /** Conversation list for the ATV toolbar picker. */
  atvListTabs(): Promise<AtvTabListEntry[]>
  /** Switch the desktop's active tab (and thereby the ATV target). */
  atvFocusTab(tabId: string): void
  /** Open an agent's dispatch detail in the desktop (switches tab first). */
  atvFocusAgent(tabId: string, agentName: string): void
  /** Main-renderer side: agent selections arriving from the ATV window. */
  onAtvFocusAgent(callback: (tabId: string, agentName: string) => void): () => void
  /** Main-renderer side: ATV window opened/closed (launcher-button indicator). */
  onAtvWindowState(callback: (open: boolean) => void): () => void
  /**
   * Mirror-store forwarding (ATV window): route an owner-durable store
   * action to the overlay renderer for execution. Action must be in
   * FORWARDED_ACTIONS; args must be structured-cloneable.
   */
  atvForwardAction(action: string, args: unknown[]): void
  /** Owner-renderer side: forwarded actions arriving from the ATV mirror. */
  onAtvExecAction(callback: (action: string, args: unknown[]) => void): () => void
  /** Owner-renderer side: publish the persisted tabs snapshot for the mirror. */
  atvPublishTabsSync(snapshot: unknown): void
  /** ATV side: boot pull of the last published tabs snapshot (null = none yet). */
  atvGetTabsSync(): Promise<unknown | null>
  /** ATV side: live tab-metadata snapshots pushed after every owner persist. */
  onAtvTabsSync(callback: (snapshot: unknown) => void): () => void
  /** ATV side: a permission was answered on some surface — clear it locally. */
  onAtvPermissionResolved(callback: (tabId: string, questionId: string) => void): () => void
  /** Resolve a dropped File's filesystem path (sandboxed renderers can't read File.path). */
  getPathForFile(file: File): string
  /** Surface the overlay glass from the ATV (palette cross-link). */
  atvShowOverlay(): void
  /** Save a composed office-snapshot PNG (save dialog). True on success. */
  atvExportImage(png: ArrayBuffer): Promise<boolean>
  /** Save a recorded office clip (webm, save dialog). True on success. */
  atvExportVideo(webm: ArrayBuffer): Promise<boolean>
  /** ATV side: user prompt submitted on some surface — insert into the mirror transcript. */
  onAtvUserMessageEcho(callback: (tabId: string, text: string) => void): () => void
  /** Live per-tab summaries (campus view). */
  atvGetAllStatus(): Promise<Array<{ tabId: string; state: string; working: number; error: number; total: number; pendingPermissions: number }>>
  /**
   * Main-renderer side: picker selections arriving from the ATV window
   * (route to the tab slice's selectTab).
   */
  onAtvFocusTab(callback: (tabId: string) => void): () => void
  /** List discovered theme packs (id, name, source root). */
  atvListThemes(): Promise<AtvThemeListEntry[]>
  /** Read every JSON manifest in a pack, raw (renderer validates). Null for unknown packs. */
  atvReadThemeBundle(packId: string): Promise<AtvRawPackBundle | null>
  /** Read raw asset bytes (PNG) inside a pack. Returns null on invalid path. */
  atvReadThemeAsset(packId: string, relPath: string): Promise<ArrayBuffer | null>
}

export const atvApi: AtvApi = {
  atvOpen: () => ipcRenderer.send(IPC.ATV_OPEN),
  atvGetState: (tabId) => ipcRenderer.invoke(IPC.ATV_GET_STATE, tabId),
  atvGetSettings: () => ipcRenderer.invoke(IPC.ATV_GET_SETTINGS),
  atvSetSetting: (key, value) => ipcRenderer.invoke(IPC.ATV_SET_SETTING, key, value),
  onAtvActiveTab: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, state: AtvTabState, profileId: string | null) =>
      callback(tabId, state, profileId ?? null)
    ipcRenderer.on(IPC.ATV_ACTIVE_TAB, handler)
    return () => ipcRenderer.removeListener(IPC.ATV_ACTIVE_TAB, handler)
  },
  atvListTabs: () => ipcRenderer.invoke(IPC.ATV_LIST_TABS),
  atvFocusTab: (tabId) => ipcRenderer.send(IPC.ATV_FOCUS_TAB, tabId),
  atvFocusAgent: (tabId, agentName) => ipcRenderer.send(IPC.ATV_FOCUS_AGENT, tabId, agentName),
  onAtvFocusAgent: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, agentName: string) => callback(tabId, agentName)
    ipcRenderer.on(IPC.ATV_FOCUS_AGENT, handler)
    return () => ipcRenderer.removeListener(IPC.ATV_FOCUS_AGENT, handler)
  },
  onAtvFocusTab: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, tabId: string) => callback(tabId)
    ipcRenderer.on(IPC.ATV_FOCUS_TAB, handler)
    return () => ipcRenderer.removeListener(IPC.ATV_FOCUS_TAB, handler)
  },
  onAtvWindowState: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, open: boolean) => callback(open === true)
    ipcRenderer.on(IPC.ATV_WINDOW_STATE, handler)
    return () => ipcRenderer.removeListener(IPC.ATV_WINDOW_STATE, handler)
  },
  atvForwardAction: (action, args) => ipcRenderer.send(IPC.ATV_FORWARD_ACTION, action, args),
  atvShowOverlay: () => ipcRenderer.send(IPC.ATV_SHOW_OVERLAY),
  atvExportImage: (png) => ipcRenderer.invoke(IPC.ATV_EXPORT_IMAGE, png),
  atvGetAllStatus: () => ipcRenderer.invoke(IPC.ATV_GET_ALL_STATUS),
  atvExportVideo: (webm) => ipcRenderer.invoke(IPC.ATV_EXPORT_VIDEO, webm),
  onAtvUserMessageEcho: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, text: string) => callback(tabId, text)
    ipcRenderer.on(IPC.ATV_USER_MESSAGE_ECHO, handler)
    return () => ipcRenderer.removeListener(IPC.ATV_USER_MESSAGE_ECHO, handler)
  },
  atvPublishTabsSync: (snapshot) => ipcRenderer.send(IPC.ATV_PUBLISH_TABS_SYNC, snapshot),
  atvGetTabsSync: () => ipcRenderer.invoke(IPC.ATV_GET_TABS_SYNC),
  onAtvTabsSync: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, snapshot: unknown) => callback(snapshot)
    ipcRenderer.on(IPC.ATV_TABS_SYNC, handler)
    return () => ipcRenderer.removeListener(IPC.ATV_TABS_SYNC, handler)
  },
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  onAtvPermissionResolved: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, questionId: string) => callback(tabId, questionId)
    ipcRenderer.on(IPC.ATV_PERMISSION_RESOLVED, handler)
    return () => ipcRenderer.removeListener(IPC.ATV_PERMISSION_RESOLVED, handler)
  },
  onAtvExecAction: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, action: string, args: unknown[]) =>
      callback(action, Array.isArray(args) ? args : [])
    ipcRenderer.on(IPC.ATV_EXEC_ACTION, handler)
    return () => ipcRenderer.removeListener(IPC.ATV_EXEC_ACTION, handler)
  },
  atvListThemes: () => ipcRenderer.invoke(IPC.ATV_LIST_THEMES),
  atvReadThemeBundle: (packId) => ipcRenderer.invoke(IPC.ATV_READ_THEME_BUNDLE, packId),
  atvReadThemeAsset: (packId, relPath) =>
    ipcRenderer.invoke(IPC.ATV_READ_THEME_ASSET, packId, relPath),
}
