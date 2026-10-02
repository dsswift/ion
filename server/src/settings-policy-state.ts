/**
 * The applied state of this Environment's enterprise settings policy: the
 * mutability class in force for every key, and a checksum of the policy
 * inputs that produced it. It carries no setting's value.
 */
import { createHash } from 'crypto'
import {
  describeSettingsPolicy,
  settingsPolicyFingerprint,
  SETTINGS_POLICY_NAMESPACES,
  type SettingsPolicyDescription,
  type SettingsPolicyNamespace,
} from '@ion/shared/enterprise-settings-policy'
import type { EnterprisePolicy } from '@ion/shared/types-enterprise'

export interface SettingsPolicyState extends SettingsPolicyDescription {
  schemaVersion: 1
  checksum: string
}

export function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

export function settingsPolicyChecksum(policy: EnterprisePolicy | null): string {
  return sha256(settingsPolicyFingerprint(policy))
}

/** The applied state. `namespaces` narrows it to what the asker is governed by. */
export function settingsPolicyState(
  policy: EnterprisePolicy | null,
  namespaces: readonly SettingsPolicyNamespace[] = SETTINGS_POLICY_NAMESPACES,
): SettingsPolicyState {
  return { schemaVersion: 1, checksum: settingsPolicyChecksum(policy), ...describeSettingsPolicy(policy, namespaces) }
}
