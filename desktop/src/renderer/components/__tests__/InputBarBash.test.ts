/**
 * Bash-mode dispatch, extracted from InputBar.handleSend. These pin the
 * refusal set that used to be three bare `return`s inside the component, so a
 * later edit cannot start clearing the operator's command before deciding
 * whether it will run.
 */
import { describe, it, expect, vi } from 'vitest'
import { dispatchBashCommand, type BashDispatchDeps } from '../InputBarBash'

function deps(over: Partial<BashDispatchDeps> = {}) {
  const exec = vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }))
  const d: BashDispatchDeps = {
    command: 'ls',
    bashExecuting: false,
    isConnecting: false,
    cwd: '/repo',
    activeTabId: 'tab-1',
    clearInput: vi.fn(),
    clearDraft: vi.fn(),
    exitBashMode: vi.fn(),
    startBashCommand: vi.fn(() => ({ toolMsgId: 'msg-1', tabId: 'tab-1' })),
    completeBashCommand: vi.fn(),
    executeBash: exec,
    onSettled: vi.fn(),
    ...over,
  }
  return d
}

describe('dispatchBashCommand', () => {
  it('clears, exits bash mode, and executes in the conversation cwd', async () => {
    const d = deps()
    expect(dispatchBashCommand(d)).toBe(true)
    expect(d.clearInput).toHaveBeenCalled()
    expect(d.clearDraft).toHaveBeenCalledWith('tab-1')
    expect(d.exitBashMode).toHaveBeenCalled()
    expect(d.executeBash).toHaveBeenCalledWith(expect.any(String), 'ls', '/repo')
    await vi.waitFor(() => expect(d.completeBashCommand).toHaveBeenCalledWith('tab-1', 'msg-1', 'ls', 'ok', '', 0))
    expect(d.onSettled).toHaveBeenCalled()
  })

  for (const [name, over] of [
    ['an empty command', { command: '' }],
    ['an execution already in flight', { bashExecuting: true }],
    ['a session that is still connecting', { isConnecting: true }],
  ] as Array<[string, Partial<BashDispatchDeps>]>) {
    it(`refuses ${name} without clearing anything`, () => {
      const d = deps(over)
      expect(dispatchBashCommand(d)).toBe(false)
      expect(d.clearInput).not.toHaveBeenCalled()
      expect(d.clearDraft).not.toHaveBeenCalled()
      expect(d.exitBashMode).not.toHaveBeenCalled()
      expect(d.executeBash).not.toHaveBeenCalled()
    })
  }

  it('surfaces an IPC failure as command output rather than dropping it', async () => {
    const d = deps({ executeBash: vi.fn(() => Promise.reject(new Error('socket closed'))) })
    dispatchBashCommand(d)
    await vi.waitFor(() => expect(d.completeBashCommand).toHaveBeenCalledWith(
      'tab-1', 'msg-1', 'ls', '', expect.stringContaining('socket closed'), 1,
    ))
  })

  it('does not clear a draft when no conversation is active', () => {
    const d = deps({ activeTabId: null })
    expect(dispatchBashCommand(d)).toBe(true)
    expect(d.clearDraft).not.toHaveBeenCalled()
  })
})
