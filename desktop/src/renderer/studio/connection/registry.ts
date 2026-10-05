/**
 * registry — the per-environment phase machine (spec 13): connects every
 * non-hidden catalog target at boot, retries stalled targets on a schedule
 * (app start, sign-in change, pushed-list change, every 15 minutes, manual
 * Refresh), detects a duplicate welcomed `environmentId` across two
 * targets, and exposes the live phase map to the union selectors.
 *
 * "Stalled" is every target nothing else is retrying: one classified
 * `hidden` here (an assignment refusal the broker knows nothing about), and
 * one left `offline` that the broker holds no connection for. The broker
 * retries every connection it holds, forever, so an offline environment it
 * knows about needs nothing from this module -- but one it never accepted
 * (the connect request itself failed) would otherwise sit dark until the
 * operator clicked Reconnect.
 *
 * The broker (main process) owns the transport; this module owns WHEN to
 * ask it to connect and HOW to classify the result. `host.connectEnvironment`
 * / `disconnectEnvironment` / `restartEnvironment` are the seam. Two
 * upstream signals feed the classification:
 *   - `host.onConnections`: transport-level phase (connecting/backoff/offline),
 *     keyed by the LOCAL catalog id (what the broker was told to connect to).
 *   - `host.onFrame`'s `studio_welcome`: carries the SERVER's own declared
 *     `environmentId`, which is what duplicate detection compares (spec 13:
 *     "second target whose welcome environmentId equals a connected one").
 */
import { ALL_DEVELOPER_SURFACES_ENABLED } from '@ion/shared/developer-surfaces'
import type { EnvironmentCatalogEntry, EnvironmentPhase, EnvironmentPhaseState, EnvironmentReasonCode, EnvironmentTarget } from '@ion/shared/types-environments'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { deriveDesktopEnvironmentPolicy } from '@ion/shared/enterprise-environment-policy'
import type { ConnectionPhaseSnapshot } from '../../../shared/types-connections'
import { host } from '../../host/host-instance'
import { notifyCatalogChanged, readCatalog } from './catalog'
import { mapBrokerPhase } from './phases'
import { policyStore } from './policy-store'
import { useModelStore } from '@ion/server/store/model-store'
import { rDebug, rInfo, rWarn } from '../../rendererLogger'

const STALLED_RETRY_INTERVAL_MS = 15 * 60_000

type Listener = (states: Map<string, EnvironmentPhaseState>) => void

class Registry {
  private states = new Map<string, EnvironmentPhaseState>()
  /** Local catalog id -> the server-declared environmentId from its last welcome. */
  private welcomedIds = new Map<string, string>()
  private catalogById = new Map<string, EnvironmentCatalogEntry>()
  private listeners = new Set<Listener>()
  private stalledRetryTimer: ReturnType<typeof setInterval> | null = null
  /** Environment ids the broker currently holds a connection for, from its last phase push. Those it holds, it retries itself. */
  private brokerHeld = new Set<string>()
  private unsubscribeConnections: (() => void) | null = null
  private unsubscribeFrame: (() => void) | null = null
  private unsubscribeCatalog: (() => void) | null = null
  private booted = false

  private setPhase(id: string, phase: EnvironmentPhase, reason?: EnvironmentReasonCode, nextAttemptAtMs?: number): void {
    const previous = this.states.get(id)
    const next: EnvironmentPhaseState = {
      phase,
      reason,
      environmentId: previous?.environmentId,
      lastAttemptAtMs: phase === 'connecting' ? Date.now() : previous?.lastAttemptAtMs,
      nextAttemptAtMs,
    }
    this.states.set(id, next)
    rInfo('studio.registry', 'environment phase transition', { environment_id: id, phase, reason })
    policyStore.onPhaseChange(id, phase)
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener(new Map(this.states))
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(new Map(this.states))
    return () => { this.listeners.delete(listener) }
  }

  phaseStates(): Map<string, EnvironmentPhaseState> {
    return new Map(this.states)
  }

  /**
   * Connects one catalog entry. Refuses (marks `blocked`) a
   * non-local target the device's environment policy disallows: `local-only`
   * blocks every non-local target outright, and `allowlist` with `locked`
   * blocks anything outside `allowed[]` — matching spec 14 phase 2's
   * enforcement, applied here too so a managed entry that slips past the
   * catalog write funnel (e.g. one added before the policy locked) never
   * silently connects.
   */
  private async attempt(entry: EnvironmentCatalogEntry): Promise<void> {
    this.catalogById.set(entry.id, entry)
    if (entry.target.kind !== 'local') {
      const policy = deriveDesktopEnvironmentPolicy(policyStore.devicePolicy())
      const blockedByLocalOnly = policy.mode === 'local-only'
      const blockedByAllowlist = policy.mode === 'allowlist' && policy.locked && !policy.allowed.includes(entry.target.url)
      if (blockedByLocalOnly || blockedByAllowlist) {
        this.setPhase(entry.id, 'blocked', 'policy_disallowed')
        rWarn('studio.registry', 'connect refused by environment policy', { environment_id: entry.id, mode: policy.mode })
        return
      }
    }
    this.setPhase(entry.id, 'connecting')
    try {
      const result = await host.connectEnvironment(entry.id, entry.label, entry.target)
      if (!result.ok) {
        rWarn('studio.registry', 'connect request failed', { environment_id: entry.id, error: result.error })
        this.setPhase(entry.id, 'offline', 'server_unreachable')
      }
    } catch (err) {
      rWarn('studio.registry', 'connect request threw', { environment_id: entry.id, error: err instanceof Error ? err.message : String(err) })
      this.setPhase(entry.id, 'offline', 'unknown')
    }
  }

  /** Handles a broker phase push, layering hidden classification on top (duplicate detection lives in onWelcomeFrame). */
  private onConnectionPhase(snapshot: ConnectionPhaseSnapshot[]): void {
    this.brokerHeld = new Set(snapshot.map((item) => item.environmentId))
    for (const item of snapshot) {
      const current = this.states.get(item.environmentId)
      if (current?.phase === 'hidden' || current?.phase === 'blocked') continue
      const mapped = mapBrokerPhase(item.phase)
      if (mapped.reason === 'not_assigned') {
        this.setPhase(item.environmentId, 'hidden', 'not_assigned')
        continue
      }
      this.setPhase(item.environmentId, mapped.phase, mapped.reason)
    }
  }

  /**
   * Checks a welcome's server-declared environmentId against every OTHER
   * catalog id's last-known welcomed id. A match blocks the later-arriving
   * target (spec 13: "second target whose welcome environmentId equals a
   * connected one").
   */
  private onWelcomeFrame(localId: string, serverEnvironmentId: string): void {
    const duplicateOwner = [...this.welcomedIds.entries()].find(([id, envId]) => id !== localId && envId === serverEnvironmentId)
    if (duplicateOwner) {
      this.setPhase(localId, 'blocked', 'duplicate_server_id')
      rWarn('studio.registry', 'duplicate environmentId detected across two targets', { local_id: localId, existing_owner: duplicateOwner[0], server_environment_id: serverEnvironmentId })
      return
    }
    this.welcomedIds.set(localId, serverEnvironmentId)
  }

  /** Retries every stalled target once (see the module doc). Used by all five trigger points (spec 13). */
  retryStalled(): void {
    for (const [id, state] of this.states) {
      const unownedOffline = state.phase === 'offline' && !this.brokerHeld.has(id)
      if (state.phase !== 'hidden' && !unownedOffline) continue
      const entry = this.catalogById.get(id)
      if (!entry) continue
      rDebug('studio.registry', 'retrying stalled environment', { environment_id: id, phase: state.phase, broker_held: this.brokerHeld.has(id) })
      void this.attempt(entry)
    }
  }

  /** Manual Refresh action (Settings diagnostics view). */
  refresh(): void {
    this.retryStalled()
  }

  /**
   * Drops everything the registry knows about one catalog entry and closes
   * its transport: the Remove verb. Without this a forgotten environment
   * kept its phase and welcome id, so re-adding the same server read as a
   * duplicate of a ghost.
   */
  forget(id: string, removed?: EnvironmentTarget): void {
    // `removed` is the catalog entry being removed for good: its stored
    // secret goes with it. Without it the connection is only closed.
    if (removed) host.forgetEnvironment(id, removed)
    else host.disconnectEnvironment(id)
    this.states.delete(id)
    this.welcomedIds.delete(id)
    this.catalogById.delete(id)
    rInfo('studio.registry', 'environment forgotten', { environment_id: id })
    this.notify()
  }

  /** Connects every non-hidden catalog entry (boot, or after a catalog change). */
  async connectAll(): Promise<void> {
    const catalog = await readCatalog()
    for (const entry of catalog) {
      if (entry.id === LOCAL_ENVIRONMENT_ID || this.states.get(entry.id)?.phase !== 'hidden') {
        void this.attempt(entry)
      }
    }
  }

  /**
   * Brings the registry in line with a catalog another process changed:
   * an environment no longer in it is forgotten, and every entry in it
   * connects.
   */
  async followCatalog(): Promise<void> {
    const ids = new Set((await readCatalog()).map((entry) => entry.id))
    for (const id of [...this.states.keys()]) {
      if (id !== LOCAL_ENVIRONMENT_ID && !ids.has(id)) this.forget(id)
    }
    await this.connectAll()
  }

  /** Boots the registry once: wires the broker phase push and welcome-frame duplicate check, connects everything, arms the hidden-retry interval. */
  boot(): void {
    if (this.booted) return
    this.booted = true
    this.unsubscribeConnections = host.onConnections((snapshot) => this.onConnectionPhase(snapshot))
    this.unsubscribeFrame = host.onFrame((localId, frame) => {
      if (frame.type === 'studio_welcome') {
        this.onWelcomeFrame(localId, frame.environmentId)
        policyStore.set(localId, frame.enterprisePolicy)
        policyStore.setHiddenGroups(localId, frame.settingsHiddenGroups)
        policyStore.setDeveloperSurfaces(localId, frame.developerSurfaces ?? ALL_DEVELOPER_SURFACES_ENABLED)
        useModelStore.getState().setEnvironmentOnHost(localId, frame.onHost === true)
      } else if (frame.type === 'studio_environment_policy') {
        policyStore.set(localId, frame.enterprisePolicy)
        policyStore.setHiddenGroups(localId, frame.settingsHiddenGroups)
        policyStore.setDeveloperSurfaces(localId, frame.developerSurfaces ?? ALL_DEVELOPER_SURFACES_ENABLED)
      }
    })
    // `ion fleet` edits the same catalog: a server it added connects, and
    // every list of servers re-reads.
    this.unsubscribeCatalog = host.onCatalogChangedOnDisk(() => {
      rInfo('studio.registry', 'catalog changed on disk; re-reading')
      void this.followCatalog().then(notifyCatalogChanged)
    })
    void this.connectAll()
    this.stalledRetryTimer = setInterval(() => this.retryStalled(), STALLED_RETRY_INTERVAL_MS)
    rInfo('studio.registry', 'registry booted')
  }

  /** Test-only teardown. */
  dispose(): void {
    this.unsubscribeConnections?.()
    this.unsubscribeConnections = null
    this.unsubscribeFrame?.()
    this.unsubscribeFrame = null
    this.unsubscribeCatalog?.()
    this.unsubscribeCatalog = null
    if (this.stalledRetryTimer) clearInterval(this.stalledRetryTimer)
    this.stalledRetryTimer = null
    this.states.clear()
    this.welcomedIds.clear()
    this.catalogById.clear()
    this.brokerHeld.clear()
    this.listeners.clear()
    this.booted = false
  }
}

export const registry = new Registry()

/** Call on work sign-in change or a pushed managed-list change (spec 13 retry triggers). */
export function retryOnSignInChange(): void {
  registry.retryStalled()
}

export function retryOnPolicyChange(): void {
  registry.retryStalled()
}
