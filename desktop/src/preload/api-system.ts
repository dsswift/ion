import { ipcRenderer } from "electron";
import { IPC } from "../shared/types";
import type { EnrichedError, NormalizedEvent } from "../shared/types";
import type { IonAPI } from "./ionapi";

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
>();

/** Filesystem, account, remote, window, and generic bridge methods. */
export const systemApi = {
  // ─── Filesystem operations ───
  fsReadDir: (directory) => ipcRenderer.invoke(IPC.FS_READ_DIR, { directory }),
  fsReadFile: (filePath) => ipcRenderer.invoke(IPC.FS_READ_FILE, { filePath }),
  fsWriteFile: (filePath, content) =>
    ipcRenderer.invoke(IPC.FS_WRITE_FILE, { filePath, content }),
  fsCreateDir: (dirPath) => ipcRenderer.invoke(IPC.FS_CREATE_DIR, { dirPath }),
  fsCreateFile: (filePath) =>
    ipcRenderer.invoke(IPC.FS_CREATE_FILE, { filePath }),
  fsRename: (oldPath, newPath) =>
    ipcRenderer.invoke(IPC.FS_RENAME, { oldPath, newPath }),
  fsDelete: (targetPath) => ipcRenderer.invoke(IPC.FS_DELETE, { targetPath }),
  fsSaveDialog: (defaultPath, defaultFileName) =>
    ipcRenderer.invoke(IPC.FS_SAVE_DIALOG, { defaultPath, defaultFileName }),
  fsRevealInFinder: (targetPath) =>
    ipcRenderer.invoke(IPC.FS_REVEAL_IN_FINDER, { targetPath }),
  fsOpenNative: (targetPath) =>
    ipcRenderer.invoke(IPC.FS_OPEN_NATIVE, { targetPath }),
  fsExists: (targetPath) => ipcRenderer.invoke(IPC.FS_EXISTS, { targetPath }),
  fsWatchFile: (filePath) =>
    ipcRenderer.invoke(IPC.FS_WATCH_FILE, { filePath }),
  fsUnwatchFile: (filePath) =>
    ipcRenderer.invoke(IPC.FS_UNWATCH_FILE, { filePath }),
  onFileChanged: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, filePath: string) =>
      callback(filePath);
    ipcRenderer.on(IPC.FS_FILE_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.FS_FILE_CHANGED, handler);
  },

  // ─── OS facilities ───
  copyPngToClipboard: (png: ArrayBuffer) =>
    ipcRenderer.invoke(IPC.COPY_PNG_TO_CLIPBOARD, png),
  requestChartJump: (request: {
    tabId: string;
    chartId: string;
    messageId: string;
  }) => ipcRenderer.send(IPC.CHART_JUMP, request),
  reconcileCharts: (request: {
    tabId: string;
    conversationId: string;
    rows: Array<{
      toolMessageId: string;
      toolInput: string;
      resultText: string;
      index: number;
    }>;
  }) => ipcRenderer.send(IPC.CHART_RECONCILE, request),
  onChartJump: (
    callback: (request: {
      tabId: string;
      chartId: string;
      messageId: string;
    }) => void,
  ) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      request: { tabId: string; chartId: string; messageId: string },
    ) => callback(request);
    ipcRenderer.on(IPC.CHART_JUMP, handler);
    return () => ipcRenderer.removeListener(IPC.CHART_JUMP, handler);
  },
  /** Main announces that the resource catalog changed outside a live delta. */
  onResourceCatalogChanged: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on(IPC.RESOURCE_CATALOG_CHANGED, handler);
    return () =>
      ipcRenderer.removeListener(IPC.RESOURCE_CATALOG_CHANGED, handler);
  },

  // ─── OAuth ───
  startOAuth: (provider) => ipcRenderer.invoke(IPC.OAUTH_START, { provider }),
  logoutOAuth: (provider) => ipcRenderer.invoke(IPC.OAUTH_LOGOUT, { provider }),
  oauthStatus: (provider) => ipcRenderer.invoke(IPC.OAUTH_STATUS, { provider }),
  oauthDeviceCode: (provider) =>
    ipcRenderer.invoke(IPC.OAUTH_DEVICE_CODE, { provider }),
  oauthDevicePoll: (deviceCode, interval, expiresIn) =>
    ipcRenderer.invoke(IPC.OAUTH_DEVICE_POLL, {
      deviceCode,
      interval,
      expiresIn,
    }),

  // ─── Entra OIDC (Feature 0001 Part F — telemetry auth) ───
  entraSignIn: () => ipcRenderer.invoke(IPC.ENTRA_SIGN_IN),
  entraSignOut: () => ipcRenderer.invoke(IPC.ENTRA_SIGN_OUT),
  entraIdentity: () => ipcRenderer.invoke(IPC.ENTRA_IDENTITY),

  // ─── Remote control ───
  remoteGetState: () => ipcRenderer.invoke(IPC.REMOTE_GET_STATE),
  remoteGetMessages: (tabId) =>
    ipcRenderer.invoke(IPC.REMOTE_GET_MESSAGES, tabId),
  remoteStartPairing: () => ipcRenderer.invoke(IPC.REMOTE_START_PAIRING),
  remoteCancelPairing: () => ipcRenderer.send(IPC.REMOTE_CANCEL_PAIRING),
  remoteRevokeDevice: (deviceId) =>
    ipcRenderer.send(IPC.REMOTE_REVOKE_DEVICE, deviceId),
  remoteDiscoverRelays: () => ipcRenderer.invoke(IPC.REMOTE_DISCOVER_RELAYS),
  remoteStopDiscovery: () => ipcRenderer.send(IPC.REMOTE_STOP_DISCOVERY),
  remoteTestRelay: (url, key) =>
    ipcRenderer.invoke(IPC.REMOTE_TEST_RELAY, url, key),
  remoteRelayAuthConfig: (url) =>
    ipcRenderer.invoke(IPC.REMOTE_RELAY_AUTH_CONFIG, url),
  remoteSetLanDisabled: (disabled) =>
    ipcRenderer.invoke(IPC.REMOTE_SET_LAN_DISABLED, disabled),
  remoteSetDisplay: (customName, customIcon) =>
    ipcRenderer.invoke(IPC.REMOTE_SET_DISPLAY, customName, customIcon),
  remoteGetDisplay: () => ipcRenderer.invoke("ion:remote-get-display"),

  // ─── Auto-update ───
  installUpdate: () => ipcRenderer.send(IPC.INSTALL_UPDATE),
  restartForUpdate: () => ipcRenderer.send(IPC.RESTART_FOR_UPDATE),
  onUpdateDownloaded: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      info: { version: string },
    ) => callback(info);
    ipcRenderer.on(IPC.UPDATE_DOWNLOADED, handler);
    return () => ipcRenderer.removeListener(IPC.UPDATE_DOWNLOADED, handler);
  },
  onUpdateProgress: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      info: { percent: number; status: string },
    ) => callback(info);
    ipcRenderer.on(IPC.UPDATE_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IPC.UPDATE_PROGRESS, handler);
  },
  onUpdateStaged: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      info: { workerPid: number },
    ) => callback(info);
    ipcRenderer.on(IPC.UPDATE_STAGED, handler);
    return () => ipcRenderer.removeListener(IPC.UPDATE_STAGED, handler);
  },
  onUpdateError: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      info: { message: string },
    ) => callback(info);
    ipcRenderer.on(IPC.UPDATE_ERROR, handler);
    return () => ipcRenderer.removeListener(IPC.UPDATE_ERROR, handler);
  },

  // ─── Renderer logging bridge ───
  logWrite: (level, tag, msg, fields) => {
    // Fire-and-forget log bridge: the renderer logger does not await delivery.
    // Void the invoke promise so its (rare) rejection doesn't float.
    void ipcRenderer.invoke(IPC.LOG_WRITE, {
      level,
      tag,
      msg,
      fields: fields ?? {},
    });
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
    const handler = (_e: Electron.IpcRendererEvent, ...args: any[]) =>
      callback(_e, ...args);
    let perChannel = ipcWrappers.get(callback);
    if (!perChannel) {
      perChannel = new Map();
      ipcWrappers.set(callback, perChannel);
    }
    // Re-registering the same callback on the same channel would otherwise
    // orphan the previous wrapper (unremovable, still firing). Drop it first
    // so `on` is idempotent per (channel, callback) pair.
    const prior = perChannel.get(channel);
    if (prior) ipcRenderer.removeListener(channel, prior);
    perChannel.set(channel, handler);
    ipcRenderer.on(channel, handler);
  },
  off: (channel, callback) => {
    const perChannel = ipcWrappers.get(callback);
    const handler = perChannel?.get(channel);
    if (!handler) return;
    ipcRenderer.removeListener(channel, handler);
    perChannel!.delete(channel);
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
      IPC.TEXT_CHUNK,
      IPC.TOOL_CALL,
      IPC.TOOL_CALL_UPDATE,
      IPC.TOOL_CALL_COMPLETE,
      IPC.TASK_UPDATE,
      IPC.TASK_COMPLETE,
      IPC.SESSION_DEAD,
      IPC.SESSION_INIT,
      IPC.ERROR,
      IPC.RATE_LIMIT,
    ];
    // Single unified handler — all normalized events come through one channel
    const handler = (
      _e: Electron.IpcRendererEvent,
      tabId: string,
      event: NormalizedEvent,
    ) => callback(tabId, event);
    ipcRenderer.on("ion:normalized-event", handler);
    return () => ipcRenderer.removeListener("ion:normalized-event", handler);
  },

  onTabStatusChange: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      tabId: string,
      newStatus: string,
      oldStatus: string,
    ) => callback(tabId, newStatus, oldStatus);
    ipcRenderer.on("ion:tab-status-change", handler);
    return () => ipcRenderer.removeListener("ion:tab-status-change", handler);
  },

  onError: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      tabId: string,
      error: EnrichedError,
    ) => callback(tabId, error);
    ipcRenderer.on("ion:enriched-error", handler);
    return () => ipcRenderer.removeListener("ion:enriched-error", handler);
  },

  onSkillStatus: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, status: any) =>
      callback(status);
    ipcRenderer.on(IPC.SKILL_STATUS, handler);
    return () => ipcRenderer.removeListener(IPC.SKILL_STATUS, handler);
  },

  onWindowShown: (callback) => {
    const handler = () => callback();
    ipcRenderer.on(IPC.WINDOW_SHOWN, handler);
    return () => ipcRenderer.removeListener(IPC.WINDOW_SHOWN, handler);
  },

  onShowSettings: (callback) => {
    const handler = () => callback();
    ipcRenderer.on(IPC.SHOW_SETTINGS, handler);
    return () => ipcRenderer.removeListener(IPC.SHOW_SETTINGS, handler);
  },
} satisfies Partial<IonAPI>;
