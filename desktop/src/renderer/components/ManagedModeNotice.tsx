import React from 'react'
import type { ManagedConfigStatus, ManagedModeStatus } from '@ion/shared/types-enterprise'
import type { ColorPalette } from '../theme'
import { activeTabEnvironmentId } from '../studio/connection/tab-environment'
import { useEnvironmentEnterprisePolicy } from './settings/use-environment-enterprise-policy'

type ManagedNoticeKind = 'policy-absent' | 'override-refused' | 'managed-config-invalid'

/** Whether a notice kind means the engine is refusing prompts. */
const BLOCKING_KINDS: ReadonlySet<ManagedNoticeKind> = new Set(['policy-absent', 'managed-config-invalid'])

/** One line per managed-mode condition the person at the composer should know about. */
export function managedModeMessages(status: ManagedModeStatus | undefined, managedConfig?: ManagedConfigStatus): { kind: ManagedNoticeKind; text: string }[] {
  const messages: { kind: ManagedNoticeKind; text: string }[] = []
  if (managedConfig?.engine?.error || managedConfig?.models?.error) {
    messages.push({
      kind: 'managed-config-invalid',
      text: 'The managed configuration for this installation could not be applied. Prompts are refused until your administrator restores it.',
    })
  }
  if (!status?.managed) return messages
  if (status.policyAbsent) {
    messages.push({
      kind: 'policy-absent',
      text: 'This installation is managed, but its enterprise policy is missing. Prompts are refused until your administrator restores it.',
    })
  }
  if (status.overrideRefused) {
    messages.push({
      kind: 'override-refused',
      text: 'ION_ENTERPRISE_CONFIG was ignored because this installation is managed.',
    })
  }
  return messages
}

/** Tells the composer's user when the active conversation's engine is locked by a managed-mode condition, or refused a policy override. */
export function ManagedModeNotice({ colors }: { colors: ColorPalette }): React.JSX.Element | null {
  const policy = useEnvironmentEnterprisePolicy(activeTabEnvironmentId())
  const messages = managedModeMessages(policy?.managedMode, policy?.managedConfigStatus)
  if (messages.length === 0) return null
  return (
    <div data-testid="managed-mode-notice" style={{ fontSize: 10, padding: '4px 6px 0' }}>
      {messages.map((m) => (
        <div key={m.kind} data-kind={m.kind} style={{ color: BLOCKING_KINDS.has(m.kind) ? colors.dangerFg : colors.textTertiary }}>
          {m.text}
        </div>
      ))}
    </div>
  )
}
