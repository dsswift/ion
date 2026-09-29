/**
 * The enterprise seal on "Allow settings edits by the agent".
 *
 * An Environment setting an admin can flip is not enough for an organization
 * that never wants the agent near a server's engine config. The seal lives in
 * the Environment's own enterprise config, under `customFields['ion-server']`,
 * and outranks the saved setting both ways: the server refuses saves of the
 * setting and the settings-files guard reads the sealed value.
 */
import type { EnterprisePolicy, IonServerPolicyFields } from './types-enterprise'

export interface EnterpriseSettingsEditsPolicy {
  allowed: boolean
}

/** The seal, or null when the organization has not set one. */
export function deriveEnterpriseSettingsEditsPolicy(policy: EnterprisePolicy | null | undefined): EnterpriseSettingsEditsPolicy | null {
  const fields = policy?.customFields?.['ion-server'] as IonServerPolicyFields | undefined
  const raw = fields?.agentSettingsEdits
  if (!raw || typeof raw !== 'object' || typeof raw.allowed !== 'boolean') return null
  return { allowed: raw.allowed }
}
