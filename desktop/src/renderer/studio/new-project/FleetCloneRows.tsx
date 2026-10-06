/** FleetCloneRows — one line per server of a fleet clone: where it stands, why it failed, and a way to try that server again. */
import React from 'react'
import { useColors } from '../../theme'
import { Button, KIT, StatusDot, type Tone } from '../../components/settings/kit'
import type { FleetCloneRun, FleetCloneState } from './fleet-clone'

function describe(state: FleetCloneState | undefined): { tone: Tone; text: string } {
  if (!state || state.phase === 'queued') return { tone: 'muted', text: 'Starting…' }
  if (state.phase === 'cloning') return { tone: 'accent', text: state.percent === undefined ? `Cloning: ${state.stage}` : `Cloning: ${state.stage} ${state.percent}%` }
  if (state.phase === 'done') return { tone: 'ok', text: state.dir }
  return { tone: 'error', text: state.error }
}

export function FleetCloneRows({ run }: { run: FleetCloneRun }): React.JSX.Element {
  const colors = useColors()
  return (
    <div role="list" aria-label="Clone progress" style={{ border: `1px solid ${colors.containerBorder}`, borderRadius: KIT.radius + 2 }}>
      {run.targets.map((target) => {
        const state = run.states[target.environmentId]
        const { tone, text } = describe(state)
        return (
          <div key={target.environmentId} role="listitem" style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: `6px ${KIT.inset}px`, borderBottom: `1px solid ${colors.borderSubtle}` }}>
            <span style={{ display: 'flex', alignItems: 'center', height: 16 }}><StatusDot tone={tone} /></span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: KIT.fontSmall, color: colors.textPrimary }}>{target.label}</span>
              <span style={{ display: 'block', fontSize: KIT.fontTiny, color: state?.phase === 'failed' ? colors.dangerFg : colors.textTertiary, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{text}</span>
            </span>
            {state?.phase === 'failed' && <Button aria-label={`Retry on ${target.label}`} onClick={() => run.retry(target.environmentId)}>Retry</Button>}
          </div>
        )
      })}
    </div>
  )
}
