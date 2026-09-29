/**
 * browser-shell-bridge — the `host.shell` methods a browser Studio client
 * CAN serve, and how each one reaches the server.
 *
 * `BrowserStudioHost.shell` is otherwise a refusal proxy: the `IonAPI`
 * surface was written against Electron's preload bridge, and a browser tab
 * has no `window.ion`. But most of that surface is not Electron-specific by
 * nature — it is validate-then-delegate work the server can do perfectly
 * well, and the earlier capability gates hid whole features (the AI & Models
 * settings category, the model picker's provider list) for want of a
 * transport rather than an implementation.
 *
 * This table is the transport. Two kinds of entry:
 *
 *   - INVOKE: a request/response method. `pack` reproduces exactly the
 *     argument marshalling the preload does for the same method, so the
 *     server sees an identical payload whichever client called it. Getting
 *     that wrong is silent (the server reads `undefined` off a differently
 *     shaped object), so each entry is written against its preload
 *     counterpart in `preload/engine-api.ts`.
 *   - SUBSCRIBE: an `on*` listener. The server already fans these out as
 *     `studio_event` frames through `broadcast()`; the entry names the
 *     channel and the listener filters for it.
 *
 * Anything NOT in this table keeps throwing. A silent no-op would be worse
 * than the refusal it replaces: the caller would believe it had succeeded.
 */

/** A bridged request/response method: which `studio_action`, and how to marshal its arguments. */
export interface ShellInvokeSpec {
  action: string
  /** Mirrors the preload's own marshalling. Defaults to passing arguments through unchanged. */
  pack?: (args: unknown[]) => unknown[]
  /**
   * Send and forget: resolve immediately instead of correlating a reply.
   *
   * For the verbs the preload sends with `ipcRenderer.send` rather than
   * `invoke` -- terminal keystrokes and resizes. Awaiting those would arm a
   * correlation listener and a 30s timer per KEYSTROKE, which is a lot of
   * bookkeeping for a call whose only real answer is the output that comes
   * back on the terminal stream anyway.
   */
  oneWay?: boolean
  /**
   * Reshape the server's reply before the caller sees it. The wire is JSON,
   * so a verb whose preload form returned bytes (`studioReadThemeAsset`'s
   * `ArrayBuffer`) carries them as base64 and is decoded here, keeping the
   * `IonAPI` signature identical on every host.
   */
  unpack?: (value: unknown) => unknown
  /**
   * How long to wait for the reply before failing the call. The default
   * (`BRIDGED_CALL_TIMEOUT_MS` in each host) suits a read; a verb that runs
   * a whisper binary or zips every conversation legitimately takes longer,
   * and a timeout that fires under it reports a failure for work that then
   * completes anyway.
   */
  timeoutMs?: number
}

/** A whisper pass over a one-minute recording, with headroom for a cold model load. */
const TRANSCRIBE_TIMEOUT_MS = 120_000
/** Archiving or restoring every conversation the Environment holds. */
const BACKUP_TIMEOUT_MS = 10 * 60_000
/**
 * A sign-in that waits on a person finishing a provider's page. The server
 * bounds each flow itself (five minutes for the engine's Entra login, a
 * device code's own expiry, fifteen minutes at most for GitHub's); this only
 * has to outlast the longest of them, so the reply is the flow's own answer
 * and never a client timeout over a sign-in still in progress.
 */
export const INTERACTIVE_SIGN_IN_TIMEOUT_MS = 16 * 60_000

/** base64 text from the wire back to the `ArrayBuffer` the preload verb returned; null passes through. */
function base64ToArrayBuffer(value: unknown): ArrayBuffer | null {
  if (typeof value !== 'string') return null
  const bin = atob(value)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}

const passthrough = (args: unknown[]): unknown[] => args
/** The preload wraps a single positional argument into a named object for most engine RPCs. */
const named = (key: string) => (args: unknown[]): unknown[] => [{ [key]: args[0] }]

export const SHELL_INVOKE: Record<string, ShellInvokeSpec> = {
  // ── Models and tiers ──
  listModels: { action: 'model.list', pack: () => [] },
  listModelTiers: { action: 'model.listTiers', pack: () => [] },
  // preload: invoke(MODEL_TIER_RESOLVE, { tier }) -- but the server action
  // takes the bare tier name, matching `resolveModelTier(tier)`'s signature.
  resolveModelTier: { action: 'model.resolveTier', pack: (args) => [args[0]] },
  setModelTier: { action: 'model.setTier', pack: passthrough },
  removeModelTier: { action: 'model.removeTier', pack: named('name') },
  refreshModels: { action: 'model.refresh', pack: named('provider') },

  // ── Providers ──
  // Describing a file the server can already see. This was unbridged while
  // the menu item offering it was still shown, so the call threw.
  // Each attachment verb names its conversation, so the call reaches the
  // Environment whose filesystem the attachment lives on.
  attachFileByPath: { action: 'fs.attachByPath', pack: (args) => [{ tabId: args[0], path: args[1] }] },
  searchFiles: { action: 'fs.searchFiles', pack: (args) => [{ directory: args[0], query: args[1], limit: args[2] }] },
  searchText: { action: 'fs.searchText', pack: (args) => [args[0]] },
  getProjectStudioConfig: { action: 'fs.projectStudioConfig', pack: (args) => [{ directory: args[0] }] },
  trustProjectQuickTools: { action: 'fs.trustProjectQuickTools', pack: (args) => [{ directory: args[0], toolsHash: args[1] }] },
  saveAttachmentData: { action: 'fs.saveAttachmentData', pack: (args) => [{ tabId: args[0], name: args[1], base64: args[2] }] },
  readFileData: { action: 'fs.readFileData', pack: (args) => [{ tabId: args[0], filePath: args[1] }] },
  resolveFileLink: { action: 'fs.resolveLink', pack: (args) => [{ tabId: args[0], path: args[1], cwd: args[2] }] },

  getDefaultProvider: { action: 'provider.getDefault', pack: () => [] },
  setDefaultProvider: { action: 'provider.setDefault', pack: named('provider') },
  storeCredential: {
    action: 'provider.storeCredential',
    pack: (args) => [{ provider: args[0], credential: args[1] }],
  },
  providerLogin: { action: 'provider.login', pack: named('provider') },
  providerLoginCancel: { action: 'provider.loginCancel', pack: named('provider') },
  providerLoginCode: {
    action: 'provider.loginCode',
    pack: (args) => [{ provider: args[0], code: args[1] }],
  },
  providerLogout: { action: 'provider.logout', pack: named('provider') },
  automationUpsert: { action: 'automation.upsert', pack: (args) => [args[0]] },
  automationDuplicate: { action: 'automation.duplicate', pack: (args) => [{ id: args[0], projectPath: args[1] }] },
  setProjectAutomationEnabled: {
    action: 'automation.setProjectEnabled',
    pack: (args) => [{ projectPath: args[0], id: args[1], enabled: args[2] }],
  },
  // Guided Questions: a browser client could watch a question arrive on
  // `ion:questions-state` and had no way to answer it until these three.
  questionsGetState: { action: 'questions.getState', pack: () => [] },
  questionsPatch: { action: 'questions.patch', pack: (args) => [args[0]] },
  questionsAction: { action: 'questions.action', pack: (args) => [args[0]] },
  studioGetState: { action: 'studio.getState', pack: (args) => [args[0]] },
  // A tab id, so the call reaches the server that owns that conversation.
  composerActions: { action: 'studio.composerActions', pack: (args) => [args[0]] },

  // ── Interactive auth flows ───────────────────────────────────────────
  // The flows run on the server; only the act of SHOWING the sign-in page
  // differs per host. A browser client opens it from `ion:open-auth-url`
  // below.
  startOAuth: { action: 'oauth.start', pack: named('provider'), timeoutMs: INTERACTIVE_SIGN_IN_TIMEOUT_MS },
  logoutOAuth: { action: 'oauth.logout', pack: named('provider') },
  oauthDeviceCode: { action: 'oauth.deviceCode', pack: named('provider') },
  oauthDevicePoll: {
    action: 'oauth.devicePoll',
    pack: (args) => [{ deviceCode: args[0], interval: args[1], expiresIn: args[2] }],
    timeoutMs: INTERACTIVE_SIGN_IN_TIMEOUT_MS,
  },
  // ── Device transport (server/src/protocol/remote-actions.ts) ──
  // The Environment's iOS/LAN/relay transport is server-owned; the Phone and
  // relay settings section drives it from any host. Each verb carries its own
  // scope server-side; a call without it is refused, never silently dropped.
  remoteGetMessages: { action: 'remote.getMessages', pack: (args) => [args[0]] },
  remoteSetDisplay: { action: 'remote.setDisplay', pack: (args) => [args[0], args[1]] },
  remoteGetDisplay: { action: 'remote.getDisplay', pack: () => [] },
  remoteDiscoverRelays: { action: 'remote.discoverRelays', pack: () => [] },
  remoteStopDiscovery: { action: 'remote.stopDiscovery', pack: () => [], oneWay: true },
  remoteTestRelay: { action: 'remote.testRelay', pack: (args) => [args[0], args[1]] },
  remoteRelayAuthConfig: { action: 'remote.relayAuthConfig', pack: (args) => [args[0]] },
  // Session-plane health plus the server's log tail (local desktop only, server-side).
  getDiagnostics: { action: 'lifecycle.diagnostics', pack: () => [] },
  entraIdentity: { action: 'entra.identity', pack: () => [] },
  entraSignIn: { action: 'entra.signIn', pack: () => [], timeoutMs: INTERACTIVE_SIGN_IN_TIMEOUT_MS },
  entraSignOut: { action: 'entra.signOut', pack: () => [] },
  mcpList: { action: 'mcp.list', pack: () => [] },
  mcpAdd: { action: 'mcp.add', pack: (args) => [args[0]] },
  mcpUpdate: { action: 'mcp.update', pack: (args) => [args[0]] },
  mcpRemove: { action: 'mcp.remove', pack: (args) => [args[0]] },
  // `slice`, not `[args[0], args[1]]`: a positional pack that always emits
  // two elements turns a one-argument call into a two-element array whose
  // second hole JSON.stringify serialises as `null`. The server then receives
  // an explicit null scope where the caller passed nothing at all. (A named
  // pack does not have this problem -- an undefined object property is
  // dropped by JSON entirely, which is why only the positional ones are
  // written this way.)
  // The third argument, `{ redirectUri }`, asks for a sign-in the requester
  // finishes (auth.completeSignIn). Without it the server waits for the
  // browser round trip, so the call gets the interactive timeout.
  mcpLogin: { action: 'mcp.login', pack: (args) => args.slice(0, 3), timeoutMs: INTERACTIVE_SIGN_IN_TIMEOUT_MS },
  authCompleteSignIn: { action: 'auth.completeSignIn', pack: (args) => [args[0]] },
  mcpLogout: { action: 'mcp.logout', pack: (args) => [args[0]] },

  // ── Resources, charts, automation ────────────────────────────────────
  // `useResourceBootstrap` reads both of these on mount inside a
  // `Promise.allSettled`, so an unbridged refusal was swallowed and the
  // notifications inbox rendered empty with nothing logged.
  getPersistedResources: { action: 'resource.listPersisted', pack: () => [] },
  getReadResourceIds: { action: 'resource.readIds', pack: () => [] },
  // Read / delete / fetch-one, packed into the one object each action takes
  // (the preload sent the same object over IPC). The first two were sent,
  // not invoked, so they stay one-way.
  markResourceRead: { action: 'resource.markRead', pack: (args) => [{ kind: args[0], resourceId: args[1], producer: args[2] }], oneWay: true },
  publishResourceDelete: { action: 'resource.delete', pack: (args) => [{ kind: args[0], resourceId: args[1], producer: args[2] }], oneWay: true },
  resourceGet: { action: 'resource.get', pack: (args) => [{ kind: args[0], id: args[1], ...((args[2] as object | undefined) ?? {}) }] },
  // The active tab, on every host: presence for everyone, and for the local
  // desktop also the Environment's operator focus (`presence.focus`'s doc).
  notifyTabFocus: { action: 'presence.focus', pack: (args) => [args[0], args[1] ?? null], oneWay: true },
  // Fire-and-forget: the answer arrives on `ion:chart-jump`, not as a reply.
  requestChartJump: { action: 'chart.jump', pack: (args) => [args[0]], oneWay: true },
  automationListing: { action: 'automation.listing', pack: (args) => [args[0]] },
  automationHistory: { action: 'automation.history', pack: () => [] },
  automationDelete: { action: 'automation.delete', pack: (args) => [args[0]] },
  resolveAutomationCommand: {
    action: 'automation.commandResult',
    pack: (args) => [{ id: args[0], ...(args[1] as object) }],
    oneWay: true,
  },

  // The Studio surface's own per-person UI state: the left sidebar's
  // visibility (`studioLayout`) and each conversation's surface panel record
  // (`studioSurface`). Unbridged, a browser client reset both on reload.
  studioGetSettings: { action: 'studio.getSettings', pack: () => [] },
  studioSetSetting: { action: 'studio.setSetting', pack: (args) => args.slice(0, 2) },
  // ── Visualizer reads (server/src/protocol/studio-actions.ts) ──
  // The campus view's conversation list and per-tab summaries, and the
  // theme-pack loader. These were the reads that kept the whole Visualizer
  // tab Electron-only; export stays native under `nativeShell`.
  studioListTabs: { action: 'studio.listTabs', pack: () => [] },
  studioGetAllStatus: { action: 'studio.allStatus', pack: () => [] },
  studioListThemes: { action: 'studio.listThemes', pack: () => [] },
  studioReadThemeBundle: { action: 'studio.readThemeBundle', pack: (args) => [args[0]] },
  studioReadThemeAsset: { action: 'studio.readThemeAsset', pack: (args) => [args[0], args[1]], unpack: base64ToArrayBuffer },

  // ── Session and conversation reads ───────────────────────────────────
  // Every one of these used to refuse in a browser client. Two of them are
  // on the first-paint path of ordinary use: `resolveNewConversationDefaults`
  // fires when the new-conversation directory picker opens and
  // `readImageDataUrl` when a conversation containing an inline image is
  // opened, so both threw out of a mount effect into the root error boundary.
  discoverCommands: { action: 'session.discoverCommands', pack: (args) => [args[0]] },
  loadSession: { action: 'session.load', pack: (args) => [{ sessionId: args[0], projectPath: args[1], encodedDir: args[2] }] },
  conversationExists: { action: 'session.exists', pack: (args) => [args[0]] },
  readPlan: { action: 'session.readPlan', pack: (args) => [args[0]] },
  readImageDataUrl: { action: 'session.readImageDataUrl', pack: (args) => [args[0]] },
  getConversation: {
    action: 'session.getConversation',
    pack: (args) => [{ conversationId: args[0], offset: args[1] ?? 0, limit: args[2] ?? 50 }],
  },
  loadConversationTranscript: { action: 'session.loadTranscript', pack: (args) => [args[0]] },
  loadChainHistory: { action: 'session.loadChainHistory', pack: (args) => [args[0]] },
  tabHealth: { action: 'session.health', pack: () => [] },
  deleteStoredConversations: { action: 'session.deleteStored', pack: (args) => [args[0]] },
  resolveNewConversationDefaults: { action: 'session.resolveNewConversationDefaults', pack: (args) => [args[0]] },
  getEnterprisePolicyFull: { action: 'policy.getFull', pack: () => [] },
  getEnterprisePolicy: { action: 'policy.getNewConversationDefaults', pack: () => [] },
  // The engine remainder (`engine-actions.ts`): the session verbs a client
  // does not reach through a store action. `key` is the tab id (ADR-010).
  engineAbortDispatch: { action: 'engine.abortDispatch', pack: (args) => [{ key: args[0], dispatchId: args[1] }] },
  engineStopBackgroundTask: { action: 'engine.stopBackgroundTask', pack: (args) => [{ key: args[0], taskId: args[1] }] },
  engineDialogResponse: { action: 'engine.dialogResponse', pack: (args) => [{ key: args[0], dialogId: args[1], value: args[2] }] },
  engineStop: { action: 'engine.stop', pack: (args) => [{ key: args[0] }] },
  engineBranchBefore: { action: 'engine.branchBefore', pack: (args) => [{ key: args[0], entryId: args[1] }] },
  engineRemapSession: { action: 'engine.remapSession', pack: (args) => [{ oldKey: args[0], newKey: args[1] }] },
  engineBroadcastHistory: { action: 'engine.broadcastHistory', pack: (args) => [{ tabId: args[0], instanceId: args[1], opts: args[2] }] },
  pluginInstall: { action: 'plugin.install', pack: (args) => [args[0]] },
  pluginList: { action: 'plugin.list', pack: () => [] },
  pluginRemove: { action: 'plugin.remove', pack: (args) => [args[0]] },
  // Voice input's audio-to-text pass, run on the server host (`transcribe.ts`).
  transcribeAudio: { action: 'transcribe.audio', pack: (args) => [args[0]], timeoutMs: TRANSCRIBE_TIMEOUT_MS },
  // The renderer half of an `ion://` confirmation. The preload sent these
  // rather than invoked them, and nothing waits on a reply here either.
  setDeepLinkConfirmAvailability: { action: 'deeplink.setConfirmAvailability', pack: (args) => [{ owner: args[0], available: args[1] }], oneWay: true },
  resolveDeepLinkConfirm: { action: 'deeplink.confirmResult', pack: (args) => [args[0]], oneWay: true },
  // The Graph View's config and corpus. `projectPath` is positional on the
  // wire; the preload wrapped it in an envelope, which the server never saw.
  graphViewGetConfig: { action: 'graphView.getConfig', pack: (args) => [args[0]] },
  graphViewSetUserConfig: { action: 'graphView.setUserConfig', pack: (args) => [args[0]] },
  graphCorpusSubscribe: { action: 'graphView.corpusSubscribe', pack: (args) => [args[0]] },
  graphCorpusUnsubscribe: { action: 'graphView.corpusUnsubscribe', pack: (args) => [args[0]] },
  // Conversation archives. The client picks the archive path with its own
  // host (`pickSavePath` / `pickFile`) and hands it over; the server never
  // shows a dialog.
  conversationExportPreview: { action: 'backup.exportPreview', pack: (args) => [{ scope: args[0] }] },
  conversationExport: { action: 'backup.export', pack: (args) => [args[0]], timeoutMs: BACKUP_TIMEOUT_MS },
  conversationRestorePreview: { action: 'backup.restorePreview', pack: (args) => [args[0] ?? {}] },
  conversationRestore: { action: 'backup.restore', pack: (args) => [args[0]], timeoutMs: BACKUP_TIMEOUT_MS },
  // The Worktree Overlap window's verbs. Each takes the repository context
  // explicitly (the window reads it once with the native
  // `getWorktreeOverlapContext`), because a `studio_action` has no calling
  // window to look it up from.
  getWorktreeOverlap: { action: 'worktree.overlap.analyze', pack: (args) => [args[0], args[1]] },
  previewWorktreeOverlap: { action: 'worktree.overlap.preview', pack: (args) => [args[0], args[1], args[2]] },
  solveWorktreeOverlap: { action: 'worktree.overlap.solve', pack: (args) => [args[0], args[1], args[2]] },
  autoOrderWorktreeOverlap: { action: 'worktree.overlap.autoOrder', pack: (args) => [args[0], args[1], args[2]] },
  previewWorktreeOverlapApply: { action: 'worktree.overlap.applyPreview', pack: (args) => [args[0], args[1], args[2]] },
  applyWorktreeOverlap: { action: 'worktree.overlap.apply', pack: (args) => [args[0], args[1], args[2]] },
  // Custom theme packs, resolved server-side with inline asset data URLs.
  listCustomThemes: { action: 'themes.list', pack: () => [] },
  // Positional on the preload (`engineCommand(key, command, args)`), packed
  // into the one object the action takes -- the same marshalling the preload
  // itself does before `ipcRenderer.invoke`.
  engineCommand: { action: 'engine.command', pack: (args) => [{ key: args[0], command: args[1], args: args[2] }] },
  engineGetContextBreakdown: { action: 'engine.contextBreakdown', pack: (args) => [{ key: args[0] }] },

  getPlanBashAllowlist: { action: 'planBashAllowlist.get', pack: () => [] },
  setPlanBashAllowlist: { action: 'planBashAllowlist.set', pack: (args) => [args[0]] },

  // ── Filesystem (Explorer tree, file editor) ──
  // The three genuinely native verbs are deliberately absent and still
  // refuse: `fsSaveDialog`, `fsRevealInFinder`, and `fsOpenNative` are OS
  // shell integrations with no server-side meaning.
  fsReadDir: { action: 'fs.readDir', pack: named('directory') },
  fsReadFile: { action: 'fs.readFile', pack: named('filePath') },
  fsExists: { action: 'fs.exists', pack: named('targetPath') },
  fsWatchFile: { action: 'fs.watchFile', pack: named('filePath') },
  fsUnwatchFile: { action: 'fs.unwatchFile', pack: named('filePath') },
  fsWriteFile: {
    action: 'fs.writeFile',
    pack: (args) => [{ filePath: args[0], content: args[1] }],
  },
  fsCreateDir: { action: 'fs.createDir', pack: named('dirPath') },
  fsCreateFile: { action: 'fs.createFile', pack: named('filePath') },
  fsRename: {
    action: 'fs.rename',
    pack: (args) => [{ oldPath: args[0], newPath: args[1] }],
  },
  fsDelete: { action: 'fs.delete', pack: named('targetPath') },

  // ── Git ──
  // Each `pack` mirrors the matching method in `preload/api-request.ts`.
  // The two bare-string payloads (isRepo, ignoredFiles) are deliberate: the
  // preload sends the directory unwrapped for exactly those two.
  gitIsRepo: { action: 'git.isRepo', pack: (args) => [args[0]] },
  gitIgnoredFiles: { action: 'git.ignoredFiles', pack: (args) => [args[0]] },
  gitGraph: {
    action: 'git.graph',
    pack: (args) => [{
      directory: args[0], skip: args[1], limit: args[2], search: args[3], author: args[4],
      ...((args[5] as Record<string, unknown> | undefined) ?? {}),
    }],
  },
  gitChanges: { action: 'git.changes', pack: named('directory') },
  gitCommit: {
    action: 'git.commit',
    pack: (args) => {
      const opts = args[2]
      return [typeof opts === 'boolean'
        ? { directory: args[0], message: args[1], amend: opts }
        : {
            directory: args[0],
            message: args[1],
            amend: (opts as { amend?: boolean } | undefined)?.amend,
            signoff: (opts as { signoff?: boolean } | undefined)?.signoff,
            gpg: (opts as { gpg?: boolean } | undefined)?.gpg,
          }]
    },
  },
  gitFetch: { action: 'git.fetch', pack: named('directory') },
  gitPull: { action: 'git.pull', pack: named('directory') },
  gitPush: { action: 'git.push', pack: named('directory') },
  gitBranches: { action: 'git.branches', pack: named('directory') },
  gitCheckout: { action: 'git.checkout', pack: (args) => [{ directory: args[0], branch: args[1] }] },
  gitCreateBranch: { action: 'git.createBranch', pack: (args) => [{ directory: args[0], name: args[1] }] },
  gitDeleteBranch: { action: 'git.deleteBranch', pack: (args) => [{ directory: args[0], branch: args[1] }] },
  gitDiff: { action: 'git.diff', pack: (args) => [{ directory: args[0], path: args[1], staged: args[2] }] },
  gitStage: { action: 'git.stage', pack: (args) => [{ directory: args[0], paths: args[1] }] },
  gitUnstage: { action: 'git.unstage', pack: (args) => [{ directory: args[0], paths: args[1] }] },
  gitDiscard: { action: 'git.discard', pack: (args) => [{ directory: args[0], paths: args[1] }] },
  gitCommitDetail: { action: 'git.commitDetail', pack: (args) => [{ directory: args[0], hash: args[1] }] },
  gitCommitFiles: { action: 'git.commitFiles', pack: (args) => [{ directory: args[0], hash: args[1] }] },
  gitCommitFileDiff: {
    action: 'git.commitFileDiff',
    pack: (args) => [{ directory: args[0], hash: args[1], path: args[2] }],
  },
  gitStashList: { action: 'git.stashList', pack: named('directory') },
  gitStashSave: { action: 'git.stashSave', pack: (args) => [{ directory: args[0], message: args[1] }] },
  gitStashPop: { action: 'git.stashPop', pack: (args) => [{ directory: args[0], ref: args[1] }] },
  gitStashDrop: { action: 'git.stashDrop', pack: (args) => [{ directory: args[0], ref: args[1] }] },
  gitCherryPick: { action: 'git.cherryPick', pack: (args) => [{ directory: args[0], hash: args[1] }] },
  gitRevert: { action: 'git.revert', pack: (args) => [{ directory: args[0], hash: args[1] }] },
  gitReset: { action: 'git.reset', pack: (args) => [{ directory: args[0], hash: args[1], mode: args[2] }] },
  gitBlame: { action: 'git.blame', pack: (args) => [{ directory: args[0], path: args[1] }] },
  gitResolveConflict: {
    action: 'git.resolveConflict',
    pack: (args) => [{ directory: args[0], path: args[1], content: args[2] }],
  },

  // ── Git operations ──
  gitRefresh: { action: 'git.refresh', pack: named('directory') },
  gitSubscribe: { action: 'git.subscribe', pack: named('directory') },
  gitUnsubscribe: { action: 'git.unsubscribe', pack: named('directory') },
  gitOpState: { action: 'git.opState', pack: named('directory') },
  gitRecentRefs: { action: 'git.recentRefs', pack: (args) => [{ directory: args[0], limit: args[1] }] },
  gitShowFile: { action: 'git.showFile', pack: (args) => [{ directory: args[0], hash: args[1], path: args[2] }] },
  gitCommitSignature: { action: 'git.commitSignature', pack: (args) => [{ directory: args[0], hash: args[1] }] },
  gitTagCreate: {
    action: 'git.tagCreate',
    pack: (args) => [{ directory: args[0], name: args[1], ref: args[2], message: args[3] }],
  },
  gitApplyPatch: {
    action: 'git.applyPatch',
    pack: (args) => [{
      directory: args[0],
      patch: args[1],
      reverse: (args[2] as { reverse?: boolean } | undefined)?.reverse,
      cached: (args[2] as { cached?: boolean } | undefined)?.cached,
    }],
  },
  gitConflictStages: { action: 'git.conflictStages', pack: (args) => [{ directory: args[0], path: args[1] }] },
  gitConflictAccept: {
    action: 'git.conflictAccept',
    pack: (args) => [{ directory: args[0], path: args[1], side: args[2] }],
  },
  gitRebaseTodo: { action: 'git.rebaseTodo', pack: (args) => [{ directory: args[0], onto: args[1] }] },
  gitRebaseExec: {
    action: 'git.rebaseExec',
    pack: (args) => [{ directory: args[0], onto: args[1], commits: args[2] }],
  },
  gitRebaseAbort: { action: 'git.rebaseAbort', pack: named('directory') },
  gitRebaseContinue: { action: 'git.rebaseContinue', pack: named('directory') },

  // ── Worktree verbs ──
  gitWorktreeAppraise: {
    action: 'git.worktreeAppraise',
    pack: (args) => [{ worktreePath: args[0], sourceBranch: args[1] }],
  },
  gitWorktreeRetirePreview: { action: 'git.worktreeRetirePreview', pack: named('worktreePath') },
  gitWorktreeRebase: {
    action: 'git.worktreeRebase',
    pack: (args) => [{ worktreePath: args[0], sourceBranch: args[1] }],
  },
  // The preload passes this one's args object straight through.
  gitWorktreeSetTitle: { action: 'git.worktreeSetTitle', pack: (args) => [args[0]] },

  // ── Preferences ──
  // Per-identity on the server, so the same sign-in restores the same Studio
  // from any browser. The subject comes from the connection, never the
  // payload, so a client can only ever read and write its own overlay.
  loadSettings: { action: 'settings.load', pack: () => [] },
  saveSettings: { action: 'settings.save', pack: (args) => [args[0]] },

  // ── FR-04 git identity ──
  // Every gitIdentity.* action resolves the subject from the connection's
  // own principal server-side, never from the payload -- see
  // protocol/git-identity-actions.ts. Same reject-on-failure contract as
  // every other bridged method (BrowserStudioHost.invokeBridged).
  gitIdentityList: { action: 'gitIdentity.list', pack: () => [] },
  gitIdentityMintSshKey: { action: 'gitIdentity.mintSshKey', pack: named('host') },
  gitIdentitySetSshKey: {
    action: 'gitIdentity.setSshKey',
    pack: (args) => [{ host: args[0], privateKey: args[1] }],
  },
  gitIdentitySetToken: {
    action: 'gitIdentity.setToken',
    pack: (args) => [{ host: args[0], token: args[1], username: args[2] }],
  },
  gitIdentityRemove: { action: 'gitIdentity.remove', pack: named('host') },
  gitIdentityAuthorize: { action: 'gitIdentity.authorize', pack: named('host') },

  // ── Terminal ──
  // Output already streams over ion:terminal-* studio_events; these are the
  // command half. `write` and `resize` are one-way to match the preload,
  // which sends rather than invokes them.
  terminalCreate: { action: 'terminal.create', pack: (args) => [{ key: args[0], cwd: args[1] }] },
  terminalWrite: { action: 'terminal.write', pack: (args) => [{ key: args[0], data: args[1] }], oneWay: true },
  terminalResize: {
    action: 'terminal.resize',
    pack: (args) => [{ key: args[0], cols: args[1], rows: args[2] }],
    oneWay: true,
  },
  terminalDestroy: { action: 'terminal.destroy', pack: named('key') },
  terminalAttach: {
    action: 'terminal.attach',
    pack: (args) => [{ key: args[0], ...((args[1] as Record<string, unknown> | undefined) ?? {}) }],
  },
  terminalActiveTabs: { action: 'terminal.activeTabs', pack: () => [] },
  terminalActivitySnapshot: { action: 'terminal.activitySnapshot', pack: () => [] },
  executeBash: {
    action: 'bash.execute',
    pack: (args) => [{ id: args[0], command: args[1], cwd: args[2] }],
  },
  cancelBash: { action: 'bash.cancel', pack: (args) => [args[0]], oneWay: true },
}

// The `on*` half of the bridge lives in its own module; re-exported here so
// every existing consumer keeps one import site for the whole table.
export { SHELL_SUBSCRIBE, BRIDGED_CAPABILITIES } from './browser-shell-subscribe'
export type { ShellSubscribeScope, ShellSubscribeSpec } from './browser-shell-subscribe'
