/**
 * browser-shell-subscribe -- the `on*` half of the browser shell bridge:
 * which `studio_event` channel feeds each listener, which Environments it
 * hears from, and the (now empty) list of capabilities still gated on a
 * host implementing them.
 *
 * Split out of `browser-shell-bridge.ts`, which owns the request/response
 * half (`SHELL_INVOKE`). That file re-exports everything here, so a consumer
 * may import either module.
 */

/**
 * `on*` methods and the `studio_event` channel that feeds each.
 *
 * The payload contract matches the Electron listener's: these three channels
 * are bare signals (the renderer re-reads through the matching invoke rather
 * than trusting a pushed body), except `ion:provider-login-event`, which
 * carries a `ProviderLoginUpdate`.
 */
/**
 * Which Environments' events a bridged `on*` listener receives (ADR-033
 * union store). `tab`: every Environment -- the payload names a tab or
 * terminal key, unique across servers, so the consumer already knows what
 * it is looking at. `active`: only the Environment that owns the active
 * conversation -- the payload names a path, and the filesystem the
 * operator is looking at is the active conversation's. `local` (default):
 * per-device bookkeeping (settings, auth pages) that only ever meant the
 * local server. `all`: every Environment, with the environment id handed to
 * the listener as a trailing argument -- for per-server catalogs the
 * consumer keys by Environment (models, provider sign-ins).
 */
export type ShellSubscribeScope = 'tab' | 'active' | 'local' | 'all'

export interface ShellSubscribeSpec {
  scope?: ShellSubscribeScope
  channel: string
  /**
   * Call the listener with the payload SPREAD as positional arguments.
   *
   * `formatEventPayload` condenses a multi-argument broadcast into an array,
   * so a channel published as `broadcast(ch, key, data)` arrives as
   * `[key, data]`. The preload's listener signature for those channels takes
   * two parameters, so handing it the array would give it `key === [key,
   * data]` and `data === undefined` -- a mismatch that is invisible until a
   * terminal renders its own key as output.
   */
  spread?: boolean
}

export const SHELL_SUBSCRIBE: Record<string, ShellSubscribeSpec> = {
  onModelTiersUpdated: { channel: 'ion:model-tiers-updated', scope: 'all' },
  onDefaultProviderUpdated: { channel: 'ion:default-provider-updated', scope: 'all' },
  onModelsUpdated: { channel: 'ion:models-updated', scope: 'all' },
  onProviderLoginEvent: { channel: 'ion:provider-login-event', scope: 'all' },
  onFileChanged: { channel: 'ion:fs-file-changed', scope: 'active' },
  onFileTreeChanged: { channel: 'ion:fs-tree-changed', scope: 'active' },
  onGitEvent: { channel: 'ion:git-event', scope: 'active' },
  // The payload names paths on the announcing server; the listener refreshes
  // that server, so it needs every Environment and the id.
  onWorktreeTitled: { channel: 'ion:worktree-titled', scope: 'all' },
  onWorktreeLanded: { channel: 'ion:worktree-landed', scope: 'all' },
  // Published as broadcast(channel, key, data) / (channel, key, exitCode).
  onTerminalData: { channel: 'ion:terminal-incoming', spread: true, scope: 'tab' },
  onTerminalExit: { channel: 'ion:terminal-exit', spread: true, scope: 'tab' },
  // broadcast(channel, key, startError | null).
  onTerminalRestarted: { channel: 'ion:terminal-restarted', spread: true, scope: 'tab' },
  // A single TerminalActivity object, so no spread.
  onTerminalActivity: { channel: 'ion:terminal-activity', scope: 'tab' },
  // Live theme-pack and settings changes; the boot reads are `listCustomThemes`
  // and `loadSettings`. Settings arrive as `broadcast(ch, key, value)`, so spread.
  onThemesChanged: { channel: 'ion:themes-changed' },
  onSettingsChanged: { channel: 'ion:settings-changed', spread: true },
  // The server's active tab, tab-scoped (`studio:active-tab` names one tab).
  // The Visualizer follows it; the payload is the tab id alone, and the
  // cached state comes back through `studioGetState`.
  onStudioActiveTab: { channel: 'studio:active-tab', scope: 'tab' },
  // A paired device's request to open a terminal's web application. One
  // `{ tabId, url }` object, so no spread.
  onStudioOpenWebApplication: { channel: 'studio:open-web-application', scope: 'tab' },
  // Device-transport state, from the local Environment only: a desktop's
  // Remote category describes THIS machine's transport, never a visited one's.
  onRemoteRelaysChanged: { channel: 'ion:remote-relays-changed', scope: 'local' },
  onRemoteDisplayChanged: { channel: 'ion:remote-display-changed', scope: 'local' },
  onResourceCatalogChanged: { channel: 'ion:resource-catalog-changed' },
  // The payload names a project root on the active conversation's host.
  onProjectStudioConfigChanged: { channel: 'ion:project-studio-config', scope: 'active' },
  // A guided question is parked on ONE conversation, and that conversation
  // may live on any connected Environment, so every Environment's snapshot
  // has to arrive. The default `local` scope dropped every remote one, which
  // is why a question asked on a visited server never rendered here.
  // `questions-store.ts` keys the union by the id handed to the listener.
  onQuestionsState: { channel: 'ion:questions-state', scope: 'all' },
  onChartJump: { channel: 'ion:chart-jump' },
  // One `ComposerActionsState` object per change, from the tab's own server.
  onComposerActions: { channel: 'studio:composer-actions', scope: 'tab' },
  // The request half of the UI-mediated automation round trip; the result
  // goes back through the `automation.commandResult` action above.
  onAutomationCommand: { channel: 'ion:automation-command' },
  onOpenAuthUrl: { channel: 'ion:open-auth-url' },
  // An `ion://` link awaiting the operator's decision, and its settlement.
  onDeepLinkConfirmRequest: { channel: 'ion:deeplink-confirm-request' },
  onDeepLinkConfirmSettled: { channel: 'ion:deeplink-confirm-settled' },
  // Published as `broadcast(channel, projectPath, payload)`, so spread. The
  // graph is a picture of a directory in the Environment the active tab is
  // connected to.
  onGraphCorpusDelta: { channel: 'ion:graph-corpus-delta', spread: true, scope: 'active' },
  onGraphViewConfigChanged: { channel: 'ion:graph-view-config-changed', spread: true, scope: 'active' },
  onConversationBackupProgress: { channel: 'ion:conversation-backup-progress', scope: 'active' },
  // ── Owner-published mirror sync ──────────────────────────────────────
  // The same five bridges the Electron window runs. Bridging them is what
  // makes `bootMirror` stop branching on `windowMirrorSync`: every client
  // gets every sync, and only the transport under it differs.
  onStudioHistoryReplace: { channel: 'studio:history-replace', scope: 'tab' },
  // Published positionally to match the preload's callback signatures.
  onStudioPermissionResolved: { channel: 'studio:permission-resolved', spread: true, scope: 'tab' },
  onStudioUserMessageEcho: { channel: 'studio:user-message-echo', spread: true, scope: 'tab' },
  // The engine's complete MCP server list, republished on every change from
  // any client, including an `ion mcp login` run in a terminal. Local, like
  // the `mcp.*` verbs the same settings surface calls.
  onMcpServersChanged: { channel: 'ion:mcp-servers-changed' },
  // The normalized engine-event stream, published as `broadcast(channel,
  // tabId, event)`. `useEngineEvents` reads the frames directly (it needs
  // the Environment tag); this bridged form serves `shell.onEvent` callers
  // such as the visualizer's agent cache. It replaced a preload listener on
  // raw main-process IPC that no longer had a producer once the store moved
  // into the Studio server.
  onEvent: { channel: 'ion:normalized-event', spread: true, scope: 'tab' },
}

/**
 * Capabilities a browser client earns by virtue of the table above.
 *
 * Every entry here is a promise that the surface it unlocks can complete
 * every `host.shell` call it makes. Claiming one whose verbs are missing is
 * worse than not claiming it: the gate stops hiding the feature, the client
 * offers it, and the first call hits the refusal proxy and throws. That is
 * exactly what happened to the former `visualizerDirect`, which sat in this
 * list while `studioListTabs`, `studioGetAllStatus`, `studioListThemes`, and
 * the export verbs were all absent from the table -- the Visualizer
 * reappeared in the surface add menu and produced a tab that could not load.
 *
 * No automated test currently re-derives this list from the real call sites
 * each capability gates (an earlier version of this comment claimed one
 * existed, under a name that was never created --
 * `boot-mirror-browser-verbs.test.ts` covers only `bootMirror`'s own verbs,
 * a narrower surface, and `browser-shell-bridge.test.ts` pins individual
 * verbs' marshalling but does not sweep this list against them). Check the
 * real call sites by hand before adding an entry here, and add a test
 * pinning that the specific verbs it depends on are present in
 * `SHELL_INVOKE`/`SHELL_SUBSCRIBE` (`__tests__/browser-shell-bridge.test.ts`
 * pins `studioGetSettings`/`studioSetSetting` this way).
 */
export const BRIDGED_CAPABILITIES: readonly string[] = [
  // Empty by design. The eight names that lived here (`gitDirect`,
  // `filesDirect`, `terminalDirect`, `persistedLayout`, `aiModelsDirect`,
  // `automationDirect`, `mcpDirect`, `entraDirect`) were deleted once every
  // host reported them: a gate both hosts satisfy gates nothing, and the
  // call sites behind them are now unconditional. A capability belongs here
  // only while some host still lacks it AND the table above serves every
  // verb it gates -- the moment the last host catches up, delete the name
  // and the gate together rather than leaving dead code behind.
]
