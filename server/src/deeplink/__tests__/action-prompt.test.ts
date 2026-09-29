import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  logLines: [] as Array<{ msg: string; fields?: Record<string, unknown> }>,
}))

const createTabInDirectory = vi.fn()
const submit = vi.fn()
const setDraftInput = vi.fn()

vi.mock('../../store/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({ createTabInDirectory, submit, setDraftInput }),
  },
}))

vi.mock('../../logger', () => ({
  log: (_tag: string, msg: string, fields?: Record<string, unknown>) => mocks.logLines.push({ msg, fields }),
  warn: (_tag: string, msg: string, fields?: Record<string, unknown>) => mocks.logLines.push({ msg, fields }),
  debug: vi.fn(), error: vi.fn(),
}))

import { runPromptAction } from '../action-prompt'

describe('runPromptAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.logLines.length = 0
    createTabInDirectory.mockResolvedValue('tab-new')
  })

  it('creates a fresh conversation then submits requested prompt text', async () => {
    const result = await runPromptAction({ action: 'prompt', dir: '/repo', text: 'inspect failing test', submit: true })

    expect(result).toEqual({ ok: true })
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

  it('contains store failures and returns an action outcome', async () => {
    createTabInDirectory.mockRejectedValue(new Error('store unavailable'))

    const result = await runPromptAction({ action: 'prompt', dir: '/repo', text: 'hello', submit: true })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('store unavailable')
    expect(mocks.logLines.some((line) => line.msg === 'prompt action threw')).toBe(true)
  })

  it('refuses when the tab creation returns no id', async () => {
    createTabInDirectory.mockResolvedValue(undefined)

    const result = await runPromptAction({ action: 'prompt', dir: '/repo', text: 'hello', submit: true })

    expect(result).toEqual({ ok: false, error: 'The conversation could not be created.' })
    expect(submit).not.toHaveBeenCalled()
  })
})
