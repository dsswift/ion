/**
 * The settings taxonomy: every settings page each client shows, in order,
 * under its heading, and the sections on it. Studio renders it with its own
 * icons and components; the server sends it to the phone with the projected
 * settings, so both clients name and order the same pages the same way.
 *
 * A section's `group` is the settings group enterprise policy hides it by
 * (`settings-classification`).
 *
 * `SETTINGS_KEY_PLACEMENT` says which section shows each setting. The Studio
 * catalog's search items and the server's projection are both checked
 * against it, so a key is never shown in one place on the desktop and
 * another on the phone.
 */
import type { SettingKey } from './settings-registry'

/** The sidebar heading a page sits under. */
export type SettingsPageScope = 'device' | 'you' | 'server'

export type SettingsPageId =
  | 'appearance' | 'behavior' | 'keyboard' | 'advanced'
  | 'defaults' | 'notifications'
  | 'servers'
  | 'overview' | 'projects' | 'git-access' | 'models' | 'agent' | 'integrations' | 'workflow' | 'access' | 'health'

export type SettingsSectionId =
  | 'appearance' | 'device-behavior' | 'device-git' | 'shortcuts' | 'presets' | 'backup' | 'developer'
  | 'defaults-conversation' | 'defaults-thinking' | 'notifications'
  | 'servers'
  | 'overview' | 'projects' | 'git-access' | 'providers' | 'ai' | 'model-tiers'
  | 'agent-access' | 'agent-tools' | 'plan-bash' | 'engine-profiles' | 'ai-assist'
  | 'mcp' | 'automation' | 'entra' | 'git' | 'tabs' | 'quicktools'
  | 'devices' | 'discovery' | 'remote' | 'health'

export interface SettingsTaxonomySection {
  /** Unique across every page: the section's anchor and deep-link id. */
  id: SettingsSectionId
  label: string
  /** The settings group policy hides this section by. */
  group: string
}

export interface SettingsTaxonomyPage {
  id: SettingsPageId
  label: string
  scope: SettingsPageScope
  description?: string
  sections: readonly SettingsTaxonomySection[]
}

export const SETTINGS_SCOPE_HEADINGS: ReadonlyArray<{ scope: SettingsPageScope; label: string }> = [
  { scope: 'device', label: 'This Device' },
  { scope: 'you', label: 'You' },
  { scope: 'server', label: 'Servers' },
]

/** The page listing every server; it has no server of its own. */
export const SERVERS_PAGE_ID = 'servers' satisfies SettingsPageId

const section = (id: SettingsSectionId, label: string, group: string): SettingsTaxonomySection => ({ id, label, group })

/** Every page except the servers list, in sidebar order under each heading. */
export const SETTINGS_TAXONOMY_PAGES: readonly SettingsTaxonomyPage[] = [
  // ── This Device ──────────────────────────────────────────────────────
  { id: 'appearance', label: 'Appearance', scope: 'device', description: 'How Ion looks on this device.', sections: [
    section('appearance', 'Appearance', 'appearance'),
  ] },
  { id: 'behavior', label: 'Behavior', scope: 'device', description: 'How Studio behaves on this device.', sections: [
    section('device-behavior', 'Conversations and alerts', 'general'),
    section('device-git', 'Git panel', 'git'),
  ] },
  { id: 'keyboard', label: 'Keyboard', scope: 'device', description: 'Rebind any shortcut. Click a key combination, then press the new one.', sections: [
    section('shortcuts', 'Keyboard shortcuts', 'shortcuts'),
  ] },
  { id: 'advanced', label: 'Advanced', scope: 'device', description: 'Presets, backups, and tools for testing Ion itself.', sections: [
    section('presets', 'Presets', 'advanced'),
    section('backup', 'Backup and restore', 'advanced'),
    section('developer', 'Developer', 'advanced'),
  ] },
  // ── You ──────────────────────────────────────────────────────────────
  { id: 'defaults', label: 'Defaults', scope: 'you', description: 'Yours on every server. New conversations start with these.', sections: [
    section('defaults-conversation', 'New conversations', 'general'),
    section('defaults-thinking', 'Extended thinking', 'ai'),
  ] },
  { id: 'notifications', label: 'Notifications', scope: 'you', description: 'Which kinds of notification reach your inbox.', sections: [
    section('notifications', 'Notification tray', 'notifications'),
  ] },
  // ── Servers (one set per server) ─────────────────────────────────────
  { id: 'overview', label: 'Overview', scope: 'server', sections: [
    section('overview', 'Overview', 'environments'),
  ] },
  { id: 'projects', label: 'Projects', scope: 'server', sections: [
    section('projects', 'Projects', 'environments'),
  ] },
  { id: 'git-access', label: 'Git access', scope: 'server', sections: [
    section('git-access', 'Git access', 'environments'),
  ] },
  { id: 'models', label: 'Providers & models', scope: 'server', sections: [
    section('providers', 'Providers', 'environments'),
    section('ai', 'Default models', 'ai'),
    section('model-tiers', 'Model tiers', 'ai'),
  ] },
  { id: 'agent', label: 'Agent rules', scope: 'server', sections: [
    section('agent-access', 'Agent access', 'advanced'),
    section('agent-tools', 'Tools', 'general'),
    section('plan-bash', 'Plan mode', 'ai'),
    section('engine-profiles', 'Engine profiles', 'environments'),
    section('ai-assist', 'AI workflow prompts', 'ai-assist'),
  ] },
  { id: 'integrations', label: 'Integrations', scope: 'server', sections: [
    section('mcp', 'MCP servers', 'mcp'),
    section('automation', 'Automations', 'automation'),
    section('entra', 'Enterprise sign-in', 'entra'),
  ] },
  { id: 'workflow', label: 'Workflow', scope: 'server', sections: [
    section('git', 'Git operations', 'git'),
    section('tabs', 'Inbox', 'tabs'),
    section('quicktools', 'Quick tools', 'quicktools'),
  ] },
  { id: 'access', label: 'Access & pairing', scope: 'server', sections: [
    section('devices', 'Paired devices', 'remote'),
    section('discovery', 'Discovery', 'remote'),
    section('remote', 'Phone and relay', 'remote'),
  ] },
  { id: 'health', label: 'Health', scope: 'server', sections: [
    section('health', 'Health', 'environments'),
  ] },
]

export const SETTINGS_TAXONOMY_SERVERS_PAGE: SettingsTaxonomyPage = {
  id: SERVERS_PAGE_ID, label: 'Fleet', scope: 'server', description: 'Every Ion Studio Server this device is paired with: its accounts, usage, and health. The local server is always here.', sections: [
    section('servers', 'Servers', 'environments'),
  ],
}

/** Every page in sidebar order: the servers list opens the Servers heading. */
export const SETTINGS_TAXONOMY: readonly SettingsTaxonomyPage[] = [
  ...SETTINGS_TAXONOMY_PAGES.filter((p) => p.scope !== 'server'),
  SETTINGS_TAXONOMY_SERVERS_PAGE,
  ...SETTINGS_TAXONOMY_PAGES.filter((p) => p.scope === 'server'),
]

export interface SettingsPlacement {
  page: SettingsPageId
  section: SettingsSectionId
}

/** The settings each section shows, by section. A key appears in one section only. */
const KEYS_BY_SECTION: ReadonlyArray<SettingsPlacement & { keys: readonly SettingKey[] }> = [
  { page: 'appearance', section: 'appearance', keys: ['selectedTheme', 'expandToolResults', 'unifiedTurnView', 'openMarkdownInPreview', 'editorWordWrap', 'editorFontSize', 'dataViewFontSize', 'uiZoom', 'terminalFontFamily', 'terminalFontSize'] },
  { page: 'behavior', section: 'device-behavior', keys: ['studioSurfaceSwitchMode', 'showTodoList', 'agentPanelDefaultOpen', 'soundEnabled', 'browserPreviewNetworkShield', 'showImplementClearContext', 'openAtLogin'] },
  { page: 'behavior', section: 'device-git', keys: ['gitChangesTreeView'] },
  { page: 'keyboard', section: 'shortcuts', keys: ['keyboardShortcuts'] },
  { page: 'defaults', section: 'defaults-conversation', keys: ['defaultPermissionMode', 'aiGeneratedTitles', 'bashCommandEntry', 'enableClaudeCompat', 'enableEarlyStopContinuation'] },
  { page: 'defaults', section: 'defaults-thinking', keys: ['defaultThinkingEffort'] },
  { page: 'notifications', section: 'notifications', keys: ['excludedResourceKinds'] },
  { page: 'projects', section: 'projects', keys: ['projects', 'workspaceFolders'] },
  // defaultEngineProfileId has no Studio row (Studio picks a profile per
  // project); it sits with the other per-server model defaults.
  { page: 'models', section: 'ai', keys: ['preferredModel', 'engineDefaultModel', 'planModelSplitEnabled', 'planModeModel', 'implementModeModel', 'defaultEngineProfileId'] },
  { page: 'agent', section: 'agent-access', keys: ['allowSettingsEdits'] },
  { page: 'agent', section: 'agent-tools', keys: ['studioPlaywrightEnabled'] },
  { page: 'agent', section: 'plan-bash', keys: ['planModeAllowedBashCommands'] },
  { page: 'agent', section: 'engine-profiles', keys: ['engineProfiles'] },
  { page: 'agent', section: 'ai-assist', keys: ['aiAssistPromptOverrides'] },
  { page: 'workflow', section: 'git', keys: ['gitOpsMode', 'worktreeCompletionStrategy', 'worktreeSkipPrTitle', 'commitCommand', 'worktreeBranchDefaults', 'gitWatcherIgnoredDirectories'] },
  // tabRecoveryEnabled has no Studio row (the server reads it); it sits with
  // the other conversation-lifecycle setting.
  { page: 'workflow', section: 'tabs', keys: ['inboxAutoSettleDays', 'usageLimitAutoResume', 'usageLimitResumePrompt', 'quotaExpiryAlertHours', 'quotaExpiryUnusedPercent', 'tabRecoveryEnabled'] },
  { page: 'workflow', section: 'quicktools', keys: ['quickTools'] },
  { page: 'access', section: 'remote', keys: ['remoteDisplay', 'relayUrl', 'relayApiKey', 'streamThinkingToRemote', 'pushConversationTitles'] },
]

/** Where each placed setting is shown. A key absent here is on no settings page. */
export const SETTINGS_KEY_PLACEMENT: Readonly<Partial<Record<SettingKey, SettingsPlacement>>> = Object.fromEntries(
  KEYS_BY_SECTION.flatMap(({ page, section: id, keys }) => keys.map((key) => [key, { page, section: id }])),
)

export function settingPlacement(key: string): SettingsPlacement | undefined {
  return Object.prototype.hasOwnProperty.call(SETTINGS_KEY_PLACEMENT, key)
    ? SETTINGS_KEY_PLACEMENT[key as SettingKey]
    : undefined
}

export function taxonomyPage(id: string): SettingsTaxonomyPage | undefined {
  return SETTINGS_TAXONOMY.find((p) => p.id === id)
}
