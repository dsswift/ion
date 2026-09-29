/**
 * Pins the `git.*` studio_action surface.
 *
 * Context: all 45 git verbs lived behind `ipcMain.handle` in four files
 * under `desktop/src/main/ipc`, so a browser Studio client showed an empty
 * Git panel and refused every verb — `gitDirect` was false for want of a
 * transport. The bodies are now one shared channel-keyed table that both
 * hosts register from.
 */
import { describe, expect, it, vi } from 'vitest'

const handlers: Record<string, ReturnType<typeof vi.fn>> = {}
vi.mock('../../git/git-api', () => ({
  get GIT_HANDLERS() { return handlers },
}))
const subscribeGit = vi.fn(() => ({ branch: 'main' }))
const unsubscribeGit = vi.fn()
vi.mock('../../git/git-subscriptions', () => ({
  subscribeGit: (...a: unknown[]) => subscribeGit(...(a as [])),
  unsubscribeGit: (...a: unknown[]) => unsubscribeGit(...(a as [])),
}))

import { GIT_ACTIONS } from '../git-actions'
import { IPC } from '@ion/shared/types'
import type { Connection } from '../connection'

function conn(): { c: Connection; sent: unknown[] } {
  const sent: unknown[] = []
  return { c: { id: 'conn-1', scopes: [], send: (f: unknown) => { sent.push(f); return true } } as unknown as Connection, sent }
}

describe('GIT_ACTIONS scopes', () => {
  it('keeps inspection at conversations:read', () => {
    for (const name of ['git.isRepo', 'git.graph', 'git.changes', 'git.diff', 'git.branches', 'git.blame', 'git.opState']) {
      expect(GIT_ACTIONS[name].requiredScope, name).toBe('conversations:read')
    }
  })

  it('requires git:write for anything that mutates the repository or index', () => {
    for (const name of [
      'git.commit', 'git.stage', 'git.unstage', 'git.discard', 'git.checkout',
      'git.createBranch', 'git.deleteBranch', 'git.stashSave', 'git.stashPop',
      'git.cherryPick', 'git.revert', 'git.reset', 'git.resolveConflict',
      'git.applyPatch', 'git.rebaseExec', 'git.rebaseAbort', 'git.rebaseContinue',
      'git.worktreeRebase', 'git.worktreeSetTitle',
    ]) {
      expect(GIT_ACTIONS[name].requiredScope, name).toBe('git:write')
    }
  })

  it('treats fetch as a write: it moves remote-tracking refs in the local repo', () => {
    expect(GIT_ACTIONS['git.fetch'].requiredScope).toBe('git:write')
  })
})

describe('GIT_ACTIONS dispatch', () => {
  it('forwards the payload to the handler keyed by the mapped IPC channel', async () => {
    handlers[IPC.GIT_CHANGES] = vi.fn(async () => ({ staged: [], unstaged: [] }))
    const { c } = conn()
    const outcome = await GIT_ACTIONS['git.changes'].handler(c, [{ directory: '/repo' }])
    expect(outcome).toEqual({ ok: true, value: { staged: [], unstaged: [] } })
    expect(handlers[IPC.GIT_CHANGES]).toHaveBeenCalledWith({ directory: '/repo' })
  })

  it('reports a mapping with no handler as a wiring bug rather than swallowing it', async () => {
    delete handlers[IPC.GIT_BLAME]
    const { c } = conn()
    const outcome = await GIT_ACTIONS['git.blame'].handler(c, [{ directory: '/repo', path: 'a' }])
    expect(outcome).toMatchObject({ ok: false, error: { code: 'git_action_unmapped' } })
  })

  it('turns a throwing handler into a typed error', async () => {
    handlers[IPC.GIT_PUSH] = vi.fn(async () => { throw new Error('rejected') })
    const { c } = conn()
    const outcome = await GIT_ACTIONS['git.push'].handler(c, [{ directory: '/repo' }])
    expect(outcome).toMatchObject({ ok: false, error: { code: 'git_action_failed' } })
  })
})

describe('git subscriptions', () => {
  it('subscribes with the connection as the subscriber and returns the snapshot', async () => {
    const { c } = conn()
    const outcome = await GIT_ACTIONS['git.subscribe'].handler(c, [{ directory: '/repo' }])
    expect(outcome).toEqual({ ok: true, value: { snapshot: { branch: 'main' } } })
    expect(subscribeGit).toHaveBeenCalledWith(expect.objectContaining({ id: 'conn-1' }), '/repo')
  })

  it('delivers repo events to the subscribing connection only, on ion:git-event', async () => {
    const { c, sent } = conn()
    subscribeGit.mockImplementationOnce(((sub: { send: (e: unknown) => void }) => {
      sub.send({ kind: 'status' })
      return null
    }) as never)
    await GIT_ACTIONS['git.subscribe'].handler(c, [{ directory: '/repo' }])
    expect(sent).toContainEqual({ type: 'studio_event', channel: IPC.GIT_EVENT, payload: { kind: 'status' } })
  })

  it('refuses a subscribe with no directory instead of retaining a bogus repo', async () => {
    const { c } = conn()
    const outcome = await GIT_ACTIONS['git.subscribe'].handler(c, [{}])
    expect(outcome).toMatchObject({ ok: false })
  })
})
