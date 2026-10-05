// @vitest-environment jsdom
/**
 * ProviderSubscriptionPrompt — shows outside Settings when a connected
 * environment's subscription lookup needs a person: offers the subscriptions
 * and applies the one picked, says when there is none and looks up again, and
 * shows once per transition into a state. Nothing shows without a lookup or
 * with a key applied.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emitOnChannel, installFakeWire } from '../../host/__tests__/fake-wire'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rDebug: vi.fn(), rTrace: vi.fn() }))
vi.mock('../../theme', () => ({ useColors: () => ({}) }))
vi.mock('../../components/PopoverLayer', () => ({ usePopoverLayer: () => document.body }))
vi.mock('../transfer/environment-label-cache', () => ({ useEnvironmentLabel: (id: string | null) => id }))
const { connected, manageOnly } = vi.hoisted(() => ({ connected: ['local'], manageOnly: new Set<string>() }))
vi.mock('../connection/registry', () => ({
  registry: {
    subscribe(listener: (states: Map<string, { phase: string }>) => void): () => void {
      listener(new Map(connected.map((id) => [id, { phase: 'connected' }])))
      return () => {}
    },
  },
}))
vi.mock('../connection/catalog', () => ({ isManageOnlyEnvironment: (id: string) => manageOnly.has(id) }))

const { ProviderSubscriptionPrompt } = await import('../ProviderSubscriptionPrompt')
const { subscriptionAttentionStore } = await import('../connection/provider-subscription-attention')

const CHANNEL = 'ion:provider-subscription-changed'
const options = [{ id: 'std', label: 'Standard' }, { id: 'prem', label: 'High quota' }]
const selectionRequired = { state: 'selection_required', provider: 'gateway', providerDisplayName: 'Corporate Gateway', options }
const none = { state: 'none', provider: 'gateway', providerDisplayName: 'Corporate Gateway' }
const applied = { state: 'applied', provider: 'gateway', options, selected: options[1], source: 'lookup' }

const ion = {
  providerSubscription: vi.fn(),
  selectProviderSubscription: vi.fn(),
  refreshProviderSubscription: vi.fn(),
}

let container: HTMLDivElement
let root: Root

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const dialog = (): HTMLElement | null => document.body.querySelector('[role="dialog"]')
const text = (): string => dialog()?.textContent ?? ''
function button(name: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent?.trim() === name)
  if (!found) throw new Error(`no button named "${name}"`)
  return found
}
async function click(name: string): Promise<void> {
  await act(async () => { button(name).click(); await flush(); await flush() })
}
async function mount(initial: unknown): Promise<void> {
  ion.providerSubscription.mockResolvedValue({ ok: true, subscription: initial })
  await act(async () => { root.render(<ProviderSubscriptionPrompt />); await flush(); await flush() })
}
async function push(snapshot: unknown): Promise<void> {
  await act(async () => { emitOnChannel(CHANNEL, snapshot); await flush() })
}

beforeEach(() => {
  vi.clearAllMocks()
  connected.splice(0, connected.length, 'local')
  manageOnly.clear()
  subscriptionAttentionStore._resetForTest()
  ;(window as unknown as { ion: unknown }).ion = installFakeWire(ion)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ProviderSubscriptionPrompt', () => {
  it('lists the offered subscriptions by label and applies the one chosen', async () => {
    ion.selectProviderSubscription.mockResolvedValue({ ok: true, subscription: applied })
    await mount(selectionRequired)
    expect(text()).toContain('Choose a Corporate Gateway subscription')
    expect(text()).toContain('Standard')
    expect(text()).toContain('High quota')
    expect(button('Use subscription').disabled).toBe(true)

    await click('High quota')
    await click('Use subscription')
    expect(ion.selectProviderSubscription).toHaveBeenCalledWith({ id: 'prem' })
    expect(dialog()).toBeNull()
  })

  it('names the provider with no subscription and looks up again', async () => {
    ion.refreshProviderSubscription.mockResolvedValue({ ok: true, subscription: { ...none, resolvedAt: 2 } })
    await mount(none)
    expect(text()).toContain('No Corporate Gateway subscription')

    await click('Look up again')
    expect(ion.refreshProviderSubscription).toHaveBeenCalledTimes(1)
    expect(text()).toContain('There is still no subscription.')
  })

  it("uses the policy's text for no subscription when one is configured", async () => {
    await mount({ ...none, policyFailure: 'subscription_unavailable', message: 'Open a ticket to request access.' })
    expect(text()).toContain('Open a ticket to request access.')
    expect(text()).not.toContain('Contact your administrator')
  })

  it('closes when a lookup finds the subscription', async () => {
    ion.refreshProviderSubscription.mockResolvedValue({ ok: true, subscription: applied })
    await mount(none)
    await click('Look up again')
    expect(dialog()).toBeNull()
  })

  it('shows a refused choice and stays open', async () => {
    ion.selectProviderSubscription.mockResolvedValue({ ok: false, error: 'admin scope required', subscription: selectionRequired })
    await mount(selectionRequired)
    await click('Standard')
    await click('Use subscription')
    expect(text()).toContain('admin scope required')
  })

  it('shows once per transition into a state', async () => {
    await mount(selectionRequired)
    await click('Not now')
    expect(dialog()).toBeNull()

    // The same state broadcast again is not a new transition.
    await push({ ...selectionRequired, resolvedAt: 5 })
    expect(dialog()).toBeNull()

    // Leaving the state and entering it again is.
    await push({ state: 'resolving', provider: 'gateway' })
    await push(selectionRequired)
    expect(text()).toContain('Choose a Corporate Gateway subscription')
  })

  it('appears when a pushed snapshot enters a state', async () => {
    await mount({ state: 'resolving', provider: 'gateway' })
    expect(dialog()).toBeNull()
    await push(none)
    expect(text()).toContain('No Corporate Gateway subscription')
  })

  it('never asks on behalf of a Manage-Only Server', async () => {
    connected.splice(0, connected.length, 'test-vm')
    manageOnly.add('test-vm')
    await mount(selectionRequired)
    expect(dialog()).toBeNull()
    expect(ion.providerSubscription).not.toHaveBeenCalled()
  })

  it('shows nothing without a lookup or with a key applied', async () => {
    await mount({ state: 'disabled' })
    expect(dialog()).toBeNull()
    await push(applied)
    expect(dialog()).toBeNull()
    expect(ion.selectProviderSubscription).not.toHaveBeenCalled()
    expect(ion.refreshProviderSubscription).not.toHaveBeenCalled()
  })
})
