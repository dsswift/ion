import { beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../state', () => ({ engineBridge: bridge }))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { EVENT_CHANNEL_NAMES, channelDeliveredToView } from '@ion/shared/studio-wire/channels'
import {
  PROVIDER_SUBSCRIPTION_CHANGED_CHANNEL,
  refreshProviderSubscription,
  selectProviderSubscription,
  wireProviderSubscriptionEvents,
} from './provider-subscription-api'

function eventSource() {
  let cb: ((key: string, event: unknown) => void) | null = null
  return {
    on: (_ev: 'event', fn: (key: string, event: never) => void) => { cb = fn as (key: string, event: unknown) => void },
    emit: (event: unknown) => cb?.('', event),
  }
}

beforeEach(() => bridge.request.mockReset())

describe('wireProviderSubscriptionEvents', () => {
  it('republishes the complete snapshot and nothing else', () => {
    const source = eventSource()
    const emit = vi.fn()
    wireProviderSubscriptionEvents(source, emit)
    const providerSubscription = {
      state: 'selection_required',
      provider: 'gateway',
      options: [{ id: 'std', label: 'Standard' }, { id: 'prem', label: 'High quota' }],
    }
    source.emit({ type: 'engine_mcp_servers', mcpServers: [] })
    source.emit({ type: 'engine_provider_subscription', providerSubscription })
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(PROVIDER_SUBSCRIPTION_CHANGED_CHANNEL, providerSubscription)
  })

  it('publishes on a channel the Studio wire carries to desktops and phones', () => {
    expect(EVENT_CHANNEL_NAMES.has(PROVIDER_SUBSCRIPTION_CHANGED_CHANNEL)).toBe(true)
    expect(channelDeliveredToView(PROVIDER_SUBSCRIPTION_CHANGED_CHANNEL, 'mirror')).toBe(true)
    expect(channelDeliveredToView(PROVIDER_SUBSCRIPTION_CHANGED_CHANNEL, 'thin')).toBe(true)
  })
})

describe('provider subscription commands', () => {
  it('selects by id and returns the engine snapshot', async () => {
    const subscription = { state: 'applied', provider: 'gateway', selected: { id: 'prem', label: 'High quota' }, source: 'lookup' }
    bridge.request.mockResolvedValue({ ok: true, data: { subscription } })
    await expect(selectProviderSubscription({ id: 'prem' })).resolves.toEqual({ ok: true, error: undefined, subscription })
    expect(bridge.request).toHaveBeenCalledWith('provider_subscription_select', { subscriptionId: 'prem' })
  })

  it('refuses a select without an id and still reports the current state', async () => {
    bridge.request.mockResolvedValue({ ok: true, data: { subscription: { state: 'none', provider: 'gateway' } } })
    const result = await selectProviderSubscription({})
    expect(result).toEqual({ ok: false, error: 'a subscription id is required', subscription: { state: 'none', provider: 'gateway' } })
    expect(bridge.request).toHaveBeenCalledWith('provider_subscription_status', {})
  })

  it('keeps the snapshot a failed refresh leaves', async () => {
    const subscription = { state: 'failed', provider: 'gateway', error: 'endpoint returned status 503' }
    bridge.request.mockResolvedValue({ ok: false, error: 'endpoint returned status 503', data: { subscription } })
    await expect(refreshProviderSubscription()).resolves.toEqual({ ok: false, error: 'endpoint returned status 503', subscription })
  })

  it('reports a failed state when the engine sent no snapshot', async () => {
    bridge.request.mockResolvedValue({ ok: false, error: 'engine unreachable' })
    const result = await refreshProviderSubscription()
    expect(result.subscription).toEqual({ state: 'failed', error: 'engine unreachable' })
  })
})
