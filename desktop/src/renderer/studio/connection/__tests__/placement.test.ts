// @vitest-environment jsdom
/**
 * Where this device opens a new conversation on Auto: the holder with the
 * most room wins, a tie keeps the caller's default, and this device's
 * weights can rule a server out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnvironmentPhaseState } from '@ion/shared/types-environments'

const wire = vi.hoisted(() => ({ states: new Map<string, EnvironmentPhaseState>(), action: vi.fn() }))
vi.mock('../../../host/host-instance', () => ({ action: wire.action }))
vi.mock('../../../rendererLogger', () => ({ rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn() }))
vi.mock('../registry', () => ({ registry: { phaseStates: () => wire.states } }))

const { placeAmong, placementWeights, savePlacementMode, savedPlacementMode, setPlacementWeight } = await import('../placement')
const { _resetFleetReportsForTest, readFleetReport } = await import('../fleet-reports')

const NOW = Date.now()
const report = (weeklyPercent: number): unknown => ({
  generatedAt: NOW, defaultProvider: 'anthropic', providers: [], modelTiers: [], devices: { paired: 0, connected: 0 }, metrics: null,
  server: { serverVersion: '1' },
  accounts: [{ provider: 'anthropic', backend: 'claude-code', email: 'user@example.com', firstSeen: NOW, lastSeen: NOW, signedIn: true,
    limits: [{ kind: 'weekly', percent: weeklyPercent, resetsAt: new Date(NOW + 100 * 3_600_000).toISOString(), fetchedAt: NOW }] }],
})
const holders = [{ environmentId: 'local', label: 'This Mac' }, { environmentId: 'env-g', label: 'devbox' }]

beforeEach(() => {
  localStorage.clear()
  _resetFleetReportsForTest()
  wire.states = new Map([['env-g', { phase: 'connected' } as EnvironmentPhaseState]])
})

async function read(byServer: Record<string, unknown>): Promise<void> {
  wire.action.mockImplementation(async (id: string) => byServer[id])
  await Promise.all(Object.keys(byServer).map(readFleetReport))
}

describe('placement', () => {
  it('remembers the mode on this device, manual until chosen', () => {
    expect(savedPlacementMode()).toBe('manual')
    savePlacementMode('auto')
    expect(savedPlacementMode()).toBe('auto')
  })

  it('opens on the holder whose account has the most room', async () => {
    await read({ local: report(90), 'env-g': report(20) })
    expect(placeAmong(holders).pick?.id).toBe('env-g')
  })

  it('keeps the first holder on a tie, and when no server has reported', async () => {
    expect(placeAmong(holders).pick?.id).toBe('local')
    await read({ local: report(50), 'env-g': report(50) })
    expect(placeAmong(holders).pick?.id).toBe('local')
  })

  it('never opens on a server this device set to never, or one that is offline', async () => {
    await read({ local: report(90), 'env-g': report(20) })
    setPlacementWeight('env-g', 'never')
    expect(placementWeights()).toEqual({ 'env-g': 'never' })
    expect(placeAmong(holders).pick?.id).toBe('local')
    setPlacementWeight('env-g', 'normal')
    expect(placementWeights()).toEqual({})
    wire.states = new Map()
    expect(placeAmong(holders).pick?.id).toBe('local')
  })
})
