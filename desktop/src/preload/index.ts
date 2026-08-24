import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/types";
import { studioApi } from "./studio-api";
import { gitApi } from "./git-api";
import { engineApi } from "./engine-api";
import type {
  NormalizedEvent,
  EnrichedError,
  DeepLinkConfirmRequest,
  DeepLinkConfirmResult,
} from "../shared/types";
import type { IonAPI } from "./ionapi";

export type { IonAPI } from "./ionapi";

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

const api: IonAPI = {
  // Ion Studio bridge (see preload/studio-api.ts)
  ...studioApi,
  startupReport: (report) => ipcRenderer.send(IPC.STARTUP_REPORT, report),
  // ─── Request-response ───
  start: () => ipcRenderer.invoke(IPC.START),
  createTab: () => ipcRenderer.invoke(IPC.CREATE_TAB),
  adoptTab: (tabId: string) => ipcRenderer.invoke(IPC.ADOPT_TAB, tabId),
  prompt: (tabId, requestId, options) =>
    ipcRenderer.invoke(IPC.PROMPT, { tabId, requestId, options }),
  cancel: (requestId) => ipcRenderer.invoke(IPC.CANCEL, requestId),
  steer: (tabId, message, clientMessageId) =>
    ipcRenderer.send(IPC.STEER, { tabId, message, clientMessageId }),
  stopTab: (tabId, scope) => ipcRenderer.invoke(IPC.STOP_TAB, tabId, scope),
  retry: (tabId, requestId, options) =>
    ipcRenderer.invoke(IPC.RETRY, { tabId, requestId, options }),
  status: () => ipcRenderer.invoke(IPC.STATUS),
  tabHealth: () => ipcRenderer.invoke(IPC.TAB_HEALTH),
  closeTab: (tabId) => ipcRenderer.invoke(IPC.CLOSE_TAB, tabId),
  tabMetaChanged: (payload: {
    tabId: string;
    title?: string;
    runCostUsd?: number;
    totalCostUsd?: number;
    groupId?: string | null;
  }) => ipcRenderer.send(IPC.TAB_META_CHANGED, payload),
  pushRemoteTabStates: (payload) =>
    ipcRenderer.send(IPC.REMOTE_TAB_STATES_PUSH, payload),
  selectDirectory: () => ipcRenderer.invoke(IPC.SELECT_DIRECTORY),
  selectExtensionFiles: () => ipcRenderer.invoke(IPC.SELECT_EXTENSION_FILES),
  getEngineHostInfo: () => ipcRenderer.invoke(IPC.GET_ENGINE_HOST_INFO),
  listEngineDirectory: (path: string, showHidden: boolean) =>
    ipcRenderer.invoke(IPC.LIST_ENGINE_DIRECTORY, path, showHidden),
  getEnterprisePolicy: () => ipcRenderer.invoke(IPC.GET_ENTERPRISE_POLICY),
  getEnterprisePolicyFull: () =>
    ipcRenderer.invoke(IPC.GET_ENTERPRISE_POLICY_FULL),
  listCustomThemes: () => ipcRenderer.invoke(IPC.THEMES_LIST_CUSTOM),
  openExternal: (url) => ipcRenderer.invoke(IPC.OPEN_EXTERNAL, url),
  getFavicon: (host) => ipcRenderer.invoke(IPC.FAVICON_GET, host),
  revealPath: (path) => ipcRenderer.invoke(IPC.REVEAL_PATH, path),
  attachFiles: () => ipcRenderer.invoke(IPC.ATTACH_FILES),
  attachFileByPath: (path) => ipcRenderer.invoke(IPC.ATTACH_FILE_BY_PATH, path),
  takeScreenshot: () => ipcRenderer.invoke(IPC.TAKE_SCREENSHOT),
  pasteImage: (dataUrl) => ipcRenderer.invoke(IPC.PASTE_IMAGE, dataUrl),
  transcribeAudio: (audioBase64) =>
    ipcRenderer.invoke(IPC.TRANSCRIBE_AUDIO, audioBase64),
  getDiagnostics: () => ipcRenderer.invoke(IPC.GET_DIAGNOSTICS),
  respondPermission: (tabId, questionId, optionId) =>
    ipcRenderer.invoke(IPC.RESPOND_PERMISSION, { tabId, questionId, optionId }),
  respondElicitation: (tabId, requestId, response, cancelled, declined) =>
    ipcRenderer.invoke(IPC.RESPOND_ELICITATION, {
      tabId,
      requestId,
      response,
      cancelled,
      declined,
    }),
  approveDeniedTools: (tabId: string, toolNames: string[]) =>
    ipcRenderer.invoke(IPC.APPROVE_DENIED_TOOLS, { tabId, toolNames }),
  initSession: (tabId) => ipcRenderer.send(IPC.INIT_SESSION, tabId),
  ensureEngineSession: (args) =>
    ipcRenderer.invoke(IPC.ENSURE_ENGINE_SESSION, args),
  resetTabSession: (tabId) => ipcRenderer.send(IPC.RESET_TAB_SESSION, tabId),
  restartTabSession: (tabId: string) =>
    ipcRenderer.send(IPC.RESTART_TAB_SESSION, tabId),
  relocateTabSession: (tabId, workingDirectory) =>
    ipcRenderer.invoke(IPC.RELOCATE_TAB_SESSION, { tabId, workingDirectory }),
  listSessions: (projectPath?: string) =>
    ipcRenderer.invoke(IPC.LIST_SESSIONS, projectPath),
  listAllSessions: () => ipcRenderer.invoke(IPC.LIST_ALL_SESSIONS),
  loadSession: (sessionId: string, projectPath?: string, encodedDir?: string) =>
    ipcRenderer.invoke(IPC.LOAD_SESSION, {
      sessionId,
      projectPath,
      encodedDir,
    }),
  conversationExists: (sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.CONVERSATION_EXISTS, sessionId),
  readPlan: (filePath: string) => ipcRenderer.invoke(IPC.READ_PLAN, filePath),
  readImageDataUrl: (filePath: string) =>
    ipcRenderer.invoke(IPC.READ_IMAGE_DATA_URL, filePath),
  discoverCommands: (projectPath: string) =>
    ipcRenderer.invoke(IPC.DISCOVER_COMMANDS, projectPath),
  listFonts: () => ipcRenderer.invoke(IPC.LIST_FONTS),
  terminalCreate: (key, cwd) =>
    ipcRenderer.invoke(IPC.TERMINAL_CREATE, { key, cwd }),
  terminalWrite: (key, data) =>
    ipcRenderer.send(IPC.TERMINAL_DATA, { key, data }),
  terminalResize: (key, cols, rows) =>
    ipcRenderer.send(IPC.TERMINAL_RESIZE, { key, cols, rows }),
  terminalDestroy: (key) => ipcRenderer.invoke(IPC.TERMINAL_DESTROY, { key }),
  terminalAttach: (key, opts) =>
    ipcRenderer.invoke(IPC.TERMINAL_ATTACH, { key, ...opts }),
  getActiveUi: () => ipcRenderer.invoke(IPC.GET_ACTIVE_UI),
  setActiveUi: (ui) => ipcRenderer.invoke(IPC.SET_ACTIVE_UI, ui),
  terminalGetScrollback: (key) =>
    ipcRenderer.invoke(IPC.TERMINAL_GET_SCROLLBACK, { key }),
  terminalActiveTabs: () => ipcRenderer.invoke(IPC.TERMINAL_ACTIVE_TABS),
  onTerminalActivity: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      activity: { key: string; tabId: string; active: boolean },
    ) => callback(activity);
    ipcRenderer.on(IPC.TERMINAL_ACTIVITY, handler);
    return () => ipcRenderer.removeListener(IPC.TERMINAL_ACTIVITY, handler);
  },
  onTerminalData: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      key: string,
      data: string,
    ) => callback(key, data);
    ipcRenderer.on(IPC.TERMINAL_INCOMING, handler);
    return () => ipcRenderer.removeListener(IPC.TERMINAL_INCOMING, handler);
  },
  onTerminalExit: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      key: string,
      exitCode: number,
    ) => callback(key, exitCode);
    ipcRenderer.on(IPC.TERMINAL_EXIT, handler);
    return () => ipcRenderer.removeListener(IPC.TERMINAL_EXIT, handler);
  },
  // An untrusted ion:// deep link needs the operator's approval before anything
  // runs. Main describes the request; the renderer renders it and answers.
  onDeepLinkConfirmRequest: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      request: DeepLinkConfirmRequest,
    ) => callback(request);
    ipcRenderer.on(IPC.DEEPLINK_CONFIRM_REQUEST, handler);
    return () =>
      ipcRenderer.removeListener(IPC.DEEPLINK_CONFIRM_REQUEST, handler);
  },
  onDeepLinkConfirmSettled: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, id: string) => callback(id);
    ipcRenderer.on(IPC.DEEPLINK_CONFIRM_SETTLED, handler);
    return () =>
      ipcRenderer.removeListener(IPC.DEEPLINK_CONFIRM_SETTLED, handler);
  },
  setDeepLinkConfirmAvailability: (owner, available) =>
    ipcRenderer.send(
      available ? IPC.DEEPLINK_CONFIRM_READY : IPC.DEEPLINK_CONFIRM_UNAVAILABLE,
      { owner },
    ),
  resolveDeepLinkConfirm: (result: DeepLinkConfirmResult) =>
    ipcRenderer.send(IPC.DEEPLINK_CONFIRM_RESULT, result),
  // iOS asked to open a worktree / bench conversation. Tab creation lives in
  // the renderer store (it owns panes and titling), so main relays the intent
  // here rather than duplicating that logic.
  onRemoteOpenWorktreeConversation: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      arg: { worktreePath: string; newConversation: boolean },
    ) => callback(arg);
    ipcRenderer.on("ion:remote-open-worktree-conversation", handler);
    return () =>
      ipcRenderer.removeListener(
        "ion:remote-open-worktree-conversation",
        handler,
      );
  },
  onRemoteRetireWorktree: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      arg: { repoPath: string; worktreePath: string; branchName: string },
    ) => callback(arg);
    ipcRenderer.on("ion:remote-retire-worktree", handler);
    return () =>
      ipcRenderer.removeListener("ion:remote-retire-worktree", handler);
  },
  onRemoteRetireLandedWorktrees: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      arg: { repoPath: string },
    ) => callback(arg);
    ipcRenderer.on("ion:remote-retire-landed-worktrees", handler);
    return () =>
      ipcRenderer.removeListener("ion:remote-retire-landed-worktrees", handler);
  },
  onRemoteOpenBenchConversation: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      arg: { repoPath: string; sourceBranch: string },
    ) => callback(arg);
    ipcRenderer.on("ion:remote-open-bench-conversation", handler);
    return () =>
      ipcRenderer.removeListener("ion:remote-open-bench-conversation", handler);
  },
  onRemoteOpenBenchTerminal: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      arg: { repoPath: string; sourceBranch: string },
    ) => callback(arg);
    ipcRenderer.on("ion:remote-open-bench-terminal", handler);
    return () =>
      ipcRenderer.removeListener("ion:remote-open-bench-terminal", handler);
  },
  onRemoteWorktreeAction: (callback) => {
    const channels = [
      "ion:remote-create-worktree",
      "ion:remote-convert-worktree-conversation",
      "ion:remote-rename-worktree",
      "ion:remote-reprovision-worktree",
      "ion:remote-recover-bench-conflict",
      "ion:remote-analyse-bench-verification",
      "ion:remote-discard-bench-member-recordings",
      "ion:remote-discard-all-bench-recordings",
      "ion:remote-worktree-conflict-assist",
      "ion:remote-bench-conflict-assist",
    ] as const;
    const handlers = channels.map((channel) => {
      const handler = (
        _e: Electron.IpcRendererEvent,
        arg: Record<string, unknown>,
      ) => callback(channel, arg);
      ipcRenderer.on(channel, handler);
      return { channel, handler };
    });
    return () =>
      handlers.forEach(({ channel, handler }) =>
        ipcRenderer.removeListener(channel, handler),
      );
  },
  // iOS drives the sync pipeline remotely: start / confirm-ai / cancel /
  // dismiss ride one channel with a verb so the listener stays a single
  // subscription. The pipeline itself is a renderer-store state machine.
  onRemoteWorktreePipeline: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      arg: {
        verb: "start" | "confirm-ai" | "cancel" | "dismiss";
        repoPath: string;
        sourceBranch?: string;
      },
    ) => callback(arg);
    ipcRenderer.on("ion:remote-worktree-pipeline", handler);
    return () =>
      ipcRenderer.removeListener("ion:remote-worktree-pipeline", handler);
  },
  // A worktree earned (or was given) a human title. Both windows listen so the
  // overlay and the Studio mirror rename the row at the same moment.
  onWorktreeTitled: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      arg: { repoPath: string; worktreePath: string; title: string },
    ) => callback(arg);
    ipcRenderer.on("ion:worktree-titled", handler);
    return () => ipcRenderer.removeListener("ion:worktree-titled", handler);
  },
  onWorktreeLanded: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      arg: {
        repoPath: string;
        worktreePath: string;
        prunedBenchPaths: string[];
      },
    ) => callback(arg);
    ipcRenderer.on("ion:worktree-landed", handler);
    return () => ipcRenderer.removeListener("ion:worktree-landed", handler);
  },
  onWorktreeFreshnessTick: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      arg: { repoPaths: string[] },
    ) => callback(arg);
    ipcRenderer.on(IPC.WORKTREE_FRESHNESS_TICK, handler);
    return () =>
      ipcRenderer.removeListener(IPC.WORKTREE_FRESHNESS_TICK, handler);
  },
  executeBash: (id, command, cwd) =>
    ipcRenderer.invoke(IPC.EXECUTE_BASH, { id, command, cwd }),
  cancelBash: (id) => ipcRenderer.send(IPC.CANCEL_BASH, id),
  sendRemote: (event) => ipcRenderer.send(IPC.REMOTE_SEND, event),
  setPermissionMode: (tabId, mode, source, planFilePath) =>
    ipcRenderer.send(IPC.SET_PERMISSION_MODE, {
      tabId,
      mode,
      source,
      planFilePath,
    }),
  resolvePermissionDenials: (tabId) =>
    ipcRenderer.send(IPC.RESOLVE_PERMISSION_DENIALS, { tabId }),
  loadSettings: () => ipcRenderer.invoke(IPC.LOAD_SETTINGS),
  saveSettings: (data) => ipcRenderer.invoke(IPC.SAVE_SETTINGS, data),
  loadTabs: () => ipcRenderer.invoke(IPC.LOAD_TABS),
  saveTabs: (data) => ipcRenderer.invoke(IPC.SAVE_TABS, data),
  loadTabContent: (tabId: string) =>
    ipcRenderer.invoke(IPC.LOAD_TAB_CONTENT, tabId),
  saveTabContent: (tabId: string, instanceId: string, messages: unknown[]) =>
    ipcRenderer.invoke(IPC.SAVE_TAB_CONTENT, { tabId, instanceId, messages }),
  deleteTabContent: (tabId: string) =>
    ipcRenderer.invoke(IPC.DELETE_TAB_CONTENT, tabId),
  saveSessionLabel: (sessionId, customTitle) =>
    ipcRenderer.invoke(IPC.SAVE_SESSION_LABEL, { sessionId, customTitle }),
  loadSessionLabels: () => ipcRenderer.invoke(IPC.LOAD_SESSION_LABELS),
  generateTitle: (text) => ipcRenderer.invoke(IPC.GENERATE_TITLE, text),
  loadSessionChains: () => ipcRenderer.invoke(IPC.LOAD_SESSION_CHAINS),
  saveSessionChains: (data) =>
    ipcRenderer.invoke(IPC.SAVE_SESSION_CHAINS, data),
  getConversation: (conversationId: string, offset = 0, limit = 50) =>
    ipcRenderer.invoke(IPC.GET_CONVERSATION, { conversationId, offset, limit }),
  deleteStoredConversations: (sessionIds: string[]) =>
    ipcRenderer.invoke(IPC.DELETE_STORED_CONVERSATIONS, sessionIds),
  loadChainHistory: (sessionIds: string[]) =>
    ipcRenderer.invoke(IPC.LOAD_CHAIN_HISTORY, sessionIds),

  // ─── Conversation backup ───
  conversationExportPreview: (scope) =>
    ipcRenderer.invoke(IPC.CONVERSATION_EXPORT_PREVIEW, { scope }),
  conversationExport: (args) =>
    ipcRenderer.invoke(IPC.CONVERSATION_EXPORT, args),
  conversationRestorePreview: (args) =>
    ipcRenderer.invoke(IPC.CONVERSATION_RESTORE_PREVIEW, args ?? {}),
  conversationRestore: (args) =>
    ipcRenderer.invoke(IPC.CONVERSATION_RESTORE, args),
  onConversationBackupProgress: (callback) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      data: { current: number; total: number; label: string },
    ) => callback(data);
    ipcRenderer.on(IPC.CONVERSATION_BACKUP_PROGRESS, handler);
    return () =>
      ipcRenderer.removeListener(IPC.CONVERSATION_BACKUP_PROGRESS, handler);
  },

  // ─── Git operations (see preload/git-api.ts) ───
  ...gitApi,
  // ─── Engine, model/provider, plugin, MCP operations (see preload/engine-api.ts) ───
  ...engineApi,
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
    const handler = (_e: Electron.IpcRendererEvent, info: { percent: number; status: string }) => callback(info);
    ipcRenderer.on(IPC.UPDATE_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IPC.UPDATE_PROGRESS, handler);
  },
  onUpdateStaged: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, info: { workerPid: number }) => callback(info);
    ipcRenderer.on(IPC.UPDATE_STAGED, handler);
    return () => ipcRenderer.removeListener(IPC.UPDATE_STAGED, handler);
  },
  onUpdateError: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, info: { message: string }) => callback(info);
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
};

contextBridge.exposeInMainWorld("ion", api);
