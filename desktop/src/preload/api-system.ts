import { ipcRenderer } from 'electron'
import { IPC } from '../shared/types'
import type { EnrichedError, NormalizedEvent } from '../shared/types'
import type { IonAPI } from './ionapi'

/**
 * Wrapper registry for the generic `on`/`off` bridge below.
 *
 * `on` cannot hand the caller's raw callback to `ipcRenderer.on` (the IPC
 * signature carries an `IpcRendererEvent` first argument that the wrapper
 * forwards), so `off` needs a way back from the callback to the wrapper that
 * was actually registered. Keyed callback → channel → wrapper. The outer
 * WeakMap lets a callback whose owner unmounted be collected along with its
 * wrappers.
 */
const ipcWrappers = new WeakMap<
  (...args: any[]) => void,
  Map<string, (_e: Electron.IpcRendererEvent, ...args: any[]) => void>
>()

/** Filesystem, engine, provider, window, and generic bridge methods. */
export const systemApi = {
  // ─── Filesystem operations ───
  fsReadDir: (directory) => ipcRenderer.invoke(IPC.FS_READ_DIR, { directory }),
  fsReadFile: (filePath) => ipcRenderer.invoke(IPC.FS_READ_FILE, { filePath }),
  fsWriteFile: (filePath, content) => ipcRenderer.invoke(IPC.FS_WRITE_FILE, { filePath, content }),
  fsCreateDir: (dirPath) => ipcRenderer.invoke(IPC.FS_CREATE_DIR, { dirPath }),
  fsCreateFile: (filePath) => ipcRenderer.invoke(IPC.FS_CREATE_FILE, { filePath }),
  fsRename: (oldPath, newPath) => ipcRenderer.invoke(IPC.FS_RENAME, { oldPath, newPath }),
  fsDelete: (targetPath) => ipcRenderer.invoke(IPC.FS_DELETE, { targetPath }),
  fsSaveDialog: (defaultPath, defaultFileName) => ipcRenderer.invoke(IPC.FS_SAVE_DIALOG, { defaultPath, defaultFileName }),
  fsRevealInFinder: (targetPath) => ipcRenderer.invoke(IPC.FS_REVEAL_IN_FINDER, { targetPath }),
  fsOpenNative: (targetPath) => ipcRenderer.invoke(IPC.FS_OPEN_NATIVE, { targetPath }),
  fsExists: (targetPath) => ipcRenderer.invoke(IPC.FS_EXISTS, { targetPath }),
  fsWatchFile: (filePath) => ipcRenderer.invoke(IPC.FS_WATCH_FILE, { filePath }),
  fsUnwatchFile: (filePath) => ipcRenderer.invoke(IPC.FS_UNWATCH_FILE, { filePath }),
  onFileChanged: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, filePath: string) => callback(filePath)
    ipcRenderer.on(IPC.FS_FILE_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC.FS_FILE_CHANGED, handler)
  },

  // ─── OS facilities ───
  copyPngToClipboard: (png: ArrayBuffer) => ipcRenderer.invoke(IPC.COPY_PNG_TO_CLIPBOARD, png),
  requestChartJump: (request: { tabId: string; chartId: string; messageId: string }) =>
    ipcRenderer.send(IPC.CHART_JUMP, request),
  reconcileCharts: (request: {
    tabId: string
    conversationId: string
    rows: Array<{ toolMessageId: string; toolInput: string; resultText: string; index: number }>
  }) => ipcRenderer.send(IPC.CHART_RECONCILE, request),
  onChartJump: (callback: (request: { tabId: string; chartId: string; messageId: string }) => void) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      request: { tabId: string; chartId: string; messageId: string },
    ) => callback(request)
    ipcRenderer.on(IPC.CHART_JUMP, handler)
    return () => ipcRenderer.removeListener(IPC.CHART_JUMP, handler)
  },
  /** Main announces that the resource catalog changed outside a live delta. */
  onResourceCatalogChanged: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC.RESOURCE_CATALOG_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC.RESOURCE_CATALOG_CHANGED, handler)
  },

  // ─── Engine operations ───
  engineStart: (key, config) => ipcRenderer.invoke(IPC.ENGINE_START, { key, config }),
  engineSetPlanMode: (key, enabled, planFilePath) => ipcRenderer.send('ion:engine-set-plan-mode', key, enabled, planFilePath),
  engineAbort: (key, scope = "all") =>
    ipcRenderer.invoke(IPC.ENGINE_ABORT, { key, scope }),
  engineAbortDispatch: (key, dispatchId) =>
    ipcRenderer.invoke(IPC.ENGINE_ABORT_DISPATCH, { key, dispatchId }),
  engineStopBackgroundTask: (key, taskId) =>
    ipcRenderer.invoke(IPC.ENGINE_STOP_BACKGROUND_TASK, { key, taskId }),
  engineDialogResponse: (key, dialogId, value) => ipcRenderer.invoke(IPC.ENGINE_DIALOG_RESPONSE, { key, dialogId, value }),
  engineCommand: (key, command, args) => ipcRenderer.invoke(IPC.ENGINE_COMMAND, { key, command, args }),
  engineStop: (key) => ipcRenderer.invoke(IPC.ENGINE_STOP, { key }),
  engineBranchBefore: (key, entryId) => ipcRenderer.invoke(IPC.ENGINE_BRANCH_BEFORE, { key, entryId }),
  engineRewind: (key, target) => ipcRenderer.invoke(IPC.ENGINE_REWIND, { key, ...target }),
  engineGetContextBreakdown: (key) => ipcRenderer.invoke(IPC.ENGINE_GET_CONTEXT_BREAKDOWN, { key }),
  getPlanBashAllowlist: () => ipcRenderer.invoke(IPC.GET_PLAN_BASH_ALLOWLIST),
  setPlanBashAllowlist: (cmds) => ipcRenderer.invoke(IPC.SET_PLAN_BASH_ALLOWLIST, cmds),
  engineRemapSession: (oldKey, newKey) => ipcRenderer.invoke(IPC.ENGINE_REMAP_SESSION, { oldKey, newKey }),
  engineBroadcastHistory: (tabId, instanceId) => ipcRenderer.invoke(IPC.ENGINE_BROADCAST_HISTORY, { tabId, instanceId }),
  notifyTabFocus: (tabId, engineProfileId) =>
    ipcRenderer.send(IPC.NOTIFY_TAB_FOCUS, { tabId, engineProfileId: engineProfileId ?? null }),
  markResourceRead: (kind, resourceId) => ipcRenderer.send(IPC.MARK_RESOURCE_READ, { kind, resourceId }),
  getReadResourceIds: () => ipcRenderer.invoke(IPC.GET_READ_RESOURCE_IDS),
  getPersistedResources: () => ipcRenderer.invoke(IPC.GET_PERSISTED_RESOURCES),
  publishResourceDelete: (kind, resourceId) => ipcRenderer.send(IPC.DELETE_RESOURCE, { kind, resourceId }),
  resourceGet: (kind, id, opts) => ipcRenderer.invoke(IPC.RESOURCE_GET, { kind, id, ...opts }),
  onEngineEvent: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, key: string, event: any) => callback(key, event)
    ipcRenderer.on(IPC.ENGINE_EVENT, handler)
    return () => ipcRenderer.removeListener(IPC.ENGINE_EVENT, handler)
  },

  // ─── Plugin management ───
  pluginInstall: (source) => ipcRenderer.invoke('plugin:install', source),
  pluginList: () => ipcRenderer.invoke('plugin:list'),
  pluginRemove: (name) => ipcRenderer.invoke('plugin:remove', name),

  // ─── MCP server administration ───
  mcpList: () => ipcRenderer.invoke(IPC.MCP_LIST),
  mcpAdd: (request) => ipcRenderer.invoke(IPC.MCP_ADD, request),
  mcpRemove: (name) => ipcRenderer.invoke(IPC.MCP_REMOVE, name),
  mcpLogin: (name, scope) => ipcRenderer.invoke(IPC.MCP_LOGIN, { name, scope }),
  mcpLogout: (name) => ipcRenderer.invoke(IPC.MCP_LOGOUT, name),

  // ─── Model & provider management ───
  listModels: () => ipcRenderer.invoke(IPC.LIST_MODELS),
  resolveModelTier: (tier: string) => ipcRenderer.invoke(IPC.MODEL_TIER_RESOLVE, { tier }),
  listModelTiers: () => ipcRenderer.invoke(IPC.LIST_MODEL_TIERS),
  setModelTier: (tier) => ipcRenderer.invoke(IPC.SET_MODEL_TIER, tier),
  removeModelTier: (name) => ipcRenderer.invoke(IPC.REMOVE_MODEL_TIER, { name }),
  onModelTiersUpdated: (callback) => {
    ipcRenderer.on(IPC.MODEL_TIERS_UPDATED, callback)
    return () => ipcRenderer.removeListener(IPC.MODEL_TIERS_UPDATED, callback)
  },
  storeCredential: (provider, credential) => ipcRenderer.invoke(IPC.STORE_CREDENTIAL, { provider, credential }),
  refreshModels: (provider) => ipcRenderer.invoke(IPC.REFRESH_MODELS, { provider }),

  // ─── Delegated-CLI provider auth (codex/claude-code/grok/cursor) ───
  providerLogin: (provider) => ipcRenderer.invoke(IPC.PROVIDER_LOGIN, { provider }),
  providerLoginCancel: (provider) => ipcRenderer.invoke(IPC.PROVIDER_LOGIN_CANCEL, { provider }),
  providerLoginCode: (provider, code) => ipcRenderer.invoke(IPC.PROVIDER_LOGIN_CODE, { provider, code }),
  providerLogout: (provider) => ipcRenderer.invoke(IPC.PROVIDER_LOGOUT, { provider }),
  onProviderLoginEvent: (handler) => {
    const listener = (_e: unknown, update: import('../shared/types-engine-event').ProviderLoginUpdate) => handler(update)
    ipcRenderer.on(IPC.PROVIDER_LOGIN_EVENT, listener)
    return () => ipcRenderer.removeListener(IPC.PROVIDER_LOGIN_EVENT, listener)
  },

  // ─── OAuth ───
  startOAuth: (provider) => ipcRenderer.invoke(IPC.OAUTH_START, { provider }),
  logoutOAuth: (provider) => ipcRenderer.invoke(IPC.OAUTH_LOGOUT, { provider }),
  oauthStatus: (provider) => ipcRenderer.invoke(IPC.OAUTH_STATUS, { provider }),
  oauthDeviceCode: (provider) => ipcRenderer.invoke(IPC.OAUTH_DEVICE_CODE, { provider }),
  oauthDevicePoll: (deviceCode, interval, expiresIn) => ipcRenderer.invoke(IPC.OAUTH_DEVICE_POLL, { deviceCode, interval, expiresIn }),

  // ─── Entra OIDC (Feature 0001 Part F — telemetry auth) ───
  entraSignIn: () => ipcRenderer.invoke(IPC.ENTRA_SIGN_IN),
  entraSignOut: () => ipcRenderer.invoke(IPC.ENTRA_SIGN_OUT),
  entraIdentity: () => ipcRenderer.invoke(IPC.ENTRA_IDENTITY),

  // ─── Remote control ───
  remoteGetState: () => ipcRenderer.invoke(IPC.REMOTE_GET_STATE),
  remoteGetMessages: (tabId) => ipcRenderer.invoke(IPC.REMOTE_GET_MESSAGES, tabId),
  remoteStartPairing: () => ipcRenderer.invoke(IPC.REMOTE_START_PAIRING),
  remoteCancelPairing: () => ipcRenderer.send(IPC.REMOTE_CANCEL_PAIRING),
  remoteRevokeDevice: (deviceId) => ipcRenderer.send(IPC.REMOTE_REVOKE_DEVICE, deviceId),
  remoteDiscoverRelays: () => ipcRenderer.invoke(IPC.REMOTE_DISCOVER_RELAYS),
  remoteStopDiscovery: () => ipcRenderer.send(IPC.REMOTE_STOP_DISCOVERY),
  remoteTestRelay: (url, key) => ipcRenderer.invoke(IPC.REMOTE_TEST_RELAY, url, key),
  remoteRelayAuthConfig: (url) => ipcRenderer.invoke(IPC.REMOTE_RELAY_AUTH_CONFIG, url),
  remoteSetLanDisabled: (disabled) => ipcRenderer.invoke(IPC.REMOTE_SET_LAN_DISABLED, disabled),
  remoteSetDisplay: (customName, customIcon) => ipcRenderer.invoke(IPC.REMOTE_SET_DISPLAY, customName, customIcon),
  remoteGetDisplay: () => ipcRenderer.invoke('ion:remote-get-display'),

  // ─── Auto-update ───
  installUpdate: () => ipcRenderer.send(IPC.INSTALL_UPDATE),
  restartForUpdate: () => ipcRenderer.send(IPC.RESTART_FOR_UPDATE),
  onUpdateDownloaded: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, info: { version: string }) => callback(info)
    ipcRenderer.on(IPC.UPDATE_DOWNLOADED, handler)
    return () => ipcRenderer.removeListener(IPC.UPDATE_DOWNLOADED, handler)
  },
  onUpdateProgress: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, info: { percent: number; status: string }) => callback(info)
    ipcRenderer.on(IPC.UPDATE_PROGRESS, handler)
    return () => ipcRenderer.removeListener(IPC.UPDATE_PROGRESS, handler)
  },
  onUpdateStaged: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, info: { workerPid: number }) => callback(info)
    ipcRenderer.on(IPC.UPDATE_STAGED, handler)
    return () => ipcRenderer.removeListener(IPC.UPDATE_STAGED, handler)
  },
  onUpdateError: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, info: { message: string }) => callback(info)
    ipcRenderer.on(IPC.UPDATE_ERROR, handler)
    return () => ipcRenderer.removeListener(IPC.UPDATE_ERROR, handler)
  },

  // ─── Renderer logging bridge ───
  logWrite: (level, tag, msg, fields) => {
    // Fire-and-forget log bridge: the renderer logger does not await delivery.
    // Void the invoke promise so its (rare) rejection doesn't float.
    void ipcRenderer.invoke(IPC.LOG_WRITE, { level, tag, msg, fields: fields ?? {} })
  },

  // `on` wraps the caller's callback, so `off` cannot pass the ORIGINAL
  // callback to removeListener — ipcRenderer holds the wrapper, the identities
  // differ, and the removal silently no-ops. That left every `on` registration
  // permanently attached: an effect that re-ran (StrictMode double-invoke, a
  // remount, a dependency change) added a second live listener for the same
  // channel and the handler then fired N times per single main-process
  // broadcast. For IPC.REMOTE_USER_MESSAGE that means N optimistic user
  // bubbles for one iOS prompt.
  //
  // The registry keys wrapper-by-callback per channel so `off` can look up the
  // exact wrapper it registered. A WeakMap on the callback keeps entries
  // collectable when the caller's closure goes away, so a component that
  // unmounts without calling `off` leaks nothing.
  on: (channel, callback) => {
    const handler = (_e: Electron.IpcRendererEvent, ...args: any[]) => callback(_e, ...args)
    let perChannel = ipcWrappers.get(callback)
    if (!perChannel) {
      perChannel = new Map()
      ipcWrappers.set(callback, perChannel)
    }
    // Re-registering the same callback on the same channel would otherwise
    // orphan the previous wrapper (unremovable, still firing). Drop it first
    // so `on` is idempotent per (channel, callback) pair.
    const prior = perChannel.get(channel)
    if (prior) ipcRenderer.removeListener(channel, prior)
    perChannel.set(channel, handler)
    ipcRenderer.on(channel, handler)
  },
  off: (channel, callback) => {
    const perChannel = ipcWrappers.get(callback)
    const handler = perChannel?.get(channel)
    if (!handler) return
    ipcRenderer.removeListener(channel, handler)
    perChannel!.delete(channel)
  },

  // ─── Window management ───
  resizeHeight: (height) => ipcRenderer.send(IPC.RESIZE_HEIGHT, height),
  animateHeight: (from, to, durationMs) =>
    ipcRenderer.invoke(IPC.ANIMATE_HEIGHT, { from, to, durationMs }),
  hideWindow: () => ipcRenderer.send(IPC.HIDE_WINDOW),
  isVisible: () => ipcRenderer.invoke(IPC.IS_VISIBLE),
  setIgnoreMouseEvents: (ignore, options) =>
    ipcRenderer.send(IPC.SET_IGNORE_MOUSE_EVENTS, ignore, options || {}),
  setWindowWidth: (width) => ipcRenderer.send(IPC.SET_WINDOW_WIDTH, width),

  // ─── Event listeners ───
  onEvent: (callback) => {
    const _channels = [
      IPC.TEXT_CHUNK, IPC.TOOL_CALL, IPC.TOOL_CALL_UPDATE,
      IPC.TOOL_CALL_COMPLETE, IPC.TASK_UPDATE, IPC.TASK_COMPLETE,
      IPC.SESSION_DEAD, IPC.SESSION_INIT, IPC.ERROR, IPC.RATE_LIMIT,
    ]
    // Single unified handler — all normalized events come through one channel
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, event: NormalizedEvent) => callback(tabId, event)
    ipcRenderer.on('ion:normalized-event', handler)
    return () => ipcRenderer.removeListener('ion:normalized-event', handler)
  },

  onTabStatusChange: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, newStatus: string, oldStatus: string) =>
      callback(tabId, newStatus, oldStatus)
    ipcRenderer.on('ion:tab-status-change', handler)
    return () => ipcRenderer.removeListener('ion:tab-status-change', handler)
  },

  onError: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, tabId: string, error: EnrichedError) =>
      callback(tabId, error)
    ipcRenderer.on('ion:enriched-error', handler)
    return () => ipcRenderer.removeListener('ion:enriched-error', handler)
  },

  onSkillStatus: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, status: any) => callback(status)
    ipcRenderer.on(IPC.SKILL_STATUS, handler)
    return () => ipcRenderer.removeListener(IPC.SKILL_STATUS, handler)
  },

  onWindowShown: (callback) => {
    const handler = () => callback()
    ipcRenderer.on(IPC.WINDOW_SHOWN, handler)
    return () => ipcRenderer.removeListener(IPC.WINDOW_SHOWN, handler)
  },

  onShowSettings: (callback) => {
    const handler = () => callback()
    ipcRenderer.on(IPC.SHOW_SETTINGS, handler)
    return () => ipcRenderer.removeListener(IPC.SHOW_SETTINGS, handler)
  },
} satisfies Partial<IonAPI>
