/**
 * Reads the policy override notices on an enterprise policy and words them
 * for Settings. The engine reports the field and a reason code; the wording
 * is this client's.
 */
import type { EnterprisePolicy, PolicyOverride } from '@ion/shared/types-enterprise'

const PROVIDER_FIELD_LABELS: Record<string, string> = {
  baseURL: 'Gateway',
  authHeader: 'Auth header',
  backend: 'Backend',
  displayName: 'Name',
  apiKey: 'API key',
}

/** The pinned-field notices for one provider. */
export function providerOverrides(policy: EnterprisePolicy | null, providerId: string): PolicyOverride[] {
  const prefix = `providers.${providerId}.`
  return (policy?.overrides ?? []).filter((o) => o.reason === 'managed_provider_pinned' && o.field.startsWith(prefix))
}

/** Says which setting of a provider the organization set, and that the configured value is not in effect. */
export function describeProviderOverride(override: PolicyOverride, providerId: string): string {
  const leaf = override.field.slice(`providers.${providerId}.`.length)
  const label = PROVIDER_FIELD_LABELS[leaf] ?? leaf
  const configured = override.userValue ? `The value in your configuration (${override.userValue})` : 'The value in your configuration'
  return `${label} is set by your organization. ${configured} is not in effect.`
}

/** The keys of the entries policy removed from a config map, for the given removal reasons. */
function removedKeys(policy: EnterprisePolicy | null, map: string, reasons: readonly string[]): string[] {
  const prefix = `${map}.`
  return (policy?.overrides ?? [])
    .filter((o) => reasons.includes(o.reason) && o.field.startsWith(prefix))
    .map((o) => o.field.slice(prefix.length))
}

/** Providers in the configuration that the organization's provider allowlist removed. */
export function removedProviders(policy: EnterprisePolicy | null): string[] {
  return removedKeys(policy, 'providers', ['provider_not_allowed'])
}

/** MCP servers in the configuration that the organization's MCP rules removed. */
export function removedMcpServers(policy: EnterprisePolicy | null): string[] {
  return removedKeys(policy, 'mcpServers', ['mcp_server_denied', 'mcp_server_not_allowed'])
}
