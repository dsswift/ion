import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const reconcile = vi.fn()

vi.mock('../hub-links', () => ({
  FleetHubLinks: class {
    reconcile = reconcile
    close = vi.fn()
  },
  setFleetHubLinks: vi.fn(),
}))

let dataDir: string
let originalIonDataDir: string | undefined

beforeEach(() => {
  vi.resetModules()
  reconcile.mockClear()
  originalIonDataDir = process.env.ION_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'ion-hub-run-'))
  process.env.ION_DATA_DIR = dataDir
})

afterEach(() => {
  if (originalIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalIonDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

describe('startFleetHubs', () => {
  it('reconciles again once the first policy read is in', async () => {
    const { startFleetHubs } = await import('../hub-run')
    const { publishEnterprisePolicy } = await import('../../enterprise-policy-publish')

    const stop = startFleetHubs()
    expect(reconcile).toHaveBeenCalledTimes(1)

    publishEnterprisePolicy({ customFields: { 'ion-server': { fleetHubs: { hubs: [{ url: 'https://hub.example.org', enrollmentToken: 'token' }] } } } })
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2))
    stop()
  })

  it('does not reconcile after it was stopped', async () => {
    const { startFleetHubs } = await import('../hub-run')
    const { publishEnterprisePolicy } = await import('../../enterprise-policy-publish')

    startFleetHubs()()
    publishEnterprisePolicy(null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reconcile).toHaveBeenCalledTimes(1)
  })
})
