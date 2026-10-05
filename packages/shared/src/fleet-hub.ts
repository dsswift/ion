/**
 * Fleet Hub: an always-on service a server reports to, so a whole Fleet can
 * be watched and managed from one page with no device paired to anything.
 * A server dials out to each hub it is enrolled with, sends its Fleet Report
 * on a timer, and runs the short list of actions a hub may ask for.
 *
 * This file is the contract between the two: the frames on the socket, what
 * the hub's own API returns to its portal, and the enterprise rule that
 * says which hubs a server may join.
 */
import type { HostInstallProgress } from './host-install'
import type { EnterprisePolicy, IonServerPolicyFields } from './types-enterprise'
import type { FleetReport } from './types-fleet'
import type { FleetDeploy, FleetDeployRecord } from './types-fleet-deploy'

export const HUB_PROTOCOL_VERSION = 1
/** Where a server's socket connects on a hub. */
export const HUB_AGENT_PATH = '/v1/agent'

/** The actions a hub may ask a server to run. Nothing outside this list is ever run for a hub. */
export const HUB_ACTIONS = ['fleet.refreshAccounts', 'environment.server.restart', 'environment.server.update'] as const
export type HubAction = (typeof HUB_ACTIONS)[number]

export function isHubAction(name: unknown): name is HubAction {
  return typeof name === 'string' && (HUB_ACTIONS as readonly string[]).includes(name)
}

/** Why a hub turned a server away. */
export type HubRefusal =
  /** No enrollment token, or one the hub does not accept. */
  | 'bad_enrollment_token'
  /** The server's own credential does not match the one the hub issued it. */
  | 'bad_credential'
  /** The hub removed this server; it must be enrolled again. */
  | 'removed'
  | 'protocol_mismatch'
  | 'malformed'

/** What a server sends a hub. */
export type HubAgentFrame =
  | {
      type: 'hub_hello'
      protocol: number
      /** The server's own stable id. */
      environmentId: string
      label: string
      /** Whether this server runs a hub's actions, or only reports. */
      manage: boolean
      /** First contact: the hub's enrollment token. */
      enrollmentToken?: string
      /** Every later contact: the credential the hub issued this server. */
      credential?: string
    }
  | { type: 'hub_report'; report: FleetReport }
  /** A deploy started on the server's own machine, sent at every step of it. */
  | { type: 'hub_deploy'; deploy: FleetDeployRecord }
  /** A step of the server restarting or installing on itself, as the server sees it. */
  | { type: 'hub_install'; progress: HostInstallProgress }
  | { type: 'hub_action_result'; id: string; ok: true; value: unknown }
  | { type: 'hub_action_result'; id: string; ok: false; error: string }

/** What a hub sends a server. */
export type HubFrame =
  /** `credential` is set once, when the hub enrolls the server; the server keeps it. */
  | { type: 'hub_welcome'; hubLabel: string; credential?: string }
  | { type: 'hub_refused'; reason: HubRefusal }
  | { type: 'hub_action'; id: string; action: HubAction; args: unknown[] }

/** One server as a hub knows it. */
export interface HubServer {
  id: string
  /** The name the hub shows: the one given on the hub, else the one the server reports under. */
  label: string
  /** The name the server reports under, when the hub shows another. */
  reportedLabel?: string
  /** The server's socket is open now. */
  online: boolean
  /** The server runs this hub's actions. */
  manage: boolean
  /** Unix ms. */
  enrolledAt: number
  /** Unix ms the server last had a socket open. */
  lastSeenAt: number | null
  /** Unix ms the report was received. */
  readAt: number | null
  report: FleetReport | null
  /** The newest step of the server restarting or installing on itself, as it reported it; absent when it never has. */
  install?: HostInstallProgress
}

/**
 * The views a hub can leave off its page, set in its `hub.json`. A Fleet that
 * runs only on API keys has no subscription quota to show.
 */
export interface HubViews {
  /** The Quota view, and the action that reads each server's usage again. */
  quota: boolean
}

/** `GET /api/fleet`. */
export interface HubFleet {
  hub: {
    label: string
    /** The hub requires a sign-in. */
    authRequired: boolean
    /** Who is signed in; absent on a hub with no sign-in. */
    user?: string
    /** Whether this person may run actions and remove servers. Always true on a hub with no sign-in. */
    canManage: boolean
    /** The views this hub shows. */
    views: HubViews
  }
  servers: HubServer[]
  /** The newest deploys the hub was told of, newest first. */
  deploys: FleetDeploy[]
}

/** `POST /api/servers/:id/actions`. */
export interface HubActionRequest {
  action: HubAction
  args?: unknown[]
}

export type HubActionResponse = { ok: true; value: unknown } | { ok: false; error: string }

/** How a server's link to one hub stands. */
export type FleetHubState =
  | 'connecting'
  | 'connected'
  /** The hub answered and turned the server away. */
  | 'refused'
  /** The enterprise policy does not allow this hub. */
  | 'blocked'
  | 'unreachable'

/** One hub a server is set to report to, as `fleet.hubs.list` returns it. */
export interface FleetHubStatus {
  url: string
  /** The hub's own name once it has answered; the URL's host until then. */
  label: string
  /** `policy`: the enterprise policy put it here and it cannot be removed. `added`: an admin of this server did. */
  source: 'policy' | 'added'
  manage: boolean
  state: FleetHubState
  /** Why, for `refused`, `blocked`, and `unreachable`. */
  detail?: string
  /** Unix ms the last report was sent. */
  lastReportAt?: number
}

/** `fleet.hubs.list`. */
export interface FleetHubsList {
  hubs: FleetHubStatus[]
  /** The enterprise policy limits which hubs this server may join. */
  restricted: boolean
}

/** `fleet.hubs.add`. */
export interface FleetHubAddRequest {
  url: string
  enrollmentToken: string
  /** Whether the hub may run its actions here. Default true. */
  manage?: boolean
  /** The name the server reports to this hub under. Default: the server's own label. */
  label?: string
}

/** `PATCH /api/servers/:id`: the hub's own name for a server. An empty label goes back to the name the server reports under. */
export interface HubServerRename {
  label: string
}

/** A hub the enterprise policy puts every server it governs on. */
export interface ManagedFleetHub {
  url: string
  /** The hub's enrollment token, or a `secretstore:` reference to it. */
  enrollmentToken: string
  manage: boolean
}

/** The enterprise rule for hubs, read from `customFields['ion-server'].fleetHubs`. */
export interface FleetHubsPolicy {
  /** The server may join only `allowed` and the managed hubs. */
  restricted: boolean
  /** Normalized hub URLs an admin of the server may add. */
  allowed: string[]
  managed: ManagedFleetHub[]
}

/**
 * A hub URL in one form, so two spellings of one hub compare equal: scheme
 * and host in lower case, `ws`/`wss` as `http`/`https`, no path, query, or
 * trailing slash. A bare host is taken as https. Null when it is not an
 * http(s) or ws(s) address.
 */
export function normalizeHubUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  // A bare host, as a person types it, is an https address.
  const text = raw.trim()
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null
  const scheme = url.protocol === 'ws:' ? 'http:' : url.protocol === 'wss:' ? 'https:' : url.protocol
  if (scheme !== 'http:' && scheme !== 'https:') return null
  return `${scheme}//${url.host.toLowerCase()}`
}

/** The socket address of a hub, from its normalized URL. */
export function hubAgentUrl(hubUrl: string): string {
  return `${hubUrl.replace(/^http/, 'ws')}${HUB_AGENT_PATH}`
}

/**
 * The enterprise rule for hubs. With no `fleetHubs` in the policy a server's
 * admins join any hub they like. `allowedUrls`, even empty, limits them to
 * that list; `hubs` are joined by every server the policy governs.
 */
export function deriveFleetHubsPolicy(policy: EnterprisePolicy | null | undefined): FleetHubsPolicy {
  const fields = policy?.customFields?.['ion-server'] as IonServerPolicyFields | undefined
  const raw = fields?.fleetHubs
  if (!raw || typeof raw !== 'object') return { restricted: false, allowed: [], managed: [] }
  const managed: ManagedFleetHub[] = []
  for (const entry of Array.isArray(raw.hubs) ? raw.hubs : []) {
    const url = normalizeHubUrl(entry?.url)
    if (!url || typeof entry.enrollmentToken !== 'string' || !entry.enrollmentToken) continue
    if (managed.some((m) => m.url === url)) continue
    managed.push({ url, enrollmentToken: entry.enrollmentToken, manage: entry.manage !== false })
  }
  const restricted = Array.isArray(raw.allowedUrls)
  const allowed = restricted ? (raw.allowedUrls as unknown[]).map(normalizeHubUrl).filter((u): u is string => u !== null) : []
  return { restricted, allowed: [...new Set(allowed)], managed }
}

/** Whether an admin of the server may add this hub under the policy. */
export function fleetHubAllowed(policy: FleetHubsPolicy, hubUrl: string): boolean {
  if (!policy.restricted) return true
  return policy.allowed.includes(hubUrl) || policy.managed.some((m) => m.url === hubUrl)
}
