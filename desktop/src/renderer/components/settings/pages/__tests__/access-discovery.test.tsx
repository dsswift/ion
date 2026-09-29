// @vitest-environment jsdom
/** The Discovery group on Access & pairing, in each of its four modes. */
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHarness, flush, type Harness } from './page-harness'

const client = vi.hoisted(() => ({ discoveryStatus: vi.fn(), discoveryOpen: vi.fn(), discoveryClose: vi.fn(), discoveryMintCode: vi.fn() }))
vi.mock('../../environment/environment-client', () => ({
  environmentClient: client,
  onEnvironmentEvent: () => () => {},
  useEnvironmentResource: (env: string, load: (e: string) => Promise<unknown>) => {
    const [data, setData] = React.useState<unknown>(null)
    const refresh = React.useCallback(() => { void load(env).then(setData) }, [env, load])
    React.useEffect(() => { refresh() }, [refresh])
    return { data, loading: data === null, error: null, refresh }
  },
}))
vi.mock('../../settings-servers', () => ({ useSettingsEnvironment: () => ({ id: 'local', label: 'This Mac', isLocal: true, justAdded: false }) }))
vi.mock('../../../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000' }) }))
vi.mock('../../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn() }))

const { DiscoverySection } = await import('../access/DiscoverySection')

describe('DiscoverySection', () => {
  let h: Harness
  beforeEach(() => { for (const fn of Object.values(client)) fn.mockReset(); h = createHarness() })
  afterEach(() => { h.unmount(); vi.useRealTimers() })
  const mount = async (): Promise<void> => { await h.render(<DiscoverySection />); await act(async () => { await flush() }) }

  it('is off by default and opens a bounded window on request', async () => {
    client.discoveryStatus.mockResolvedValue({ mode: 'off', advertising: false, until: null, code: null })
    client.discoveryOpen.mockResolvedValue({})
    await mount()
    expect(h.container.textContent).toContain('not discoverable')
    expect(h.maybeControl('1 hour')).toBeDefined()
    await h.click('15 minutes')
    expect(client.discoveryOpen).toHaveBeenCalledWith('local', 15)
    expect(client.discoveryStatus).toHaveBeenCalledTimes(2)
  })

  it('shows the live code, a countdown that ticks each second, and a way to turn it off while a window is open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(1_000_000)
    client.discoveryStatus.mockResolvedValue({ mode: 'window', advertising: true, until: 1_000_000 + 600_000, code: 'ABCD-EFGH' })
    client.discoveryClose.mockResolvedValue({})
    await mount()
    expect(h.container.querySelector('[data-testid="discovery-code"]')?.textContent).toBe('ABCD-EFGH')
    expect(h.container.textContent).toContain('turns itself off in 10:00')
    await act(async () => { vi.advanceTimersByTime(2000) })
    expect(h.container.textContent).toContain('turns itself off in 9:58')
    expect(h.container.textContent).toContain('It pairs one device, then a new code appears here.')
    await h.click('Turn off now')
    expect(client.discoveryClose).toHaveBeenCalledWith('local')
  })

  it('offers nothing when the organization has sealed LAN discovery', async () => {
    client.discoveryStatus.mockResolvedValue({ mode: 'sealed', advertising: false, until: null, code: null })
    await mount()
    expect(h.container.textContent).toContain('Your organization has turned LAN discovery off')
    expect(h.container.querySelectorAll('button')).toHaveLength(0)
  })

  it('a persistently discoverable host only mints a code on request', async () => {
    client.discoveryStatus.mockResolvedValue({ mode: 'persistent', advertising: true, until: null, code: null })
    client.discoveryMintCode.mockResolvedValue({ code: 'WXYZ-2345', expiresAt: Date.now() + 60_000 })
    await mount()
    expect(h.container.textContent).toContain('always discoverable')
    expect(h.container.querySelector('[data-testid="discovery-code"]')).toBeNull()
    await h.click('Show a code')
    expect(h.container.querySelector('[data-testid="discovery-code"]')?.textContent).toBe('WXYZ-2345')
  })

  it('says why an action was refused', async () => {
    client.discoveryStatus.mockResolvedValue({ mode: 'off', advertising: false, until: null, code: null })
    client.discoveryOpen.mockRejectedValue(new Error('not allowed here'))
    await mount()
    await h.click('1 hour')
    expect(client.discoveryOpen).toHaveBeenCalledWith('local', 60)
    expect(h.container.textContent).toContain('not allowed here')
  })
})
