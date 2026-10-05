/**
 * account-poll — keeps the Provider Account Ledger current.
 *
 * The engine reports which account each provider CLI is signed in to and
 * its usage limits (`provider_account_usage`). This asks on a period, and
 * again whenever the engine says provider sign-in state changed, so a
 * sign-in or sign-out lands at once. The engine's in-run usage reports
 * (`engine_rate_limit`) update the signed-in account between polls.
 *
 * The poll is not gated on anyone watching: the ledger's job is to remember
 * an account that was signed in while no client was connected.
 */
import type { EngineEvent } from '@ion/shared/types-engine-event'
import type { ProviderAccountUsage } from '@ion/shared/types-models'
import type { FleetAccount } from '@ion/shared/types-fleet'
import { engineBridge } from '../state'
import { currentServerConfig } from '../config/current'
import { applyRateLimitReport, listAccounts, recordAccountPoll } from './account-ledger'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('fleet.accounts', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('fleet.accounts', msg, fields)
}

/** The backend whose in-run usage reports `engine_rate_limit` carries. */
const RATE_LIMIT_BACKEND = 'claude-code'

let timer: ReturnType<typeof setInterval> | null = null
let inFlight: Promise<FleetAccount[]> | null = null
let wired = false

async function pollOnce(): Promise<FleetAccount[]> {
  const result = await engineBridge.request<{ accounts?: ProviderAccountUsage[] }>('provider_account_usage')
  if (!result.ok || !result.data?.accounts) {
    // A failed read says nothing about who is signed in; the ledger stands.
    warn('account usage read failed; ledger unchanged', { error: result.error ?? 'no accounts in the answer' })
    return listAccounts()
  }
  return recordAccountPoll(result.data.accounts)
}

/**
 * Reads the engine now and returns the ledger. Calls made while a read is
 * running share it: each read spawns the provider CLIs.
 */
export function pollAccountsNow(): Promise<FleetAccount[]> {
  if (inFlight) {
    log('account poll joined the read already running')
    return inFlight
  }
  inFlight = pollOnce()
    .catch((err: unknown) => {
      warn('account poll failed', { error: String(err) })
      return listAccounts()
    })
    .finally(() => { inFlight = null })
  return inFlight
}

export function startAccountPoll(): void {
  stopAccountPoll()
  if (!wired) {
    wired = true
    engineBridge.on('event', (_key: string, event: EngineEvent) => {
      if (event.type === 'engine_providers_updated') void pollAccountsNow()
      else if (event.type === 'engine_rate_limit' && event.rateLimit) applyRateLimitReport(RATE_LIMIT_BACKEND, event.rateLimit)
    })
  }
  const periodMs = currentServerConfig().fleet.accountPollSeconds * 1000
  timer = setInterval(() => { void pollAccountsNow() }, periodMs)
  void pollAccountsNow()
  log('account poll started', { period_ms: periodMs })
}

export function stopAccountPoll(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
  log('account poll stopped')
}
