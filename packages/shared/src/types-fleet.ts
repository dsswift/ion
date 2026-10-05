/**
 * Fleet: what one server reports about itself so a client can show every
 * server it is paired with on one screen (`fleet.report`), and the Provider
 * Account Ledger that report carries.
 */
import type { EnvironmentServerInfo } from './types-environment-admin'
import type { ProviderCliStatus, ProviderUsageLimit } from './types-models'
import type { ModelTier } from './types-model-tiers'
import type { EnvironmentSystemMetrics } from './types-system-metrics'

/** How long the Provider Account Ledger remembers an account after it was last signed in. */
export const FLEET_ACCOUNT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

/** A usage limit as the ledger holds it: the CLI's report plus when it was read. */
export interface FleetAccountLimit extends ProviderUsageLimit {
  /** Unix ms this limit was last read. */
  fetchedAt: number
}

/**
 * One provider CLI account a server has seen signed in during the last 30
 * days. `signedIn` says whether it is the account signed in on that server
 * now; a signed-out row keeps the limits last read for it.
 */
export interface FleetAccount {
  /** The provider id the CLI serves (e.g. "anthropic"). */
  provider: string
  /** The CLI backend that reported the account (e.g. "claude-code"). */
  backend: string
  /** Empty for a login with no email (an API key). */
  email: string
  orgId?: string
  orgName?: string
  planType?: string
  authMethod?: string
  label?: string
  /** Unix ms. */
  firstSeen: number
  /** Unix ms the account was last seen signed in. */
  lastSeen: number
  signedIn: boolean
  limits: FleetAccountLimit[]
  /** Why the newest read of the limits failed; the limits are the last good read. */
  limitsError?: string
}

/** A provider as a Fleet row shows it. */
export interface FleetProvider {
  id: string
  displayName?: string
  hasAuth: boolean
  authSource?: string
  /** The backend routing will pick for this provider. */
  backend?: string
  cli?: ProviderCliStatus
  /** How many models the provider lists. */
  modelCount: number
  /** The provider exists only because this server's configuration defines it, such as a company gateway. */
  custom?: boolean
}

/** One Fleet Hub a server reports to, as its Fleet Report names it. */
export interface FleetReportHub {
  url: string
  /** The hub's own name once it has answered; the address's host until then. */
  label: string
  /** `connecting`, `connected`, `refused`, `blocked`, or `unreachable`. */
  state: string
  /** Whether the hub may run its actions on the server. */
  manage: boolean
}

/** The person signed in to a server's enterprise sign-in. */
export interface FleetEnterpriseAccount {
  /** The sign-in's user name, usually an email. Empty for an account type that has none. */
  username: string
  displayName: string
}

/** `fleet.report`: one server's facts, load, providers, and accounts. */
export interface FleetReport {
  /** Unix ms the report was built. */
  generatedAt: number
  server: EnvironmentServerInfo
  /** The newest System Metrics sample; null when the server has none. */
  metrics: EnvironmentSystemMetrics | null
  /** The caller's own paired devices on this server, the calling one left out. */
  devices: { paired: number; connected: number }
  providers: FleetProvider[]
  /** Empty when no default provider is set. */
  defaultProvider: string
  modelTiers: ModelTier[]
  accounts: FleetAccount[]
  /** The Fleet Hubs the server reports to, with how each link stands. Absent from a server that does not report it. */
  hubs?: FleetReportHub[]
  /** Who is signed in to the server's enterprise sign-in; null when nobody is. Absent from a server that does not report it. */
  enterpriseAccount?: FleetEnterpriseAccount | null
}

/** The identity of a ledger row: one account of one provider. */
export function fleetAccountKey(a: Pick<FleetAccount, 'provider' | 'email' | 'orgId' | 'authMethod'>): string {
  return [a.provider, a.email.toLowerCase(), a.orgId ?? '', a.email ? '' : a.authMethod ?? ''].join('|')
}
