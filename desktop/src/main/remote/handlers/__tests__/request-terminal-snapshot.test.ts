/**
 * Tests for `handleRequestTerminalSnapshot` — the iOS terminal-snapshot
 * request path.
 *
 * What this file covers
 * ─────────────────────
 *   1. Pane-missing auto-create (the WI-1A fix). When iOS requests a
 *      snapshot for a tab whose renderer store has no `terminalPanes`
 *      entry (the desktop user never opened the terminal panel locally),
 *      the handler must mirror TerminalPanel.tsx's first-mount behavior:
 *      auto-create the default "Shell" instance via the renderer's
 *      `addTerminalInstance`, spawn the PTY via `terminalManager.create`
 *      with the `${tabId}:${instanceId}` key and the tab-derived cwd, and
 *      reply to the requesting device with a `desktop_terminal_snapshot`
 *      containing exactly that instance.
 *   2. Pane-present passthrough (existing behavior preserved). When the
 *      pane exists, the handler replies with the pane's instances and
 *      active instance id, and does NOT create anything.
 *
 * Regression contract
 * ───────────────────
 * On the unfixed code, the pane-missing renderer IIFE returned null and
 * the handler exited silently: no `terminalManager.create`, no reply to
 * iOS. Test #1 goes red on that code — it asserts both the PTY spawn and
 * the `sendToDevice` reply happen.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  executeJsMock: vi.fn(),
  sendToDevice: vi.fn(),
  send: vi.fn(),
  terminalCreate: vi.fn(),
}))

vi.mock('../../../state', () => ({
  state: {
    mainWindow: { webContents: { executeJavaScript: (...a: any[]) => mocks.executeJsMock(...a) } },
    remoteTransport: {
      send: (...a: any[]) => mocks.send(...a),
      sendToDevice: (...a: any[]) => mocks.sendToDevice(...a),
    },
  },
  terminalScrollback: new Map<string, string>(),
}))

vi.mock('../../../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../../../broadcast', () => ({ broadcast: vi.fn() }))

vi.mock('../../../terminal-manager-instance', () => ({
  terminalManager: {
    create: (...a: any[]) => mocks.terminalCreate(...a),
    write: vi.fn(),
    resize: vi.fn(),
    destroy: vi.fn(),
  },
}))

import { handleRequestTerminalSnapshot } from '../terminal'

beforeEach(() => {
  mocks.executeJsMock.mockReset()
  mocks.sendToDevice.mockReset()
  mocks.send.mockReset()
  mocks.terminalCreate.mockReset()
})

describe('handleRequestTerminalSnapshot', () => {
  it('auto-creates the default instance and replies when the tab has no pane', async () => {
    // First executeJavaScript call is the snapshot read: pane missing → null.
    // Second call is the auto-create IIFE: returns the freshly created
    // instance shape (mirrors what the renderer addTerminalInstance builds:
    // label "Shell 1", kind 'user', cwd from the tab's workingDirectory).
    mocks.executeJsMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'inst1234', label: 'Shell 1', kind: 'user', cwd: '/repo/work' })

    await handleRequestTerminalSnapshot(
      { type: 'desktop_request_terminal_snapshot', tabId: 'tab-abc' },
      'device-1',
    )

    // The auto-create IIFE must call the renderer's addTerminalInstance
    // with kind 'user' — same default TerminalPanel.tsx creates on mount.
    expect(mocks.executeJsMock).toHaveBeenCalledTimes(2)
    const createBody = mocks.executeJsMock.mock.calls[1][0] as string
    expect(createBody).toContain("addTerminalInstance('tab-abc', 'user')")

    // PTY spawned with the tab-derived key and the renderer-resolved cwd.
    expect(mocks.terminalCreate).toHaveBeenCalledTimes(1)
    expect(mocks.terminalCreate).toHaveBeenCalledWith('tab-abc:inst1234', '/repo/work')

    // Reply goes to the requesting device with exactly the new instance.
    expect(mocks.sendToDevice).toHaveBeenCalledTimes(1)
    const [deviceId, event] = mocks.sendToDevice.mock.calls[0]
    expect(deviceId).toBe('device-1')
    expect(event).toEqual({
      type: 'desktop_terminal_snapshot',
      tabId: 'tab-abc',
      instances: [{ id: 'inst1234', label: 'Shell 1', kind: 'user', readOnly: false, cwd: '/repo/work' }],
      activeInstanceId: 'inst1234',
      buffers: undefined,
    })
  })

  it('replies with the existing pane instances when the pane exists (no auto-create)', async () => {
    mocks.executeJsMock.mockResolvedValueOnce({
      instances: [
        { id: 'a1', label: 'Shell 1', kind: 'user', readOnly: false, cwd: '/repo' },
        { id: 'b2', label: 'Commit', kind: 'commit', readOnly: true, cwd: '/repo' },
      ],
      activeInstanceId: 'a1',
      buffers: { a1: 'scrollback-a1' },
    })

    await handleRequestTerminalSnapshot(
      { type: 'desktop_request_terminal_snapshot', tabId: 'tab-abc' },
      'device-2',
    )

    // Existing pane: no second executeJavaScript, no PTY spawn.
    expect(mocks.executeJsMock).toHaveBeenCalledTimes(1)
    expect(mocks.terminalCreate).not.toHaveBeenCalled()

    expect(mocks.sendToDevice).toHaveBeenCalledTimes(1)
    const [deviceId, event] = mocks.sendToDevice.mock.calls[0]
    expect(deviceId).toBe('device-2')
    expect(event).toEqual({
      type: 'desktop_terminal_snapshot',
      tabId: 'tab-abc',
      instances: [
        { id: 'a1', label: 'Shell 1', kind: 'user', readOnly: false, cwd: '/repo' },
        { id: 'b2', label: 'Commit', kind: 'commit', readOnly: true, cwd: '/repo' },
      ],
      activeInstanceId: 'a1',
      buffers: { a1: 'scrollback-a1' },
    })
  })
})
