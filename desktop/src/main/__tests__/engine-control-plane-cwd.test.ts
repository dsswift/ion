/**
 * reconcileSessionWorkingDirectory — a prompt's project path is authoritative
 * over the directory its session happened to start in.
 *
 * The behaviour under test is the root-cause fix for worktree conversations
 * running in the base checkout: the engine pins a session's cwd at
 * `start_session`, so a prompt whose directory differs from the started one must
 * RELOCATE the session rather than silently run in the stale directory.
 *
 * These tests exercise the reconciler directly against injected deps, so they
 * pin its decision table without needing a live bridge. The integration-level
 * proof that `submitPrompt` actually calls it lives in
 * engine-control-plane-submit-cwd.test.ts.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { reconcileSessionWorkingDirectory, type ReconcileDeps } from '../engine-control-plane-cwd'
import type { TabEntry } from '../engine-control-plane-events'

const REPO = '/Users/test/project'
const WORKTREE = '/Users/test/.ion/worktrees/project-a3f1'

/** Minimal TabEntry carrying only the fields the reconciler reads. */
function makeTab(over: Partial<TabEntry> = {}): TabEntry {
  return {
    tabId: 'tab-1',
    conversationId: 'conv-1',
    engineSessionStarted: true,
    permissionMode: 'auto',
    status: 'idle',
    activeRequestId: null,
    lastActivityAt: 0,
    promptCount: 0,
    promptCountSinceCheckpoint: 0,
    clearedSinceLastPrompt: false,
    resumedSavedConversation: false,
    approvedTools: [],
    startedAt: 0,
    toolCallCount: 0,
    sawPermissionRequest: false,
    lastSurfacedProposalSig: null,
    ...over,
  } as TabEntry
}

function makeDeps(startedDir: string | undefined, over: Partial<ReconcileDeps> = {}): {
  deps: ReconcileDeps
  restartSession: ReturnType<typeof vi.fn>
  ensureSession: ReturnType<typeof vi.fn>
} {
  const restartSession = vi.fn()
  const ensureSession = vi.fn().mockResolvedValue({ ok: true })
  return {
    deps: {
      startedWorkingDirectory: () => startedDir,
      restartSession,
      ensureSession,
      ...over,
    },
    restartSession,
    ensureSession,
  }
}

describe('reconcileSessionWorkingDirectory', () => {
  beforeEach(() => vi.clearAllMocks())

  // THE regression test for the reported bug. A session started in the repo
  // receiving a prompt for a worktree must move. On the unfixed code path the
  // prompt directory was dropped and no relocation ever happened.
  it('relocates when the prompt directory diverges from the started directory', async () => {
    const { deps, restartSession, ensureSession } = makeDeps(REPO)
    const tab = makeTab({ conversationId: 'conv-keep-me' })

    const res = await reconcileSessionWorkingDirectory(deps, 'tab-1', tab, WORKTREE)

    expect(res.relocated).toBe(true)
    expect(restartSession).toHaveBeenCalledOnce()
    expect(restartSession).toHaveBeenCalledWith('tab-1')
    // Relocated to the PROMPT's directory, carrying the SAME conversation.
    expect(ensureSession).toHaveBeenCalledOnce()
    expect(ensureSession).toHaveBeenCalledWith('tab-1', {
      workingDirectory: WORKTREE,
      conversationId: 'conv-keep-me',
      permissionMode: 'auto',
    })
  })

  it('relocates exactly once, not once per call, when the directory then agrees', async () => {
    // First call diverges and relocates; a second call with the bridge now
    // reporting the new directory must be a no-op. This pins that the
    // reconciler is convergent rather than restarting on every prompt.
    const { deps, restartSession } = makeDeps(REPO)
    const tab = makeTab()
    await reconcileSessionWorkingDirectory(deps, 'tab-1', tab, WORKTREE)
    expect(restartSession).toHaveBeenCalledOnce()

    const settled = makeDeps(WORKTREE)
    const res = await reconcileSessionWorkingDirectory(settled.deps, 'tab-1', tab, WORKTREE)
    expect(res.relocated).toBe(false)
    expect(settled.restartSession).not.toHaveBeenCalled()
  })

  it('does nothing when the started directory already matches', async () => {
    const { deps, restartSession, ensureSession } = makeDeps(WORKTREE)

    const res = await reconcileSessionWorkingDirectory(deps, 'tab-1', makeTab(), WORKTREE)

    expect(res.relocated).toBe(false)
    expect(restartSession).not.toHaveBeenCalled()
    expect(ensureSession).not.toHaveBeenCalled()
  })

  it('does nothing when the session has not started yet', async () => {
    // submitPrompt's own start site handles this case; reconciling would be a
    // redundant restart of a session that does not exist.
    const { deps, restartSession, ensureSession } = makeDeps(undefined)

    const res = await reconcileSessionWorkingDirectory(
      deps, 'tab-1', makeTab({ engineSessionStarted: false }), WORKTREE,
    )

    expect(res.relocated).toBe(false)
    expect(restartSession).not.toHaveBeenCalled()
    expect(ensureSession).not.toHaveBeenCalled()
  })

  it('keeps the started directory when the prompt carries no project path', async () => {
    // An empty prompt directory asserts nothing about where the conversation
    // lives. Treating it as "relocate to nowhere" would tear down a working
    // session on a partial run-options payload.
    const { deps, restartSession } = makeDeps(REPO)

    const res = await reconcileSessionWorkingDirectory(deps, 'tab-1', makeTab(), '')

    expect(res.relocated).toBe(false)
    expect(restartSession).not.toHaveBeenCalled()
  })

  it('fails open when the bridge has no config for a session marked started', async () => {
    // Relocating on an unknown baseline would restart the session on every
    // prompt — strictly worse than leaving a session the bridge cannot
    // describe.
    const { deps, restartSession } = makeDeps(undefined)

    const res = await reconcileSessionWorkingDirectory(deps, 'tab-1', makeTab(), WORKTREE)

    expect(res.relocated).toBe(false)
    expect(restartSession).not.toHaveBeenCalled()
  })

  it('reports a failed relocation without claiming success', async () => {
    const { deps } = makeDeps(REPO, {
      ensureSession: vi.fn().mockResolvedValue({ ok: false, error: 'engine offline' }),
    })

    const res = await reconcileSessionWorkingDirectory(deps, 'tab-1', makeTab(), WORKTREE)

    expect(res.relocated).toBe(false)
    expect(res.error).toBe('engine offline')
  })
})
