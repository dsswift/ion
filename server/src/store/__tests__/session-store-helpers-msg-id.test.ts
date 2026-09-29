/**
 * Locally minted row ids must never collide across processes.
 *
 * The server and every Studio mirror each load this module and mint their own
 * row ids. Those ids travel between processes: the server publishes a user
 * turn under its id, and the mirror skips any echo whose id it already holds.
 * With a bare per-process counter both sides minted "msg-101", the mirror
 * already had a row of its own under that id, and a steered message vanished
 * from Studio. Each fresh module load stands in for one process here.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../persistence/preferences', () => ({
  usePreferencesStore: { getState: () => ({ soundEnabled: true }) },
}))
vi.mock('../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))
vi.mock('../model-store', () => ({
  useModelStore: { getState: () => ({ findModel: () => null }) },
}))
vi.mock('../host-api', () => ({ echoUserTurnToStudio: vi.fn(), isVisible: async () => false }))

async function loadFreshCopy() {
  vi.resetModules()
  return import('../session-store-helpers')
}

describe('nextMsgId across processes', () => {
  it('gives two independently loaded copies disjoint ids', async () => {
    const server = await loadFreshCopy()
    const studio = await loadFreshCopy()
    const serverIds = new Set(Array.from({ length: 200 }, () => server.nextMsgId()))
    const studioIds = Array.from({ length: 200 }, () => studio.nextMsgId())
    expect(studioIds.filter((id) => serverIds.has(id))).toEqual([])
  })

  it('keeps ids unique within one process and marked as local', async () => {
    const helpers = await loadFreshCopy()
    const ids = Array.from({ length: 50 }, () => helpers.nextMsgId())
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id.startsWith('msg-')).toBe(true)
  })
})
