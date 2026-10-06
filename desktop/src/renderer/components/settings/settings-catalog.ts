/**
 * settings-catalog — every page of the Settings dialog, what is on it, and
 * what search can find there.
 *
 * The sidebar has three headings. THIS DEVICE and YOU are single pages.
 * SERVERS lists every server this device can reach; each one opens into the
 * same set of pages, so a server's settings live in one place under its own
 * name instead of behind a picker.
 *
 * Pages, sections, their order, labels, and groups come from the shared
 * settings taxonomy (`@ion/shared/settings-taxonomy`), which the phone
 * renders too. This catalog adds what only Studio has: icons, components,
 * host requirements, and search items.
 *
 * A page is a list of sections. A section's `group` is its settings GROUP
 * (`@ion/shared/settings-classification`): the key enterprise policy hides.
 * Hiding a group hides every section filed under it and then any page left
 * empty. Its `items` are what search finds; each names the registry keys it
 * shows, and a test proves every key with a page is findable, in the section
 * the taxonomy places it in.
 */
import type { Icon } from '@phosphor-icons/react'
import {
  PaintBrush, Keyboard, SlidersHorizontal, Faders, User, Bell, Info, FolderSimple, Key, Brain, ShieldCheck, Plugs, GitBranch, DeviceMobile, Pulse, HardDrives,
} from '@phosphor-icons/react'
import type React from 'react'
import type { SettingKey } from '@ion/shared/settings-registry'
import {
  SERVERS_PAGE_ID, SETTINGS_SCOPE_HEADINGS, SETTINGS_TAXONOMY_PAGES, SETTINGS_TAXONOMY_SERVERS_PAGE,
  type SettingsPageId, type SettingsPageScope, type SettingsSectionId, type SettingsTaxonomyPage,
} from '@ion/shared/settings-taxonomy'
import type { Capability } from '../../host/StudioHost'
import * as P from './pages'

export { SERVERS_PAGE_ID, SETTINGS_SCOPE_HEADINGS, type SettingsPageScope }

export interface SettingsItem {
  /** Unique across the catalog; a row carrying it as `anchor` is where a search hit lands. */
  id: string
  label: string
  keywords: string
  keys?: readonly SettingKey[]
}

export interface SettingsSection {
  /** Unique across the catalog: the section's anchor and deep-link id. */
  id: string
  label: string
  /** The settings group policy hides this section by. */
  group: string
  component: React.FC
  items: readonly SettingsItem[]
  /** A host capability the section needs; without it the section is not shown. */
  requires?: Capability
}

export interface SettingsPage {
  id: string
  label: string
  icon: Icon
  scope: SettingsPageScope
  description?: string
  sections: readonly SettingsSection[]
  /** The page uses the dialog's full width instead of the reading column. */
  wide?: boolean
}

/** What Studio adds to a taxonomy section: how it renders and what search finds there. */
interface SectionUi {
  component: React.FC
  items: readonly SettingsItem[]
  requires?: Capability
}

const item = (id: string, label: string, keywords: string, keys?: readonly SettingKey[]): SettingsItem => ({ id, label, keywords, keys })

const PAGE_ICONS: Record<SettingsPageId, Icon> = {
  appearance: PaintBrush, behavior: SlidersHorizontal, keyboard: Keyboard, advanced: Faders,
  defaults: User, notifications: Bell,
  servers: HardDrives,
  overview: Info, projects: FolderSimple, 'git-access': Key, models: Brain, agent: ShieldCheck, integrations: Plugs, workflow: GitBranch, access: DeviceMobile, health: Pulse,
}

const SECTION_UI: Record<SettingsSectionId, SectionUi> = {
  // ── This Device ──────────────────────────────────────────────────────
  appearance: { component: P.AppearancePage, items: [
    item('theme', 'Color theme', 'theme dark light color appearance', ['selectedTheme']),
    item('tool-output', 'Expand tool output', 'tool output expand auto results file write edit', ['expandToolResults']),
    item('unified-turn', 'Unified turn view', 'unified turn view conversation layout', ['unifiedTurnView']),
    item('markdown-preview', 'Open Markdown in preview', 'markdown preview edit mode .md file', ['openMarkdownInPreview']),
    item('word-wrap', 'Word wrap', 'word wrap editor line long scroll horizontal', ['editorWordWrap']),
    item('editor-font', 'Editor font size', 'editor font size pixels text code', ['editorFontSize']),
    item('data-font', 'Data view font size', 'data views table font size', ['dataViewFontSize']),
    item('ui-zoom', 'Interface scale', 'interface scale zoom ui size larger smaller', ['uiZoom']),
    item('terminal-font', 'Terminal font', 'terminal font family size nerd monospace typeface', ['terminalFontFamily', 'terminalFontSize']),
  ] },
  'device-behavior': { component: P.BehaviorPage, items: [
    item('surface-switch', 'Studio surface on conversation switch', 'studio surface switch conversation mode', ['studioSurfaceSwitchMode']),
    item('task-list', 'Show task list', 'task list todo checklist show hide', ['showTodoList']),
    item('agent-panel', 'Agent panel open by default', 'agent panel open default', ['agentPanelDefaultOpen']),
    item('sound', 'Notification sound', 'notification sound alert audio task complete', ['soundEnabled']),
    item('network-shield', 'Browser preview network shield', 'browser preview network shield block', ['browserPreviewNetworkShield']),
    item('open-at-login', 'Open Ion at login', 'open launch start at login startup boot autostart sign in', ['openAtLogin']),
    item('build-notice', "Show what's new after an update", 'update updated whats new release notes version dialog notice popup', ['showBuildNotice']),
    item('implement-clear', 'Show “Implement, clear context”', 'clear context implement plan button', ['showImplementClearContext']),
  ] },
  'device-git': { component: P.DeviceGitSection, items: [
    item('changes-tree', 'Tree view for changes', 'tree view changes git panel directory group files', ['gitChangesTreeView']),
  ] },
  shortcuts: { component: P.KeyboardPage, items: [
    item('shortcuts', 'Keyboard shortcuts', 'keyboard shortcut keybinding mapping hotkey rebind customize chord', ['keyboardShortcuts']),
  ] },
  presets: { component: P.PresetsSection, items: [item('presets', 'Presets', 'preset operator developer quick configure apply bundle')] },
  backup: { component: P.BackupSection, items: [item('backup', 'Backup and restore', 'backup restore export import conversations archive')] },
  developer: { component: P.DeveloperSection, items: [item('simulate-update', 'Simulate update', 'simulate update developer auto debug test')] },
  // ── You ──────────────────────────────────────────────────────────────
  'defaults-conversation': { component: P.DefaultsPage, items: [
    item('permission-mode', 'Default permission mode', 'permission mode plan auto approve', ['defaultPermissionMode']),
    item('ai-titles', 'AI tab titles', 'ai tab titles generate automatic name', ['aiGeneratedTitles']),
    item('bash-entry', 'Bash command entry', 'bash command entry shell terminal exclamation', ['bashCommandEntry']),
    item('claude-compat', 'Claude compatibility', 'claude compatibility compat .claude commands skills', ['enableClaudeCompat']),
    item('early-stop', 'Early-stop continuation nudge', 'early stop continuation nudge continue', ['enableEarlyStopContinuation']),
  ] },
  'defaults-thinking': { component: P.ThinkingSection, items: [
    item('thinking', 'Default thinking level', 'extended thinking effort reasoning level', ['defaultThinkingEffort']),
  ] },
  notifications: { component: P.NotificationsPage, items: [
    item('notification-kinds', 'Notification kinds', 'notification tray inbox kinds resource mute exclude', ['excludedResourceKinds']),
  ] },
  // ── Servers ──────────────────────────────────────────────────────────
  servers: { component: P.FleetPage, requires: 'local', items: [
    item('fleet-quota', 'Quota by provider', 'fleet quota provider pool limit usage claude codex subscription 5-hour 7-day weekly'),
    item('fleet-accounts', 'Accounts and usage', 'fleet accounts usage limit quota claude codex subscription 5-hour 7-day weekly signed in'),
    item('fleet-totals', 'Fleet totals', 'fleet totals servers online running conversations versions'),
    item('servers-list', 'Servers', 'environment server host list reach connect fleet manage only version load'),
    item('fleet-compatibility', 'Compatibility', 'fleet compatibility transfer format studio wire versions'),
    item('add-server', 'Add a server', 'add environment server pair pairing link ssh sign in nearby'),
    item('hidden-servers', 'Hidden and blocked servers', 'hidden blocked environment diagnostics unreachable'),
  ] },
  overview: { component: P.OverviewPage, requires: 'local', items: [
    item('connection', 'Connection', 'connection reconnect rename status reach ssh relay lan'),
    item('server-facts', 'Server version and host', 'server engine version bundle host data directory uptime'),
    item('server-lifecycle', 'Restart, update, or remove', 'restart update uninstall remove purge forget'),
  ] },
  projects: { component: P.ProjectsPage, requires: 'local', items: [
    item('projects-list', 'Projects', 'project clone copy from another environment relocate setup remove browse folder trust', ['projects']),
    item('clone-base', 'Base folder for clones', 'base folder clone directory source'),
    item('workspace-folders', 'Workspace folders', 'workspace folders mount add folder project', ['workspaceFolders']),
    item('project-profile', 'Project profile', 'project profile plain conversation ask override default star'),
  ] },
  'git-access': { component: P.GitAccessPage, requires: 'local', items: [
    item('credentials', 'Git credentials', 'git identity credential ssh key mint paste token github gitlab azure devops authorize'),
    item('test-access', 'Test repository access', 'test access ls-remote reachable repository'),
    item('commit-author', 'Commit author', 'commit author name email identity'),
  ] },
  providers: { component: P.ProvidersSection, requires: 'local', items: [
    item('providers', 'Providers', 'provider api key sign in login anthropic openai copilot gateway credential'),
  ] },
  ai: { component: P.DefaultModelsSection, items: [
    item('default-model', 'Default models', 'model conversation engine default opus sonnet haiku', ['preferredModel', 'engineDefaultModel']),
    item('plan-split', 'Plan and implement models', 'plan implement model split planning switch', ['planModelSplitEnabled', 'planModeModel', 'implementModeModel']),
  ] },
  'model-tiers': { component: P.ModelTiersSection, requires: 'local', items: [
    item('default-provider', 'Default provider', 'default provider prefer model name'),
    item('tiers', 'Model tiers', 'model tier reasoning standard fast primary fallback custom'),
  ] },
  'agent-access': { component: P.AgentAccessSection, items: [
    item('settings-edits', 'Allow settings edits by the agent', 'allow settings edits agent modify ion.md engine.json', ['allowSettingsEdits']),
  ] },
  'agent-tools': { component: P.AgentToolsSection, items: [
    item('playwright', 'Built-in browser tools', 'playwright browser tools built-in', ['studioPlaywrightEnabled']),
  ] },
  'plan-bash': { component: P.PlanBashSection, requires: 'local', items: [
    item('plan-bash', 'Allowed Bash commands in plan mode', 'plan mode bash allowlist allowed commands prefix engine.json', ['planModeAllowedBashCommands']),
  ] },
  'engine-profiles': { component: P.EngineProfilesSection, requires: 'local', items: [
    item('engine-profiles', 'Engine profiles', 'engine profiles extensions configuration', ['engineProfiles']),
  ] },
  'ai-assist': { component: P.AIWorkflowsSection, items: [
    item('ai-workflows', 'AI workflow prompts', 'workbench prompt template rebase merge cherry pick bench verification resolution', ['aiAssistPromptOverrides']),
  ] },
  mcp: { component: P.McpSection, items: [
    item('mcp', 'MCP servers', 'mcp model context protocol server tools add remote stdio authorize oauth'),
  ] },
  automation: { component: P.AutomationSection, items: [
    item('automations', 'Desktop automations', 'desktop automation trigger event rule workflow when if then activity history'),
  ] },
  entra: { component: P.EntraSection, items: [
    item('entra', 'Enterprise sign-in', 'microsoft entra oidc telemetry authentication sign in'),
    item('provider-subscription', 'Provider subscription', 'subscription key lookup gateway provider api key choose select'),
  ] },
  git: { component: P.GitWorkflowSection, items: [
    item('gitops-mode', 'GitOps mode', 'gitops mode manual worktree branch isolate', ['gitOpsMode']),
    item('completion', 'Completion strategy', 'completion strategy merge pull request pr linear', ['worktreeCompletionStrategy', 'worktreeSkipPrTitle']),
    item('commit-command', 'Commit command', 'commit command bash terminal custom', ['commitCommand']),
    item('branch-defaults', 'Branch defaults', 'branch defaults source directory saved', ['worktreeBranchDefaults']),
    item('watcher-ignore', 'Ignored directories', 'git watcher ignored directories node_modules', ['gitWatcherIgnoredDirectories']),
  ] },
  tabs: { component: P.InboxSection, items: [
    item('auto-settle', 'Auto-settle conversations', 'inbox settle inactive idle days automatic archive', ['inboxAutoSettleDays']),
    item('usage-limits', 'Usage limits', 'usage limit quota resume reset rate limited spare unused expire alert subscription', ['usageLimitAutoResume', 'usageLimitResumePrompt', 'quotaExpiryAlertHours', 'quotaExpiryUnusedPercent']),
  ] },
  quicktools: { component: P.QuickToolsSection, items: [
    item('quick-tools', 'Quick tools', 'quick tools custom button shortcut action icon command', ['quickTools']),
  ] },
  // No host requirement: a person without admin (a web Studio sign-in)
  // pairs their own devices here; the section picks the view by scope.
  devices: { component: P.DevicesSection, items: [
    item('devices', 'Paired devices', 'devices paired desktop phone iphone ios pair qr code revoke pairing link mint'),
  ] },
  discovery: { component: P.DiscoverySection, requires: 'local', items: [
    item('discovery', 'Discovery', 'discovery lan nearby discoverable code bonjour'),
  ] },
  remote: { component: P.PhoneRelaySection, requires: 'local', items: [
    item('display', 'Name and icon on the phone', 'desktop display name icon phone', ['remoteDisplay']),
    item('relay', 'Relay server', 'relay server url api key oidc discovery remote', ['relayUrl', 'relayApiKey']),
    item('low-bandwidth', 'Low-bandwidth mode', 'stream reasoning phone low bandwidth push conversation titles notifications', ['streamThinkingToRemote', 'pushConversationTitles']),
  ] },
  health: { component: P.HealthPage, requires: 'local', items: [
    item('metrics', 'System metrics', 'system metrics cpu memory disk load processes gpu'),
    item('host-tools', 'Tools on the host', 'tools host toolchain node go git version missing'),
    item('telemetry', 'Telemetry delivery', 'telemetry delivery queue backlog'),
    item('logs', 'Logs', 'logs engine.jsonl server.jsonl tail'),
  ] },
}

/** A taxonomy page with Studio's icon, and each section with its component and search items. */
function studioPage(page: SettingsTaxonomyPage): SettingsPage {
  return { ...page, icon: PAGE_ICONS[page.id], sections: page.sections.map((s) => ({ ...s, ...SECTION_UI[s.id] })) }
}

export const SETTINGS_PAGES: readonly SettingsPage[] = SETTINGS_TAXONOMY_PAGES.map(studioPage)

export const SERVERS_PAGE: SettingsPage = { ...studioPage(SETTINGS_TAXONOMY_SERVERS_PAGE), wide: true }

/** Where the dialog is: a page, the server it is about (server pages only), and a row to reveal. */
export interface SettingsLocation {
  pageId: string
  environmentId: string | null
  anchor: string | null
}

/** Old tab ids that name neither a page nor a section today. */
export const LEGACY_TAB_MAP: Record<string, string> = {
  environments: SERVERS_PAGE_ID,
  general: 'defaults',
  migration: 'advanced',
  editor: 'appearance',
  engine: 'models',
  'git-identity': 'git-access',
}

/** Maps a page id, a section id, or a legacy tab id onto a location. Server pages open on `environmentId`. */
export function resolveSettingsTab(tab: string | null | undefined, environmentId: string, pages: readonly SettingsPage[] = SETTINGS_PAGES): SettingsLocation {
  const fallback: SettingsLocation = { pageId: pages[0]?.id ?? 'appearance', environmentId: null, anchor: null }
  if (!tab) return fallback
  const wanted = LEGACY_TAB_MAP[tab] ?? tab
  if (wanted === SERVERS_PAGE_ID) return { pageId: SERVERS_PAGE_ID, environmentId: null, anchor: null }
  const at = (page: SettingsPage, anchor: string | null): SettingsLocation =>
    ({ pageId: page.id, environmentId: page.scope === 'server' ? environmentId : null, anchor })
  const page = pages.find((p) => p.id === wanted)
  if (page) return at(page, null)
  for (const p of pages) {
    const section = p.sections.find((s) => s.id === wanted)
    if (section) return at(p, p.sections.length > 1 ? section.id : null)
  }
  return fallback
}

export interface SectionFilter {
  hiddenGroups: readonly string[]
  capabilities: readonly Capability[]
  /** True while the new-conversation lock names a directory: the sections that add or change projects and profiles go. */
  foldersLocked?: boolean
}

/**
 * Sections that only manage the projects and profiles a new conversation can
 * pick from. Under a new-conversation lock that names a directory there is
 * nothing to pick, and the server refuses every change they make.
 */
const SECTIONS_HIDDEN_UNDER_FOLDER_LOCK: ReadonlySet<string> = new Set(['projects', 'engine-profiles'])

/** The sections of `page` this host and this policy show. */
export function visibleSections(page: SettingsPage, filter: SectionFilter): SettingsSection[] {
  const hidden = new Set(filter.hiddenGroups)
  return page.sections.filter((s) =>
    !hidden.has(s.group)
    && !(filter.foldersLocked && SECTIONS_HIDDEN_UNDER_FOLDER_LOCK.has(s.id))
    && (!s.requires || filter.capabilities.includes(s.requires)))
}

/** Pages with at least one visible section, in catalog order. */
export function visiblePages(pages: readonly SettingsPage[], scope: SettingsPageScope, filter: SectionFilter): SettingsPage[] {
  return pages.filter((p) => p.scope === scope && visibleSections(p, filter).length > 0)
}
