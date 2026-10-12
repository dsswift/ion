/**
 * usage-limit — what a conversation carries when its account's usage limit
 * stopped a run, and the prompt a server can hold for it until later.
 *
 * Both are owner-durable tab state. The server sets `usageLimit` from the
 * backend's own report (`rate_limit` with status `rejected`) and clears it
 * when the backend next allows a request. A held prompt is released by the
 * server itself, so it sends with every client closed.
 */
import type { FleetAccountLimit } from './types-fleet'

/** The backend's verdict that refuses the next request. */
export const RATE_LIMIT_REJECTED = 'rejected'

/** A usage limit that stopped a conversation's run. */
export interface TabUsageLimit {
  /** The window that ran out, as the backend names it ("five_hour", "seven_day"). */
  limitType: string
  /** Unix ms the window resets. */
  resetsAt: number
  /** Unix ms the run was refused. */
  hitAt: number
}

/**
 * When a held prompt is sent.
 *  - limit-reset: once the limit that stopped the conversation has reset.
 *  - spare-quota: once the account has quota that would otherwise reset unused.
 */
export type DeferredRelease = 'limit-reset' | 'spare-quota'

export const DEFERRED_RELEASES: readonly DeferredRelease[] = ['limit-reset', 'spare-quota']

/** A prompt the server holds for a conversation and sends by itself. */
export interface TabDeferredSend {
  text: string
  release: DeferredRelease
  /** Unix ms the prompt was queued. */
  queuedAt: number
}

/** What a resume at reset sends when the server's setting names nothing else. */
export const DEFAULT_RESUME_PROMPT = 'Continue where you left off.'

/** The reset time while the limit still holds, else null. */
export function usageLimitedUntil(tab: { usageLimit?: TabUsageLimit | null }, now: number): number | null {
  const limit = tab.usageLimit
  return limit && limit.resetsAt > now ? limit.resetsAt : null
}

/** "5-hour limit", "7-day limit", or the backend's own name for a window this does not know. */
export function usageLimitLabel(limitType: string): string {
  if (limitType === 'five_hour') return '5-hour limit'
  if (limitType.startsWith('seven_day')) return '7-day limit'
  return limitType ? `${limitType.replace(/_/g, ' ')} limit` : 'usage limit'
}

/** A backend's usage report, as far as the transcript line about it needs. */
export interface RateLimitReport {
  status: string
  rateLimitType: string
  /** Unix second the window resets. */
  resetsAt: number
  utilization?: number
  windows?: Record<string, { utilization: number }>
}

/** Fraction (0..1) used of the window a report is about, when the backend said. */
export function rateLimitUtilization(report: RateLimitReport): number | null {
  return report.utilization ?? report.windows?.[report.rateLimitType]?.utilization ?? null
}

/**
 * The transcript line for a usage report, or null when the request was simply
 * allowed. Only a refusal says the limit was reached; any other verdict that
 * is not a plain allow is the backend warning that the limit is close.
 */
export function rateLimitNotice(report: RateLimitReport, now: number): string | null {
  if (report.status === 'allowed') return null
  const label = usageLimitLabel(report.rateLimitType)
  const at = new Date(report.resetsAt * 1000)
  const sameDay = report.resetsAt * 1000 - now < 24 * 3_600_000
  const resets = at.toLocaleString(undefined, sameDay ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' })
  if (report.status === RATE_LIMIT_REJECTED) return `${label.charAt(0).toUpperCase()}${label.slice(1)} reached. Resets at ${resets}.`
  const used = rateLimitUtilization(report)
  const percent = used === null ? '' : ` (${Math.round(used * 100)}% used)`
  return `Approaching the ${label}${percent}. Requests are still allowed. Resets at ${resets}.`
}

/** How much unused quota counts as spare, and how close to its reset. */
export interface SpareQuotaRule {
  /** A weekly window counts once it resets within this many hours. */
  withinHours: number
  /** And at least this much of it (0..100) is still unused. */
  unusedPercent: number
}

export const DEFAULT_SPARE_QUOTA_RULE: SpareQuotaRule = { withinHours: 12, unusedPercent: 25 }

/** A weekly limit whose unused part is about to be lost at its reset. */
export interface ExpiringQuota {
  limit: FleetAccountLimit
  /** Percent (0..100) that resets unused. */
  unusedPercent: number
  /** Unix ms of the reset. */
  resetsAt: number
}

function resetMs(limit: Pick<FleetAccountLimit, 'resetsAt'>): number | null {
  if (!limit.resetsAt) return null
  const at = Date.parse(limit.resetsAt)
  return Number.isFinite(at) ? at : null
}

/**
 * The weekly limits of one account that will reset with quota unused, soonest
 * first. A limit already past its reset says nothing and is left out.
 */
export function expiringQuota(limits: readonly FleetAccountLimit[], now: number, rule: SpareQuotaRule = DEFAULT_SPARE_QUOTA_RULE): ExpiringQuota[] {
  const out: ExpiringQuota[] = []
  for (const limit of limits) {
    if (limit.kind !== 'weekly' && limit.kind !== 'weekly_model') continue
    const at = resetMs(limit)
    if (at === null || at <= now || at - now > rule.withinHours * 3_600_000) continue
    const unused = Math.max(0, 100 - limit.percent)
    if (unused < rule.unusedPercent) continue
    out.push({ limit, unusedPercent: unused, resetsAt: at })
  }
  return out.sort((a, b) => a.resetsAt - b.resetsAt)
}

/**
 * What an account loses at its coming weekly reset, as a list to show: every
 * weekly limit resetting within the rule's hours with a whole percent or more
 * unused, a model's before the account's own. Empty unless one of them is
 * expiring, so a limit under the rule's share is named only beside one over it.
 */
export function unusedAtReset(limits: readonly FleetAccountLimit[], now: number, rule: SpareQuotaRule = DEFAULT_SPARE_QUOTA_RULE): ExpiringQuota[] {
  if (expiringQuota(limits, now, rule).length === 0) return []
  const modelFirst = (entry: ExpiringQuota): number => (entry.limit.kind === 'weekly_model' ? 0 : 1)
  return expiringQuota(limits, now, { ...rule, unusedPercent: 1 })
    .sort((a, b) => modelFirst(a) - modelFirst(b) || (a.limit.label ?? '').localeCompare(b.limit.label ?? ''))
}

/** "21% Fable unused" for a model's limit; "43% unused" for the account's own, "43% total unused" when it is listed beside a model's. */
export function unusedAtResetLabel(entry: ExpiringQuota, all: readonly ExpiringQuota[]): string {
  const percent = `${Math.round(entry.unusedPercent)}%`
  if (entry.limit.kind === 'weekly_model') return `${percent} ${entry.limit.label ?? 'model'} unused`
  return all.some((other) => other.limit.kind === 'weekly_model') ? `${percent} total unused` : `${percent} unused`
}

/**
 * Whether two reset times name the same weekly window. A backend reports one
 * window's reset a little differently from read to read; two windows of one
 * limit are days apart.
 */
export const SAME_WINDOW_MS = 3_600_000
export function sameResetWindow(a: number, b: number): boolean {
  return Math.abs(a - b) < SAME_WINDOW_MS
}

/**
 * Whether an account can take work now: no limit that still holds is used up.
 * A limit read before its reset and looked at after it no longer counts.
 */
export function accountHasRoom(limits: readonly FleetAccountLimit[], now: number): boolean {
  return limits.every((limit) => {
    if (limit.kind === 'spend') return true
    const at = resetMs(limit)
    if (at !== null && at <= now && limit.fetchedAt < at) return true
    return limit.percent < 100
  })
}

/** Spare quota worth spending: something is about to reset unused, and the account can take work now. */
export function hasSpareQuota(limits: readonly FleetAccountLimit[], now: number, rule: SpareQuotaRule = DEFAULT_SPARE_QUOTA_RULE): boolean {
  return accountHasRoom(limits, now) && expiringQuota(limits, now, rule).length > 0
}
