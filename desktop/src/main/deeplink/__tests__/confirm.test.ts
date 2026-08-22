import { describe, it, expect, beforeEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  lines: [] as Array<{ msg: string; fields?: Record<string, unknown> }>,
  broadcast: vi.fn(),
}))
vi.mock('../../logger', () => ({
  log: (_tag: string, msg: string, fields?: Record<string, unknown>) => mocks.lines.push({ msg, fields }),
  warn: (_tag: string, msg: string, fields?: Record<string, unknown>) => mocks.lines.push({ msg, fields }),
}))
vi.mock('../../broadcast', () => ({ broadcast: (...args: unknown[]) => mocks.broadcast(...args) }))

import { IPC } from '../../../shared/types'
import {
  CONFIRM_TIMEOUT_MS, markDeepLinkConfirmationReady, markDeepLinkConfirmationUnavailable,
  pendingConfirmationCountForTests, rejectAllDeepLinkConfirmations, requestDeepLinkConfirmation,
  resolveDeepLinkConfirmation,
} from '../confirm'

const TERMINAL = { action: 'terminal' as const, tabId: 'tab-a', title: 'api', cmd: 'npm start', dir: '/repo' }
const PROMPT = { action: 'prompt' as const, dir: '/repo', text: 'do the thing', submit: true }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.lines.length = 0
  rejectAllDeepLinkConfirmations('reset')
  markDeepLinkConfirmationReady('overlay')
  markDeepLinkConfirmationReady('studio')
})

function lastRequest(): { id: string; owner: 'overlay' | 'studio'; action: string; selectTab?: boolean } {
  return mocks.broadcast.mock.calls.filter((call) => call[0] === IPC.DEEPLINK_CONFIRM_REQUEST).at(-1)![1] as never
}

describe('deep-link confirmation', () => {
  it('delivers detailed request only after selected owner is ready', async () => {
    markDeepLinkConfirmationUnavailable('studio', 'test')
    const pending = requestDeepLinkConfirmation(TERMINAL, 'studio')
    expect(mocks.broadcast).not.toHaveBeenCalledWith(IPC.DEEPLINK_CONFIRM_REQUEST, expect.anything())
    markDeepLinkConfirmationReady('studio')
    expect(lastRequest()).toMatchObject({ owner: 'studio', action: 'terminal', tabId: 'tab-a', cmd: 'npm start' })
    resolveDeepLinkConfirmation({ id: lastRequest().id, owner: 'studio', approved: false })
    await expect(pending).resolves.toEqual({ approved: false })
  })

  it('allows operator target selection only when request asks for it', async () => {
    const pending = requestDeepLinkConfirmation({ ...TERMINAL, tabId: '' }, 'overlay', true)
    const request = lastRequest()
    expect(request).toMatchObject({ owner: 'overlay', selectTab: true })
    resolveDeepLinkConfirmation({ id: request.id, owner: 'overlay', approved: true, tabId: 'tab-picked' })
    await expect(pending).resolves.toEqual({ approved: true, tabId: 'tab-picked' })
  })

  it('refuses approval without required target', async () => {
    const pending = requestDeepLinkConfirmation({ ...TERMINAL, tabId: '' }, 'overlay', true)
    resolveDeepLinkConfirmation({ id: lastRequest().id, owner: 'overlay', approved: true })
    expect(pendingConfirmationCountForTests()).toBe(1)
    rejectAllDeepLinkConfirmations('test')
    await expect(pending).resolves.toEqual({ approved: false })
  })

  it('rejects response from non-owner and settles owner response once', async () => {
    const pending = requestDeepLinkConfirmation(PROMPT, 'studio')
    const request = lastRequest()
    resolveDeepLinkConfirmation({ id: request.id, owner: 'overlay', approved: true })
    expect(pendingConfirmationCountForTests()).toBe(1)
    resolveDeepLinkConfirmation({ id: request.id, owner: 'studio', approved: true })
    await expect(pending).resolves.toEqual({ approved: true, tabId: undefined })
    expect(mocks.broadcast).toHaveBeenCalledWith(IPC.DEEPLINK_CONFIRM_SETTLED, request.id)
  })

  it('declines on timeout and owner loss', async () => {
    vi.useFakeTimers()
    const timeout = requestDeepLinkConfirmation(PROMPT, 'overlay')
    vi.advanceTimersByTime(CONFIRM_TIMEOUT_MS + 1)
    await expect(timeout).resolves.toEqual({ approved: false })
    const gone = requestDeepLinkConfirmation(PROMPT, 'studio')
    markDeepLinkConfirmationUnavailable('studio', 'closed')
    await expect(gone).resolves.toEqual({ approved: false })
    vi.useRealTimers()
  })
})
