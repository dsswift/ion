/**
 * Pins the `terminal.*` / `bash.*` studio_action surface.
 *
 * Context: the PTY manager always lived in this package and its output
 * already reached every client over the ion:terminal-* channels, but the
 * COMMAND half sat behind ipcMain. A browser client could therefore receive
 * terminal output it had no way to ask for and no way to type into.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const api = vi.hoisted(() => ({
  terminalCreate: vi.fn(),
  terminalWrite: vi.fn(),
  terminalResize: vi.fn(),
  terminalDestroy: vi.fn(),
  terminalAttach: vi.fn(() => ({ history: 'x', running: true, exitCode: null, cwd: '/r', cwdFellBack: false })),
  terminalActiveTabs: vi.fn(() => ['tab-1']),
  terminalActivitySnapshot: vi.fn(() => []),
  executeBash: vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 })),
  cancelBash: vi.fn(),
}))
vi.mock('../../terminal/terminal-api', () => api)

import { TERMINAL_ACTIONS } from '../terminal-actions'
import type { Connection } from '../connection'

const conn = { id: 'conn-1', scopes: [] } as unknown as Connection

beforeEach(() => { for (const fn of Object.values(api)) fn.mockClear() })

describe('TERMINAL_ACTIONS scopes', () => {
  it('requires terminal:operate for every verb', () => {
    for (const [name, spec] of Object.entries(TERMINAL_ACTIONS)) {
      expect(spec.requiredScope, name).toBe('terminal:operate')
    }
  })

  it('treats attach as an operate verb, not a read', () => {
    // attach can RESPAWN a dead terminal and returns full scrollback, so it
    // is not an observation.
    expect(TERMINAL_ACTIONS['terminal.attach'].requiredScope).toBe('terminal:operate')
  })
})

describe('TERMINAL_ACTIONS dispatch', () => {
  it('forwards the payload to the shared api', async () => {
    await TERMINAL_ACTIONS['terminal.write'].handler(conn, [{ key: 'k', data: 'ls' }])
    expect(api.terminalWrite).toHaveBeenCalledWith({ key: 'k', data: 'ls' })
  })

  it('returns the attach info the client renders from', async () => {
    const outcome = await TERMINAL_ACTIONS['terminal.attach'].handler(conn, [{ key: 'k' }])
    expect(outcome).toEqual({ ok: true, value: { history: 'x', running: true, exitCode: null, cwd: '/r', cwdFellBack: false } })
  })

  it('normalizes a void verb to null rather than dropping the reply', async () => {
    const outcome = await TERMINAL_ACTIONS['terminal.destroy'].handler(conn, [{ key: 'k' }])
    expect(outcome).toEqual({ ok: true, value: null })
  })

  it('awaits the async bash verb', async () => {
    const outcome = await TERMINAL_ACTIONS['bash.execute'].handler(conn, [{ id: '1', command: 'echo ok', cwd: '/' }])
    expect(outcome).toEqual({ ok: true, value: { stdout: 'ok', stderr: '', exitCode: 0 } })
  })

  it('turns a throw into a typed error', async () => {
    api.terminalCreate.mockImplementationOnce(() => { throw new Error('pty spawn failed') })
    const outcome = await TERMINAL_ACTIONS['terminal.create'].handler(conn, [{ key: 'k', cwd: '/' }])
    expect(outcome).toMatchObject({ ok: false, error: { code: 'terminal_action_failed' } })
  })
})
