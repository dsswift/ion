// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { sendOpenResult } from '../useWorktreeRemoteCommandListeners'

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
