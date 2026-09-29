/**
 * The device-transport channels are on the wire contract, so `broadcast()`
 * fans them out instead of dropping them as off-contract.
 */
import { describe, expect, it } from 'vitest'
import { EVENT_CHANNELS } from '@ion/shared/studio-wire/channels'

describe('remote transport channels', () => {
  it.each([
    'ion:remote-state-changed',
    'ion:remote-device-paired',
    'ion:remote-device-revoked',
    'ion:remote-display-changed',
    'ion:telemetry-health',
  ])('%s is registered environment-wide', (name) => {
    expect(EVENT_CHANNELS.find((c) => c.name === name)).toEqual({ name, scope: 'environment' })
  })

  // A phone administers the relay through the same actions, so it needs the same refresh.
  it('ion:remote-relays-changed is registered environment-wide for mirror and thin connections', () => {
    expect(EVENT_CHANNELS.find((c) => c.name === 'ion:remote-relays-changed')).toEqual({ name: 'ion:remote-relays-changed', scope: 'environment', views: ['mirror', 'thin'] })
  })

  // A phone edits model tiers and the default provider, so its screens refresh on the same signals.
  it.each(['ion:model-tiers-updated', 'ion:default-provider-updated'])('%s reaches mirror and thin connections', (name) => {
    expect(EVENT_CHANNELS.find((c) => c.name === name)).toEqual({ name, scope: 'environment', views: ['mirror', 'thin'] })
  })
})
