/**
 * fleet-view — a device's Fleet is every server it is paired with. Each
 * server answers `fleet.report` about itself; these pure functions add the
 * answers up into what a Fleet screen shows: one row per account across
 * every server, the totals, and which servers can work with which.
 */
import type { FormatRule, FormatVersion } from './format-versions'
import { fleetAccountKey, type FleetAccount, type FleetAccountLimit, type FleetEnterpriseAccount, type FleetReport } from './types-fleet'
import { getProviderDisplayName, type ProviderUsageLimitKind } from './types-models'
import { DEFAULT_SPARE_QUOTA_RULE, expiringQuota, type ExpiringQuota, type SpareQuotaRule } from './usage-limit'

/** One server's place in the Fleet: its report, when one has been read. */
export interface FleetServer {
  /** The device's own id for the server (its catalog id). */
  id: string
  label: string
  /** Whether the device is connected to the server now. */
  online: boolean
  /** The newest report read; null when none has been. */
  report: FleetReport | null
}

/** A server an account has been seen on. */
export interface FleetAccountMachine {
  serverId: string
  label: string
  /** Signed in on that server now. Otherwise seen there within the ledger's 30 days. */
  signedIn: boolean
  /** Unix ms the server last saw the account signed in. */
  lastSeen: number
}

/** One account across the whole Fleet. */
export interface FleetAccountRow {
  key: string
  provider: string
  backend: string
  email: string
  orgName?: string
  planType?: string
  label?: string
  /** Signed in on at least one server now. */
  signedIn: boolean
  /** Unix ms any server last saw the account signed in. */
  lastSeen: number
  /** Each limit, taken from whichever server read it most recently. */
  limits: FleetAccountLimit[]
  machines: FleetAccountMachine[]
}

function limitKey(l: Pick<FleetAccountLimit, 'kind' | 'label'>): string {
  return `${l.kind}|${l.label ?? ''}`
}

/**
 * One row per account across every server's ledger. The same account on
 * two servers is one row with two machines; each of its limits is the
 * newest read any server holds. Rows are ordered by provider name, then by
 * account email; an account with no email follows its provider's others.
 */
export function mergeFleetAccounts(servers: readonly FleetServer[]): FleetAccountRow[] {
  const rows = new Map<string, FleetAccountRow>()
  const limits = new Map<string, Map<string, FleetAccountLimit>>()
  for (const server of servers) {
    for (const account of server.report?.accounts ?? []) {
      const key = fleetAccountKey(account)
      const newer = (rows.get(key)?.lastSeen ?? -1) < account.lastSeen
      const prev = rows.get(key)
      const row: FleetAccountRow = prev && !newer ? prev : {
        key,
        provider: account.provider,
        backend: account.backend,
        email: account.email,
        orgName: account.orgName,
        planType: account.planType,
        label: account.label,
        signedIn: prev?.signedIn ?? false,
        lastSeen: account.lastSeen,
        limits: [],
        machines: prev?.machines ?? [],
      }
      row.signedIn = row.signedIn || account.signedIn
      row.machines.push({ serverId: server.id, label: server.label, signedIn: account.signedIn, lastSeen: account.lastSeen })
      rows.set(key, row)
      const byLimit = limits.get(key) ?? new Map<string, FleetAccountLimit>()
      for (const limit of account.limits) {
        const held = byLimit.get(limitKey(limit))
        if (!held || held.fetchedAt < limit.fetchedAt) byLimit.set(limitKey(limit), limit)
      }
      limits.set(key, byLimit)
    }
  }
  return [...rows.values()]
    .map((row) => ({
      ...row,
      limits: [...(limits.get(row.key)?.values() ?? [])],
      machines: [...row.machines].sort((a, b) => Number(b.signedIn) - Number(a.signedIn) || a.label.localeCompare(b.label)),
    }))
    .sort(compareFleetAccounts)
}

function compareFleetAccounts(a: FleetAccountRow, b: FleetAccountRow): number {
  return getProviderDisplayName(a.provider).localeCompare(getProviderDisplayName(b.provider), undefined, { sensitivity: 'base' })
    || Number(!a.email) - Number(!b.email)
    || a.email.localeCompare(b.email, undefined, { sensitivity: 'base' })
    || Number(b.signedIn) - Number(a.signedIn)
    || b.lastSeen - a.lastSeen
}

/**
 * What a Fleet screen shows in place of an account email until the operator
 * reveals it, so a screenshot or a shared screen does not expose the account.
 * Fixed, so it says nothing about the email's length or domain either.
 */
export const HIDDEN_FLEET_EMAIL = '••••••@••••••'

/** What to call an account: its email (hidden unless revealed), else its plan label, else its provider. */
export function fleetAccountName(account: Pick<FleetAccount, 'email' | 'label' | 'provider'>, revealEmail: boolean): string {
  if (account.email) return revealEmail ? account.email : HIDDEN_FLEET_EMAIL
  return account.label || getProviderDisplayName(account.provider)
}

/** What to call a server's enterprise account: its user name (hidden unless revealed), else its display name. */
export function fleetEnterpriseAccountName(account: FleetEnterpriseAccount, revealEmail: boolean): string {
  if (account.username) return revealEmail ? account.username : HIDDEN_FLEET_EMAIL
  return account.displayName || 'Signed in'
}

/** The limit of `kind` on a row; `label` picks one model's among several `weekly_model` limits. */
export function fleetLimit(row: Pick<FleetAccountRow, 'limits'>, kind: ProviderUsageLimitKind, label?: string): FleetAccountLimit | undefined {
  return row.limits.find((l) => l.kind === kind && (label === undefined || l.label === label))
}

/** Every model that has a weekly limit on some account, by name. One Fleet column each. */
export function fleetModelLimitLabels(rows: readonly FleetAccountRow[]): string[] {
  const labels = new Set<string>()
  for (const row of rows) for (const l of row.limits) if (l.kind === 'weekly_model' && l.label) labels.add(l.label)
  return [...labels].sort((a, b) => a.localeCompare(b))
}

/**
 * Whether a limit's window has reset since it was read. A limit read before
 * its reset time, looked at after it, no longer says how much is used.
 */
export function fleetLimitExpired(limit: Pick<FleetAccountLimit, 'resetsAt' | 'fetchedAt'>, now: number): boolean {
  if (!limit.resetsAt) return false
  const resets = Date.parse(limit.resetsAt)
  return Number.isFinite(resets) && resets <= now && limit.fetchedAt < resets
}

/** One usage limit added up across every account of a provider that reports it. */
export interface FleetQuotaLimit {
  kind: ProviderUsageLimitKind
  /** The model, for a `weekly_model` limit. */
  label?: string
  /** Accounts that report this limit. */
  accounts: number
  /** 100 per account: two accounts hold 200%. */
  capacity: number
  /** Percent used, summed over those accounts. A window that reset since it was read counts as unused. */
  used: number
  /** The soonest reset still ahead among those accounts. */
  nextReset?: string
}

/** One provider's quota across the Fleet: every account of it, signed in now or seen in the last 30 days. */
export interface FleetQuotaPool {
  provider: string
  accounts: number
  limits: FleetQuotaLimit[]
}

/** A model's weekly limit first, then the 5-hour, then the 7-day, then the rest. */
function quotaLimitOrder(l: Pick<FleetQuotaLimit, 'kind' | 'label'>): string {
  if (l.kind === 'weekly_model') return `0|${l.label ?? ''}`
  if (l.kind === 'session') return '1'
  if (l.kind === 'weekly') return '2'
  return `3|${l.kind}|${l.label ?? ''}`
}

/**
 * The quota pools: per provider, each limit summed over its accounts, so two
 * accounts with a 7-day limit hold 200% and show how much of it is used.
 * A spend limit is money, not a share of a window, so it is left out.
 * Providers in name order.
 */
export function fleetQuotaPools(rows: readonly FleetAccountRow[], now: number): FleetQuotaPool[] {
  const pools = new Map<string, { accounts: number; limits: Map<string, FleetQuotaLimit> }>()
  for (const row of rows) {
    const pool = pools.get(row.provider) ?? { accounts: 0, limits: new Map<string, FleetQuotaLimit>() }
    pool.accounts += 1
    for (const limit of row.limits) {
      if (limit.kind === 'spend') continue
      const sum = pool.limits.get(limitKey(limit)) ?? { kind: limit.kind, label: limit.label, accounts: 0, capacity: 0, used: 0 }
      sum.accounts += 1
      sum.capacity += 100
      if (!fleetLimitExpired(limit, now)) {
        sum.used += Math.min(Math.max(limit.percent, 0), 100)
        const resets = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
        if (resets > now && (!sum.nextReset || resets < Date.parse(sum.nextReset))) sum.nextReset = limit.resetsAt
      }
      pool.limits.set(limitKey(limit), sum)
    }
    pools.set(row.provider, pool)
  }
  return [...pools]
    .map(([provider, pool]) => ({
      provider,
      accounts: pool.accounts,
      limits: [...pool.limits.values()].sort((a, b) => quotaLimitOrder(a).localeCompare(quotaLimitOrder(b))),
    }))
    .sort((a, b) => getProviderDisplayName(a.provider).localeCompare(getProviderDisplayName(b.provider), undefined, { sensitivity: 'base' }))
}

/** A signed-in account with weekly quota about to reset unused. */
export interface FleetExpiringAccount {
  row: FleetAccountRow
  /** Its expiring limits, soonest reset first. */
  expiring: ExpiringQuota[]
}

/**
 * The burn-down: every account signed in somewhere whose weekly quota will
 * reset with a share unused, soonest first. A signed-out account cannot
 * spend what it has left, so it is not listed.
 */
export function fleetExpiringQuota(accounts: readonly FleetAccountRow[], now: number, rule: SpareQuotaRule = DEFAULT_SPARE_QUOTA_RULE): FleetExpiringAccount[] {
  return accounts
    .filter((row) => row.signedIn)
    .map((row) => ({ row, expiring: expiringQuota(row.limits, now, rule) }))
    .filter((entry) => entry.expiring.length > 0)
    .sort((a, b) => a.expiring[0].resetsAt - b.expiring[0].resetsAt)
}

export interface FleetTotals {
  servers: number
  serversOnline: number
  /** Conversations with an agent running now, across the servers that say. */
  runningConversations: number
  /** Each server version in use and how many servers run it, most servers first. */
  versions: Array<{ version: string; servers: number }>
  accounts: number
  accountsSignedIn: number
}

export function fleetTotals(servers: readonly FleetServer[], accounts: readonly FleetAccountRow[]): FleetTotals {
  const versions = new Map<string, number>()
  let running = 0
  for (const server of servers) {
    if (!server.report) continue
    versions.set(server.report.server.serverVersion, (versions.get(server.report.server.serverVersion) ?? 0) + 1)
    if (server.online) running += server.report.server.runningConversations ?? 0
  }
  return {
    servers: servers.length,
    serversOnline: servers.filter((s) => s.online).length,
    runningConversations: running,
    versions: [...versions].map(([version, count]) => ({ version, servers: count })).sort((a, b) => b.servers - a.servers || a.version.localeCompare(b.version)),
    accounts: accounts.length,
    accountsSignedIn: accounts.filter((a) => a.signedIn).length,
  }
}

export type FleetVerdict = 'ok' | 'blocked' | 'unknown'

/**
 * Applies a Format Version rule to a sender's and a receiver's version.
 *  - exact: equal.
 *  - accepts-previous: the receiver accepts its own version and the one before.
 *  - reader-at-least: the receiver reads every version up to its own.
 */
export function judgeFormat(rule: FormatRule, from: string | undefined, to: string | undefined): { verdict: FleetVerdict; reason?: string } {
  if (!from || !to) return { verdict: 'unknown', reason: 'a server does not report this format' }
  if (rule === 'exact') return from === to ? { verdict: 'ok' } : { verdict: 'blocked', reason: `writes ${from}, the other reads ${to}` }
  if (rule !== 'accepts-previous' && rule !== 'reader-at-least') return { verdict: 'unknown', reason: 'this format is not compared between servers' }
  const f = Number(from)
  const t = Number(to)
  if (!Number.isInteger(f) || !Number.isInteger(t)) return from === to ? { verdict: 'ok' } : { verdict: 'unknown', reason: 'versions are not comparable numbers' }
  if (rule === 'accepts-previous') return f === t || f === t - 1 ? { verdict: 'ok' } : { verdict: 'blocked', reason: `client speaks ${f}, server accepts ${t} and ${t - 1}` }
  return t >= f ? { verdict: 'ok' } : { verdict: 'blocked', reason: `writer is at ${f}, reader only reads up to ${t}` }
}

export interface FleetMatrixCell {
  from: string
  to: string
  verdict: FleetVerdict
  fromVersion?: string
  toVersion?: string
  reason?: string
}

/** One format across the Fleet. Rows send to columns. */
export interface FleetMatrix {
  formatId: string
  rule: FormatRule
  meaning: string
  rows: Array<{ id: string; label: string }>
  columns: Array<{ id: string; label: string }>
  cells: FleetMatrixCell[][]
}

/** The formats a Fleet compares: moving a conversation, and a desktop connecting to a server. */
export const FLEET_TRANSFER_FORMAT = 'transfer-archive'
export const FLEET_STUDIO_WIRE_FORMAT = 'studio-wire'

function serverFormat(server: FleetServer, formatId: string): FormatVersion | undefined {
  return server.report?.server.formats?.find((f) => f.owner === 'server' && f.id === formatId)
}

/**
 * The matrix of one server-owned format, or null when no server reports it.
 * The Studio wire's rows are only the servers a desktop runs, because a
 * desktop is the client that connects.
 */
export function buildFleetMatrix(servers: readonly FleetServer[], formatId: string): FleetMatrix | null {
  const reporting = servers.filter((s) => serverFormat(s, formatId))
  const sample = reporting.map((s) => serverFormat(s, formatId)).find((f) => f !== undefined)
  if (!sample) return null
  const senders = formatId === FLEET_STUDIO_WIRE_FORMAT ? reporting.filter((s) => s.report?.server.hostApp) : reporting
  const cells = senders.map((from) => reporting.map((to): FleetMatrixCell => {
    const fromVersion = serverFormat(from, formatId)?.version
    const toVersion = serverFormat(to, formatId)?.version
    return { from: from.id, to: to.id, fromVersion, toVersion, ...judgeFormat(sample.rule, fromVersion, toVersion) }
  }))
  return {
    formatId,
    rule: sample.rule,
    meaning: sample.meaning,
    rows: senders.map((s) => ({ id: s.id, label: s.label })),
    columns: reporting.map((s) => ({ id: s.id, label: s.label })),
    cells,
  }
}
