import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Runtime ownership resolution, exercised through the renderer command seam.
 *
 * The point of these tests is the ownership chain: a session key comes in, the
 * conversation's linked tab is asked for, the registry is consulted for that
 * exact guest, and a Playwright page for that guest comes back. Each link in
 * that chain has a way to fail, and each failure must be a model-readable
 * refusal rather than a hang or a wrong-tab success.
 */
const commandSender = vi.hoisted(() => vi.fn())
const resolveTarget = vi.hoisted(() => vi.fn())
const pageForTarget = vi.hoisted(() => vi.fn())
const applyEmulation = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('./renderer-bridge', () => ({
  browserCommandSender: () => commandSender,
  setBrowserCommandSender: vi.fn(),
}))
vi.mock('./host', () => ({
  studioPlaywrightHost: { resolve: resolveTarget },
  readDevToolsEndpoint: vi.fn(),
}))
vi.mock('./connection', () => ({ pageForTarget, sharedBrowser: vi.fn() }))
vi.mock('./emulation', () => ({ applyEmulation, emulationSession: vi.fn(async () => ({ send: vi.fn(async () => ({})) })), resolveEmulation: vi.fn(), knownDevices: () => [] }))
// Main now creates the guest itself rather than waiting for a React component,
// so the view manager is part of this path and must be stubbed (it imports
// Electron).
const ensureBrowserView = vi.hoisted(() => vi.fn(() => ({ id: 1 })))
vi.mock('../studio-browser-views', () => ({
  ensureBrowserView,
  isBrowserViewVisible: vi.fn(() => false),
}))

import { cancelBrowserWork, resolveBrowser, runExclusive, setRegistrationTimeoutForTests, STUDIO_REQUIRED_ERROR } from './runtime'

// The refusal path is worth pinning; paying the real ten-second wait to pin it
// is not.
setRegistrationTimeoutForTests(150)

const page = { url: () => 'https://example.test/', isClosed: () => false, evaluate: vi.fn(async () => ({ w: 1280, h: 800 })) }

function tab(overrides: Record<string, unknown> = {}) {
  return {
    instanceId: 'browser-1',
    url: 'https://example.test/',
    title: 'Example',
    mode: 'browse',
    sessionMode: 'shared',
    agentLinked: true,
    emulation: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  commandSender.mockResolvedValue({ callId: 'c1', ok: true, tab: tab() })
  resolveTarget.mockReturnValue({ conversationId: 'tab-1', instanceId: 'browser-1', cdpTargetId: 'target-1', webContents: {} })
  pageForTarget.mockResolvedValue(page)
})

describe('ownership resolution', () => {
  it('resolves the linked tab for the calling session', async () => {
    const result = await resolveBrowser('tab-1')
    expect('error' in result).toBe(false)
    if ('error' in result) return
    expect(result.conversationId).toBe('tab-1')
    expect(result.instanceId).toBe('browser-1')
    // The conversation comes from the session key, never from tool input.
    expect(commandSender).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'tab-1' }), expect.any(Number))
  })

  it('derives the conversation from a legacy compound session key', async () => {
    await resolveBrowser('tab-9:main')
    expect(commandSender).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'tab-9' }), expect.any(Number))
  })

  it('refuses when no Studio window has registered a sender', async () => {
    const { setBrowserCommandSender } = await import('./renderer-bridge')
    vi.mocked(setBrowserCommandSender).mockClear()
    commandSender.mockRejectedValue(new Error('no window'))
    const result = await resolveBrowser('tab-1')
    // A rejected command is a refusal, not an exception escaping into the
    // tool loop.
    expect('error' in result && result.error).toBeTruthy()
  })

  it('reports the renderer refusal verbatim', async () => {
    commandSender.mockResolvedValue({ callId: 'c1', ok: false, error: 'Studio is showing a different conversation' })
    const result = await resolveBrowser('tab-1')
    expect('error' in result && result.error).toContain('different conversation')
  })

  it('refuses when the guest never registers', async () => {
    // The descriptor exists but no webview registered, so there is no CDP
    // target to attach to. Waiting forever would hang the model's turn.
    resolveTarget.mockReturnValue(null)
    const result = await resolveBrowser('tab-1')
    expect('error' in result && result.error).toContain('did not finish loading')
  })

  it('refuses when Playwright cannot attach to the registered guest', async () => {
    pageForTarget.mockResolvedValue(null)
    const result = await resolveBrowser('tab-1')
    expect('error' in result && result.error).toContain('could not attach')
  })

  it('asks for status without creating a tab', async () => {
    await resolveBrowser('tab-1', { create: false })
    expect(commandSender).toHaveBeenCalledWith(expect.objectContaining({ kind: 'status' }), expect.any(Number))
  })

  it('reapplies emulation when the descriptor carries it', async () => {
    commandSender.mockResolvedValue({ callId: 'c1', ok: true, tab: tab({ emulation: { width: 390, height: 844 } }) })
    await resolveBrowser('tab-1')
    // A rebind loses CDP overrides while the descriptor still says the tab is
    // a phone, so the two would silently disagree without this.
    // Third argument is whether the guest is displayed: a hidden view takes
    // mobile:false so its viewport matches the request exactly.
    expect(applyEmulation).toHaveBeenCalledWith(page, { width: 390, height: 844 }, false)
  })

  it('does not reapply an unchanged emulation on the next call', async () => {
    // A distinct instance: the applied-state cache is per browser instance and
    // deliberately outlives one call, which is what makes the dedupe work.
    const state = { width: 412, height: 915 }
    commandSender.mockResolvedValue({ callId: 'c1', ok: true, tab: tab({ instanceId: 'browser-dedupe', emulation: state }) })
    resolveTarget.mockReturnValue({ conversationId: 'tab-1', instanceId: 'browser-dedupe', cdpTargetId: 'target-2', webContents: {} })

    await resolveBrowser('tab-1')
    expect(applyEmulation).toHaveBeenCalledTimes(1)
    await resolveBrowser('tab-1')
    // Re-applying identical overrides on every call would reset the page's
    // scroll and layout mid-turn.
    expect(applyEmulation).toHaveBeenCalledTimes(1)
  })

  it('refuses a session key with no desktop tab', async () => {
    const result = await resolveBrowser('')
    expect('error' in result && result.error).toContain('no desktop tab')
    expect(commandSender).not.toHaveBeenCalled()
  })
})

describe('per-instance serialization', () => {
  it('cancels queued work for a closed tab', async () => {
    const started: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })

    const running = runExclusive('browser-1', 'first', async () => { started.push('first'); await gate })
    const queued = runExclusive('browser-1', 'second', async () => { started.push('second') })

    cancelBrowserWork('browser-1', 'the browser tab was closed')
    await expect(queued).rejects.toThrow(/closed/)
    release()
    await running
    expect(started).toEqual(['first'])
  })
})

describe('studio requirement', () => {
  it('states that Studio is required', () => {
    // Overlay has no Surface panel, so this is the honest answer rather than
    // silently switching the operator's interface.
    expect(STUDIO_REQUIRED_ERROR).toContain('Ion Studio')
  })
})

describe('background conversations need no renderer body', () => {
  it('creates the guest itself instead of waiting for a mount', async () => {
    // The defect this prevents: guest creation used to live in a React effect
    // in BrowserSurface, so it required the component to mount. A background
    // conversation never renders its browser body -- that is what makes it
    // background -- so an agent there got a descriptor and no browser, and
    // every tool failed with "did not finish loading in time".
    await resolveBrowser('tab-1')
    expect(ensureBrowserView).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'tab-1',
      instanceId: 'browser-1',
    }))
  })

  it('derives the partition so sessions match the visible path', async () => {
    commandSender.mockResolvedValue({ callId: 'c1', ok: true, tab: tab({ sessionMode: 'isolated' }) })
    await resolveBrowser('tab-1')
    // Same partition rule as the renderer, shared rather than duplicated: a
    // divergence here would silently give a background tab a different
    // session, losing the operator's logins.
    expect(ensureBrowserView).toHaveBeenCalledWith(expect.objectContaining({
      partition: 'studio-isolated-browser-1',
    }))
  })

  it('gives a hidden guest a real viewport', async () => {
    // A parked view reports 0x0, which makes innerWidth/innerHeight zero and
    // makes Page.captureScreenshot fail outright -- so a background agent
    // could not measure or screenshot anything. Verified against the live
    // protocol before fixing.
    const send = vi.fn(async (_method: string, _params?: unknown) => ({}))
    const { emulationSession } = await import('./emulation')
    vi.mocked(emulationSession).mockResolvedValue({ send } as never)
    page.evaluate.mockResolvedValueOnce({ w: 0, h: 0 })

    await resolveBrowser('tab-1')
    const metrics = send.mock.calls.find((call) => call[0] === 'Emulation.setDeviceMetricsOverride')
    expect(metrics).toBeDefined()
    expect((metrics?.[1] as { width: number } | undefined)?.width ?? 0).toBeGreaterThan(0)
  })

  it('leaves an already-sized guest alone', async () => {
    const send = vi.fn(async (_method: string, _params?: unknown) => ({}))
    const { emulationSession } = await import('./emulation')
    vi.mocked(emulationSession).mockResolvedValue({ send } as never)
    page.evaluate.mockResolvedValueOnce({ w: 1280, h: 800 })

    await resolveBrowser('tab-1')
    // Re-overriding a guest that already has a viewport would fight the
    // renderer's own sizing on the visible path.
    expect(send.mock.calls.find((call) => call[0] === 'Emulation.setDeviceMetricsOverride')).toBeUndefined()
  })
})
