/**
 * The hubs this server reports to: the ones the enterprise policy names,
 * and the ones an admin of the server added that the policy allows. One
 * HubLink runs per hub. The set is worked out again whenever the policy
 * changes or an admin adds or removes a hub.
 */
import { deriveFleetHubsPolicy, fleetHubAllowed, type FleetHubsList, type FleetHubStatus, type HubAction } from '@ion/shared/fleet-hub'
import type { EnterprisePolicy } from '@ion/shared/types-enterprise'
import type { FleetReport } from '@ion/shared/types-fleet'
import { FLEET_DEPLOY_LOST_MS, type FleetDeployRecord } from '@ion/shared/types-fleet-deploy'
import { HOST_INSTALL_STALE_MS, type HostInstallProgress } from '@ion/shared/host-install'
import { HubLink, type HubActionOutcome } from './hub-link'
import type { AddedHub, FleetHubStore } from './hub-store'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('fleet.hub-links', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('fleet.hub-links', msg, fields)
}

export interface FleetHubLinksDeps {
  store: FleetHubStore
  policy(): EnterprisePolicy | null
  /** Resolves a policy token that is a `secretstore:` reference. */
  resolveSecret(ref: string): string
  environmentId(): string
  label: string
  reportSeconds: number
  buildReport(): Promise<FleetReport>
  runAction(action: HubAction, args: unknown[]): Promise<HubActionOutcome>
  /** Test seam: builds the link for one hub. */
  createLink?: (options: ConstructorParameters<typeof HubLink>[0]) => HubLink
}

interface Wanted {
  url: string
  source: 'policy' | 'added'
  manage: boolean
  enrollmentToken: string
  /** The name to report under; absent means the server's own label. */
  label?: string
}

export type FleetHubAddOutcome = { ok: true } | { ok: false; code: 'not_allowed' | 'policy_hub'; message: string }

export class FleetHubLinks {
  private readonly links = new Map<string, { link: HubLink; wanted: Wanted }>()
  /** Added hubs the policy does not allow: listed, never dialed. */
  private blocked: AddedHub[] = []
  /** Deploys still running, by id, with when each was last heard of: what a hub that connects late is told. */
  private readonly running = new Map<string, { record: FleetDeployRecord; at: number }>()
  /** The newest step of this server's own restart or install. */
  private lastInstall: HostInstallProgress | null = null

  constructor(private readonly deps: FleetHubLinksDeps) {}

  /** Brings the running links in line with the policy and the store. */
  reconcile(): void {
    const policy = deriveFleetHubsPolicy(this.deps.policy())
    const wanted = new Map<string, Wanted>()
    for (const hub of policy.managed) {
      const token = this.deps.resolveSecret(hub.enrollmentToken)
      if (!token) {
        warn('policy hub skipped: its enrollment token could not be resolved', { hub_url: hub.url })
        continue
      }
      wanted.set(hub.url, { url: hub.url, source: 'policy', manage: hub.manage, enrollmentToken: token })
    }
    this.blocked = []
    for (const hub of this.deps.store.added()) {
      // The policy's own entry for a hub wins over one an admin added.
      if (wanted.has(hub.url)) continue
      if (!fleetHubAllowed(policy, hub.url)) {
        this.blocked.push(hub)
        continue
      }
      wanted.set(hub.url, { url: hub.url, source: 'added', manage: hub.manage, enrollmentToken: hub.enrollmentToken, label: hub.label })
    }
    for (const [url, running] of this.links) {
      const next = wanted.get(url)
      if (next && next.manage === running.wanted.manage && next.enrollmentToken === running.wanted.enrollmentToken && next.source === running.wanted.source && next.label === running.wanted.label) continue
      running.link.close()
      this.links.delete(url)
      log('hub link stopped', { hub_url: url, reason: next ? 'changed' : 'no longer wanted' })
    }
    for (const [url, hub] of wanted) {
      if (this.links.has(url)) continue
      const options = {
        url,
        manage: hub.manage,
        enrollmentToken: hub.enrollmentToken,
        environmentId: this.deps.environmentId(),
        label: hub.label ?? this.deps.label,
        reportSeconds: this.deps.reportSeconds,
        credential: () => this.deps.store.credential(url),
        saveCredential: (credential: string) => this.deps.store.setCredential(url, credential),
        clearCredential: () => this.deps.store.clearCredential(url),
        buildReport: this.deps.buildReport,
        runAction: this.deps.runAction,
        standing: () => this.standing(),
      }
      const link = this.deps.createLink ? this.deps.createLink(options) : new HubLink(options)
      this.links.set(url, { link, wanted: hub })
      link.start()
      log('hub link started', { hub_url: url, source: hub.source, manage: hub.manage })
    }
    log('hub links reconciled', { link_count: this.links.size, blocked_count: this.blocked.length, restricted: policy.restricted })
  }

  /** Passes a deploy's newest record to every hub. A deploy still running is kept for a hub that connects later. */
  deploy(record: FleetDeployRecord, now: number = Date.now()): void {
    if (record.state === 'running') this.running.set(record.id, { record, at: now })
    else this.running.delete(record.id)
    let sent = 0
    for (const { link } of this.links.values()) if (link.sendDeploy(record)) sent += 1
    if (record.state !== 'running') log('deploy outcome passed to hubs', { deploy_id: record.id, state: record.state, hub_count: sent })
  }

  /** Passes a step of this server's own restart or install to every hub. */
  install(progress: HostInstallProgress): void {
    this.lastInstall = progress
    let sent = 0
    for (const { link } of this.links.values()) if (link.sendInstall(progress)) sent += 1
    log('host install step passed to hubs', { stage: progress.stage, kind: progress.kind, hub_count: sent })
  }

  /** What still stands now: deploys heard of lately, and an install step that is not old news. */
  private standing(now: number = Date.now()): { deploys: FleetDeployRecord[]; install: HostInstallProgress | null } {
    for (const [id, held] of this.running) if (now - held.at > FLEET_DEPLOY_LOST_MS) this.running.delete(id)
    const install = this.lastInstall && now - this.lastInstall.at <= HOST_INSTALL_STALE_MS ? this.lastInstall : null
    return { deploys: [...this.running.values()].map((held) => held.record), install }
  }

  list(): FleetHubsList {
    const hubs: FleetHubStatus[] = []
    for (const [url, { link, wanted }] of this.links) {
      const status = link.status()
      hubs.push({ url, label: status.hubLabel ?? new URL(url).host, source: wanted.source, manage: wanted.manage, state: status.state, detail: status.detail, lastReportAt: status.lastReportAt })
    }
    for (const hub of this.blocked) {
      hubs.push({ url: hub.url, label: new URL(hub.url).host, source: 'added', manage: hub.manage, state: 'blocked', detail: 'your organization does not allow this hub' })
    }
    return { hubs, restricted: deriveFleetHubsPolicy(this.deps.policy()).restricted }
  }

  /** Waits, up to `timeoutMs`, for the link to a hub to have an answer. */
  async settled(url: string, timeoutMs: number): Promise<void> {
    await this.links.get(url)?.link.settled(timeoutMs)
  }

  add(hub: AddedHub): FleetHubAddOutcome {
    const policy = deriveFleetHubsPolicy(this.deps.policy())
    if (policy.managed.some((m) => m.url === hub.url)) {
      warn('hub add refused: the policy already puts this server on it', { hub_url: hub.url })
      return { ok: false, code: 'policy_hub', message: 'Your organization already has this server on that hub.' }
    }
    if (!fleetHubAllowed(policy, hub.url)) {
      warn('hub add refused: the policy does not allow it', { hub_url: hub.url })
      return { ok: false, code: 'not_allowed', message: 'Your organization does not allow this server to join that hub.' }
    }
    this.deps.store.add(hub)
    this.reconcile()
    return { ok: true }
  }

  /** False when no such hub was added here; a policy hub cannot be removed. */
  remove(url: string): boolean {
    const removed = this.deps.store.remove(url)
    if (removed) this.reconcile()
    return removed
  }

  close(): void {
    for (const { link } of this.links.values()) link.close()
    this.links.clear()
  }
}

let current: FleetHubLinks | null = null

/** The running links, or null before boot started them. */
export function fleetHubLinks(): FleetHubLinks | null {
  return current
}

export function setFleetHubLinks(links: FleetHubLinks | null): void {
  current = links
}
