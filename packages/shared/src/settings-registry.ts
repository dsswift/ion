/**
 * Settings registry: every persisted setting declares its scope, once.
 *
 * Where a value is stored, who may write it, and who reads it all follow
 * from the scope. No surface guesses, and no second table restates it.
 *
 *   environment  One value for the whole server. Stored in that server's
 *                settings document. Written by a connection holding `admin`.
 *   account      Yours, but only meaningful on that server (it names models
 *                or directories that exist there). Stored in that
 *                server's per-identity overlay. Written by you.
 *   personal     Yours on every server. Stored on the client. A key marked
 *                `travels` is sent with the requests that need it and stamped
 *                onto the conversation; the server keeps no settings copy.
 *   device       The screen in use. Stored on the client, read only there.
 *   runtime      Held in memory, never persisted as a preference. Listed so
 *                the completeness test can prove nothing is unclassified.
 *
 * `serverWritten` marks environment keys only the server itself writes (the
 * pairing handler, revoke, the relay OIDC probe). A client's settings
 * document is a snapshot from whenever its store last loaded, so a save that
 * carried one would revert a fresh pairing on disk. `settings.save` drops
 * them from every patch; disk always wins.
 */

export type SettingScope = 'environment' | 'account' | 'personal' | 'device' | 'runtime'

/**
 * The settings page a key is shown on. The ids are the settings groups an
 * organization can hide (`settings-classification`), so the server can refuse
 * a save of any key whose page is hidden, not only hide the page. `none` is a
 * key with no page: layout state a surface remembers, or a runtime value.
 */
export type SettingsPage =
  | 'general' | 'ai' | 'appearance' | 'tabs' | 'git' | 'quicktools' | 'notifications' | 'advanced'
  | 'projects' | 'ai-assist' | 'automation' | 'shortcuts' | 'remote' | 'environments' | 'mcp' | 'entra'
  | 'none'

export interface SettingRegistryEntry {
  scope: SettingScope
  page: SettingsPage
  /** Personal scope only: the server consumes this value, so the client sends it. */
  travels?: true
  /** Environment scope only: never accepted from a client patch. */
  serverWritten?: true
}

const environment = (page: SettingsPage): SettingRegistryEntry => ({ scope: 'environment', page })
const serverWritten = (page: SettingsPage): SettingRegistryEntry => ({ scope: 'environment', page, serverWritten: true })
const account = (page: SettingsPage): SettingRegistryEntry => ({ scope: 'account', page })
const personal = (page: SettingsPage): SettingRegistryEntry => ({ scope: 'personal', page })
const travels = (page: SettingsPage): SettingRegistryEntry => ({ scope: 'personal', page, travels: true })
const device = (page: SettingsPage): SettingRegistryEntry => ({ scope: 'device', page })
const runtime = (page: SettingsPage): SettingRegistryEntry => ({ scope: 'runtime', page })

export const SETTINGS_REGISTRY = {
  // ── environment ──────────────────────────────────────────────────────
  inboxAutoSettleDays: environment('tabs'),
  inboxAutoSettleOnMerge: environment('tabs'),
  tabRecoveryEnabled: environment('tabs'),
  tabRecoveryTimeoutSec: environment('tabs'),
  engineProfiles: environment('environments'),
  projects: environment('environments'),
  projectSettingsVersion: environment('environments'),
  gitWatcherIgnoredDirectories: environment('git'),
  studioPlaywrightEnabled: environment('general'),
  aiAssistPromptOverrides: environment('ai-assist'),
  planModeAllowedBashCommands: environment('ai'),
  relayUrl: environment('remote'),
  relayApiKey: environment('remote'),
  remoteDisplay: environment('remote'),
  streamThinkingToRemote: environment('remote'),
  // Whether the agent may be approved to change this server's own settings
  // files. The server enforces it (`server/src/engine/settings-files-guard.ts`),
  // so it is this server's to decide, never a connected device's.
  allowSettingsEdits: environment('advanced'),
  // Whether a conversation's push notifications show its title. On by
  // default; off keeps titles away from Apple's push service and the relay,
  // at the cost of generic notification text.
  pushConversationTitles: environment('remote'),
  pairedDevices: serverWritten('remote'),
  relayAuthMode: serverWritten('remote'),
  relayOidcRelayUrl: serverWritten('remote'),
  relayOidcIssuer: serverWritten('remote'),
  relayOidcAudience: serverWritten('remote'),
  relayOidcRequiredScope: serverWritten('remote'),

  // ── account ──────────────────────────────────────────────────────────
  preferredModel: account('ai'),
  engineDefaultModel: account('ai'),
  planModelSplitEnabled: account('ai'),
  planModeModel: account('ai'),
  implementModeModel: account('ai'),
  defaultEngineProfileId: account('ai'),
  defaultBaseDirectory: account('projects'),
  recentBaseDirectories: account('projects'),
  directoryUsageCounts: account('projects'),
  workspaceFolders: account('projects'),
  gitOpsMode: account('git'),
  worktreeCompletionStrategy: account('git'),
  worktreeSkipPrTitle: account('git'),
  worktreeBranchDefaults: account('git'),
  commitCommand: account('git'),
  quickTools: account('quicktools'),

  // ── personal ─────────────────────────────────────────────────────────
  defaultPermissionMode: travels('general'),
  defaultThinkingEffort: travels('ai'),
  aiGeneratedTitles: travels('general'),
  enableClaudeCompat: travels('general'),
  enableEarlyStopContinuation: travels('general'),
  bashCommandEntry: personal('general'),
  excludedResourceKinds: personal('notifications'),

  // ── device ───────────────────────────────────────────────────────────
  selectedTheme: device('appearance'),
  uiZoom: device('appearance'),
  terminalFontFamily: device('appearance'),
  terminalFontSize: device('appearance'),
  editorFontSize: device('appearance'),
  dataViewFontSize: device('appearance'),
  editorWordWrap: device('appearance'),
  openMarkdownInPreview: device('appearance'),
  showHiddenFiles: device('none'),
  expandToolResults: device('appearance'),
  unifiedTurnView: device('appearance'),
  showTodoList: device('general'),
  agentPanelDefaultOpen: device('general'),
  showImplementClearContext: device('general'),
  soundEnabled: device('general'),
  keyboardShortcuts: device('shortcuts'),
  browserPreviewNetworkShield: device('general'),
  gitChangesTreeView: device('git'),
  gitPanelPaneProportions: device('none'),
  gitPanelHeight: device('none'),
  gitPanelChangesOpen: device('none'),
  gitPanelGraphOpen: device('none'),
  gitPanelRepoSectionsCollapsed: device('none'),
  fileExplorerHeight: device('none'),
  studioSurfaceSwitchMode: device('general'),
  // The Studio surface's own state. Electron keeps these in its device file.
  // A browser has no durable device store, so it keeps them in its person's
  // overlay through `studio.setSetting`, a funnel of its own that accepts
  // only these keys (`server/src/persistence/studio-settings-keys.ts`).
  studioTheme: device('none'),
  studioZoom: device('none'),
  studioSeed: device('none'),
  studioHeat: device('none'),
  studioBeacon: device('none'),
  studioSound: device('none'),
  studioLayout: device('none'),
  studioSurface: device('none'),
  studioComposerStash: device('none'),
  // Idle-repaint warning limits. Device scope: they judge this machine's
  // own Studio processes, which no server sees.
  idleRepaintGpuPercent: device('none'),
  idleRepaintCpuPercent: device('none'),
  idleRepaintSeconds: device('none'),

  // ── runtime ──────────────────────────────────────────────────────────
  enterprisePolicy: runtime('none'),
  enterpriseNewConversationDefaults: runtime('none'),
} as const satisfies Record<string, SettingRegistryEntry>

export type SettingKey = keyof typeof SETTINGS_REGISTRY

const REGISTRY: Record<string, SettingRegistryEntry> = SETTINGS_REGISTRY

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(REGISTRY, key)
}

/** `undefined` for a key the registry does not know: a legacy or foreign key, never the same as any scope. */
export function settingScope(key: string): SettingScope | undefined {
  return isSettingKey(key) ? REGISTRY[key].scope : undefined
}

/** The settings page `key` is shown on; `undefined` for a key the registry does not know. */
export function settingPage(key: string): SettingsPage | undefined {
  return isSettingKey(key) ? REGISTRY[key].page : undefined
}

export function settingKeysInScope(scope: SettingScope): SettingKey[] {
  return (Object.keys(REGISTRY) as SettingKey[]).filter((key) => REGISTRY[key].scope === scope)
}

/** Environment keys a client patch may never carry. */
export function isServerWrittenSettingKey(key: string): boolean {
  return isSettingKey(key) && REGISTRY[key].serverWritten === true
}

/** Personal keys the server consumes, so a client sends them with its requests. */
export const TRAVELLING_PREFERENCE_KEYS = (Object.keys(REGISTRY) as SettingKey[]).filter(
  (key) => REGISTRY[key].travels === true,
)

/**
 * The personal preferences a client sends with a request that creates a
 * conversation or sends a prompt. The server stamps them onto the
 * conversation and reads them from there; it holds no settings copy.
 */
export interface PersonalPreferences {
  defaultPermissionMode?: 'auto' | 'plan'
  defaultThinkingEffort?: string
  aiGeneratedTitles?: boolean
  enableClaudeCompat?: boolean
  enableEarlyStopContinuation?: boolean
}

/** What a conversation no client has ever touched runs under. */
export const PERSONAL_PREFERENCE_DEFAULTS: Required<PersonalPreferences> = {
  defaultPermissionMode: 'plan',
  defaultThinkingEffort: 'medium',
  aiGeneratedTitles: true,
  enableClaudeCompat: false,
  enableEarlyStopContinuation: false,
}

/**
 * Keep only well-formed travelling preferences from an untrusted wire value.
 * A malformed field is dropped, never coerced: the conversation then keeps
 * the value it already had.
 */
export function sanitizePersonalPreferences(raw: unknown): PersonalPreferences {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const src = raw as Record<string, unknown>
  const out: PersonalPreferences = {}
  if (src.defaultPermissionMode === 'auto' || src.defaultPermissionMode === 'plan') out.defaultPermissionMode = src.defaultPermissionMode
  if (typeof src.defaultThinkingEffort === 'string' && src.defaultThinkingEffort) out.defaultThinkingEffort = src.defaultThinkingEffort
  if (typeof src.aiGeneratedTitles === 'boolean') out.aiGeneratedTitles = src.aiGeneratedTitles
  if (typeof src.enableClaudeCompat === 'boolean') out.enableClaudeCompat = src.enableClaudeCompat
  if (typeof src.enableEarlyStopContinuation === 'boolean') out.enableEarlyStopContinuation = src.enableEarlyStopContinuation
  return out
}
