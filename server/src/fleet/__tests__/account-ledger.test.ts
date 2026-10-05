/** The Provider Account Ledger: who is signed in now, who was, and for how long it remembers. */
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderAccountUsage } from '@ion/shared/types-models'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
const dir = vi.hoisted(() => ({ path: '' }))
vi.mock('../../paths', () => ({ dataDir: () => dir.path }))

import { _resetAccountLedgerForTest, applyRateLimitReport, listAccounts, recordAccountPoll } from '../account-ledger'

const DAY = 24 * 60 * 60 * 1000
const T0 = 1_800_000_000_000

function claude(email: string, percent = 16): ProviderAccountUsage {
  return {
    backend: 'claude-code',
    account: { provider: 'anthropic', email, orgId: `org-${email}`, planType: 'max', authMethod: 'claude.ai', label: 'Claude Max' },
    limits: [
      { kind: 'session', percent, resetsAt: '2026-10-03T17:20:00Z' },
      { kind: 'weekly', percent: 63 },
      { kind: 'weekly_model', label: 'Example Model', percent: 76 },
    ],
    fetchedAt: '2026-10-03T14:00:00Z',
  }
}

beforeEach(() => {
  dir.path = mkdtempSync(join(tmpdir(), 'ion-ledger-'))
  _resetAccountLedgerForTest()
})
afterEach(() => rmSync(dir.path, { recursive: true, force: true }))

describe('recordAccountPoll', () => {
  it('records the signed-in account with its limits stamped at the read time', () => {
    const [row] = recordAccountPoll([claude('a@example.com')], T0)
    expect(row).toMatchObject({ provider: 'anthropic', backend: 'claude-code', email: 'a@example.com', signedIn: true, firstSeen: T0, lastSeen: T0 })
    expect(row.limits.map((l) => [l.kind, l.percent, l.fetchedAt])).toEqual([['session', 16, T0], ['weekly', 63, T0], ['weekly_model', 76, T0]])
  })

  it('keeps an account that signed out, with the limits last read for it', () => {
    recordAccountPoll([claude('a@example.com')], T0)
    const rows = recordAccountPoll([claude('b@example.com', 5)], T0 + DAY)
    expect(rows.map((r) => [r.email, r.signedIn])).toEqual([['b@example.com', true], ['a@example.com', false]])
    const gone = rows[1]
    expect(gone.lastSeen).toBe(T0)
    expect(gone.limits[0]).toMatchObject({ kind: 'session', percent: 16, fetchedAt: T0 })
  })

  it('marks an account signed out when its CLI reports no account', () => {
    recordAccountPoll([claude('a@example.com')], T0)
    const rows = recordAccountPoll([{ backend: 'claude-code', limits: [], fetchedAt: '' }], T0 + 1000)
    expect(rows).toHaveLength(1)
    expect(rows[0].signedIn).toBe(false)
  })

  it('keeps the last good limits when a read of them fails', () => {
    recordAccountPoll([claude('a@example.com')], T0)
    const [row] = recordAccountPoll([{ ...claude('a@example.com'), limits: [], error: 'claude did not answer' }], T0 + 1000)
    expect(row.limitsError).toBe('claude did not answer')
    expect(row.limits).toHaveLength(3)
    expect(row.limits[0].fetchedAt).toBe(T0)
    expect(row.lastSeen).toBe(T0 + 1000)
  })

  it('forgets an account not signed in for more than 30 days, and never a signed-in one', () => {
    recordAccountPoll([claude('a@example.com')], T0)
    recordAccountPoll([claude('b@example.com')], T0 + DAY)
    expect(recordAccountPoll([claude('b@example.com')], T0 + 29 * DAY).map((r) => r.email)).toEqual(['b@example.com', 'a@example.com'])
    expect(recordAccountPoll([claude('b@example.com')], T0 + 31 * DAY).map((r) => r.email)).toEqual(['b@example.com'])
  })

  it('persists across a restart and prunes on load', () => {
    recordAccountPoll([claude('a@example.com')], T0)
    recordAccountPoll([claude('b@example.com')], T0 + DAY)
    const onDisk = JSON.parse(readFileSync(join(dir.path, 'provider-accounts.json'), 'utf-8')) as { accounts: unknown[] }
    expect(onDisk.accounts).toHaveLength(2)
    _resetAccountLedgerForTest()
    expect(listAccounts(T0 + 2 * DAY).map((r) => r.email)).toEqual(['b@example.com', 'a@example.com'])
    _resetAccountLedgerForTest()
    expect(listAccounts(T0 + 40 * DAY).map((r) => r.email)).toEqual(['b@example.com'])
  })

  it('tells two logins with no email apart by auth method', () => {
    const rows = recordAccountPoll([
      { backend: 'codex', account: { provider: 'openai', authMethod: 'apiKey', label: 'OpenAI API Key' }, limits: [], fetchedAt: '' },
      claude('a@example.com'),
    ], T0)
    expect(rows.map((r) => r.provider).sort()).toEqual(['anthropic', 'openai'])
  })
})

describe('applyRateLimitReport', () => {
  it('updates the session and weekly limits of the account signed in on the backend, leaving the model limit', () => {
    recordAccountPoll([claude('a@example.com')], T0)
    const changed = applyRateLimitReport('claude-code', {
      status: 'allowed', resetsAt: 1791048000, rateLimitType: 'five_hour',
      windows: { five_hour: { utilization: 0.24, resetsAt: 1791048000 }, seven_day: { utilization: 0.64, resetsAt: 1791234000 } },
    }, T0 + 5000)
    expect(changed).toBe(true)
    const [row] = listAccounts(T0 + 5000)
    expect(row.limits.find((l) => l.kind === 'session')).toMatchObject({ percent: 24, fetchedAt: T0 + 5000, resetsAt: new Date(1791048000 * 1000).toISOString() })
    expect(row.limits.find((l) => l.kind === 'weekly')).toMatchObject({ percent: 64, fetchedAt: T0 + 5000 })
    expect(row.limits.find((l) => l.kind === 'weekly_model')).toMatchObject({ percent: 76, fetchedAt: T0 })
  })

  it('ignores a report when no account is signed in on the backend', () => {
    expect(applyRateLimitReport('claude-code', { status: 'allowed', resetsAt: 0, rateLimitType: 'five_hour', windows: { five_hour: { utilization: 0.5, resetsAt: 0 } } }, T0)).toBe(false)
    expect(listAccounts(T0)).toEqual([])
  })
})
