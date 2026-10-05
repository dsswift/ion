import { beforeEach, describe, expect, it, vi } from 'vitest'

const ops = vi.hoisted(() => ({ addMember: vi.fn(), assembleWorkspace: vi.fn(), findMemberWorkspace: vi.fn(), updateMember: vi.fn() }))
const registry = vi.hoisted(() => ({ lookupWorktreeRegistration: vi.fn() }))
vi.mock('../logger', () => ({ debug: vi.fn(), log: vi.fn(), warn: vi.fn() }))
vi.mock('../integration/bench-ops', () => ops)
vi.mock('../worktree/registry-helpers', () => registry)

import { joinBench } from './bench-join'
import type { AutomationActionContext } from '@ion/shared/types-automation'

const context = (payload: Record<string, unknown>): AutomationActionContext => ({
  automation: { id: 'a1' }, action: { kind: 'bench:join' }, event: { type: 'conversation:completed', payload }, causation: { rootId: 'r', chain: [], depth: 0 },
} as unknown as AutomationActionContext)

beforeEach(() => {
  vi.clearAllMocks()
  registry.lookupWorktreeRegistration.mockReturnValue({ repoPath: '/repo', sourceBranch: 'main', branchName: 'wt/a' })
  ops.addMember.mockResolvedValue({ ok: true })
  ops.assembleWorkspace.mockResolvedValue({ ok: true })
  ops.updateMember.mockResolvedValue({ ok: true })
})

describe('bench:join', () => {
  it('enrolls a worktree that is not a member, then assembles the bench', async () => {
    ops.findMemberWorkspace.mockReturnValue(false)
    await joinBench(context({ worktreePath: '/wt/a' }))
    expect(ops.addMember).toHaveBeenCalledWith('/repo', 'main', '/wt/a', 'wt/a')
    expect(ops.assembleWorkspace).toHaveBeenCalledWith('/repo', 'main')
    expect(ops.updateMember).not.toHaveBeenCalled()
  })

  it('updates the pin of a worktree that already is one', async () => {
    ops.findMemberWorkspace.mockReturnValue(true)
    await joinBench(context({ worktreePath: '/wt/a' }))
    expect(ops.updateMember).toHaveBeenCalledWith('/repo', 'main', '/wt/a')
    expect(ops.addMember).not.toHaveBeenCalled()
  })

  it('skips an event with no worktree, and fails one the bench refuses', async () => {
    await joinBench(context({}))
    expect(registry.lookupWorktreeRegistration).not.toHaveBeenCalled()
    ops.findMemberWorkspace.mockReturnValue(false)
    ops.addMember.mockResolvedValue({ ok: false, error: 'This worktree has already landed and cannot join an integration bench.' })
    await expect(joinBench(context({ worktreePath: '/wt/a' }))).rejects.toThrow('already landed')
  })
})
