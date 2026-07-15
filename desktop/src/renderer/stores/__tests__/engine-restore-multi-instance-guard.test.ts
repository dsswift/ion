/**
 * useTabRestoration-engine — renderer split-fallback guard (data-loss fix)
 *
 * The on-disk migration (tab-migration-split-runner.ts) normally splits a
 * legacy multi-instance extension tab into N standalone tabs before the renderer
 * loads. But on paths where the on-disk migration was skipped (no-file,
 * not-unified, verify failure, or the runner never ran for the profile), a
 * multi-instance tab can still reach `restoreConversationTab`. The defensive guard
 * there MUST split every instance into its own tab rather than dropping
 * instances 2..N — otherwise conversation history is silently lost with no
 * on-disk `.pre-split` backup to recover from (ADR-011).
 *
 * Regression contract
 * ───────────────────
 * Before the fix, `restoreConversationTab` called `restoreSingleInstanceTab(st)`
 * once and dropped instances 2..N. Reverting the guard to restore only the
 * first instance makes the "restores all N instances" test go red (only 1
 * tab created instead of 3).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const createConversationTab = vi.fn()

vi.mock('../sessionStore', () => ({
  useSessionStore: {
    getState: () => ({
      createConversationTab,
      conversationPanes: new Map(),
    }),
    setState: vi.fn(),
  },
}))

// No engine profile configured → restoreSingleInstanceTab skips engineStart,
// so we don't need to mock window.ion.engineStart for this path.
vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => ({ engineProfiles: [] }) },
}))

vi.mock('../session-store-persistence', () => ({
  isExtensionErrorMessage: () => false,
}))

import { restoreConversationTab } from '../../hooks/useTabRestoration-engine'
import type { PersistedTab, PersistedConversationInstance } from '../../../shared/types-persistence'

function inst(id: string, label: string): PersistedConversationInstance {
  return {
    id,
    label,
    messages: [{ role: 'user', content: `hi from ${label}`, timestamp: 1 }],
    messageCount: 1,
    modelOverride: null,
    sessionModel: null,
    permissionMode: 'auto',
    permissionDenied: null,
    conversationIds: [`conv-${id}`],
    draftInput: '',
    agentStates: [],
    planFilePath: null,
  }
}

function multiTab(instances: PersistedConversationInstance[]): PersistedTab {
  return {
    conversationId: 'parent',
    title: 'Engine',
    customTitle: null,
    workingDirectory: '/tmp/p',
    hasChosenDirectory: true,
    additionalDirs: [],
    permissionMode: 'auto',
    engineProfileId: 'profile-1',
    conversationPane: { instances, activeInstanceId: instances[0]?.id },
  } as PersistedTab
}

beforeEach(() => {
  createConversationTab.mockReset()
  let n = 0
  createConversationTab.mockImplementation(() => Promise.resolve(`new-tab-${n++}`))
})

describe('restoreConversationTab — multi-instance renderer split fallback', () => {
  it('restores ALL instances as standalone tabs (no data dropped)', async () => {
    const restoredTabIds: Array<{ tabId: string; sessionId: string | null; index: number }> = []
    const tab = multiTab([inst('a', 'One'), inst('b', 'Two'), inst('c', 'Three')])

    const firstId = await restoreConversationTab(tab, restoredTabIds, 5)

    // One tab created per instance — none dropped.
    expect(createConversationTab).toHaveBeenCalledTimes(3)
    expect(restoredTabIds).toHaveLength(3)
    // First split tab id is returned for active-tab continuity.
    expect(firstId).toBe('new-tab-0')
    // Indices are offset from the original tabIndex so ordering is preserved.
    expect(restoredTabIds.map((r) => r.index)).toEqual([5, 6, 7])
  })

  it('restores a single-instance tab as exactly one tab (no spurious split)', async () => {
    const restoredTabIds: Array<{ tabId: string; sessionId: string | null; index: number }> = []
    const tab = multiTab([inst('solo', 'Solo')])

    await restoreConversationTab(tab, restoredTabIds, 0)

    expect(createConversationTab).toHaveBeenCalledTimes(1)
    expect(restoredTabIds).toHaveLength(1)
  })
})
