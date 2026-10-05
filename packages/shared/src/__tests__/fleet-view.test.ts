import { describe, expect, it } from 'vitest'
import { buildFleetMatrix, fleetAccountName, fleetLimit, fleetLimitExpired, fleetModelLimitLabels, fleetQuotaPools, fleetTotals, judgeFormat, mergeFleetAccounts, HIDDEN_FLEET_EMAIL, type FleetServer } from '../fleet-view'
import type { FleetAccount, FleetReport } from '../types-fleet'

const T0 = 1_800_000_000_000

function account(email: string, over: Partial<FleetAccount> = {}): FleetAccount {
  return { provider: 'anthropic', backend: 'claude-code', email, orgId: `org-${email}`, planType: 'max', firstSeen: T0, lastSeen: T0, signedIn: true, limits: [], ...over }
}

function server(id: string, accounts: FleetAccount[], over: Partial<FleetServer> = {}, serverOver: Record<string, unknown> = {}): FleetServer {
  const report = { generatedAt: T0, server: { serverVersion: '1.0.0', runningConversations: 1, formats: [], ...serverOver }, accounts } as unknown as FleetReport
  return { id, label: id, online: true, report, ...over }
}

describe('fleetQuotaPools', () => {
  it('adds each limit up across a provider\'s accounts, 100% per account', () => {
    const rows = mergeFleetAccounts([server('oscar', [
      account('a@example.com', { limits: [
        { kind: 'weekly', percent: 100, resetsAt: new Date(T0 + 86_400_000).toISOString(), fetchedAt: T0 },
        { kind: 'session', percent: 30, resetsAt: new Date(T0 - 1000).toISOString(), fetchedAt: T0 - 5000 },
        { kind: 'spend', percent: 50, fetchedAt: T0 },
      ] }),
      account('b@example.com', { signedIn: false, limits: [
        { kind: 'weekly', percent: 76, resetsAt: new Date(T0 + 3_600_000).toISOString(), fetchedAt: T0 },
        { kind: 'weekly_model', label: 'Fable', percent: 99, fetchedAt: T0 },
      ] }),
      account('c@example.com', { provider: 'openai', backend: 'codex', limits: [{ kind: 'weekly', percent: 3, fetchedAt: T0 }] }),
      account('', { provider: 'xai', backend: 'grok' }),
    ])])
    const pools = fleetQuotaPools(rows, T0)
    expect(pools.map((p) => [p.provider, p.accounts])).toEqual([['anthropic', 2], ['openai', 1], ['xai', 1]])
    expect(pools[0].limits).toEqual([
      { kind: 'weekly_model', label: 'Fable', accounts: 1, capacity: 100, used: 99, resets: [] },
      { kind: 'session', accounts: 1, capacity: 100, used: 0, resets: [] },
      { kind: 'weekly', accounts: 2, capacity: 200, used: 176, resets: [
        { at: new Date(T0 + 3_600_000).toISOString(), freed: 76 },
        { at: new Date(T0 + 86_400_000).toISOString(), freed: 100 },
      ] },
    ])
    expect(pools[2].limits).toEqual([])
  })

  it('lists each upcoming reset with only the use it gives back, soonest first', () => {
    const at = (ms: number): string => new Date(T0 + ms).toISOString()
    const weekly = (percent: number, resetsIn: number) => ({ limits: [{ kind: 'weekly' as const, percent, resetsAt: at(resetsIn), fetchedAt: T0 }] })
    const rows = mergeFleetAccounts([server('oscar', [
      account('a@example.com', weekly(99, 9 * 3_600_000)),
      account('b@example.com', weekly(32, 2 * 86_400_000)),
      account('c@example.com', weekly(10, 2 * 86_400_000)),
      account('d@example.com', weekly(0, 3_600_000)),
    ])])
    const [limit] = fleetQuotaPools(rows, T0)[0].limits
    expect(limit.used).toBe(141)
    expect(limit.resets).toEqual([
      { at: at(9 * 3_600_000), freed: 99 },
      { at: at(2 * 86_400_000), freed: 42 },
    ])
  })
})

describe('mergeFleetAccounts', () => {
  it('makes one row of an account seen on two servers, solid where signed in and remembered where not', () => {
    const rows = mergeFleetAccounts([
      server('oscar', [account('a@example.com', { signedIn: false, lastSeen: T0 - 5000 })]),
      server('laptop', [account('a@example.com', { lastSeen: T0 })]),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ email: 'a@example.com', signedIn: true, lastSeen: T0 })
    expect(rows[0].machines).toEqual([
      { serverId: 'laptop', label: 'laptop', signedIn: true, lastSeen: T0 },
      { serverId: 'oscar', label: 'oscar', signedIn: false, lastSeen: T0 - 5000 },
    ])
  })

  it('takes each limit from the server that read it most recently', () => {
    const rows = mergeFleetAccounts([
      server('oscar', [account('a@example.com', { limits: [{ kind: 'session', percent: 10, fetchedAt: T0 - 9000 }, { kind: 'weekly', percent: 60, fetchedAt: T0 }] })]),
      server('laptop', [account('a@example.com', { limits: [{ kind: 'session', percent: 40, fetchedAt: T0 }, { kind: 'weekly', percent: 50, fetchedAt: T0 - 9000 }] })]),
    ])
    expect(fleetLimit(rows[0], 'session')?.percent).toBe(40)
    expect(fleetLimit(rows[0], 'weekly')?.percent).toBe(60)
  })

  it('orders rows by provider name, then by email, with a missing email last', () => {
    const rows = mergeFleetAccounts([
      server('oscar', [
        account('', { provider: 'xai', backend: 'grok' }),
        account('Zed@example.com'),
        account('b@example.com', { provider: 'openai', backend: 'codex' }),
        account('', { orgId: 'no-email' }),
        account('gone@example.com', { signedIn: false, lastSeen: T0 - 1000 }),
      ]),
    ])
    expect(rows.map((r) => [r.provider, r.email, r.signedIn])).toEqual([
      ['anthropic', 'gone@example.com', false],
      ['anthropic', 'Zed@example.com', true],
      ['anthropic', '', true],
      ['openai', 'b@example.com', true],
      ['xai', '', true],
    ])
  })

  it('tells accounts of different providers and organizations apart', () => {
    const rows = mergeFleetAccounts([server('oscar', [
      account('a@example.com'),
      account('a@example.com', { orgId: 'other-org' }),
      account('a@example.com', { provider: 'openai', backend: 'codex' }),
    ])])
    expect(rows).toHaveLength(3)
  })

  it('names one column per model that has a weekly limit', () => {
    const rows = mergeFleetAccounts([server('oscar', [
      account('a@example.com', { limits: [{ kind: 'weekly_model', label: 'Model B', percent: 1, fetchedAt: T0 }] }),
      account('b@example.com', { limits: [{ kind: 'weekly_model', label: 'Model A', percent: 2, fetchedAt: T0 }, { kind: 'weekly', percent: 3, fetchedAt: T0 }] }),
    ])])
    expect(fleetModelLimitLabels(rows)).toEqual(['Model A', 'Model B'])
    expect(fleetLimit(rows.find((r) => r.email === 'a@example.com')!, 'weekly_model', 'Model A')).toBeUndefined()
  })
})

describe('fleetLimitExpired', () => {
  it('is true only for a limit read before a reset that has since passed', () => {
    const resetsAt = new Date(T0).toISOString()
    expect(fleetLimitExpired({ resetsAt, fetchedAt: T0 - 1000 }, T0 + 1)).toBe(true)
    expect(fleetLimitExpired({ resetsAt, fetchedAt: T0 - 1000 }, T0 - 1)).toBe(false)
    expect(fleetLimitExpired({ resetsAt, fetchedAt: T0 + 5 }, T0 + 10)).toBe(false)
    expect(fleetLimitExpired({ fetchedAt: T0 }, T0 + 10)).toBe(false)
  })
})

describe('fleetTotals', () => {
  it('counts servers, running conversations on reachable ones, versions, and accounts', () => {
    const servers = [
      server('a', [account('x@example.com')], {}, { serverVersion: '1.1.0', runningConversations: 2 }),
      server('b', [account('y@example.com', { signedIn: false })], {}, { serverVersion: '1.1.0', runningConversations: 3 }),
      server('c', [], { online: false }, { serverVersion: '1.0.0', runningConversations: 9 }),
      { id: 'd', label: 'd', online: false, report: null },
    ]
    expect(fleetTotals(servers, mergeFleetAccounts(servers))).toEqual({
      servers: 4, serversOnline: 2, runningConversations: 5,
      versions: [{ version: '1.1.0', servers: 2 }, { version: '1.0.0', servers: 1 }],
      accounts: 2, accountsSignedIn: 1,
    })
  })
})

describe('judgeFormat', () => {
  it('applies each rule', () => {
    expect(judgeFormat('exact', '3', '3').verdict).toBe('ok')
    expect(judgeFormat('exact', '3', '4').verdict).toBe('blocked')
    expect(judgeFormat('accepts-previous', '4', '5').verdict).toBe('ok')
    expect(judgeFormat('accepts-previous', '3', '5').verdict).toBe('blocked')
    expect(judgeFormat('accepts-previous', '6', '5').verdict).toBe('blocked')
    expect(judgeFormat('reader-at-least', '2', '5').verdict).toBe('ok')
    expect(judgeFormat('reader-at-least', '6', '5').verdict).toBe('blocked')
    expect(judgeFormat('exact', undefined, '5').verdict).toBe('unknown')
    expect(judgeFormat('host-storage', '1', '1').verdict).toBe('unknown')
  })
})

describe('buildFleetMatrix', () => {
  const fmt = (id: string, version: string, rule: string) => ({ id, owner: 'server', version, rule, meaning: 'm' })
  it('judges every pair for transfer, rows sending to columns', () => {
    const matrix = buildFleetMatrix([
      server('a', [], {}, { formats: [fmt('transfer-archive', '2', 'exact')] }),
      server('b', [], {}, { formats: [fmt('transfer-archive', '3', 'exact')] }),
      server('c', [], {}, { formats: [] }),
    ], 'transfer-archive')
    expect(matrix?.rows.map((r) => r.id)).toEqual(['a', 'b'])
    expect(matrix?.cells.map((row) => row.map((c) => c.verdict))).toEqual([['ok', 'blocked'], ['blocked', 'ok']])
  })

  it('lists only desktop-run servers as Studio wire senders', () => {
    const matrix = buildFleetMatrix([
      server('mac', [], {}, { hostApp: { name: 'desktop', version: '1' }, formats: [fmt('studio-wire', '4', 'accepts-previous')] }),
      server('box', [], {}, { hostApp: null, formats: [fmt('studio-wire', '5', 'accepts-previous')] }),
    ], 'studio-wire')
    expect(matrix?.rows.map((r) => r.id)).toEqual(['mac'])
    expect(matrix?.columns.map((c) => c.id)).toEqual(['mac', 'box'])
    expect(matrix?.cells[0].map((c) => c.verdict)).toEqual(['ok', 'ok'])
  })

  it('is null when no server reports the format', () => {
    expect(buildFleetMatrix([server('a', [])], 'transfer-archive')).toBeNull()
  })
})

describe('fleetAccountName', () => {
  it('hides an email until it is revealed, and names an account with no email by its plan or provider', () => {
    const account = { provider: 'anthropic', email: 'user@example.com', label: 'Claude Max' }
    expect(fleetAccountName(account, false)).toBe(HIDDEN_FLEET_EMAIL)
    expect(HIDDEN_FLEET_EMAIL).not.toContain('example')
    expect(fleetAccountName(account, true)).toBe('user@example.com')
    expect(fleetAccountName({ ...account, email: '' }, false)).toBe('Claude Max')
    expect(fleetAccountName({ provider: 'anthropic', email: '' }, false)).toBe('Anthropic')
  })
})
