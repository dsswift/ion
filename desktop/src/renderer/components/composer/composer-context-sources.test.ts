import { afterEach, describe, expect, it, vi } from 'vitest'

const addComposerContext = vi.fn(async (_token: string, _name: string, _content: string) => true)
vi.mock('./composer-context', async (orig) => ({
  ...(await orig<typeof import('./composer-context')>()),
  addComposerContext: (t: string, n: string, c: string) => addComposerContext(t, n, c),
}))
vi.mock('../../rendererLogger', () => ({ rError: vi.fn(), rWarn: vi.fn(), rInfo: vi.fn() }))
const gitDiff = vi.fn(async () => ({ diff: '+line', fileName: 'a.ts', isBinary: false }))
vi.mock('../../host/host-instance', () => ({ host: { shell: { gitDiff: (...a: unknown[]) => gitDiff(...(a as [])) } } }))
vi.mock('@ion/server/store/sessionStore', () => ({ useSessionStore: { getState: () => ({}) } }))

import { addDiffContext, addTerminalContext, terminalContextText } from './composer-context-sources'

function fakeTerminal(lines: string[], selection = ''): Parameters<typeof terminalContextText>[0] {
  return {
    hasSelection: () => selection.length > 0,
    getSelection: () => selection,
    buffer: { active: { length: lines.length, getLine: (i: number) => ({ translateToString: () => lines[i] }) } },
  } as never
}

afterEach(() => vi.clearAllMocks())

describe('terminal context', () => {
  it('takes the selection when there is one', () => {
    expect(terminalContextText(fakeTerminal(['a', 'b'], 'picked'))).toEqual({ text: 'picked', source: 'selection' })
  })
  it('falls back to the recent output, without the unused rows below it', () => {
    expect(terminalContextText(fakeTerminal(['$ make', 'ok', '', '   ']))).toEqual({ text: '$ make\nok', source: 'tail' })
  })
  it('attaches it under a terminal token, and attaches nothing from an empty terminal', async () => {
    expect(await addTerminalContext(fakeTerminal(['$ make']))).toBe(true)
    expect(addComposerContext.mock.calls[0][0]).toMatch(/^@@terminal:\d+$/)
    expect(addComposerContext.mock.calls[0][2]).toBe('$ make')
    expect(await addTerminalContext(fakeTerminal(['', '']))).toBe(false)
    expect(addComposerContext).toHaveBeenCalledTimes(1)
  })
})

describe('diff context', () => {
  it('attaches the file diff under a diff token', async () => {
    expect(await addDiffContext('/repo', 'src/a.ts', false)).toBe(true)
    expect(gitDiff).toHaveBeenCalledWith('/repo', 'src/a.ts', false)
    expect(addComposerContext).toHaveBeenCalledWith('@@diff:src/a.ts', 'a.ts.diff', '+line')
  })
  it('attaches nothing for a binary file', async () => {
    gitDiff.mockResolvedValueOnce({ diff: '', fileName: 'a.png', isBinary: true })
    expect(await addDiffContext('/repo', 'a.png', false)).toBe(false)
    expect(addComposerContext).not.toHaveBeenCalled()
  })
})
