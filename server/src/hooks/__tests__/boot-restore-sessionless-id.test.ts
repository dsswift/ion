/**
 * A restored conversation with no messages yet keeps its persisted id.
 *
 * Its content file is keyed by that id. Restoring it under a fresh id left
 * the old id's file on disk with no tab in the manifest, and the tab save
 * guard reads exactly that as a truncated save: it refused the next save and
 * every save after it. Each later restart then reloaded the stale manifest,
 * and every conversation opened since the last good save was gone.
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

import { restoreOneTab } from '../boot-restore-tab'
import type { RestoredTabId } from '../boot-restore-types'

beforeEach(() => {
  createConversationTab.mockClear()
  setState.mockClear()
})

describe('restoreOneTab: a conversation with no messages yet', () => {
  it('adopts the persisted id instead of minting one', async () => {
    const saved = [{ id: 'ec7d06ba-816a-4d05-a51a-f65f12c1f4c0', title: 'New Tab', workingDirectory: process.cwd() }] as never[]
    const restored: RestoredTabId[] = []

    await restoreOneTab(saved, 0, null, null, restored, new Map())

    expect(createConversationTab).toHaveBeenCalledWith(process.cwd(), expect.objectContaining({
      reuseTabId: 'ec7d06ba-816a-4d05-a51a-f65f12c1f4c0',
      restoring: true,
    }))
    expect(restored).toEqual([{ tabId: 'ec7d06ba-816a-4d05-a51a-f65f12c1f4c0', sessionId: null, index: 0 }])
  })

  it('mints a fresh id only for a record saved before ids were persisted', async () => {
    const saved = [{ title: 'New Tab', workingDirectory: '/gone/project' }] as never[]
    const restored: RestoredTabId[] = []

    await restoreOneTab(saved, 0, null, null, restored, new Map())

    const opts = createConversationTab.mock.calls[0]?.[1] as Record<string, unknown>
    expect(opts).not.toHaveProperty('reuseTabId')
    expect(opts.restoring).toBe(true)
    expect(restored[0]?.tabId).toBe('minted-id')
  })
})
