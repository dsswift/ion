/**
 * Fleet Deploy Record: one deploy as it runs. `ion fleet deploy` keeps the
 * record and tells the server on its own machine at every step. That server
 * holds the newest few, publishes them to Studio, and passes each one to the
 * Fleet Hubs it reports to, so a deploy is watched from the device that
 * started it and from the hub alike.
 */

export type FleetDeployState = 'running' | 'done' | 'failed' | 'cancelled'

/** The stages `ion fleet deploy` moves a host through that end it. Any other stage is a host still under way. */
export const FLEET_DEPLOY_STAGE_DONE = 'done'
export const FLEET_DEPLOY_STAGE_FAILED = 'failed'

/** One host of a deploy. */
export interface FleetDeployTarget {
  /** The host's fleet name. */
  host: string
  /** The host's own stable id, when the deploying device knows it. */
  environmentId?: string
  label: string
  /** `server` or `desktop`. */
  component?: string
  /** `goos/goarch`, when known. */
  platform?: string
  /** `queued`, `building`, `deploying`, `waiting for the terminal`, `verifying`, `done`, or `failed`. */
  stage: string
  /** The stage's one-line explanation; the version installed, for `done`. */
  detail?: string
  /** Unix ms. */
  updatedAt: number
  /** Why a failed host failed. */
  error?: string
}

/** A deploy as `ion fleet deploy` reports it. */
export interface FleetDeployRecord {
  id: string
  /** What is deployed, for a person: `build of ion`, `release 1.2.3`. */
  source: string
  /** Unix ms. */
  startedAt: number
  updatedAt: number
  endedAt?: number
  state: FleetDeployState
  targets: FleetDeployTarget[]
}

/** A deploy as a server or a hub holds it. */
export interface FleetDeploy extends FleetDeployRecord {
  /** Unix ms this holder last heard of the deploy, by its own clock. */
  receivedAt: number
  /** The server that passed the record on: the deploying device's own. Set by a hub. */
  reportedBy?: { id: string; label: string }
}

/** Every deploy a server holds, newest first, published whenever one changes. */
export const FLEET_DEPLOYS_CHANNEL = 'ion:fleet-deploys'

/** `ion fleet deploy` sends its record at least this often while it runs. */
export const FLEET_DEPLOY_BEAT_MS = 30_000
/** A running deploy not heard of for this long has lost the process that ran it. */
export const FLEET_DEPLOY_LOST_MS = 4 * FLEET_DEPLOY_BEAT_MS
/** How many deploys a server or a hub keeps. */
export const FLEET_DEPLOYS_KEPT = 10

const MAX_TARGETS = 200
const MAX_TEXT = 2_000

function text(value: unknown, max = MAX_TEXT): string | undefined {
  return typeof value === 'string' && value !== '' ? value.slice(0, max) : undefined
}

function time(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function isState(value: unknown): value is FleetDeployState {
  return value === 'running' || value === 'done' || value === 'failed' || value === 'cancelled'
}

/** Reads a deploy record from an untrusted sender, keeping only what the type names. Null when it is not one. */
export function parseFleetDeployRecord(raw: unknown): FleetDeployRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const id = text(r.id, 128)
  const startedAt = time(r.startedAt)
  const updatedAt = time(r.updatedAt)
  if (!id || startedAt === undefined || updatedAt === undefined || !isState(r.state) || !Array.isArray(r.targets)) return null
  const targets: FleetDeployTarget[] = []
  for (const entry of r.targets.slice(0, MAX_TARGETS)) {
    if (!entry || typeof entry !== 'object') return null
    const t = entry as Record<string, unknown>
    const host = text(t.host, 256)
    const stage = text(t.stage, 64)
    if (!host || !stage) return null
    targets.push({
      host,
      label: text(t.label, 256) ?? host,
      stage,
      updatedAt: time(t.updatedAt) ?? updatedAt,
      ...(text(t.environmentId, 128) ? { environmentId: text(t.environmentId, 128) } : {}),
      ...(text(t.component, 32) ? { component: text(t.component, 32) } : {}),
      ...(text(t.platform, 64) ? { platform: text(t.platform, 64) } : {}),
      ...(text(t.detail) ? { detail: text(t.detail) } : {}),
      ...(text(t.error) ? { error: text(t.error) } : {}),
    })
  }
  const endedAt = time(r.endedAt)
  return { id, source: text(r.source, 256) ?? 'deploy', startedAt, updatedAt, state: r.state, targets, ...(endedAt ? { endedAt } : {}) }
}

/** Whether a deploy still marked running has stopped being heard of. */
export function fleetDeployLost(deploy: Pick<FleetDeploy, 'state' | 'receivedAt'>, now: number): boolean {
  return deploy.state === 'running' && now - deploy.receivedAt > FLEET_DEPLOY_LOST_MS
}

/** How a host of a deploy stands. */
export type FleetDeployTargetStanding = 'waiting' | 'working' | 'done' | 'failed'

export function fleetDeployTargetStanding(target: Pick<FleetDeployTarget, 'stage'>): FleetDeployTargetStanding {
  if (target.stage === FLEET_DEPLOY_STAGE_DONE) return 'done'
  if (target.stage === FLEET_DEPLOY_STAGE_FAILED) return 'failed'
  return target.stage === 'queued' || target.stage.startsWith('waiting') ? 'waiting' : 'working'
}

/** How many hosts of a deploy are done, failed, and in all. */
export function fleetDeployCounts(deploy: Pick<FleetDeployRecord, 'targets'>): { done: number; failed: number; total: number } {
  let done = 0
  let failed = 0
  for (const target of deploy.targets) {
    const standing = fleetDeployTargetStanding(target)
    if (standing === 'done') done += 1
    else if (standing === 'failed') failed += 1
  }
  return { done, failed, total: deploy.targets.length }
}

/**
 * Keeps the newest deploys: `incoming` replaces the one with its id, or is
 * added, and the list is cut to `FLEET_DEPLOYS_KEPT`, newest start first. A
 * record older than the one already held for its id is dropped.
 */
export function mergeFleetDeploy(held: readonly FleetDeploy[], incoming: FleetDeploy): FleetDeploy[] {
  const current = held.find((d) => d.id === incoming.id)
  if (current && current.updatedAt > incoming.updatedAt) return [...held]
  return [incoming, ...held.filter((d) => d.id !== incoming.id)].sort((a, b) => b.startedAt - a.startedAt).slice(0, FLEET_DEPLOYS_KEPT)
}
