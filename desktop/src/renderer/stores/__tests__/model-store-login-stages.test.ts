// @vitest-environment jsdom
//
// The delegated-CLI login stage machine in setupModelSync. The behavior that
// matters most here is which stages auto-open a browser: a CLI that opens its
// own tab (claude-code) must NOT have its printed fallback URL auto-opened.
// That URL carries a different redirect_uri, so auto-opening it would create a
// second browser flow instead of using the loopback callback already in flight.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useModelStore, setupModelSync } from '../model-store'
import type { ProviderLoginUpdate } from '../../../shared/types-engine-event'

type LoginHandler = (u: ProviderLoginUpdate) => void

const openExternal = vi.fn(async () => true)
const providerLoginCancel = vi.fn(async () => ({ ok: true }))
const listModels = vi.fn(async () => ({ models: [], providers: [] }))

let emitLogin: LoginHandler

function installIon() {
  ;(window as unknown as { ion: unknown }).ion = {
    listModels,
    openExternal,
    providerLoginCancel,
    on: vi.fn(),
    onProviderLoginEvent: (handler: LoginHandler) => {
      emitLogin = handler
      return () => undefined
    },
  }
}

/** Minimal stage payload; only the fields the machine reads. */
function stage(over: Partial<ProviderLoginUpdate>): ProviderLoginUpdate {
  return { provider: 'anthropic', backend: 'claude-code', stage: 'started', ...over }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  useModelStore.setState({ loginStates: {} })
  installIon()
  setupModelSync()
})

describe('provider login stage machine', () => {
  it('does not auto-open the fallback URL for a CLI that opens its own browser', () => {
    emitLogin(stage({ stage: 'started' }))
    emitLogin(stage({ stage: 'await_browser', authUrl: 'https://claude.com/cai/oauth/authorize?x=1' }))

    expect(openExternal).not.toHaveBeenCalled()
    // The URL is still retained so the row can offer it on demand.
    expect(useModelStore.getState().loginStates.anthropic?.url).toBe('https://claude.com/cai/oauth/authorize?x=1')
  })

  it('still auto-opens for a CLI that does not open its own browser', () => {
    emitLogin(stage({ provider: 'openai', backend: 'codex', stage: 'started' }))
    emitLogin(stage({ provider: 'openai', backend: 'codex', stage: 'await_browser', authUrl: 'https://auth.openai.com/x' }))

    expect(openExternal).toHaveBeenCalledWith('https://auth.openai.com/x')
  })

  it('enters await_code and re-arms the timeout past the 120s started budget', () => {
    emitLogin(stage({ stage: 'started' }))
    emitLogin(stage({ stage: 'await_auth_code' }))

    expect(useModelStore.getState().loginStates.anthropic?.phase).toBe('await_code')

    // The 120s started-stage budget must no longer fire: the user is mid-paste.
    vi.advanceTimersByTime(150_000)
    expect(useModelStore.getState().loginStates.anthropic?.phase).toBe('await_code')
    expect(providerLoginCancel).not.toHaveBeenCalled()

    // The re-armed 10-minute ceiling still bounds an abandoned paste.
    vi.advanceTimersByTime(10 * 60_000)
    expect(useModelStore.getState().loginStates.anthropic?.phase).toBe('error')
    expect(providerLoginCancel).toHaveBeenCalledWith('anthropic')
  })

  it('times out a login abandoned at the started stage', () => {
    emitLogin(stage({ stage: 'started' }))
    vi.advanceTimersByTime(120_000)

    expect(useModelStore.getState().loginStates.anthropic?.phase).toBe('error')
    expect(providerLoginCancel).toHaveBeenCalledWith('anthropic')
  })

  it('clears state on completion and cancels the pending timeout', () => {
    emitLogin(stage({ stage: 'started' }))
    emitLogin(stage({ stage: 'await_auth_code' }))
    emitLogin(stage({ stage: 'completed' }))

    expect(useModelStore.getState().loginStates.anthropic).toBeUndefined()
    vi.advanceTimersByTime(20 * 60_000)
    expect(providerLoginCancel).not.toHaveBeenCalled()
  })

  it('surfaces a failure with the engine-supplied reason', () => {
    emitLogin(stage({ stage: 'started' }))
    emitLogin(stage({ stage: 'failed', loginError: 'claude CLI not installed' }))

    const st = useModelStore.getState().loginStates.anthropic
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
    expect(useModelStore.getState().loginStates.openai?.userCode).toBe('ABCD-1234')
  })
})
