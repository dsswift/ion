// @vitest-environment jsdom
/**
 * useTransferPreflight — describe on the source, preflight on the
 * destination, and the checklist that follows: a missing repo is fixable by
 * cloning with the source's origin and suggested folder; a missing base
 * branch flips the export to carry it with the destination's tips excluded;
 * a dirty worktree blocks; a plain conversation has nothing to check; a
 * destination `ion:projects-changed` event re-asks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const frameListeners = new Set<(envId: string, frame: unknown) => void>()
const hostMock = { onFrame: vi.fn((cb: (envId: string, frame: unknown) => void) => { frameListeners.add(cb); return () => frameListeners.delete(cb) }) }
const actionMock = vi.fn()
vi.mock('../../../host/host-instance', () => ({ host: hostMock, action: (...args: unknown[]) => actionMock(...args) }))

const { useTransferPreflight } = await import('../useTransferPreflight')

const worktreeDescription = { status: 'idle', worktree: { repoRemote: 'github.com/o/r', branch: 'wt/x', sourceBranch: 'josh', repoPath: '/Users/u/src/r', originUrl: 'git@github.com:o/r.git', dirty: false, suggestedParentDir: '~/src', siblings: [] as Array<{ tabId: string; title: string }> } }

function flush(): Promise<void> { return new Promise((r) => setTimeout(r, 0)) }

describe('useTransferPreflight', () => {
  let container: HTMLDivElement
  let root: Root
  let result: ReturnType<typeof useTransferPreflight>

  beforeEach(() => {
    actionMock.mockReset()
    frameListeners.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  // Whole-worktree by default: the worktree cases below are about moving one
  // whole, and a conversation with no worktree ignores the mode.
  async function mount(resolvedHere: Parameters<typeof useTransferPreflight>[4] = null, mode: Parameters<typeof useTransferPreflight>[5] = 'worktree', targetProjects: Parameters<typeof useTransferPreflight>[6] = []): Promise<void> {
    function Harness(): null { result = useTransferPreflight('src', 'tab-1', 'devbox', 'devbox', resolvedHere, mode, targetProjects); return null }
    await act(async () => { root.render(React.createElement(Harness)); await flush(); await flush() })
  }

  it('offers Clone it there when the destination has no project, using the origin and suggested folder', async () => {
    actionMock.mockImplementation(async (env: string, name: string) => {
      if (name === 'transfer.describe') return worktreeDescription
      if (name === 'transfer.preflight') return { projectDir: null, projectDirs: [], allProjectDirs: [], sourceDirectoryExists: false, hasSourceBranch: false, knownTips: [], worktreeCopy: null }
      if (name === 'environment.projects.clone') return { jobId: 'j1', dir: '/home/g/src/r' }
      throw new Error(`unexpected ${env} ${name}`)
    })
    await mount()
    expect(result.ready).toBe(false)
    const repo = result.checks.find((c) => c.id === 'repo')!
    expect(repo.state).toBe('fixable')
    await repo.fixes![0].run()
    expect(actionMock).toHaveBeenCalledWith('devbox', 'environment.projects.clone', [{ url: 'git@github.com:o/r.git', parentDir: '~/src' }])
    expect(actionMock).toHaveBeenCalledWith('devbox', 'transfer.preflight', [{ repoRemote: 'github.com/o/r', sourceBranch: 'josh', branch: 'wt/x' }])
  })

  // The repository declares code to run, so the clone is where trust is
  // asked: one click clones, trusts, and runs the setup when it lands.
  it('offers Clone and trust or Clone only, naming what trust runs, when the repository declares code', async () => {
    actionMock.mockImplementation(async (env: string, name: string) => {
      if (name === 'transfer.describe') return { ...worktreeDescription, worktree: { ...worktreeDescription.worktree, provisioning: { setup: 'make bootstrap', builds: ['npm ci'] } } }
      if (name === 'transfer.preflight') return { projectDir: null, projectDirs: [], allProjectDirs: [], sourceDirectoryExists: false, hasSourceBranch: false, knownTips: [], worktreeCopy: null }
      if (name === 'environment.projects.clone') return { jobId: 'j1', dir: '/home/g/src/r' }
      throw new Error(`unexpected ${env} ${name}`)
    })
    await mount()
    const repo = result.checks.find((c) => c.id === 'repo')!
    expect(repo.fixes?.map((f) => f.label)).toEqual(['Clone and trust', 'Clone only'])
    expect(repo.detail).toContain('runs its setup, make bootstrap, as soon as it lands, and lets its worktrees run npm ci')
    await repo.fixes![0].run()
    expect(actionMock).toHaveBeenCalledWith('devbox', 'environment.projects.clone', [{ url: 'git@github.com:o/r.git', parentDir: '~/src', trust: true }])
    await repo.fixes![1].run()
    expect(actionMock).toHaveBeenLastCalledWith('devbox', 'environment.projects.clone', [{ url: 'git@github.com:o/r.git', parentDir: '~/src' }])
  })

  it('refuses before anything is exported when the source writes an older archive format', async () => {
    actionMock.mockImplementation(async (env: string, name: string) => {
      if (name === 'transfer.describe') return worktreeDescription
      if (name === 'transfer.preflight') return { projectDir: '/home/g/src/r', projectDirs: ['/home/g/src/r'], allProjectDirs: ['/home/g/src/r'], sourceDirectoryExists: false, hasSourceBranch: true, knownTips: [], worktreeCopy: null, archiveVersion: 2 }
      throw new Error(`unexpected ${env} ${name}`)
    })
    await mount()
    expect(result.checks.map((c) => [c.id, c.state])).toEqual([['version', 'blocked']])
    expect(result.ready).toBe(false)
  })

  it('carries a missing base branch in the export with the destination tips excluded, and is ready', async () => {
    actionMock.mockImplementation(async (_env: string, name: string) => {
      if (name === 'transfer.describe') return worktreeDescription
      if (name === 'transfer.preflight') return { projectDir: '/home/g/src/r', projectDirs: ['/home/g/src/r'], allProjectDirs: ['/home/g/src/r'], sourceDirectoryExists: false, hasSourceBranch: false, knownTips: ['abc123'], worktreeCopy: null }
      throw new Error(`unexpected ${name}`)
    })
    await mount()
    expect(result.ready).toBe(true)
    expect(result.exportOptions).toEqual({ includeSourceBranch: true, knownTips: ['abc123'], carryWorktree: true })
    expect(result.checks.map((c) => [c.id, c.state])).toEqual([['siblings', 'info'], ['clean', 'ok'], ['repo', 'ok'], ['branch', 'info']])
    expect(result.siblingTabIds).toEqual([])
  })

  // A worktree has one home: the move takes every conversation in it, and
  // the export is always cut against what the destination has.
  it('names the siblings that move too, and always excludes the destination tips', async () => {
    actionMock.mockImplementation(async (_env: string, name: string) => {
      if (name === 'transfer.describe') return { ...worktreeDescription, worktree: { ...worktreeDescription.worktree, siblings: [{ tabId: 'tab-2', title: 'Second' }, { tabId: 'tab-3', title: 'Third' }] } }
      if (name === 'transfer.preflight') return { projectDir: '/home/g/src/r', projectDirs: ['/home/g/src/r'], allProjectDirs: ['/home/g/src/r'], sourceDirectoryExists: false, hasSourceBranch: true, knownTips: ['abc123'], worktreeCopy: null }
      throw new Error(`unexpected ${name}`)
    })
    await mount()
    expect(result.ready).toBe(true)
    expect(result.siblingTabIds).toEqual(['tab-2', 'tab-3'])
    expect(result.checks[0]).toMatchObject({ id: 'siblings', state: 'info', label: 'Moves the whole worktree: 3 conversations' })
    expect(result.checks[0].detail).toContain('Second, Third')
    expect(result.exportOptions).toEqual({ includeSourceBranch: false, knownTips: ['abc123'], carryWorktree: true })
  })

  it('blocks when the destination already holds this worktree, whatever its state', async () => {
    // A transfer deletes the worktree it moves, so a checkout on the
    // destination is never a leftover copy of the same work coming home --
    // it is a second home, which a move refuses to create.
    for (const copy of [
      { worktreePath: '/home/g/.ion/worktrees/wt-x', dirty: false },
      { worktreePath: '/home/g/.ion/worktrees/wt-x', dirty: true },
    ]) {
      actionMock.mockImplementation(async (_env: string, name: string) => {
        if (name === 'transfer.describe') return worktreeDescription
        if (name === 'transfer.preflight') return { projectDir: '/home/g/src/r', projectDirs: ['/home/g/src/r'], allProjectDirs: ['/home/g/src/r'], sourceDirectoryExists: false, hasSourceBranch: true, knownTips: [], worktreeCopy: copy }
        throw new Error(`unexpected ${name}`)
      })
      act(() => root.unmount())
      root = createRoot(container)
      await mount()
      expect(result.ready).toBe(false)
      expect(result.checks.find((c) => c.id === 'copy')?.state).toBe('blocked')
    }
  })

  it('blocks on a dirty worktree, passes a plain conversation, and re-asks on a projects-changed event', async () => {
    actionMock.mockImplementation(async (_env: string, name: string) => {
      if (name === 'transfer.describe') return { ...worktreeDescription, worktree: { ...worktreeDescription.worktree, dirty: true } }
      if (name === 'transfer.preflight') return { projectDir: '/home/g/src/r', projectDirs: ['/home/g/src/r'], allProjectDirs: ['/home/g/src/r'], sourceDirectoryExists: false, hasSourceBranch: true, knownTips: [], worktreeCopy: null }
      throw new Error(`unexpected ${name}`)
    })
    await mount()
    expect(result.ready).toBe(false)
    expect(result.checks.find((c) => c.id === 'clean')?.state).toBe('blocked')
    const before = actionMock.mock.calls.filter((c) => c[1] === 'transfer.preflight').length
    await act(async () => { for (const cb of frameListeners) cb('devbox', { type: 'studio_event', channel: 'ion:projects-changed', payload: {} }); await flush(); await flush() })
    expect(actionMock.mock.calls.filter((c) => c[1] === 'transfer.preflight').length).toBe(before + 1)

  })

  // A plain conversation asks the destination too: its working directory is
  // a path on the machine it is leaving, so only the destination can say
  // where it lands.
  const plainDescription = {
    status: 'idle',
    worktree: null,
    project: { workingDirectory: '/Users/them/src/r/sub', repoRemote: 'github.com/o/r', originUrl: 'git@github.com:o/r.git', suggestedParentDir: '~/src' },
  }

  it('resolves the destination directory for a plain conversation and is ready', async () => {
    actionMock.mockImplementation(async (_env: string, name: string) => {
      if (name === 'transfer.describe') return plainDescription
      if (name === 'transfer.preflight') return { projectDir: '/home/g/src/r', projectDirs: ['/home/g/src/r'], allProjectDirs: ['/home/g/src/r'], sourceDirectoryExists: false, hasSourceBranch: false, knownTips: [], worktreeCopy: null }
      throw new Error(`unexpected ${name}`)
    })
    await mount()

    expect(result.destinationDirectory).toBe('/home/g/src/r')
    expect(result.checks.find((c) => c.id === 'lands')).toMatchObject({ state: 'ok', detail: '/home/g/src/r' })
    expect(result.ready).toBe(true)
    // The directory is never taken from the source.
    expect(result.destinationDirectory).not.toBe(plainDescription.project.workingDirectory)
  })

  it('offers to clone the repository when the destination does not have it', async () => {
    actionMock.mockImplementation(async (_env: string, name: string) => {
      if (name === 'transfer.describe') return plainDescription
      if (name === 'transfer.preflight') return { projectDir: null, projectDirs: [], allProjectDirs: [], sourceDirectoryExists: false, hasSourceBranch: false, knownTips: [], worktreeCopy: null }
      throw new Error(`unexpected ${name}`)
    })
    await mount()

    expect(result.ready).toBe(false)
    expect(result.checks.find((c) => c.id === 'repo')).toMatchObject({ state: 'fixable' })
    expect(result.checks.find((c) => c.id === 'repo')?.fixes?.map((f) => f.label)).toEqual(['Clone it there'])
  })

  it('asks to trust with the clone for a conversation moving on its own too', async () => {
    actionMock.mockImplementation(async (_env: string, name: string) => {
      if (name === 'transfer.describe') return { ...plainDescription, project: { ...plainDescription.project, provisioning: { setup: 'make bootstrap', builds: [] } } }
      if (name === 'transfer.preflight') return { projectDir: null, projectDirs: [], allProjectDirs: [], sourceDirectoryExists: false, hasSourceBranch: false, knownTips: [], worktreeCopy: null }
      if (name === 'environment.projects.clone') return { jobId: 'j1', dir: '/home/g/src/r' }
      throw new Error(`unexpected ${name}`)
    })
    await mount()
    const repo = result.checks.find((c) => c.id === 'repo')!
    expect(repo.fixes?.map((f) => f.label)).toEqual(['Clone and trust', 'Clone only'])
    expect(repo.detail).toBe('The conversation lands in the clone. Clone and trust runs its setup, make bootstrap, as soon as it lands. Clone only runs none of its code.')
    await repo.fixes![0].run()
    expect(actionMock).toHaveBeenCalledWith('devbox', 'environment.projects.clone', [expect.objectContaining({ trust: true })])
  })

  it('asks which checkout when the destination has the repository twice, and refuses until told', async () => {
    actionMock.mockImplementation(async (_env: string, name: string) => {
      if (name === 'transfer.describe') return plainDescription
      if (name === 'transfer.preflight') return { projectDir: '/home/g/src/r', projectDirs: ['/home/g/a/r', '/home/g/b/r'], allProjectDirs: ['/home/g/a/r', '/home/g/b/r'], sourceDirectoryExists: false, hasSourceBranch: false, knownTips: [], worktreeCopy: null }
      throw new Error(`unexpected ${name}`)
    })
    await mount()

    expect(result.destinationDirectory).toBe('')
    expect(result.ready).toBe(false)
    expect(result.destinationMatches).toEqual(['/home/g/a/r', '/home/g/b/r'])
    expect(result.destinationOthers).toEqual([])

    await act(async () => { result.setDestinationDirectory('/home/g/b/r') })
    expect(result.destinationDirectory).toBe('/home/g/b/r')
    expect(result.ready).toBe(true)
  })

  // The case that shipped broken: the source runs a build that does not
  // report the conversation's repository. This desktop resolves it from the
  // source's project list instead, so the destination still matches — and
  // the matching project is preselected rather than left for the operator
  // to find in a list of every project on the machine.
  it('defaults to the matching project even when the source reports no repository', async () => {
    const asked: Array<Record<string, unknown>> = []
    actionMock.mockImplementation(async (_env: string, name: string, args: unknown[]) => {
      if (name === 'transfer.describe') return { status: 'idle', worktree: null }
      if (name === 'transfer.preflight') {
        asked.push(args[0] as Record<string, unknown>)
        return { projectDir: '/Users/Shared/source/personal/ion', projectDirs: ['/Users/Shared/source/personal/ion'], allProjectDirs: ['/Users/Shared/source/personal/ion', '/Users/josh/orion'], sourceDirectoryExists: false, hasSourceBranch: false, knownTips: [], worktreeCopy: null }
      }
      throw new Error(`unexpected ${name}`)
    })

    await mount({ workingDirectory: '/Users/them/source/personal/ion', repoRemote: 'github.com/o/ion', originUrl: 'git@github.com:o/ion.git', suggestedParentDir: '~/source/personal' })

    expect(asked[0]?.repoRemote).toBe('github.com/o/ion')
    expect(result.destinationDirectory).toBe('/Users/Shared/source/personal/ion')
    expect(result.ready).toBe(true)
    // The match is preselected, never the only choice: every other project
    // is still offered, after it.
    expect(result.destinationMatches).toEqual(['/Users/Shared/source/personal/ion'])
    expect(result.destinationOthers).toEqual(['/Users/josh/orion'])
  })

  // A conversation leaving its worktree resolves its destination like a
  // plain one: by repository, with no bundle, no siblings, and no dirty
  // check — the worktree stays where it is.
  it('moves a worktree conversation on its own like a plain one', async () => {
    const asked: Array<Record<string, unknown>> = []
    actionMock.mockImplementation(async (_env: string, name: string, args: unknown[]) => {
      if (name === 'transfer.describe') return {
        ...worktreeDescription,
        worktree: { ...worktreeDescription.worktree, dirty: true, siblings: [{ tabId: 'tab-2', title: 'Second' }] },
        project: { workingDirectory: '/Users/u/.ion/worktrees/r-1', repoRemote: 'github.com/o/r', originUrl: 'git@github.com:o/r.git', suggestedParentDir: '~/src' },
      }
      if (name === 'transfer.preflight') {
        asked.push(args[0] as Record<string, unknown>)
        return { projectDir: '/home/g/src/r', projectDirs: ['/home/g/src/r'], allProjectDirs: ['/home/g/src/r'], sourceDirectoryExists: false, hasSourceBranch: false, knownTips: [], worktreeCopy: null }
      }
      throw new Error(`unexpected ${name}`)
    })
    await mount(null, 'conversation')

    expect(asked[0]).toEqual({ repoRemote: 'github.com/o/r', sourceDirectory: '/Users/u/.ion/worktrees/r-1' })
    expect(result.destinationDirectory).toBe('/home/g/src/r')
    expect(result.exportOptions).toEqual({})
    expect(result.siblingTabIds).toEqual([])
    expect(result.checks.some((c) => c.id === 'clean' || c.id === 'siblings')).toBe(false)
    expect(result.ready).toBe(true)
  })

  it('offers the destination\'s whole project list when there is no repository to resolve by', async () => {
    actionMock.mockImplementation(async (_env: string, name: string) => {
      if (name === 'transfer.describe') return { status: 'idle', worktree: null, project: { workingDirectory: '/Users/them/notes', repoRemote: '', originUrl: '', suggestedParentDir: '' } }
      if (name === 'transfer.preflight') return { projectDir: null, projectDirs: [], allProjectDirs: ['/home/g/src/r', '/home/g/other'], sourceDirectoryExists: false, hasSourceBranch: false, knownTips: [], worktreeCopy: null }
      throw new Error(`unexpected ${name}`)
    })
    await mount()

    expect(result.destinationMatches).toEqual([])
    expect(result.destinationOthers).toEqual(['/home/g/src/r', '/home/g/other'])
    expect(result.ready).toBe(false)
    expect(result.checks.find((c) => c.id === 'lands')?.state).toBe('blocked')
  })

  // Ion cannot know whether someone ran a setup by hand, so it never claims
  // one has not run. The row appears only for a checkout Ion cloned and the
  // operator has not trusted, names the command, and runs nothing until
  // pressed — trust first, then the setup.
  describe('the setup row', () => {
    const preflightAnswer = { projectDir: '/home/g/src/r', projectDirs: ['/home/g/src/r'], allProjectDirs: ['/home/g/src/r'], sourceDirectoryExists: false, hasSourceBranch: true, knownTips: [], worktreeCopy: null }
    const project = (over: Record<string, unknown> = {}) => ({ dir: '/home/g/src/r', entry: { addedManually: true, lastUsedAt: 1 }, displayName: 'r', exists: true, isGitRepo: true, ...over })

    beforeEach(() => {
      actionMock.mockImplementation(async (_env: string, name: string) => {
        if (name === 'transfer.describe') return worktreeDescription
        if (name === 'transfer.preflight') return preflightAnswer
        if (name === 'environment.projects.trust' || name === 'environment.projects.setup') return {}
        throw new Error(`unexpected ${name}`)
      })
    })

    it('is absent for a checkout the operator already has, setup declared or not', async () => {
      await mount(null, 'worktree', [project({ setupCommand: 'make bootstrap' })])
      expect(result.checks.find((c) => c.id === 'setup')).toBeUndefined()
    })

    it('names the command for an untrusted clone, and trusts before it runs', async () => {
      await mount(null, 'worktree', [project({ trusted: false, setupCommand: 'make bootstrap' })])
      const row = result.checks.find((c) => c.id === 'setup')!
      expect(row.label).toBe('r declares a setup: make bootstrap')
      expect(row.fixes?.[0].label).toBe('Trust and run setup')
      expect(actionMock.mock.calls.some((c) => c[1] === 'environment.projects.setup' || c[1] === 'environment.projects.trust')).toBe(false)

      await act(async () => { await row.fixes![0].run() })
      const verbs = actionMock.mock.calls.map((c) => c[1]).filter((n) => n === 'environment.projects.trust' || n === 'environment.projects.setup')
      expect(verbs).toEqual(['environment.projects.trust', 'environment.projects.setup'])
    })

    it('only trusts an untrusted clone that declares no setup', async () => {
      await mount(null, 'worktree', [project({ trusted: false })])
      const row = result.checks.find((c) => c.id === 'setup')!
      expect(row.fixes?.[0].label).toBe('Trust project')
      await act(async () => { await row.fixes![0].run() })
      expect(actionMock.mock.calls.some((c) => c[1] === 'environment.projects.setup')).toBe(false)
    })
  })
})
