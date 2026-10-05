/**
 * fleet-placement — which server a new conversation should open on.
 *
 * Among the servers that hold the project, the pick goes to the one whose
 * signed-in account has the most room, leaning toward an account whose
 * weekly quota is about to reset unused, with the host's free CPU and memory
 * breaking near ties. Each input is something the server itself reported
 * (`fleet.report`); nothing here is guessed.
 *
 * The weights are the caller's: a device marks a server Prefer, Normal, Less
 * often, or Never.
 */
import type { FleetAccount, FleetReport } from './types-fleet'
import { DEFAULT_SPARE_QUOTA_RULE, expiringQuota, type SpareQuotaRule } from './usage-limit'

export type PlacementWeight = 'prefer' | 'normal' | 'less' | 'never'

export const PLACEMENT_WEIGHTS: readonly PlacementWeight[] = ['prefer', 'normal', 'less', 'never']

export const PLACEMENT_WEIGHT_LABELS: Record<PlacementWeight, string> = { prefer: 'Prefer', normal: 'Normal', less: 'Less often', never: 'Never' }

const WEIGHT_FACTOR: Record<PlacementWeight, number> = { prefer: 1.5, normal: 1, less: 0.5, never: 0 }

/** How much each part of a server's standing counts toward its score. */
const ROOM_SHARE = 0.6
const EXPIRING_SHARE = 0.15
const LOAD_SHARE = 0.25

/** A report older than this says nothing about the server now. */
export const PLACEMENT_REPORT_MAX_AGE_MS = 5 * 60_000

export interface PlacementCandidate {
  id: string
  label: string
  /** Connected now. */
  online: boolean
  /** In the fleet but not offered for conversations. */
  manageOnly?: boolean
  weight?: PlacementWeight
  report: FleetReport | null
  /** Unix ms the report was read. */
  readAt?: number
}

export interface PlacementScore {
  id: string
  label: string
  /** 0 when the server cannot take the conversation. */
  score: number
  /** Why it scored as it did, in a few plain words. */
  reason: string
  /** Percent (0..100) of the tightest limit still unused; null when the server reports no account. */
  roomPercent: number | null
}

/** Percent of the tightest limit that still holds which is unused. A limit already past its reset counts as fully unused. */
export function accountRoomPercent(account: Pick<FleetAccount, 'limits'>, now: number): number {
  let room = 100
  for (const limit of account.limits) {
    if (limit.kind === 'spend') continue
    const resets = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
    if (Number.isFinite(resets) && resets <= now && limit.fetchedAt < resets) continue
    room = Math.min(room, Math.max(0, 100 - limit.percent))
  }
  return room
}

/** The account a new conversation on this server would run on: the default provider's when one is signed in, else the signed-in account with the most room. */
export function placementAccount(report: FleetReport, now: number): FleetAccount | null {
  const signedIn = report.accounts.filter((account) => account.signedIn)
  const preferred = signedIn.filter((account) => account.provider === report.defaultProvider)
  const pool = preferred.length > 0 ? preferred : signedIn
  return [...pool].sort((a, b) => accountRoomPercent(b, now) - accountRoomPercent(a, now))[0] ?? null
}

/** Free share of the host, 0..1: free CPU times free memory. 0.5 when the server has no sample. */
function hostFree(report: FleetReport): number {
  const host = report.metrics?.host
  if (!host) return 0.5
  const cpuFree = host.cpuUtilization === null ? 0.5 : Math.max(0, 1 - host.cpuUtilization)
  const total = host.memoryLimitBytes > 0 ? host.memoryLimitBytes : host.memoryTotalBytes
  const memFree = total > 0 ? Math.min(1, Math.max(0, host.memoryAvailableBytes / total)) : 0.5
  return cpuFree * memFree
}

export function scorePlacement(candidate: PlacementCandidate, now: number, rule: SpareQuotaRule = DEFAULT_SPARE_QUOTA_RULE): PlacementScore {
  const base = { id: candidate.id, label: candidate.label }
  const out = (score: number, reason: string, roomPercent: number | null = null): PlacementScore => ({ ...base, score, reason, roomPercent })
  const weight = candidate.weight ?? 'normal'
  if (candidate.manageOnly) return out(0, 'manage-only')
  if (weight === 'never') return out(0, 'set to never')
  if (!candidate.online) return out(0, 'offline')
  const report = candidate.report
  if (!report || (candidate.readAt !== undefined && now - candidate.readAt > PLACEMENT_REPORT_MAX_AGE_MS)) {
    // It can take the conversation, but nothing says how well: it only wins
    // when no server with a report can.
    return out(0.01 * WEIGHT_FACTOR[weight], 'no fleet report')
  }
  const account = placementAccount(report, now)
  const free = hostFree(report)
  if (!account) {
    // An API key or no CLI sign-in: no limit to read, so only load counts.
    return out(WEIGHT_FACTOR[weight] * (ROOM_SHARE * 0.5 + LOAD_SHARE * free), 'no subscription account; by load')
  }
  const room = accountRoomPercent(account, now)
  if (room <= 0) return out(0, 'account at its limit', 0)
  const expiring = expiringQuota(account.limits, now, rule)[0]
  const expiringPart = expiring ? expiring.unusedPercent / 100 : 0
  const score = WEIGHT_FACTOR[weight] * (ROOM_SHARE * (room / 100) + EXPIRING_SHARE * expiringPart + LOAD_SHARE * free)
  const reason = expiring
    ? `${Math.round(room)}% room, ${Math.round(expiring.unusedPercent)}% weekly quota about to reset unused`
    : `${Math.round(room)}% room`
  return out(score, reason, room)
}

export interface Placement {
  /** The server to open on; null when none of the candidates can take it. */
  pick: PlacementScore | null
  /** Every candidate, best first. */
  scores: PlacementScore[]
}

/** Scores every candidate and picks the best. Ties keep the candidates' own order, so the caller's default stays the default. */
export function pickPlacement(candidates: readonly PlacementCandidate[], now: number, rule: SpareQuotaRule = DEFAULT_SPARE_QUOTA_RULE): Placement {
  const scores = candidates
    .map((candidate, index) => ({ score: scorePlacement(candidate, now, rule), index }))
    .sort((a, b) => b.score.score - a.score.score || a.index - b.index)
    .map((entry) => entry.score)
  const best = scores[0]
  return { pick: best && best.score > 0 ? best : null, scores }
}
