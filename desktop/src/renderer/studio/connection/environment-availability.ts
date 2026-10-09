/**
 * environment-availability — whether this desktop is actually talking to
 * each Environment right now, and what the union store is allowed to show
 * as a result.
 *
 * The registry's phases describe the TRANSPORT (connecting, backoff,
 * offline, hidden, blocked). This module turns that into the only
 * distinction the UI needs:
 *
 *   connected     the wire is welcomed; rows are live and interactive.
 *   reconnecting  the wire dropped a moment ago. Rows stay, dimmed, and
 *                 every input is refused. A blip -- a roaming laptop, a
 *                 server restart, a relay hiccup -- is over inside this
 *                 window, and clearing the Inbox for one second of it
 *                 would be its own kind of lie.
 *   offline       the wire stayed down past the grace window. The
 *                 Environment's rows are dropped from the store entirely
 *                 (`secondary-store-purge.ts`).
 *
 * The grace window is not a freshness heuristic: nothing stale is ever
 * presented as live. Through the whole window the rows are visibly degraded
 * and cannot be acted on, so the only thing it buys is that a brief drop
 * does not reshuffle the operator's window.
 */
import { useEffect, useState } from 'react'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import type { EnvironmentCatalogEntry, EnvironmentPhaseState, EnvironmentReasonCode } from '@ion/shared/types-environments'
import { registry } from './registry'
import { readCatalog } from './catalog'
import { dropEnvironmentState } from '../state/secondary-store-purge'
import { rInfo, rWarn } from '../../rendererLogger'

export type EnvironmentAvailability = 'connected' | 'reconnecting' | 'offline'

/** How long a dropped wire keeps its rows on screen (dimmed, inert) before they are dropped. */
export const RECONNECT_GRACE_MS = 5_000

export interface EnvironmentAvailabilityEntry {
  environmentId: string
  label: string
  availability: EnvironmentAvailability
  /** When the wire left `connected`, for "offline for 4m". Null while connected. */
  since: number | null
  /** Why the wire is down, once an attempt has said. Absent while connected. */
  reason?: EnvironmentReasonCode
}

type Listener = (entries: Map<string, EnvironmentAvailabilityEntry>) => void

class EnvironmentAvailabilityStore {
  private entries = new Map<string, EnvironmentAvailabilityEntry>()
  private graceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private labels = new Map<string, string>()
  private listeners = new Set<Listener>()
  private unsubscribe: (() => void) | null = null
  private booted = false

  boot(): void {
    if (this.booted) return
    this.booted = true
    void readCatalog()
      .then((catalog) => this.rememberLabels(catalog))
      .catch((err: unknown) => rWarn('studio.availability', 'catalog read failed; environments will be labelled by id', { error: String(err) }))
    this.unsubscribe = registry.subscribe((states) => this.apply(states))
    rInfo('studio.availability', 'availability store booted', { grace_ms: RECONNECT_GRACE_MS })
  }

  private rememberLabels(catalog: readonly EnvironmentCatalogEntry[]): void {
    for (const entry of catalog) this.labels.set(entry.id, entry.label)
    if (this.entries.size > 0) this.notify()
  }

  private labelOf(environmentId: string): string {
    return this.labels.get(environmentId) ?? environmentId
  }

  private apply(states: Map<string, EnvironmentPhaseState>): void {
    let changed = false
    for (const [environmentId, state] of states) {
      changed = this.applyOne(environmentId, state.phase === 'connected', state.reason) || changed
    }
    if (changed) this.notify()
  }

  /**
   * Returns whether this Environment's entry changed. `reason` is the latest
   * attempt's; a phase that carries none (a retry starting) keeps the last one.
   */
  private applyOne(environmentId: string, connected: boolean, reason: EnvironmentReasonCode | undefined): boolean {
    const previous = this.entries.get(environmentId)
    if (connected) {
      this.disarm(environmentId)
      if (previous?.availability === 'connected') return false
      this.entries.set(environmentId, { environmentId, label: this.labelOf(environmentId), availability: 'connected', since: null })
      rInfo('studio.availability', 'environment is live again', { environment_id: environmentId, was: previous?.availability ?? 'unknown' })
      return true
    }
    // Never connected in this session: there is nothing on screen from it
    // and nothing to take away, so it is offline from the start.
    if (previous === undefined) {
      this.entries.set(environmentId, { environmentId, label: this.labelOf(environmentId), availability: 'offline', since: Date.now(), reason })
      return true
    }
    if (previous.availability !== 'connected') {
      if (reason === undefined || reason === previous.reason) return false
      this.entries.set(environmentId, { ...previous, reason })
      rInfo('studio.availability', 'environment is down for a new reason', { environment_id: environmentId, reason, was: previous.reason })
      return true
    }
    this.entries.set(environmentId, { environmentId, label: this.labelOf(environmentId), availability: 'reconnecting', since: Date.now(), reason })
    rInfo('studio.availability', 'environment wire dropped; rows are inert for the grace window', { environment_id: environmentId, grace_ms: RECONNECT_GRACE_MS })
    const timer = setTimeout(() => this.expire(environmentId), RECONNECT_GRACE_MS)
    timer.unref?.()
    this.graceTimers.set(environmentId, timer)
    return true
  }

  /** The grace window closed with the wire still down: the Environment's rows go. */
  private expire(environmentId: string): void {
    this.graceTimers.delete(environmentId)
    const previous = this.entries.get(environmentId)
    if (previous?.availability !== 'reconnecting') return
    this.entries.set(environmentId, { ...previous, availability: 'offline' })
    rInfo('studio.availability', 'environment stayed down past the grace window; dropping its state', { environment_id: environmentId })
    if (environmentId !== LOCAL_ENVIRONMENT_ID) dropEnvironmentState(environmentId)
    this.notify()
  }

  private disarm(environmentId: string): void {
    const timer = this.graceTimers.get(environmentId)
    if (!timer) return
    clearTimeout(timer)
    this.graceTimers.delete(environmentId)
  }

  private notify(): void {
    const snapshot = new Map(this.entries)
    for (const listener of this.listeners) listener(snapshot)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(new Map(this.entries))
    return () => { this.listeners.delete(listener) }
  }

  availabilityOf(environmentId: string): EnvironmentAvailability {
    return this.entries.get(environmentId)?.availability ?? 'connected'
  }

  all(): Map<string, EnvironmentAvailabilityEntry> {
    return new Map(this.entries)
  }

  /** TEST ONLY. */
  dispose(): void {
    for (const timer of this.graceTimers.values()) clearTimeout(timer)
    this.graceTimers.clear()
    this.unsubscribe?.()
    this.unsubscribe = null
    this.entries.clear()
    this.labels.clear()
    this.listeners.clear()
    this.booted = false
  }
}

export const environmentAvailability = new EnvironmentAvailabilityStore()

/** React: every Environment's availability, re-rendering on each transition. */
export function useEnvironmentAvailabilityMap(): Map<string, EnvironmentAvailabilityEntry> {
  const [entries, setEntries] = useState<Map<string, EnvironmentAvailabilityEntry>>(() => environmentAvailability.all())
  useEffect(() => environmentAvailability.subscribe(setEntries), [])
  return entries
}

/** React: one Environment's availability. An Environment nothing has reported on is treated as live. */
export function useEnvironmentAvailability(environmentId: string): EnvironmentAvailability {
  return useEnvironmentAvailabilityMap().get(environmentId)?.availability ?? 'connected'
}

/** React: every Environment that is not live right now, for the title bar indicator. */
export function useDegradedEnvironments(): EnvironmentAvailabilityEntry[] {
  const entries = useEnvironmentAvailabilityMap()
  return [...entries.values()]
    .filter((entry) => entry.availability !== 'connected')
    .sort((a, b) => (a.since ?? 0) - (b.since ?? 0))
}
