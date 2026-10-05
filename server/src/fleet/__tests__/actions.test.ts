/** fleet.* actions: scope, the report's shape, and that one failed part does not sink the rest. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Connection } from '../../protocol/connection'
import type { FleetReport } from '@ion/shared/types-fleet'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
vi.mock('../../state', () => ({ engineBridge: {} }))
vi.mock('../../compat/runtime', () => ({ readEngineRuntime: vi.fn(async () => ({ version: '9.9.9', runningConversations: 2, formats: [] })) }))
vi.mock('../../environment/actions', () => ({ bootedEnvironmentServerVersion: () => '0.4.2' }))
vi.mock('../../environment/host-install', () => ({
  serverInfoWithInstall: (serverVersion: string, runtime: { version: string; runningConversations: number }) => ({ serverVersion, engineVersion: runtime.version, runningConversations: runtime.runningConversations, hostname: 'host-1' }),
}))
vi.mock('../../system-metrics/runtime', () => ({ systemMetricsPublisher: () => ({ latest: () => ({ sampledAt: 5 }) }) }))
vi.mock('../../auth/credentials-store', () => ({ credentialsStore: () => ({}) }))
vi.mock('../../auth/pairing-links', () => ({ listClients: () => [] }))
vi.mock('../../auth/devices', () => ({
  devicesOf: () => [{ self: true, connected: true }, { self: false, connected: true }, { self: false, connected: false }],
}))
vi.mock('../../protocol/connection', () => ({ connectionRegistry: { all: () => [] } }))
const provider = vi.hoisted(() => ({
  listModels: vi.fn(),
  listModelTiers: vi.fn(async () => [{ name: 'standard', model: 'm-1', fallbacks: [] }]),
  getDefaultProvider: vi.fn(async () => 'anthropic'),
}))
vi.mock('../../engine/provider-api', () => provider)
const identity = vi.hoisted(() => ({ getSignedInIdentityIfEngineConnected: vi.fn() }))
vi.mock('../../oauth/entra-flow', () => identity)
vi.mock('../hub-links', () => ({ fleetHubLinks: () => ({ list: () => ({ restricted: false, hubs: [{ url: 'https://hub.example.org', label: 'Home hub', source: 'added', manage: true, state: 'connected', lastReportAt: 5 }] }) }) }))
const ACCOUNTS = [{ provider: 'anthropic', email: 'a@example.com', signedIn: true }]
vi.mock('../account-ledger', () => ({ listAccounts: () => ACCOUNTS }))
const poll = vi.hoisted(() => ({ pollAccountsNow: vi.fn(async () => [{ provider: 'anthropic', email: 'b@example.com', signedIn: true }]) }))
vi.mock('../account-poll', () => poll)

import { FLEET_ACTIONS } from '../actions'

const conn = { id: 'c', scopes: ['conversations:read'], principal: { subject: 'paired:x' }, pairedClientId: 'me' } as unknown as Connection

beforeEach(() => {
  provider.listModels.mockReset().mockResolvedValue({
    models: [{ id: 'm-1', providerId: 'anthropic' }, { id: 'm-2', providerId: 'anthropic' }, { id: 'g-1', providerId: 'openai' }],
    providers: [
      { id: 'anthropic', hasAuth: true, authSource: 'cli', backend: 'claude-code', cli: { backend: 'claude-code', installed: true, authenticated: true, email: 'a@example.com' }, apiKeyRef: 'never-forwarded' },
      { id: 'openai', hasAuth: false },
      { id: 'gateway', hasAuth: true, custom: true },
    ],
  })
  identity.getSignedInIdentityIfEngineConnected.mockReset().mockResolvedValue({ user: 'p@example.org', username: 'p@example.org', displayName: 'A Person', oid: 'o', issuer: 'i' })
})

describe('fleet actions', () => {
  it('reading needs only conversations:read; changing the hubs and reporting a deploy are an admin\'s', () => {
    expect(Object.entries(FLEET_ACTIONS).map(([name, spec]) => [name, spec.requiredScope])).toEqual([
      ['fleet.report', 'conversations:read'],
      ['fleet.refreshAccounts', 'conversations:read'],
      ['fleet.hubs.list', 'conversations:read'],
      ['fleet.hubs.add', 'admin'],
      ['fleet.hubs.remove', 'admin'],
      ['fleet.deploy.report', 'admin'],
      ['fleet.deploys.list', 'conversations:read'],
    ])
  })

  it('reports server facts, metrics, devices, providers with model counts, tiers, and the ledger', async () => {
    const outcome = await FLEET_ACTIONS['fleet.report'].handler(conn, [])
    expect(outcome.ok).toBe(true)
    const report = (outcome as { value: FleetReport }).value
    expect(report.server).toMatchObject({ serverVersion: '0.4.2', engineVersion: '9.9.9', runningConversations: 2 })
    expect(report.metrics).toEqual({ sampledAt: 5 })
    expect(report.devices).toEqual({ paired: 2, connected: 1 })
    expect(report.providers).toEqual([
      { id: 'anthropic', displayName: undefined, hasAuth: true, authSource: 'cli', backend: 'claude-code', cli: { backend: 'claude-code', installed: true, authenticated: true, email: 'a@example.com' }, modelCount: 2 },
      { id: 'openai', displayName: undefined, hasAuth: false, authSource: undefined, backend: undefined, cli: undefined, modelCount: 1 },
      // Only a provider the server's configuration defines carries the mark.
      { id: 'gateway', displayName: undefined, hasAuth: true, authSource: undefined, backend: undefined, cli: undefined, modelCount: 0, custom: true },
    ])
    expect(report.defaultProvider).toBe('anthropic')
    expect(report.enterpriseAccount).toEqual({ username: 'p@example.org', displayName: 'A Person' })
    expect(report.hubs).toEqual([{ url: 'https://hub.example.org', label: 'Home hub', state: 'connected', manage: true }])
    expect(report.modelTiers).toEqual([{ name: 'standard', model: 'm-1', fallbacks: [] }])
    expect(report.accounts).toBe(ACCOUNTS)
  })

  it('still answers when the model listing is unavailable', async () => {
    provider.listModels.mockRejectedValueOnce(new Error('engine not connected'))
    const outcome = await FLEET_ACTIONS['fleet.report'].handler(conn, [])
    expect(outcome).toMatchObject({ ok: true, value: { providers: [], defaultProvider: 'anthropic' } })
  })

  it('refreshAccounts polls now and returns the ledger', async () => {
    const outcome = await FLEET_ACTIONS['fleet.refreshAccounts'].handler(conn, [])
    expect(poll.pollAccountsNow).toHaveBeenCalledTimes(1)
    expect(outcome).toMatchObject({ ok: true, value: { accounts: [{ email: 'b@example.com' }] } })
  })
})
