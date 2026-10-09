/**
 * A tab saved with a blank conversationId and a lastKnownSessionId whose
 * conversation is on disk restores as that conversation, not as a sessionless
 * tab. Filed as sessionless, its history never loaded and the operator saw an
 * empty transcript for a conversation that was whole on disk.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../../logger', () => ({ debug: vi.fn(), warn: vi.fn(), log: vi.fn(), error: vi.fn() }))

const createConversationTab = vi.fn(async (_dir: string, opts: { reuseTabId?: string } = {}) => opts.reuseTabId ?? 'minted-id')
const setState = vi.fn()

vi.mock('../useTabRestoration-engine', () => ({ restoreConversationTab: vi.fn() }))
vi.mock('../../store/worktree-registration', () => ({ resolveRegisteredWorktree: async () => null }))
vi.mock('../../store/sessionStore', () => ({
  useSessionStore: { getState: () => ({ createConversationTab }), setState: (...a: unknown[]) => setState(...a) },
}))
vi.mock('../../store/host-api-engine', () => ({ adoptTab: vi.fn() }))
vi.mock('../../store/host-api', () => ({ setPermissionMode: vi.fn() }))
vi.mock('../../session-meta', () => ({ conversationExists: (id: string) => id === 'conv-on-disk' }))

import { restoreOneTab } from '../boot-restore-tab'
import type { RestoredTabId } from '../boot-restore-types'

const TAB_ID = '6ff1c449-89bc-4e67-a18f-1d9a5e3eefef'

beforeEach(() => {
  createConversationTab.mockClear()
  setState.mockClear()
})

describe('restoreOneTab: a blank conversationId beside a last known conversation', () => {
  it('restores as that conversation when its file is on disk', async () => {
    const saved = [{ id: TAB_ID, conversationId: '', lastKnownSessionId: 'conv-on-disk', title: 'Finances', workingDirectory: process.cwd() }] as never[]
    const restored: RestoredTabId[] = []

    await restoreOneTab(saved, 0, null, null, restored, new Map())

    expect(restored).toEqual([{ tabId: TAB_ID, sessionId: 'conv-on-disk', index: 0 }])
    expect(createConversationTab).not.toHaveBeenCalled()
    // The saved record is repaired in place so the rest of the boot sees the id.
    expect((saved[0] as { conversationId: string }).conversationId).toBe('conv-on-disk')
  })

  it('stays sessionless when the last known conversation has no file', async () => {
    const saved = [{ id: TAB_ID, conversationId: '', lastKnownSessionId: 'conv-gone', title: 'Finances', workingDirectory: process.cwd() }] as never[]
    const restored: RestoredTabId[] = []

    await restoreOneTab(saved, 0, null, null, restored, new Map())

    expect(restored).toEqual([{ tabId: TAB_ID, sessionId: null, index: 0 }])
    expect(createConversationTab).toHaveBeenCalledWith(process.cwd(), expect.objectContaining({ reuseTabId: TAB_ID, restoring: true }))
  })
})
