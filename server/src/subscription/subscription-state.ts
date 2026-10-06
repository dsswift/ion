/**
 * Per-person Provider Subscription state: resolving, applied, selection
 * required, none, or failed, in the same vocabulary the engine's own lookup
 * uses (`ProviderSubscriptionStatus`), so the web client's prompt and Settings
 * control read it unchanged.
 *
 * One `SubscriptionStates` holds every signed-in person's state, keyed by
 * subject. A person's key never serves another: `keyFor(subject)` answers
 * only from that person's own entry.
 *
 * Behavior mirrors the engine's table in `docs/configuration/subscription-lookup.md`:
 *
 *   - A cached key within `cacheMaxAgeSeconds` is applied with no lookup.
 *     Zero means a cached key is reused until a lookup is requested.
 *   - No cached key: look up. One subscription applies silently (unless
 *     `requireSelection`); several apply the remembered choice or ask; none
 *     is the `none` state; a failure keeps a key already applied and
 *     otherwise applies nothing.
 */
import type { ProviderSubscriptionStatus, SubscriptionOption } from '@ion/shared/types-engine-event'
import type { ServerSubscriptionLookupConfig } from '../config/subscription-lookup-config'
import { LookupFailure, type Subscription } from './lookup-client'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('subscription-state', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('subscription-state', msg, fields)
}

/** What is remembered per person across restarts. Held encrypted, never logged. */
export interface CachedSubscription {
  selectedId: string
  label: string
  key: string
  options: SubscriptionOption[]
  resolvedAt: number
}

/** Where a person's remembered choice lives. */
export interface SubscriptionCache {
  load(subject: string, provider: string): CachedSubscription | null
  save(subject: string, provider: string, entry: CachedSubscription): void
  clear(subject: string, provider: string): void
}

/** How a person's access token for the lookup is obtained. Null when this server holds none for them. */
export type TokenProvider = (subject: string) => Promise<{ ok: true; accessToken: string } | { ok: false; reason: string }>

export type LookupFn = (config: ServerSubscriptionLookupConfig, accessToken: string) => Promise<Subscription[]>

export interface SubscriptionStatesDeps {
  config: () => ServerSubscriptionLookupConfig | null
  tokens: TokenProvider
  lookup: LookupFn
  cache: SubscriptionCache
  /** Told each time one person's snapshot changes. */
  onChange: (subject: string, status: ProviderSubscriptionStatus) => void
  now?: () => number
  /** Display name the snapshots carry for the provider; absent leaves it off. */
  providerDisplayName?: () => string | undefined
}

interface PersonState {
  status: ProviderSubscriptionStatus
  /** The applied key. Never leaves this module except through keyFor. */
  key: string | null
  /** The subscription id to prefer when a lookup returns several. */
  remembered: string
  /** The last lookup's full response, keys included, so a choice needs no second lookup. */
  results: Subscription[]
  /** A lookup in flight, so concurrent callers share one. */
  inFlight: Promise<ProviderSubscriptionStatus> | null
  /** Bumped on every reset so a slow lookup cannot overwrite a newer one. */
  generation: number
}

const DISABLED: ProviderSubscriptionStatus = { state: 'disabled' }

export class SubscriptionStates {
  private readonly people = new Map<string, PersonState>()
  private readonly now: () => number

  constructor(private readonly deps: SubscriptionStatesDeps) {
    this.now = deps.now ?? Date.now
  }

  /** True when a lookup is configured. Without one this module answers nothing. */
  enabled(): boolean {
    return this.deps.config() !== null
  }

  /** The provider the lookup serves, lowercase, or null when none is configured. */
  provider(): string | null {
    return this.deps.config()?.provider ?? null
  }

  /** One person's current snapshot. `disabled` when no lookup is configured. */
  status(subject: string): ProviderSubscriptionStatus {
    const config = this.deps.config()
    if (!config) return DISABLED
    const person = this.people.get(subject)
    return this.stamp(config, person ? person.status : { state: 'awaiting_identity', provider: config.provider })
  }

  /** The applied key for `subject` and `provider`, or null. Another person's key is never returned. */
  keyFor(subject: string, provider: string): string | null {
    const config = this.deps.config()
    if (!config || provider.toLowerCase() !== config.provider) return null
    return this.people.get(subject)?.key ?? null
  }

  /** The header the key is sent under, or '' for the provider's default. */
  header(): string {
    return this.deps.config()?.header ?? ''
  }

  /**
   * A person signed in or opened an instance. Applies a cached key, or looks
   * up when there is none. Safe to call on every connection: a person already
   * resolved is left alone.
   */
  async ensure(subject: string): Promise<ProviderSubscriptionStatus> {
    const config = this.deps.config()
    if (!config) return DISABLED
    const existing = this.people.get(subject)
    if (existing) {
      if (existing.inFlight) return existing.inFlight
      if (existing.status.state !== 'awaiting_identity' && existing.status.state !== 'failed') {
        log('person already resolved; nothing to do', { subject, state: existing.status.state })
        return this.status(subject)
      }
    }
    const person = this.reset(subject, config)
    const cached = this.deps.cache.load(subject, config.provider)
    if (cached && cached.key && cached.selectedId) {
      person.remembered = cached.selectedId
      person.key = cached.key
      const expired = this.expired(config, cached.resolvedAt)
      this.set(subject, config, {
        state: 'applied',
        provider: config.provider,
        selected: { id: cached.selectedId, label: cached.label },
        options: cached.options,
        source: 'cache',
        resolvedAt: cached.resolvedAt,
      })
      log('cached subscription applied', { subject, subscription_id: cached.selectedId, expired })
      if (!expired) return this.status(subject)
      return this.startLookup(subject, config, person, 'cache_expired')
    }
    log('no cached subscription; looking up', { subject })
    return this.startLookup(subject, config, person, 'no_cache')
  }

  /** Looks up again now, for a person who asked. */
  async refresh(subject: string): Promise<ProviderSubscriptionStatus> {
    const config = this.deps.config()
    if (!config) return DISABLED
    const person = this.people.get(subject) ?? this.reset(subject, config)
    if (person.inFlight) return person.inFlight
    return this.startLookup(subject, config, person, 'refresh')
  }

  /** Applies one offered subscription for `subject` and remembers it. */
  async select(subject: string, subscriptionId: string): Promise<{ ok: boolean; error?: string; status: ProviderSubscriptionStatus }> {
    const config = this.deps.config()
    if (!config) return { ok: false, error: 'no subscription lookup is configured', status: DISABLED }
    const person = this.people.get(subject)
    const chosen = person?.results.find((s) => s.id === subscriptionId)
    if (!person || !chosen) {
      warn('select refused: not an offered subscription', { subject, subscription_id: subscriptionId })
      return { ok: false, error: 'that subscription was not offered; look up again', status: this.status(subject) }
    }
    person.remembered = chosen.id
    person.key = chosen.key
    this.persist(subject, config, person, chosen)
    this.set(subject, config, {
      state: 'applied',
      provider: config.provider,
      selected: { id: chosen.id, label: chosen.label },
      options: person.results.map(optionOf),
      source: 'lookup',
      resolvedAt: this.now(),
    })
    log('subscription selected', { subject, subscription_id: chosen.id })
    return { ok: true, status: this.status(subject) }
  }

  /** A person signed out or their session ended: drop the applied key. The remembered choice stays on disk for their next sign-in. */
  forget(subject: string): void {
    if (this.people.delete(subject)) log('person forgotten; applied key removed', { subject })
  }

  // --- internals ---

  private reset(subject: string, config: ServerSubscriptionLookupConfig): PersonState {
    const previous = this.people.get(subject)
    const person: PersonState = {
      status: { state: 'resolving', provider: config.provider },
      key: null,
      remembered: '',
      results: [],
      inFlight: null,
      generation: (previous?.generation ?? 0) + 1,
    }
    this.people.set(subject, person)
    return person
  }

  private startLookup(subject: string, config: ServerSubscriptionLookupConfig, person: PersonState, reason: string): Promise<ProviderSubscriptionStatus> {
    const generation = person.generation
    // A key already applied stays in use while a lookup runs; only a person with none shows `resolving`.
    if (!person.key) this.set(subject, config, { state: 'resolving', provider: config.provider })
    const run = this.runLookup(subject, config, person, generation, reason).finally(() => {
      if (person.generation === generation) person.inFlight = null
    })
    person.inFlight = run
    return run
  }

  private async runLookup(subject: string, config: ServerSubscriptionLookupConfig, person: PersonState, generation: number, reason: string): Promise<ProviderSubscriptionStatus> {
    const token = await this.deps.tokens(subject)
    if (person.generation !== generation) return this.status(subject)
    if (!token.ok) {
      warn('no token for the lookup', { subject, reason: token.reason })
      return this.settleFailure(subject, config, person, `Could not look up your subscription: ${token.reason}.`)
    }
    let results: Subscription[]
    try {
      results = await this.deps.lookup(config, token.accessToken)
    } catch (err) {
      const message = err instanceof LookupFailure ? err.reason : 'the lookup failed'
      warn('subscription lookup failed', { subject, reason, error: message })
      if (person.generation !== generation) return this.status(subject)
      return this.settleFailure(subject, config, person, `Could not look up your subscription: ${message}.`)
    }
    if (person.generation !== generation) return this.status(subject)
    return this.settleResults(subject, config, person, results)
  }

  private settleFailure(subject: string, config: ServerSubscriptionLookupConfig, person: PersonState, message: string): ProviderSubscriptionStatus {
    if (person.key) {
      // A cached key stays in use; the failure rides along on the applied snapshot.
      this.set(subject, config, { ...person.status, error: message })
    } else {
      this.set(subject, config, { state: 'failed', provider: config.provider, error: message })
    }
    return this.status(subject)
  }

  private settleResults(subject: string, config: ServerSubscriptionLookupConfig, person: PersonState, results: Subscription[]): ProviderSubscriptionStatus {
    person.results = results
    const options = results.map(optionOf)
    if (results.length === 0) {
      person.key = null
      this.deps.cache.clear(subject, config.provider)
      this.set(subject, config, { state: 'none', provider: config.provider, options: [], resolvedAt: this.now() })
      log('lookup returned no subscription', { subject })
      return this.status(subject)
    }
    const remembered = results.find((s) => s.id === person.remembered)
    const only = results.length === 1 && !config.requireSelection ? results[0] : undefined
    const chosen = remembered ?? only
    if (!chosen) {
      person.key = null
      this.set(subject, config, { state: 'selection_required', provider: config.provider, options, resolvedAt: this.now() })
      log('lookup needs a choice', { subject, count: results.length })
      return this.status(subject)
    }
    person.remembered = chosen.id
    person.key = chosen.key
    this.persist(subject, config, person, chosen)
    this.set(subject, config, {
      state: 'applied',
      provider: config.provider,
      selected: { id: chosen.id, label: chosen.label },
      options,
      source: 'lookup',
      resolvedAt: this.now(),
    })
    log('subscription applied from lookup', { subject, subscription_id: chosen.id, count: results.length })
    return this.status(subject)
  }

  private persist(subject: string, config: ServerSubscriptionLookupConfig, person: PersonState, chosen: Subscription): void {
    try {
      this.deps.cache.save(subject, config.provider, {
        selectedId: chosen.id,
        label: chosen.label,
        key: chosen.key,
        options: person.results.map(optionOf),
        resolvedAt: this.now(),
      })
    } catch (err) {
      // A cache that cannot be written costs the next sign-in a lookup, nothing more.
      warn('subscription cache write failed', { subject, error: String(err) })
    }
  }

  private expired(config: ServerSubscriptionLookupConfig, resolvedAt: number): boolean {
    if (config.cacheMaxAgeSeconds <= 0) return false
    return this.now() - resolvedAt >= config.cacheMaxAgeSeconds * 1000
  }

  private set(subject: string, config: ServerSubscriptionLookupConfig, status: ProviderSubscriptionStatus): void {
    const person = this.people.get(subject)
    if (!person) return
    person.status = status
    log('subscription state changed', { subject, state: status.state, source: status.source ?? '', count: status.options?.length ?? 0 })
    this.deps.onChange(subject, this.stamp(config, status))
  }

  private stamp(config: ServerSubscriptionLookupConfig, status: ProviderSubscriptionStatus): ProviderSubscriptionStatus {
    const name = this.deps.providerDisplayName?.()
    return { ...status, provider: config.provider, ...(name ? { providerDisplayName: name } : {}) }
  }
}

function optionOf(s: Subscription): SubscriptionOption {
  return { id: s.id, label: s.label }
}
