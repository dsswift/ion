// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { sendOpenResult, projectPipelineToWire } from '../useWorktreeRemoteCommandListeners'

const sendRemote = vi.fn()

Object.defineProperty(window, 'ion', {
  configurable: true,
  value: { sendRemote },
})

describe('sendOpenResult', () => {
  it('sends focused tab id for bench conversation or terminal success', () => {
    sendOpenResult('bench-tab', 'could not open')

    expect(sendRemote).toHaveBeenCalledWith({
      type: 'desktop_worktree_op_result',
      operation: 'open',
      ok: true,
      tabId: 'bench-tab',
      error: undefined,
    })
  })

  it('sends typed failure when bench action cannot open a tab', () => {
    sendOpenResult(null, 'Could not open bench terminal.')

    expect(sendRemote).toHaveBeenLastCalledWith({
      type: 'desktop_worktree_op_result',
      operation: 'open',
      ok: false,
      tabId: undefined,
      error: 'Could not open bench terminal.',
    })
  })
})

describe('projectPipelineToWire', () => {
  it('projects a live pipeline state field-for-field', () => {
    expect(projectPipelineToWire({
      repoPath: '/repo',
      sourceBranch: 'josh',
      phase: 'awaiting-ai-confirm',
      queue: ['/wt/a', '/wt/b'],
      current: null,
      needsManual: ['/wt/c'],
      resolvedByAi: 2,
      summary: undefined,
    })).toEqual({
      type: 'desktop_worktree_pipeline',
      repoPath: '/repo',
      sourceBranch: 'josh',
      phase: 'awaiting-ai-confirm',
      queue: ['/wt/a', '/wt/b'],
      current: null,
      needsManual: ['/wt/c'],
      resolvedByAi: 2,
      summary: undefined,
    })
  })

  it('projects dismissal as phase null with the last repo path', () => {
    expect(projectPipelineToWire(null, '/repo')).toEqual({
      type: 'desktop_worktree_pipeline',
      repoPath: '/repo',
      sourceBranch: null,
      phase: null,
      queue: [],
      current: null,
      needsManual: [],
      resolvedByAi: 0,
    })
  })
})
