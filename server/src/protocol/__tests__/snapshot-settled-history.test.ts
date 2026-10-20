/**
 * `studio:tabs-sync` carries the settled history only when it changed, so the
 * welcome snapshot is where a connecting client gets its first copy. It is
 * scoped to the connecting principal exactly as the live tabs are.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../automation/store', () => ({ AutomationStore: class { load() { return [] } } }))
vi.mock('../../persistence/user-settings-store', () => ({ readSettingsForSubject: () => ({}) }))
vi.mock('../../store/session-store-worktree-sync', () => ({ projectStudioWorktreeSnapshot: () => ({}) }))
vi.mock('../../store/studio-revisions', () => ({ nextWorktreeRevision: () => 1, nextTerminalRevision: () => 1 }))
vi.mock('../../store/sessionStore', () => ({
  useSessionStore: { getState: () => ({ tabs: [], conversationPanes: new Map(), terminalPanes: new Map(), terminalOpenTabIds: new Set() }) },
}))
vi.mock('../../state', () => ({ engineBridge: { connected: true } }))
vi.mock('../presence', () => ({ fullPresenceSnapshot: () => ({ entries: [], driving: {} }) }))
vi.mock('../../system-metrics/runtime', () => ({ systemMetricsPublisher: () => null }))
vi.mock('../../engine/telemetry-health', () => ({ telemetryHealthState: () => undefined }))
vi.mock('../tabs-index', () => ({
  loadSnapshotTabs: () => [{ id: 'live', principalSubject: 'subject-a' }],
  loadSnapshotSettledHistory: () => [
    { id: 'settled-mine', principalSubject: 'subject-a' },
    { id: 'settled-theirs', principalSubject: 'subject-b' },
  ],
  tabVisibleTo: (tab: { principalSubject?: string }, principal: { subject: string }) => tab.principalSubject === principal.subject,
  principalSubjectForTab: () => undefined,
  _resetPrincipalIndexForTest: () => {},
}))

import { buildStudioSnapshot } from '../snapshot'

describe('welcome snapshot settled history', () => {
  it('carries the settled conversations the connecting principal may see', () => {
    const snapshot = buildStudioSnapshot({ subject: 'subject-a', displayName: 'A' } as never)
    expect(snapshot.tabs.map((t) => t.id)).toEqual(['live'])
    expect(snapshot.settledHistory?.map((t) => t.id)).toEqual(['settled-mine'])
  })
})
