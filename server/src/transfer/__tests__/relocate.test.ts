/**
 * A move within this machine: the conversation is repointed at another
 * checkout or worktree here, and the worktree it leaves is untouched.
 */
import { describe, expect, it, vi } from 'vitest'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { runRelocate, type RelocateDeps } from '../relocate'
import { makeTestPaths } from './fixtures'
import type { RegistryEntry } from '../../worktree/registry'

const idle = { blocked: false, orchestratorRunning: false, orchestratorAttachingOnly: false, childCounts: [], shellCount: 0 }

function setup(name: string) {
  const paths = makeTestPaths(name)
  const dir = (n: string) => { const d = join(paths.dataDir, n); mkdirSync(d, { recursive: true }); return d }
  const project = dir('ion')
  const current = dir('wt-current')
  const other = dir('wt-other')
  const worktrees: RegistryEntry[] = [
    { worktreePath: current, repoPath: project, branchName: 'wt/current', sourceBranch: 'main', createdAt: 1 } as RegistryEntry,
    { worktreePath: other, repoPath: project, branchName: 'wt/other', sourceBranch: 'main', createdAt: 2 } as RegistryEntry,
  ]
  const tab = { id: 'tab-1', status: 'idle' as const, bashExecuting: false, workingDirectory: current, worktree: { worktreePath: current, branchName: 'wt/current', sourceBranch: 'main', repoPath: project } }
  const repoint = vi.fn(async () => true)
  const deps: RelocateDeps = {
    readProjects: () => ({ [project]: {} }),
    loadRegistry: () => worktrees,
    hasBranch: async () => true,
    createWorktree: async () => ({ ok: true, worktree: { worktreePath: join(paths.dataDir, 'wt-new'), branchName: 'wt/ion-new', sourceBranch: 'main', repoPath: project } }),
    findTab: () => tab,
    busyGuard: () => idle,
    repoint,
  }
  return { project, current, other, tab, deps, repoint, paths }
}

describe('runRelocate', () => {
  it('moves a worktree conversation into the project checkout, with no worktree', async () => {
    const s = setup('relocate-checkout')
    const result = await runRelocate('tab-1', { kind: 'checkout', dir: s.project }, s.deps)
    expect(result).toEqual({ ok: true, tabId: 'tab-1', workingDirectory: s.project, worktreePath: null })
    expect(s.repoint).toHaveBeenCalledWith('tab-1', s.project, null)
  })

  it('moves a conversation into another existing worktree', async () => {
    const s = setup('relocate-worktree')
    const result = await runRelocate('tab-1', { kind: 'worktree', worktreePath: s.other }, s.deps)
    expect(result.ok).toBe(true)
    expect(s.repoint).toHaveBeenCalledWith('tab-1', s.other, { worktreePath: s.other, branchName: 'wt/other', sourceBranch: 'main', repoPath: s.project })
  })

  it('moves a conversation into a new worktree', async () => {
    const s = setup('relocate-new')
    const result = await runRelocate('tab-1', { kind: 'new-worktree', projectDir: s.project, baseBranch: 'main' }, s.deps)
    expect(result).toEqual({ ok: true, tabId: 'tab-1', workingDirectory: join(s.paths.dataDir, 'wt-new'), worktreePath: join(s.paths.dataDir, 'wt-new') })
  })

  it('refuses a move to where the conversation already lives', async () => {
    const s = setup('relocate-same')
    const result = await runRelocate('tab-1', { kind: 'worktree', worktreePath: s.current }, s.deps)
    expect(result).toMatchObject({ ok: false, refusal: { code: 'same_place' } })
    expect(s.repoint).not.toHaveBeenCalled()
  })

  it('refuses a busy conversation, including one with background work', async () => {
    const s = setup('relocate-busy')
    const running = await runRelocate('tab-1', { kind: 'checkout', dir: s.project }, { ...s.deps, findTab: () => ({ ...s.tab, status: 'running' }) })
    const background = await runRelocate('tab-1', { kind: 'checkout', dir: s.project }, { ...s.deps, busyGuard: () => ({ ...idle, blocked: true, childCounts: [{ id: 'i', count: 1 }] }) })
    expect(running).toMatchObject({ ok: false, refusal: { code: 'running' } })
    expect(background).toMatchObject({ ok: false, refusal: { code: 'running' } })
    expect(s.repoint).not.toHaveBeenCalled()
  })

  it('refuses a landing that does not hold here', async () => {
    const s = setup('relocate-gone')
    const result = await runRelocate('tab-1', { kind: 'checkout', dir: join(s.paths.dataDir, 'gone') }, s.deps)
    expect(result).toMatchObject({ ok: false, refusal: { code: 'no_destination_directory' } })
  })
})
