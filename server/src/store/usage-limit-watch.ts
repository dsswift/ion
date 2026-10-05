/**
 * usage-limit-watch — what the server does by itself about usage limits.
 *
 * Three jobs, all owner-only, none needing a client:
 *
 *  1. When a conversation becomes limited (the backend refused its run), ring
 *     the phone, tell automations, and, when the server is set to resume by
 *     itself, hold the resume prompt until the limit resets.
 *  2. Every minute, send each held prompt whose release is met: the limit has
 *     reset, or the conversation's account has quota about to reset unused.
 *  3. Every minute, ring the phone once per account window that is about to
 *     reset with quota unused.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { StoreApi } from 'zustand'
import type { FleetAccount } from '@ion/shared/types-fleet'
import { fleetAccountKey } from '@ion/shared/types-fleet'
import type { RelayPushMeta } from '@ion/shared/studio-wire/relay-envelope'
import { expiringQuota, hasSpareQuota, usageLimitLabel, usageLimitedUntil, type SpareQuotaRule } from '@ion/shared/usage-limit'
import { isPersistedSettled } from '@ion/shared/tab-predicates'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { dataDir } from '../paths'
import { hostName } from '../host-name'
import { usePreferencesStore } from '../persistence/preferences'
import { ringOfflineThinClients } from '../thin-view/push-doorbell'
import { pushConversationTitle } from '../thin-view/push-title'
import { listAccounts } from '../fleet/account-ledger'
import { triggerUsageAutomation, type UsageAutomationEvent } from '../fleet/usage-automation-trigger'
import * as providerApi from '../engine/provider-api'
import { projectResolvedModels } from './resolved-model-projection'
import { activeInstance } from './conversation-instance'
import { rDebug, rInfo, rWarn } from './rendererLogger'
import type { State } from './session-store-types'

const TAG = 'usage-limit.watch'
export const USAGE_LIMIT_SWEEP_MS = 60_000
/** A limit is read as reset this long after its reset time, so the backend has caught up. */
export const LIMIT_RESET_GRACE_MS = 60_000

export const LIMIT_PUSH_KIND = 'usage_limit_reached'
export const QUOTA_EXPIRING_PUSH_KIND = 'quota_expiring'

type Tab = State['tabs'][number]

export interface UsageLimitSettings {
  autoResume: boolean
  resumePrompt: string
  /** 0 turns the expiring-quota alert and the spare-quota release off. */
  spare: SpareQuotaRule
  expiryAlert: boolean
}

export interface UsageLimitWatchDeps {
  ring: (push: RelayPushMeta) => void
  host: () => string
  title: (tab: Tab) => string | null
  accounts: () => FleetAccount[]
  settings: () => UsageLimitSettings
  /** The provider a conversation's model is served by, or '' when it cannot be told. */
  providerOf: (state: State, tab: Tab) => Promise<string>
  automation: (type: UsageAutomationEvent, payload: Record<string, unknown>) => Promise<void>
  /** Account windows already alerted on, kept across restarts. */
  alerted: { has(key: string): boolean; add(key: string): void }
  now: () => number
  sweepMs: number
}

function alertsFile(): string {
  return join(dataDir(), 'quota-alerts.json')
}

/** One entry per account window that has rung; windows long past are dropped on load. */
function fileBackedAlerts(now: number): UsageLimitWatchDeps['alerted'] {
  const seen = new Map<string, number>()
  const path = alertsFile()
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, number>
      for (const [key, at] of Object.entries(parsed)) if (typeof at === 'number' && now - at < 14 * 86_400_000) seen.set(key, at)
    } catch (err) {
      rWarn(TAG, 'quota alert record unreadable; starting empty', { path, error: String(err) })
    }
  }
  return {
    has: (key) => seen.has(key),
    add: (key) => {
      seen.set(key, Date.now())
      try {
        atomicWriteFileSync(path, JSON.stringify(Object.fromEntries(seen)), 0o600)
      } catch (err) {
        rWarn(TAG, 'quota alert record not saved', { path, error: String(err) })
      }
    },
  }
}

async function providerOfTab(state: State, tab: Tab): Promise<string> {
  const instance = activeInstance(state.conversationPanes, tab.id)
  if (instance?.modelOverrideProviderId) return instance.modelOverrideProviderId
  try {
    const model = instance ? projectResolvedModels([tab], state.conversationPanes)[tab.id]?.[instance.id] : undefined
    const listing = (await providerApi.listModels()) as { models?: Array<{ id: string; providerId: string }> }
    const owner = model ? listing.models?.find((entry) => entry.id === model)?.providerId : undefined
    return owner ?? (await providerApi.getDefaultProvider())
  } catch (err) {
    rWarn(TAG, 'conversation provider not resolved', { tab_id: tab.id.slice(0, 8), error: String(err) })
    return ''
  }
}

function readSettings(): UsageLimitSettings {
  const prefs = usePreferencesStore.getState()
  return {
    autoResume: prefs.usageLimitAutoResume,
    resumePrompt: prefs.usageLimitResumePrompt,
    spare: { withinHours: prefs.quotaExpiryAlertHours, unusedPercent: prefs.quotaExpiryUnusedPercent },
    expiryAlert: prefs.quotaExpiryAlertHours > 0,
  }
}

function defaultDeps(): UsageLimitWatchDeps {
  return {
    ring: ringOfflineThinClients,
    host: () => hostName(),
    title: pushConversationTitle,
    accounts: () => listAccounts(),
    settings: readSettings,
    providerOf: providerOfTab,
    automation: triggerUsageAutomation,
    alerted: fileBackedAlerts(Date.now()),
    now: () => Date.now(),
    sweepMs: USAGE_LIMIT_SWEEP_MS,
  }
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** A conversation at rest can take a prompt; one mid-run or waiting on the person cannot. */
function atRest(tab: Tab): boolean {
  return !tab.isTerminalOnly && !tab.inputLocked && !isPersistedSettled(tab)
    && (tab.status === 'idle' || tab.status === 'completed' || tab.status === 'failed')
}

export interface UsageLimitWatch {
  /** One pass of the minute sweep. Exposed so a test drives it without a timer. */
  sweep(): Promise<void>
  stop(): void
}

export function setupUsageLimitWatch(store: StoreApi<State>, overrides: Partial<UsageLimitWatchDeps> = {}): UsageLimitWatch {
  const deps: UsageLimitWatchDeps = { ...defaultDeps(), ...overrides }

  const onLimited = (tab: Tab): void => {
    const limit = tab.usageLimit
    if (!limit) return
    const settings = deps.settings()
    const title = deps.title(tab)
    const body = `${usageLimitLabel(limit.limitType)} reached on ${deps.host()}. Resets at ${clock(limit.resetsAt)}.`
    deps.ring({ pushTitle: title ?? 'Usage limit reached', pushBody: body, pushTabId: tab.id, notifyKind: LIMIT_PUSH_KIND })
    rInfo(TAG, 'limit push rung', { tab_id: tab.id.slice(0, 8), limit_type: limit.limitType, resets_at: limit.resetsAt, auto_resume: settings.autoResume })
    void deps.automation('usage:limit-reached', { tabId: tab.id, limitType: limit.limitType, resetsAt: limit.resetsAt, worktreePath: tab.worktree?.worktreePath, directory: tab.workingDirectory })
    if (settings.autoResume && !tab.deferredSend && settings.resumePrompt.trim()) {
      store.getState().deferSend(tab.id, settings.resumePrompt, 'limit-reset')
    }
  }

  const unsubscribe = store.subscribe((state, previous) => {
    if (!state.tabsReady || !previous.tabsReady || state.tabs === previous.tabs) return
    const before = new Map(previous.tabs.map((tab) => [tab.id, tab.usageLimit?.hitAt ?? null]))
    for (const tab of state.tabs) {
      if (tab.usageLimit && before.has(tab.id) && before.get(tab.id) !== tab.usageLimit.hitAt) onLimited(tab)
    }
  })

  const sweepLimits = async (state: State, now: number): Promise<void> => {
    for (const tab of state.tabs) {
      const limit = tab.usageLimit
      if (!limit || limit.resetsAt + LIMIT_RESET_GRACE_MS > now) continue
      // The window has reset. A held resume prompt goes out; either way the
      // conversation is no longer limited. Automations hear of the reset once,
      // when the limit is lifted, however many sweeps a held prompt waits.
      const tellAutomations = (): void => {
        void deps.automation('usage:limit-reset', { tabId: tab.id, limitType: limit.limitType, resetsAt: limit.resetsAt, worktreePath: tab.worktree?.worktreePath, directory: tab.workingDirectory })
      }
      if (tab.deferredSend?.release === 'limit-reset') {
        if (!atRest(tab)) {
          rDebug(TAG, 'resume held: the conversation is not at rest', { tab_id: tab.id.slice(0, 8), status: tab.status })
          continue
        }
        if (store.getState().releaseDeferredSend(tab.id)) tellAutomations()
        continue
      }
      store.setState((current) => ({ tabs: current.tabs.map((candidate) => candidate.id === tab.id ? { ...candidate, usageLimit: null } : candidate) }))
      tellAutomations()
      rInfo(TAG, 'limit reset; conversation no longer limited', { tab_id: tab.id.slice(0, 8), limit_type: limit.limitType })
    }
  }

  const sweepSpareQuota = async (state: State, now: number, settings: UsageLimitSettings): Promise<void> => {
    const waiting = state.tabs.filter((tab) => tab.deferredSend?.release === 'spare-quota')
    if (waiting.length === 0 || settings.spare.withinHours <= 0) return
    const signedIn = deps.accounts().filter((account) => account.signedIn)
    for (const tab of waiting) {
      if (!atRest(tab) || usageLimitedUntil(tab, now) !== null) continue
      const provider = await deps.providerOf(state, tab)
      const account = signedIn.find((candidate) => candidate.provider === provider)
      if (!account) {
        rDebug(TAG, 'spare-quota prompt held: no signed-in account for its provider', { tab_id: tab.id.slice(0, 8), provider })
        continue
      }
      if (!hasSpareQuota(account.limits, now, settings.spare)) continue
      rInfo(TAG, 'spare quota found; sending the held prompt', { tab_id: tab.id.slice(0, 8), provider })
      store.getState().releaseDeferredSend(tab.id)
    }
  }

  const sweepExpiring = (now: number, settings: UsageLimitSettings): void => {
    if (!settings.expiryAlert) return
    for (const account of deps.accounts()) {
      if (!account.signedIn) continue
      for (const expiring of expiringQuota(account.limits, now, settings.spare)) {
        const key = `${fleetAccountKey(account)}|${expiring.limit.kind}|${expiring.limit.label ?? ''}|${expiring.resetsAt}`
        if (deps.alerted.has(key)) continue
        deps.alerted.add(key)
        const what = expiring.limit.kind === 'weekly_model' && expiring.limit.label ? `7-day ${expiring.limit.label}` : '7-day'
        const hours = Math.max(1, Math.round((expiring.resetsAt - now) / 3_600_000))
        deps.ring({
          pushTitle: 'Quota about to reset unused',
          pushBody: `${Math.round(expiring.unusedPercent)}% of the ${what} limit on ${deps.host()} resets in ${hours} h.`,
          notifyKind: QUOTA_EXPIRING_PUSH_KIND,
        })
        rInfo(TAG, 'expiring quota push rung', { provider: account.provider, limit_kind: expiring.limit.kind, unused_percent: Math.round(expiring.unusedPercent), resets_at: expiring.resetsAt })
        void deps.automation('usage:quota-expiring', { provider: account.provider, limitKind: expiring.limit.kind, limitLabel: expiring.limit.label ?? '', unusedPercent: Math.round(expiring.unusedPercent), resetsAt: expiring.resetsAt })
      }
    }
  }

  let running = false
  const sweep = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      const state = store.getState()
      if (!state.tabsReady) return
      const now = deps.now()
      const settings = deps.settings()
      await sweepLimits(state, now)
      await sweepSpareQuota(store.getState(), now, settings)
      sweepExpiring(now, settings)
    } catch (err) {
      rWarn(TAG, 'usage limit sweep failed', { error: String(err) })
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => { void sweep() }, deps.sweepMs)
  return {
    sweep,
    stop: () => {
      clearInterval(timer)
      unsubscribe()
    },
  }
}
