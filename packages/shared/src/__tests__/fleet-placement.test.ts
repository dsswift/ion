import { describe, expect, it } from 'vitest'
import type { FleetAccount, FleetReport } from '../types-fleet'
import { accountRoomPercent, pickPlacement, type PlacementCandidate } from '../fleet-placement'

const NOW = Date.parse('2026-10-03T12:00:00Z')
const HOUR = 3_600_000
const iso = (ms: number): string => new Date(ms).toISOString()

function account(over: Partial<FleetAccount> = {}): FleetAccount {
  return { provider: 'anthropic', backend: 'claude-code', email: 'user@example.com', firstSeen: NOW, lastSeen: NOW, signedIn: true, limits: [], ...over }
}

function weekly(percent: number, resetsInHours = 100): FleetAccount['limits'][number] {
  return { kind: 'weekly', percent, resetsAt: iso(NOW + resetsInHours * HOUR), fetchedAt: NOW - HOUR }
}
function session(percent: number): FleetAccount['limits'][number] {
  return { kind: 'session', percent, resetsAt: iso(NOW + 2 * HOUR), fetchedAt: NOW - HOUR }
}

function report(accounts: FleetAccount[], cpu = 0.2): FleetReport {
  return {
    generatedAt: NOW, defaultProvider: 'anthropic', providers: [], modelTiers: [], accounts, devices: { paired: 0, connected: 0 },
    server: { serverVersion: '1', hostname: 'h', platform: 'linux', arch: 'x64', home: '/', dataDir: '/', bundle: null, uptimeSeconds: 1 } as FleetReport['server'],
    metrics: { host: { cpuUtilization: cpu, memoryTotalBytes: 100, memoryAvailableBytes: 80, memoryLimitBytes: 0 } } as FleetReport['metrics'],
  }
}

function candidate(id: string, over: Partial<PlacementCandidate>): PlacementCandidate {
  return { id, label: id, online: true, report: null, readAt: NOW, ...over }
}

describe('account room', () => {
  it('is what the tightest holding limit leaves', () => {
    expect(accountRoomPercent(account({ limits: [weekly(30), session(80)] }), NOW)).toBe(20)
  })
  it('ignores a limit whose window has reset since it was read', () => {
    const stale = { kind: 'session' as const, percent: 100, resetsAt: iso(NOW - HOUR), fetchedAt: NOW - 3 * HOUR }
    expect(accountRoomPercent(account({ limits: [weekly(30), stale] }), NOW)).toBe(70)
  })
})

describe('pickPlacement', () => {
  it('picks the server whose account has the most room', () => {
    const placement = pickPlacement([
      candidate('mac', { report: report([account({ limits: [weekly(90), session(50)] })]) }),
      candidate('linux', { report: report([account({ limits: [weekly(20), session(10)] })]) }),
    ], NOW)
    expect(placement.pick?.id).toBe('linux')
    expect(placement.pick?.roomPercent).toBe(80)
  })

  it('leans toward quota that is about to reset unused when room is equal', () => {
    const placement = pickPlacement([
      candidate('far', { report: report([account({ limits: [weekly(40, 100)] })]) }),
      candidate('soon', { report: report([account({ limits: [weekly(40, 6)] })]) }),
    ], NOW)
    expect(placement.pick?.id).toBe('soon')
    expect(placement.pick?.reason).toContain('about to reset unused')
  })

  it('never picks a server that is offline, manage-only, set to never, or at its limit', () => {
    const full = report([account({ limits: [session(100)] })])
    const open = report([account({ limits: [weekly(95)] })])
    const placement = pickPlacement([
      candidate('offline', { online: false, report: report([account()]) }),
      candidate('fleet-only', { manageOnly: true, report: report([account()]) }),
      candidate('never', { weight: 'never', report: report([account()]) }),
      candidate('full', { report: full }),
      candidate('open', { report: open }),
    ], NOW)
    expect(placement.pick?.id).toBe('open')
    expect(placement.scores.filter((s) => s.score === 0).map((s) => s.id).sort()).toEqual(['fleet-only', 'full', 'never', 'offline'])
  })

  it('lets a preferred server win over a slightly roomier one', () => {
    const placement = pickPlacement([
      candidate('roomier', { report: report([account({ limits: [weekly(20)] })]) }),
      candidate('preferred', { weight: 'prefer', report: report([account({ limits: [weekly(35)] })]) }),
    ], NOW)
    expect(placement.pick?.id).toBe('preferred')
  })

  it("breaks a tie on room with the less loaded host, and a full tie with the caller's order", () => {
    const same = [account({ limits: [weekly(50)] })]
    expect(pickPlacement([candidate('busy', { report: report(same, 0.9) }), candidate('calm', { report: report(same, 0.1) })], NOW).pick?.id).toBe('calm')
    expect(pickPlacement([candidate('first', { report: report(same) }), candidate('second', { report: report(same) })], NOW).pick?.id).toBe('first')
  })

  it('uses a server with no report only when nothing better can take the work', () => {
    const unknown = candidate('old', {})
    expect(pickPlacement([unknown, candidate('full', { report: report([account({ limits: [session(100)] })]) })], NOW).pick?.id).toBe('old')
    expect(pickPlacement([unknown, candidate('known', { report: report([account({ limits: [weekly(80)] })]) })], NOW).pick?.id).toBe('known')
    expect(pickPlacement([candidate('gone', { online: false })], NOW).pick).toBeNull()
  })
})

describe('fleetExpiringQuota', () => {
  it('lists signed-in accounts with weekly quota about to reset unused, soonest first', async () => {
    const { fleetExpiringQuota, mergeFleetAccounts } = await import('../fleet-view')
    const rows = mergeFleetAccounts([{ id: 's', label: 's', online: true, report: report([
      account({ email: 'late@example.com', limits: [weekly(40, 10)] }),
      account({ email: 'soon@example.com', limits: [weekly(40, 3)] }),
      account({ email: 'spent@example.com', limits: [weekly(95, 3)] }),
      account({ email: 'gone@example.com', signedIn: false, limits: [weekly(10, 3)] }),
    ]) }])
    expect(fleetExpiringQuota(rows, NOW).map((entry) => entry.row.email)).toEqual(['soon@example.com', 'late@example.com'])
  })
})
