// @vitest-environment jsdom
/** serverFacts: what a server's row says about its accounts and providers. */
import { describe, expect, it, vi } from 'vitest'
import { HIDDEN_FLEET_EMAIL } from '@ion/shared/fleet-view'
import type { FleetReport } from '@ion/shared/types-fleet'

vi.mock('../../../../theme', () => ({ useColors: () => ({}) }))
vi.mock('../../server-status', () => ({ describeReach: () => '', phaseStatus: () => ({ tone: 'ok', label: '' }), usePhase: () => undefined }))

import { serverFacts } from '../fleet/FleetServers'

const report = (over: Partial<FleetReport>): FleetReport => ({
  generatedAt: 1, server: { serverVersion: '1.0.0' }, metrics: null, devices: { paired: 0, connected: 0 }, providers: [], defaultProvider: '', modelTiers: [], accounts: [], ...over,
} as FleetReport)
const fact = (r: FleetReport, label: string, reveal = false): string | undefined => serverFacts(r, 'room', reveal).find((f) => f.label === label)?.value

describe('serverFacts', () => {
  it('shows the enterprise account masked until emails are shown', () => {
    const r = report({ enterpriseAccount: { username: 'person@example.org', displayName: 'A Person' } })
    expect(fact(r, 'Enterprise account')).toBe(HIDDEN_FLEET_EMAIL)
    expect(fact(r, 'Enterprise account', true)).toBe('person@example.org')
    // An account with no user name has nothing to hide.
    expect(fact(report({ enterpriseAccount: { username: '', displayName: 'A Person' } }), 'Enterprise account')).toBe('A Person')
  })

  it('says when nobody is signed in', () => {
    expect(fact(report({ enterpriseAccount: null }), 'Enterprise account')).toBe('not signed in')
  })

  it('names the custom providers, and says when there are none', () => {
    const providers = [{ id: 'gateway', displayName: 'Corp Gateway', hasAuth: true, modelCount: 2, custom: true }, { id: 'anthropic', hasAuth: true, modelCount: 3 }]
    expect(fact(report({ enterpriseAccount: null, providers }), 'Custom providers')).toBe('Corp Gateway')
    expect(fact(report({ enterpriseAccount: null }), 'Custom providers')).toBe('none')
  })

  it('says a server too old to report either does not, rather than "signed out" or "none"', () => {
    const old = report({})
    expect(fact(old, 'Enterprise account')).toBe('not reported')
    expect(fact(old, 'Custom providers')).toBe('not reported')
  })

  it('names the hubs a server reports to, with how each link stands', () => {
    const hubs = [{ url: 'https://a.example.org', label: 'Home hub', state: 'connected', manage: true }, { url: 'https://b.example.org', label: 'Corp hub', state: 'unreachable', manage: false }]
    expect(fact(report({ hubs }), 'Fleet hubs')).toBe('Home hub (reporting), Corp hub (unreachable, reports only)')
    expect(fact(report({ hubs: [] }), 'Fleet hubs')).toBe('none')
    expect(fact(report({}), 'Fleet hubs')).toBe('not reported')
  })

  it('shows only where new work stands for a server with no report', () => {
    expect(serverFacts(null, 'no fleet report', false)).toEqual([{ label: 'New work', value: 'no fleet report' }])
  })
})
