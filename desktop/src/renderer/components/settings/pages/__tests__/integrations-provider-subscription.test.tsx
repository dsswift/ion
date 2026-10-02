// @vitest-environment jsdom
/**
 * ProviderSubscriptionGroup — hidden without a lookup, offers the choice when
 * the lookup returned several subscriptions, sends the chosen id, explains
 * the zero-subscription state, and replaces its view on every pushed snapshot.
 */
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emitOnChannel, installFakeWire } from '../../../../host/__tests__/fake-wire'
import { createHarness, flush, type Harness } from './page-harness'

vi.mock('../../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rDebug: vi.fn(), rTrace: vi.fn() }))

const { ProviderSubscriptionGroup } = await import('../integrations/ProviderSubscriptionGroup')

const options = [{ id: 'std', label: 'Standard' }, { id: 'prem', label: 'High quota' }]
const ion = {
  providerSubscription: vi.fn(),
  selectProviderSubscription: vi.fn(),
  refreshProviderSubscription: vi.fn(),
}

let h: Harness
beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { ion: unknown }).ion = installFakeWire(ion)
  h = createHarness()
})
afterEach(() => h.unmount())

const text = (): string => h.container.textContent ?? ''

describe('ProviderSubscriptionGroup', () => {
  it('renders nothing when the server configures no lookup', async () => {
    ion.providerSubscription.mockResolvedValue({ ok: true, subscription: { state: 'disabled' } })
    await h.render(<ProviderSubscriptionGroup />)
    expect(text()).toBe('')
  })

  it('offers the subscriptions and applies the one chosen', async () => {
    ion.providerSubscription.mockResolvedValue({ ok: true, subscription: { state: 'selection_required', provider: 'gateway', providerDisplayName: 'Corporate Gateway', options } })
    ion.selectProviderSubscription.mockResolvedValue({
      ok: true, subscription: { state: 'applied', provider: 'gateway', options, selected: options[1], source: 'lookup' },
    })
    await h.render(<ProviderSubscriptionGroup />)
    expect(text()).toContain('Choose the subscription your account uses')
    // The row names the provider the key configures, by its display name.
    expect(text()).toContain('Corporate Gateway subscription')

    const select = h.control('Subscription') as HTMLSelectElement
    await act(async () => {
      select.value = 'prem'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await flush()
    })
    await h.click('Use subscription')
    expect(ion.selectProviderSubscription).toHaveBeenCalledWith({ id: 'prem' })
    expect(text()).toContain('Using High quota.')
  })

  it('explains an account with no subscription', async () => {
    ion.providerSubscription.mockResolvedValue({ ok: true, subscription: { state: 'none', provider: 'gateway' } })
    await h.render(<ProviderSubscriptionGroup />)
    expect(text()).toContain('Your account has no subscription.')
    expect(h.maybeControl('Use subscription')).toBeUndefined()
    // Without a display name the row falls back to the provider id.
    expect(text()).toContain('gateway subscription')
  })

  it("uses the policy's text for a failure state when one is configured", async () => {
    ion.providerSubscription.mockResolvedValue({ ok: true, subscription: { state: 'none', provider: 'gateway', policyFailure: 'subscription_unavailable', message: 'Open a ticket to request access.' } })
    await h.render(<ProviderSubscriptionGroup />)
    expect(text()).toContain('Open a ticket to request access.')
    expect(text()).not.toContain('Your account has no subscription.')
  })

  it('shows a failed lookup and looks up again on request', async () => {
    ion.providerSubscription.mockResolvedValue({ ok: true, subscription: { state: 'failed', provider: 'gateway', error: 'endpoint returned status 503' } })
    ion.refreshProviderSubscription.mockResolvedValue({ ok: true, subscription: { state: 'applied', provider: 'gateway', selected: options[0], options: [options[0]], source: 'lookup' } })
    await h.render(<ProviderSubscriptionGroup />)
    expect(text()).toContain('endpoint returned status 503')
    await h.click('Look up again')
    expect(ion.refreshProviderSubscription).toHaveBeenCalled()
    expect(text()).toContain('Using Standard.')
  })

  it('replaces its view with a pushed snapshot', async () => {
    ion.providerSubscription.mockResolvedValue({ ok: true, subscription: { state: 'resolving', provider: 'gateway' } })
    await h.render(<ProviderSubscriptionGroup />)
    expect(text()).toContain('Looking up your subscription')
    await act(async () => {
      emitOnChannel('ion:provider-subscription-changed', { state: 'applied', provider: 'gateway', selected: options[0], source: 'lookup' })
      await flush()
    })
    expect(text()).toContain('Using Standard.')
  })
})
