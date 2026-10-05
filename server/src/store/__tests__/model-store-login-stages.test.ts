// @vitest-environment jsdom
//
// The delegated-CLI login stage machine in setupModelSync. The behavior that
// matters most here is which stages auto-open a browser: a CLI that opens its
// own tab (claude-code) must NOT have its printed fallback URL auto-opened.
// That URL carries a different redirect_uri, so auto-opening it would create a
// second browser flow instead of using the loopback callback already in flight.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ProviderLoginUpdate } from '@ion/shared/types-engine-event'

type LoginHandler = (u: ProviderLoginUpdate, environmentId?: string) => void

const openExternal = vi.fn(async (..._a: any[]) => true)
const providerLoginCancel = vi.fn(async (..._a: any[]) => ({ ok: true }))
const listModels = vi.fn(async (..._a: any[]) => ({ models: [], providers: [] }))
const on = vi.fn()

let emitLogin: LoginHandler

vi.mock('../host-api', () => ({
  echoUserTurnToStudio: vi.fn(),
  listModels: (...args: any[]) => listModels(...args),
  openExternal: (...args: any[]) => openExternal(...args),
  providerLoginCancel: (...args: any[]) => providerLoginCancel(...args),
  on: (...args: any[]) => on(...args),
  onProviderLoginEvent: (handler: LoginHandler) => {
    emitLogin = handler
    return () => undefined
  },
}))

import { useModelStore, setupModelSync } from '../model-store'

function installIon() {
  // Real IPC bridge is replaced by the host-api mock above; nothing else needed.
}

/** Minimal stage payload; only the fields the machine reads. */
function stage(over: Partial<ProviderLoginUpdate>): ProviderLoginUpdate {
  return { provider: 'anthropic', backend: 'claude-code', stage: 'started', ...over }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  useModelStore.setState({ loginStates: {}, onHost: { local: true } })
  installIon()
  setupModelSync()
})

describe('provider login stage machine', () => {
  it('does not auto-open the fallback URL for a CLI that opens its own browser', () => {
    emitLogin(stage({ stage: 'started' }))
    emitLogin(stage({ stage: 'await_browser', authUrl: 'https://claude.com/cai/oauth/authorize?x=1' }))

    expect(openExternal).not.toHaveBeenCalled()
    // The URL is still retained so the row can offer it on demand.
    expect(useModelStore.getState().loginStates.local?.anthropic?.url).toBe('https://claude.com/cai/oauth/authorize?x=1')
  })

  it('still auto-opens for a CLI that does not open its own browser', () => {
    emitLogin(stage({ provider: 'openai', backend: 'codex', stage: 'started' }))
    emitLogin(stage({ provider: 'openai', backend: 'codex', stage: 'await_browser', authUrl: 'https://auth.openai.com/x' }))

    expect(openExternal).toHaveBeenCalledWith('https://auth.openai.com/x')
  })

  it('enters await_code and re-arms the timeout past the 120s started budget', () => {
    emitLogin(stage({ stage: 'started' }))
    emitLogin(stage({ stage: 'await_auth_code' }))

    expect(useModelStore.getState().loginStates.local?.anthropic?.phase).toBe('await_code')

    // The 120s started-stage budget must no longer fire: the user is mid-paste.
    vi.advanceTimersByTime(150_000)
    expect(useModelStore.getState().loginStates.local?.anthropic?.phase).toBe('await_code')
    expect(providerLoginCancel).not.toHaveBeenCalled()

    // The re-armed 10-minute ceiling still bounds an abandoned paste.
    vi.advanceTimersByTime(10 * 60_000)
    expect(useModelStore.getState().loginStates.local?.anthropic?.phase).toBe('error')
    expect(providerLoginCancel).toHaveBeenCalledWith('anthropic', 'local')
  })

  it('keeps the sign-in page for the pasted code when only the browser stage named it, and leaves the host\'s own tab alone', () => {
    emitLogin(stage({ stage: 'started' }))
    emitLogin(stage({ stage: 'await_browser', authUrl: 'https://claude.com/cai/oauth/authorize?x=1' }))
    emitLogin(stage({ stage: 'await_auth_code' }))

    expect(useModelStore.getState().loginStates.local?.anthropic).toEqual({ phase: 'await_code', url: 'https://claude.com/cai/oauth/authorize?x=1' })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('opens the sign-in page here when the server is another machine, whose own tab this person cannot see', () => {
    emitLogin(stage({ stage: 'started' }), 'devbox')
    emitLogin(stage({ stage: 'await_auth_code', authUrl: 'https://claude.com/cai/oauth/authorize?x=2' }), 'devbox')

    expect(useModelStore.getState().loginStates.devbox?.anthropic).toEqual({ phase: 'await_code', url: 'https://claude.com/cai/oauth/authorize?x=2' })
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith('https://claude.com/cai/oauth/authorize?x=2')
  })

  it('times out a login abandoned at the started stage', () => {
    emitLogin(stage({ stage: 'started' }))
    vi.advanceTimersByTime(120_000)

    expect(useModelStore.getState().loginStates.local?.anthropic?.phase).toBe('error')
    expect(providerLoginCancel).toHaveBeenCalledWith('anthropic', 'local')
  })

  it('clears state on completion and cancels the pending timeout', () => {
    emitLogin(stage({ stage: 'started' }))
    emitLogin(stage({ stage: 'await_auth_code' }))
    emitLogin(stage({ stage: 'completed' }))

    expect(useModelStore.getState().loginStates.local?.anthropic).toBeUndefined()
    vi.advanceTimersByTime(20 * 60_000)
    expect(providerLoginCancel).not.toHaveBeenCalled()
  })

  it('surfaces a failure with the engine-supplied reason', () => {
    emitLogin(stage({ stage: 'started' }))
    emitLogin(stage({ stage: 'failed', loginError: 'claude CLI not installed' }))

    const st = useModelStore.getState().loginStates.local?.anthropic
    expect(st?.phase).toBe('error')
    expect(st?.error).toBe('claude CLI not installed')
  })

  it('still auto-opens the device-code verification page', () => {
    emitLogin(stage({ provider: 'openai', backend: 'codex', stage: 'started' }))
    emitLogin(stage({
      provider: 'openai', backend: 'codex', stage: 'await_device_code',
      userCode: 'ABCD-1234', verificationUrl: 'https://verify/x',
    }))

    expect(openExternal).toHaveBeenCalledWith('https://verify/x')
    expect(useModelStore.getState().loginStates.local?.openai?.userCode).toBe('ABCD-1234')
  })
})
