/**
 * snapshot — builds the `StudioSnapshot` carried on `studio_welcome` and
 * repeated (full, never a diff) on `studio_snapshot` (manifest contract C3).
 *
 * Tab metadata (`loadSnapshotTabs`/`tabVisibleTo`/`principalSubjectForTab`)
 * lives in `tabs-index.ts` — see that module's doc for why it is split out
 * (keeping the session store off `events.ts`'s import path). This module
 * re-exports those for callers that only need "the snapshot," and adds the
 * heavier pieces that DO need the store: settings, worktree/bench state,
 * automation rules, and engine connectivity.
 */
import { AutomationStore } from '../automation/store'
import { readSettingsForSubject } from '../persistence/user-settings-store'
import { projectStudioWorktreeSnapshot } from '../store/session-store-worktree-sync'
import { projectStudioConversationTerminals } from '@ion/shared/studio-conversation-terminal-sync'
import { nextWorktreeRevision, nextTerminalRevision } from '../store/studio-revisions'
import { useSessionStore } from '../store/sessionStore'
import { withSpan } from '../tracing/op-span'
import { projectResolvedModels } from '../store/resolved-model-projection'
import { engineBridge } from '../state'
import { log as _log, warn as _warn } from '../logger'
import { loadSnapshotTabs, tabVisibleTo } from './tabs-index'
import { fullPresenceSnapshot } from './presence'
import { systemMetricsPublisher } from '../system-metrics/runtime'
import { telemetryHealthState } from '../engine/telemetry-health'
import type { StudioPrincipalSummary, StudioSettingsSnapshot, StudioSnapshot, StudioView } from '@ion/shared/studio-wire/types'

export { loadSnapshotTabs, tabVisibleTo, principalSubjectForTab, _resetPrincipalIndexForTest } from './tabs-index'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('studio-snapshot', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('studio-snapshot', msg, fields)
}

/**
 * The settings a client paints first must be that client's OWN settings.
 * Personal preferences live in the connecting subject's overlay, so reading
 * the Environment document alone would hand every client the host's values and
 * make the first paint disagree with the `settings.load` that follows it.
 */
function buildSettingsSnapshot(subject: string): StudioSettingsSnapshot {
  return readSettingsForSubject(subject) as StudioSettingsSnapshot
}

function buildWorktreeSnapshot() {
  return { revision: nextWorktreeRevision(), ...projectStudioWorktreeSnapshot(useSessionStore.getState(), true) }
}

/**
 * First-paint Conversation Terminal Panel state, from the same projector the
 * delta publisher uses (`store/session-store-terminal-sync.ts`), so a client's
 * first paint and its subsequent deltas cannot disagree about shape.
 */
function buildTerminalSnapshot() {
  const state = useSessionStore.getState()
  return { ...projectStudioConversationTerminals(state.terminalPanes, state.terminalOpenTabIds), revision: nextTerminalRevision() }
}

function buildAutomationSnapshot() {
  try {
    return new AutomationStore().load()
  } catch (err) {
    warn('automation definitions load failed for snapshot', { error: String(err) })
    return []
  }
}

/**
 * The Environment's latest System Metrics and the retained telemetry
 * delivery health, replayed so a client that connects between changes starts
 * from the current state rather than from nothing.
 */
function environmentHealthSnapshot(): Pick<StudioSnapshot, 'systemMetrics' | 'telemetryHealth'> {
  const systemMetrics = systemMetricsPublisher()?.latest() ?? undefined
  return { systemMetrics, telemetryHealth: telemetryHealthState() }
}

/**
 * The welcome snapshot of a thin connection. The store-shaped fields are
 * empty rather than absent so the frame keeps one shape: a thin client's tab
 * list, worktrees, and terminals arrive as `RemoteEvent`s on
 * `studio:thin-event` (`thin-view/thin-sync.ts`), built for its principal.
 */
function buildThinStudioSnapshot(principal: StudioPrincipalSummary): StudioSnapshot {
  const snapshot: StudioSnapshot = {
    tabs: [],
    settings: {},
    worktrees: { revision: 0, ready: false, inventory: {}, workspaces: {}, benchSourceTips: [], benchRetired: [], gitConflictAlerts: [], worktreePipeline: null, workspaceOperationLedger: [] },
    terminals: { revision: 0, panes: [], openTabIds: [] },
    automations: [],
    engine: { connected: engineBridge.connected },
    presence: fullPresenceSnapshot(),
    ...environmentHealthSnapshot(),
  }
  log('thin snapshot built', { subject: principal.subject, connected: engineBridge.connected })
  return snapshot
}

/** Build the full first-paint payload for one connecting principal. */
export function buildStudioSnapshot(principal: StudioPrincipalSummary, view: StudioView = 'mirror'): StudioSnapshot {
  return withSpan('snapshot.build', { attrs: { view, user: principal.subject } }, () => buildSnapshotNow(principal, view))
}

function buildSnapshotNow(principal: StudioPrincipalSummary, view: StudioView): StudioSnapshot {
  if (view === 'thin') return buildThinStudioSnapshot(principal)
  const tabs = loadSnapshotTabs().filter((tab) => tabVisibleTo(tab, principal))
  const visible = new Set(tabs.map((tab) => tab.id))
  const live = useSessionStore.getState()
  const snapshot: StudioSnapshot = {
    tabs,
    resolvedModels: projectResolvedModels(live.tabs.filter((tab) => visible.has(tab.id)), live.conversationPanes),
    settings: buildSettingsSnapshot(principal.subject),
    worktrees: buildWorktreeSnapshot(),
    terminals: buildTerminalSnapshot(),
    automations: buildAutomationSnapshot(),
    engine: { connected: engineBridge.connected },
    presence: fullPresenceSnapshot(),
    ...environmentHealthSnapshot(),
  }
  log('snapshot built', { subject: principal.subject, tab_count: tabs.length, connected: engineBridge.connected })
  return snapshot
}
