/**
 * Which settings groups enterprise device policy hides from a connection. Shared by `hello.ts` (serves `settingsHiddenGroups` on
 * `studio_welcome`) and `actions.ts` (refuses a mutation whose group is
 * hidden with `{code:'settings_locked'}`), so the two never drift.
 */
import type { EnterprisePolicy, IonDesktopPolicyFields } from '@ion/shared/types-enterprise'
import type { Connection } from './connection'

/**
 * Mutating studio_actions whose settings group can be locked. Read-only
 * siblings (`model.list`, `model.listTiers`, `provider.getDefault`,
 * `mcp.list`) stay reachable even when their group is hidden -- a hidden
 * group means "you cannot change this," not "you cannot see what it's set
 * to," and several of these reads (e.g. `model.list`) are load-bearing for
 * the prompt UI regardless of tenancy.
 */
// The lock below is the enterprise DEVICE policy only. Who may change a
// server's configuration at all is a separate question, answered by the
// `admin` scope each of these actions already requires.
const LOCKABLE_ACTION_GROUP: Record<string, string> = {
  'model.setTier': 'ai',
  'model.removeTier': 'ai',
  'model.refresh': 'ai',
  'provider.setDefault': 'ai',
  'provider.storeCredential': 'ai',
  'provider.login': 'ai',
  'provider.loginCancel': 'ai',
  'provider.loginCode': 'ai',
  'provider.logout': 'ai',
  'provider.remove': 'ai',
  'mcp.add': 'mcp',
  'mcp.update': 'mcp',
  'mcp.remove': 'mcp',
  'mcp.login': 'mcp',
  'mcp.logout': 'mcp',
}

/** The settings group `action` belongs to, if it is a lockable mutation. */
export function lockableActionGroup(action: string): string | undefined {
  return LOCKABLE_ACTION_GROUP[action]
}

/**
 * The settings groups an enterprise sealed config hides on the local desktop
 * (`customFields['ion-desktop'].hiddenSettingsGroups`).
 *
 * Device policy governs a person's own desktop, so it applies to the local
 * connection and to nothing else: a visiting client is never narrowed by the
 * host machine's device policy. What a visiting client may CHANGE is decided
 * by its scopes, not by hiding groups from it.
 */
export function computeSettingsHiddenGroups(
  conn: Pick<Connection, 'transport'>,
  enterprisePolicy: EnterprisePolicy | null,
): string[] {
  if (conn.transport !== 'local') return []
  const fields = enterprisePolicy?.customFields?.['ion-desktop'] as IonDesktopPolicyFields | undefined
  return fields?.hiddenSettingsGroups ?? []
}
