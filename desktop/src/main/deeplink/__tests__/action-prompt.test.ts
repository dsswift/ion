import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  showWindow: vi.fn(),
  logLines: [] as Array<{ msg: string; fields?: Record<string, unknown> }>,
}))

let executeJavaScript: (source: string) => Promise<unknown>

vi.mock('../../state', () => ({
  state: {
    get mainWindow() {
      return { webContents: { executeJavaScript } }
    },
  },
}))

vi.mock('../../window-manager', () => ({ showWindow: (...args: unknown[]) => mocks.showWindow(...args) }))
vi.mock('../../logger', () => ({
  log: (_tag: string, msg: string, fields?: Record<string, unknown>) => mocks.logLines.push({ msg, fields }),
  warn: (_tag: string, msg: string, fields?: Record<string, unknown>) => mocks.logLines.push({ msg, fields }),
  debug: vi.fn(), error: vi.fn(),
}))

import { runPromptAction } from '../action-prompt'

function executeInRenderer(store: { getState: () => object }): (source: string) => Promise<unknown> {
  return async (source) => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- test evaluates action's renderer bridge against a fake store
    const evaluate = new Function('window', `return (${source.trim()})`)
    return evaluate({ __Ion_SESSION_STORE__: store })
  }
}

describe('runPromptAction', () => {
  const createTabInDirectory = vi.fn()
  const submit = vi.fn()
  const setDraftInput = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.logLines.length = 0
    createTabInDirectory.mockResolvedValue('tab-new')
    executeJavaScript = executeInRenderer({
      getState: () => ({ createTabInDirectory, submit, setDraftInput }),
    })
  })

  it('creates a fresh conversation then submits requested prompt text', async () => {
    const result = await runPromptAction({ action: 'prompt', dir: '/repo', text: 'inspect failing test', submit: true })

    expect(result).toEqual({ ok: true })
    expect(mocks.showWindow).toHaveBeenCalledWith('deeplink prompt')
    expect(createTabInDirectory).toHaveBeenCalledWith('/repo', undefined, true)
    expect(submit).toHaveBeenCalledWith('tab-new', 'inspect failing test')
    expect(setDraftInput).not.toHaveBeenCalled()
  })

  it('leaves non-submitted prompt text in new conversation draft', async () => {
    const result = await runPromptAction({ action: 'prompt', dir: '/repo', text: 'edit before send', submit: false })

    expect(result).toEqual({ ok: true })
    expect(createTabInDirectory).toHaveBeenCalledWith('/repo', undefined, true)
    expect(setDraftInput).toHaveBeenCalledWith('tab-new', 'edit before send')
    expect(submit).not.toHaveBeenCalled()
  })

  it('contains renderer failures and returns an action outcome', async () => {
    executeJavaScript = vi.fn().mockRejectedValue(new Error('renderer disconnected'))

    const result = await runPromptAction({ action: 'prompt', dir: '/repo', text: 'hello', submit: true })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('renderer disconnected')
    expect(mocks.logLines.some((line) => line.msg === 'prompt action threw')).toBe(true)
  })
})
