// @vitest-environment jsdom
/** FleetHubsPanel: the hubs one server reports to, adding one, and what the server refuses. */
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnvironmentCatalogEntry } from '@ion/shared/types-environments'
import { createHarness, flush, type Harness } from './page-harness'

const action = vi.hoisted(() => vi.fn())
vi.mock('../../../../host/host-instance', () => ({ host: {}, action }))
vi.mock('../../../../rendererLogger', () => ({ rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn() }))

const { FleetHubsPanel } = await import('../fleet/FleetHubsPanel')

const local: EnvironmentCatalogEntry = { id: 'local', label: 'This Mac', target: { kind: 'local' } }
let h: Harness
function type(label: string, value: string): void {
  const input = document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => { h = createHarness(); action.mockReset() })
afterEach(() => h.unmount())

describe('FleetHubsPanel', () => {
  it('shows the hubs a server reports to, adds one, and says why the server refused another', async () => {
    const hub = (over: Record<string, unknown>): Record<string, unknown> => ({ url: 'https://hub.corp.example.org', label: 'Corp hub', source: 'policy', manage: true, state: 'connected', ...over })
    const home = hub({ url: 'https://hub.home.example.org', label: 'Home hub', source: 'added' })
    action.mockImplementation(async (_env: string, name: string, args: unknown[]) => {
      if (name === 'fleet.hubs.list') return { restricted: true, hubs: [hub({})] }
      if (name === 'fleet.hubs.add') {
        if ((args[0] as { url: string }).url.includes('other')) throw new Error('Your organization does not allow this server to join that hub.')
        return { restricted: true, hubs: [hub({}), home] }
      }
      if (name === 'fleet.hubs.remove') return { restricted: true, hubs: [hub({})] }
      throw new Error('unknown_action')
    })
    await h.render(<FleetHubsPanel entry={local} onClose={() => {}} />)
    await act(async () => { await flush() })
    const panel = (): string => document.body.textContent ?? ''
    expect(panel()).toContain('Fleet hubs for This Mac')
    expect(panel()).toContain('Set by your organization')
    expect(panel()).toContain('Your organization limits which hubs')
    // A hub the policy set has no remove control.
    expect(document.querySelector('[aria-label="Stop reporting to Corp hub"]')).toBeNull()

    type('Hub address', 'https://hub.home.example.org')
    type('Enrollment token', 'home-token')
    await h.click('Add hub')
    expect(action).toHaveBeenCalledWith('local', 'fleet.hubs.add', [{ url: 'https://hub.home.example.org', enrollmentToken: 'home-token', manage: true }])
    expect(panel()).toContain('Home hub')

    type('Hub address', 'https://hub.other.example.org')
    type('Enrollment token', 't')
    await h.click('Add hub')
    expect(panel()).toContain('Your organization does not allow this server to join that hub.')

    await act(async () => { (document.querySelector('[aria-label="Stop reporting to Home hub"]') as HTMLElement).click(); await flush(); await flush() })
    expect(action).toHaveBeenCalledWith('local', 'fleet.hubs.remove', [{ url: 'https://hub.home.example.org' }])
    expect(panel()).not.toContain('Home hub')
  })

  it('joins a hub under the name this device knows the server by', async () => {
    const remote: EnvironmentCatalogEntry = { id: 'env-w', label: 'win-arm64', target: { kind: 'paired', label: 'win-arm64', url: 'http://vm.example:7331', credentialRef: 'w', via: 'lan' } }
    action.mockImplementation(async () => ({ restricted: false, hubs: [] }))
    await h.render(<FleetHubsPanel entry={remote} onClose={() => {}} />)
    await act(async () => { await flush() })
    type('Hub address', 'hub.example.org')
    type('Enrollment token', 't')
    await h.click('Add hub')
    expect(action).toHaveBeenCalledWith('env-w', 'fleet.hubs.add', [{ url: 'hub.example.org', enrollmentToken: 't', manage: true, label: 'win-arm64' }])
  })
})
