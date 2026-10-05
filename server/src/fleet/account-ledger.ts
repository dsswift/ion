/**
 * account-ledger — the Provider Account Ledger: every provider CLI account
 * this server has seen signed in during the last 30 days, with the usage
 * limits last read for it.
 *
 * A CLI holds one login at a time, so the account signed in now is all the
 * engine can report. The ledger keeps the ones that were signed in before,
 * marked signed out, so a Fleet view can still show where an account has
 * been and what its limits were when last seen.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { ProviderAccountUsage, ProviderUsageLimit } from '@ion/shared/types-models'
import type { RateLimitPayload } from '@ion/shared/types-engine-event-model'
import { FLEET_ACCOUNT_RETENTION_MS, fleetAccountKey, type FleetAccount, type FleetAccountLimit } from '@ion/shared/types-fleet'
import { dataDir } from '../paths'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('fleet.accounts', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('fleet.accounts', msg, fields)
}

const byKey = new Map<string, FleetAccount>()
let loaded = false

function ledgerFilePath(): string {
  return join(dataDir(), 'provider-accounts.json')
}

function prune(now: number): number {
  let dropped = 0
  for (const [key, row] of byKey) {
    if (!row.signedIn && now - row.lastSeen > FLEET_ACCOUNT_RETENTION_MS) {
      byKey.delete(key)
      dropped++
    }
  }
  return dropped
}

/** Loads `provider-accounts.json` once, tolerating a missing or corrupt file. */
function ensureLoaded(now: number): void {
  if (loaded) return
  loaded = true
  const path = ledgerFilePath()
  if (!existsSync(path)) return
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { accounts?: FleetAccount[] }
    for (const row of parsed.accounts ?? []) {
      if (row && typeof row.provider === 'string' && typeof row.email === 'string') byKey.set(fleetAccountKey(row), { ...row, limits: row.limits ?? [] })
    }
    const dropped = prune(now)
    log('account ledger loaded from disk', { count: byKey.size, pruned: dropped })
    if (dropped > 0) persist()
  } catch (err) {
    warn('account ledger file corrupt; starting empty', { path, error: String(err) })
  }
}

function persist(): void {
  const path = ledgerFilePath()
  try {
    atomicWriteFileSync(path, JSON.stringify({ accounts: [...byKey.values()] }, null, 2), 0o600)
  } catch (err) {
    warn('account ledger persist failed', { path, error: String(err) })
  }
}

function stamp(limits: ProviderUsageLimit[], now: number): FleetAccountLimit[] {
  return limits.map((l) => ({ ...l, fetchedAt: now }))
}

/**
 * Records one `provider_account_usage` answer. Every account in it is signed
 * in now; every other row is not. A read whose limits failed keeps the
 * row's last good limits and notes the failure.
 */
export function recordAccountPoll(entries: ProviderAccountUsage[], now = Date.now()): FleetAccount[] {
  ensureLoaded(now)
  const signedInKeys = new Set<string>()
  for (const entry of entries) {
    const account = entry.account
    if (!account) continue
    const identity = { provider: account.provider, email: account.email ?? '', orgId: account.orgId, authMethod: account.authMethod }
    const key = fleetAccountKey(identity)
    signedInKeys.add(key)
    const prev = byKey.get(key)
    if (!prev) log('account first seen', { provider: account.provider, backend: entry.backend, plan_type: account.planType ?? '' })
    else if (!prev.signedIn) log('account signed in again', { provider: account.provider, backend: entry.backend })
    byKey.set(key, {
      provider: account.provider,
      backend: entry.backend,
      email: account.email ?? '',
      orgId: account.orgId,
      orgName: account.orgName,
      planType: account.planType,
      authMethod: account.authMethod,
      label: account.label,
      firstSeen: prev?.firstSeen ?? now,
      lastSeen: now,
      signedIn: true,
      limits: entry.error ? prev?.limits ?? [] : stamp(entry.limits ?? [], now),
      limitsError: entry.error || undefined,
    })
  }
  for (const [key, row] of byKey) {
    if (row.signedIn && !signedInKeys.has(key)) {
      row.signedIn = false
      log('account signed out', { provider: row.provider, backend: row.backend })
    }
  }
  const dropped = prune(now)
  persist()
  log('account poll recorded', { signed_in: signedInKeys.size, known: byKey.size, pruned: dropped })
  return listAccounts(now)
}

/** The windows of a Claude rate limit report, by the limit kind each one is. */
const RATE_LIMIT_WINDOW_KIND: Record<string, ProviderUsageLimit['kind']> = { five_hour: 'session', seven_day: 'weekly' }

/**
 * Applies a backend's in-run usage report to the account signed in on that
 * backend, so its session and weekly limits stay current between polls.
 * Returns whether a row changed.
 */
export function applyRateLimitReport(backend: string, report: RateLimitPayload, now = Date.now()): boolean {
  ensureLoaded(now)
  const row = [...byKey.values()].find((r) => r.signedIn && r.backend === backend)
  if (!row) {
    log('rate limit report ignored: no signed-in account on the backend', { backend })
    return false
  }
  let changed = false
  for (const [name, window] of Object.entries(report.windows ?? {})) {
    const kind = RATE_LIMIT_WINDOW_KIND[name]
    if (!kind) continue
    const next: FleetAccountLimit = {
      kind,
      percent: window.utilization * 100,
      resetsAt: window.resetsAt > 0 ? new Date(window.resetsAt * 1000).toISOString() : undefined,
      fetchedAt: now,
    }
    const at = row.limits.findIndex((l) => l.kind === kind)
    if (at >= 0) row.limits[at] = next
    else row.limits.push(next)
    changed = true
  }
  if (changed) {
    row.lastSeen = now
    persist()
    log('rate limit report applied', { backend, provider: row.provider, window_count: Object.keys(report.windows ?? {}).length })
  }
  return changed
}

/** Every account in the ledger, signed-in ones first, then most recently seen. */
export function listAccounts(now = Date.now()): FleetAccount[] {
  ensureLoaded(now)
  return [...byKey.values()]
    .map((row) => ({ ...row, limits: row.limits.map((l) => ({ ...l })) }))
    .sort((a, b) => Number(b.signedIn) - Number(a.signedIn) || b.lastSeen - a.lastSeen)
}

/** TEST ONLY. Empties the ledger and forces the next read to re-read disk. */
export function _resetAccountLedgerForTest(): void {
  byKey.clear()
  loaded = false
}
