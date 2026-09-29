/**
 * EnvironmentBadge — the "this conversation lives on another host" chip an
 * Inbox row wears (spec 13 union view). Shows the environment's label;
 * hovering names the host it resolves to. The local environment never
 * wears one: a badge on every row would say nothing.
 *
 * While that host's wire is down the badge turns amber and says
 * "reconnecting". The row is on borrowed time -- it is dropped outright if
 * the wire stays down past the grace window
 * (`connection/environment-availability.ts`) -- and until then nothing on it
 * can be acted on, so the chip that says WHERE the conversation lives is
 * also where it says the machine has stopped answering.
 */
import React from 'react'
import { Broadcast } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { Tooltip } from '../../components/git/Tooltip'
import { useEnvironmentInfo } from '../transfer/environment-label-cache'
import { useEnvironmentAvailability } from '../connection/environment-availability'

export function EnvironmentBadge({ environmentId, compact = false }: { environmentId: string; compact?: boolean }): React.JSX.Element | null {
  const colors = useColors()
  const info = useEnvironmentInfo(environmentId)
  const availability = useEnvironmentAvailability(environmentId)
  if (!info) return null
  const where = info.url ? `${info.label} · ${info.url}` : info.label
  const live = availability === 'connected'
  const tone = live ? colors.statusRunning : colors.statusWarning
  return (
    <Tooltip text={live ? `Remote environment: ${where}` : `${where} is not answering — reconnecting. Nothing can be sent to this conversation.`}>
      <span
        data-testid="environment-badge"
        data-environment-id={environmentId}
        data-availability={availability}
        aria-label={live ? `On remote environment ${where}` : `On remote environment ${where}, reconnecting`}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0,
          fontSize: 9, fontWeight: 600, lineHeight: 1.4, letterSpacing: '0.02em', whiteSpace: 'nowrap',
          color: tone, background: `${tone}22`, border: `1px solid ${tone}40`,
          borderRadius: 4, padding: compact ? '0 3px' : '1px 4px',
        }}
      >
        <Broadcast size={10} weight="bold" />
        {live ? info.label : `${info.label} · reconnecting`}
      </span>
    </Tooltip>
  )
}
