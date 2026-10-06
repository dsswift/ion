/** fleet.deploy.*: a deploy's record is checked, kept, published to Studio, and passed to the hubs. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLEET_DEPLOYS_CHANNEL, FLEET_DEPLOYS_KEPT, type FleetDeployRecord } from '@ion/shared/types-fleet-deploy'
import type { Connection } from '../../protocol/connection'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
const { broadcast } = vi.hoisted(() => ({ broadcast: vi.fn() }))
vi.mock('../../broadcast', () => ({ broadcast }))
const hubs = vi.hoisted(() => ({ deploy: vi.fn(), running: true }))
vi.mock('../hub-links', () => ({ fleetHubLinks: () => (hubs.running ? { deploy: hubs.deploy } : null) }))
const benches = vi.hoisted(() => ({
  checkoutForBranch: vi.fn(async (_ref: unknown): Promise<{ ok: true; path: string; via: 'bench' | 'branch' } | { ok: false; error: string }> => ({ ok: true, path: '/ion/integration/ion-josh', via: 'bench' })),
  benchOfFolder: vi.fn((_folder: string): { repoPath: string; branch: string } | null => null),
}))
vi.mock('../../integration/bench-source-checkout', () => benches)

import { FLEET_DEPLOY_ACTIONS } from '../deploy-actions'
import { _resetFleetDeploysForTest, listFleetDeploys } from '../deploy-ledger'

const conn = { id: 'c' } as unknown as Connection
const record = (over: Partial<FleetDeployRecord> = {}): FleetDeployRecord => ({
  id: 'd1', source: 'build of ion', startedAt: 100, updatedAt: 100, state: 'running',
  targets: [{ host: 'mac-1', label: 'Mac one', stage: 'queued', updatedAt: 100 }],
  ...over,
})
const report = (payload: unknown) => FLEET_DEPLOY_ACTIONS['fleet.deploy.report'].handler(conn, [payload])

beforeEach(() => {
  _resetFleetDeploysForTest()
  broadcast.mockClear()
  hubs.deploy.mockClear()
  hubs.running = true
})

describe('fleet.deploy.report', () => {
  it('is an admin\'s, and reading the deploys is anyone\'s who can read', () => {
    expect(FLEET_DEPLOY_ACTIONS['fleet.deploy.report'].requiredScope).toBe('admin')
    expect(FLEET_DEPLOY_ACTIONS['fleet.deploys.list'].requiredScope).toBe('conversations:read')
  })

  it('keeps the record, publishes the list to Studio, and passes the record to the hubs', async () => {
    expect(await report(record())).toEqual({ ok: true, value: null })
    expect(listFleetDeploys()).toMatchObject([{ id: 'd1', state: 'running' }])
    expect(listFleetDeploys()[0].receivedAt).toBeGreaterThan(0)
    expect(broadcast).toHaveBeenCalledWith(FLEET_DEPLOYS_CHANNEL, listFleetDeploys())
    expect(hubs.deploy).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1' }))
    expect(await FLEET_DEPLOY_ACTIONS['fleet.deploys.list'].handler(conn, [])).toEqual({ ok: true, value: listFleetDeploys() })
  })

  it('replaces a deploy with its newer record, and drops one that arrives out of order', async () => {
    await report(record())
    await report(record({ updatedAt: 300, state: 'done', endedAt: 300, targets: [{ host: 'mac-1', label: 'Mac one', stage: 'done', detail: '1.2.3', updatedAt: 300 }] }))
    await report(record({ updatedAt: 200 }))
    expect(listFleetDeploys()).toHaveLength(1)
    expect(listFleetDeploys()[0]).toMatchObject({ state: 'done', updatedAt: 300, targets: [{ stage: 'done', detail: '1.2.3' }] })
  })

  it('keeps only the newest deploys, newest start first', async () => {
    for (let i = 0; i < FLEET_DEPLOYS_KEPT + 3; i++) await report(record({ id: `d${i}`, startedAt: i, updatedAt: i }))
    const ids = listFleetDeploys().map((d) => d.id)
    expect(ids).toHaveLength(FLEET_DEPLOYS_KEPT)
    expect(ids[0]).toBe(`d${FLEET_DEPLOYS_KEPT + 2}`)
    expect(ids).not.toContain('d0')
  })

  it('refuses what is not a deploy record, and keeps only the fields a record has', async () => {
    for (const bad of [null, {}, { ...record(), state: 'exploded' }, { ...record(), targets: [{ label: 'no host' }] }]) {
      expect(await report(bad)).toMatchObject({ ok: false, refusal: { code: 'invalid_deploy' } })
    }
    expect(listFleetDeploys()).toEqual([])
    await report({ ...record(), checkout: '/Users/someone/src/ion', targets: [{ host: 'mac-1', stage: 'queued', sshKey: 'secret' }] })
    expect(JSON.stringify(listFleetDeploys())).not.toMatch(/someone|secret/)
    expect(listFleetDeploys()[0].targets[0]).toMatchObject({ host: 'mac-1', label: 'mac-1' })
  })

  it('still records a deploy on a server whose hub links have not started', async () => {
    hubs.running = false
    expect(await report(record())).toEqual({ ok: true, value: null })
    expect(listFleetDeploys()).toHaveLength(1)
  })
})

// A deploy's checkout is found here: a bench is named by its branch, because
// its folder is removed when its last worktree lands.
describe('fleet.deploy.source', () => {
  const source = (query: unknown) => FLEET_DEPLOY_ACTIONS['fleet.deploy.source'].handler(conn, [query])
  const josh = { repoPath: '/src/ion', branch: 'josh' }

  it('finds the folder a bench names now, by its branch', async () => {
    expect(await source(josh)).toEqual({ ok: true, value: { path: '/ion/integration/ion-josh', via: 'bench', bench: josh } })
    expect(benches.checkoutForBranch).toHaveBeenCalledWith(josh)
    benches.checkoutForBranch.mockResolvedValueOnce({ ok: true, path: '/src/ion', via: 'branch' })
    expect(await source(josh)).toEqual({ ok: true, value: { path: '/src/ion', via: 'branch', bench: josh } })
    benches.checkoutForBranch.mockResolvedValueOnce({ ok: false, error: 'No folder on this device holds josh' })
    expect(await source(josh)).toEqual({ ok: false, refusal: { code: 'no_checkout', message: 'No folder on this device holds josh' } })
  })

  it('names the bench a folder is, so a client can remember it by its branch', async () => {
    benches.benchOfFolder.mockReturnValueOnce(josh)
    expect(await source(' /ion/integration/ion-josh ')).toEqual({ ok: true, value: { path: '/ion/integration/ion-josh', via: 'folder', bench: josh } })
    expect(await source('/src/other')).toEqual({ ok: true, value: { path: '/src/other', via: 'folder' } })
    expect(await source({ repoPath: '/src/ion' })).toMatchObject({ ok: false, refusal: { code: 'invalid_source' } })
  })
})
