import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('playwright-core', () => ({
  devices: {
    'Pixel 7': { userAgent: 'android-ua', viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, defaultBrowserType: 'chromium' },
    'iPhone 15': { userAgent: 'iphone-ua', viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, defaultBrowserType: 'webkit' },
  },
  chromium: { connectOverCDP: vi.fn() },
}))

import { applyEmulation, resolveEmulation } from './emulation'

/** A page whose CDP session records every command and detach. */
function fakePage() {
  const send = vi.fn(async () => ({}))
  const detach = vi.fn(async () => undefined)
  const newCDPSession = vi.fn(async () => ({ send, detach }))
  const page = {
    context: () => ({ newCDPSession }),
    once: vi.fn(),
    evaluate: vi.fn(async () => 'existing-ua'),
  } as never
  return { page, send, detach, newCDPSession }
}

function sent(send: ReturnType<typeof vi.fn>, method: string): Record<string, unknown> | undefined {
  return send.mock.calls.find((call) => call[0] === method)?.[1] as Record<string, unknown> | undefined
}

/** Some CDP commands take no parameters, so presence is checked by name. */
function called(send: ReturnType<typeof vi.fn>, method: string): boolean {
  return send.mock.calls.some((call) => call[0] === method)
}

describe('CDP session lifetime', () => {
  it('never detaches the session that holds the overrides', async () => {
    // CDP emulation overrides belong to the SESSION that set them. Detaching
    // reverts device metrics, touch, and the UA override immediately, so a
    // per-call session closed in a finally undid the emulation the instant it
    // was applied: the tool reported a phone while the page stayed desktop.
    const { page, detach } = fakePage()
    await applyEmulation(page, { width: 412, height: 915, isMobile: true, hasTouch: true })
    expect(detach).not.toHaveBeenCalled()
  })

  it('reuses one session across calls', async () => {
    const { page, newCDPSession, detach } = fakePage()
    await applyEmulation(page, { width: 412, height: 915 })
    await applyEmulation(page, { width: 390, height: 844 })
    await applyEmulation(page, null)
    expect(newCDPSession).toHaveBeenCalledTimes(1)
    expect(detach).not.toHaveBeenCalled()
  })
})

describe('applied overrides', () => {
  it('sends a touch-point count Chromium accepts when touch is off', async () => {
    // Chromium rejects maxTouchPoints: 0 outright, which failed EVERY resize
    // and emulate call. `enabled: false` is what disables touch.
    const { page, send } = fakePage()
    await applyEmulation(page, { width: 1440, height: 900 })
    const touch = sent(send, 'Emulation.setTouchEmulationEnabled')!
    expect(touch.enabled).toBe(false)
    expect(touch.maxTouchPoints as number).toBeGreaterThanOrEqual(1)
  })

  it('applies the device metrics a phone preset resolves to', async () => {
    const { page, send } = fakePage()
    const resolved = resolveEmulation(null, { device: 'Pixel 7' })
    await applyEmulation(page, resolved.state)
    const metrics = sent(send, 'Emulation.setDeviceMetricsOverride')!
    expect(metrics).toMatchObject({ width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true })
    expect(sent(send, 'Emulation.setTouchEmulationEnabled')).toMatchObject({ enabled: true })
    expect(sent(send, 'Emulation.setUserAgentOverride')).toMatchObject({ userAgent: 'android-ua' })
  })

  it('clears every override on reset', async () => {
    const { page, send } = fakePage()
    await applyEmulation(page, null)
    // A partial reset is how a stale UA or touch flag survives into a
    // "responsive" session and changes behaviour later.
    expect(called(send, 'Emulation.clearDeviceMetricsOverride')).toBe(true)
    expect(sent(send, 'Emulation.setTouchEmulationEnabled')).toMatchObject({ enabled: false })
    expect(sent(send, 'Emulation.setUserAgentOverride')).toMatchObject({ userAgent: '' })
  })
})
