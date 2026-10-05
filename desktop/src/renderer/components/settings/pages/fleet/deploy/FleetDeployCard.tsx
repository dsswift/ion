/**
 * FleetDeployCard — one deploy as it stands: what is deployed, how far it
 * is, and a row per server with its stage, the stage's one-line detail, and
 * why it failed. The Deploy panel, the Fleet page, and a Fleet Hub's page
 * all show a deploy with this card.
 *
 * A row with log lines opens to show them. `note` adds a word per server
 * from another source, such as what the server itself last reported.
 */
import React, { useEffect, useRef, useState } from 'react'
import { CaretDown, CaretRight } from '@phosphor-icons/react'
import { fleetDeployCounts, fleetDeployLost, fleetDeployTargetStanding, type FleetDeploy, type FleetDeployTarget } from '@ion/shared/types-fleet-deploy'
import { useColors } from '../../../../../theme'
import { Chip, KIT, StatusDot, type Tone } from '../../../kit'
import { formatAgo, formatSpan } from '../../../fleet/fleet-format'

const STANDING_TONE: Record<ReturnType<typeof fleetDeployTargetStanding>, Tone> = { waiting: 'muted', working: 'accent', done: 'ok', failed: 'error' }

/** The deploy's state in a word, and whether the process running it went quiet. */
function stateChip(deploy: FleetDeploy, now: number): { tone: Tone; text: string } {
  if (fleetDeployLost(deploy, now)) return { tone: 'warn', text: 'no word from it' }
  switch (deploy.state) {
    case 'running': return { tone: 'accent', text: 'running' }
    case 'done': return { tone: 'ok', text: 'done' }
    case 'failed': return { tone: 'error', text: 'failed' }
    case 'cancelled': return { tone: 'warn', text: 'stopped' }
  }
}

/** "2 of 4 done, 1 failed". */
export function fleetDeploySummary(deploy: Pick<FleetDeploy, 'targets'>): string {
  const { done, failed, total } = fleetDeployCounts(deploy)
  return `${done} of ${total} done${failed > 0 ? `, ${failed} failed` : ''}`
}

function TargetRow({ target, running, now, log, note }: { target: FleetDeployTarget; running: boolean; now: number; log: readonly string[] | undefined; note: string | null }): React.JSX.Element {
  const colors = useColors()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLPreElement | null>(null)
  const standing = fleetDeployTargetStanding(target)
  const hasLog = !!log && log.length > 0
  // Keep the newest line in view while the log grows.
  useEffect(() => { if (open && box.current) box.current.scrollTop = box.current.scrollHeight }, [open, log?.length])
  const stage = standing === 'failed' ? 'failed' : target.stage
  const detail = target.error ?? target.detail
  // A server still under way says how long it has been on this step.
  const since = running && standing === 'working' && now - target.updatedAt >= 60_000 ? ` · ${formatSpan(now - target.updatedAt)} on this step` : ''
  const Caret = open ? CaretDown : CaretRight
  return (
    <div role="listitem" aria-label={`${target.label}: ${stage}`} style={{ padding: '6px 0', borderTop: `1px solid ${colors.containerBorder}` }}>
      <div
        role={hasLog ? 'button' : undefined}
        tabIndex={hasLog ? 0 : undefined}
        aria-expanded={hasLog ? open : undefined}
        onClick={hasLog ? () => setOpen(!open) : undefined}
        onKeyDown={hasLog ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open) } } : undefined}
        style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, cursor: hasLog ? 'pointer' : 'default' }}
      >
        <StatusDot tone={STANDING_TONE[standing]} label={standing} />
        <span style={{ fontSize: KIT.fontSmall, fontWeight: 600, color: colors.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{target.label}</span>
        {target.platform && <span style={{ fontSize: KIT.fontTiny, color: colors.textTertiary, whiteSpace: 'nowrap' }}>{target.component ? `${target.component} · ` : ''}{target.platform}</span>}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: KIT.fontSmall, color: standing === 'failed' ? colors.statusError : colors.textSecondary, whiteSpace: 'nowrap' }}>{stage}</span>
        {hasLog && <Caret size={11} color={colors.textTertiary} />}
      </div>
      {(detail || since || note) && (
        <div style={{ margin: '2px 0 0 15px', fontSize: KIT.fontTiny, lineHeight: 1.45, color: standing === 'failed' ? colors.statusError : colors.textTertiary, wordBreak: 'break-word' }}>
          {detail}{since}
          {note && <div style={{ color: colors.textTertiary }}>{note}</div>}
        </div>
      )}
      {open && hasLog && (
        <pre ref={box} aria-label={`${target.label} log`} style={{ margin: '6px 0 0 15px', padding: 8, maxHeight: 220, overflow: 'auto', fontFamily: KIT.mono, fontSize: KIT.fontTiny, lineHeight: 1.45, color: colors.textSecondary, background: colors.surfacePrimary, border: `1px solid ${colors.containerBorder}`, borderRadius: KIT.radius, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {log.join('\n')}
        </pre>
      )}
    </div>
  )
}

export interface FleetDeployCardProps {
  deploy: FleetDeploy
  now: number
  /** Each server's log lines, by its fleet host name. */
  logs?: ReadonlyMap<string, readonly string[]>
  /** A word per server from another source. */
  note?(target: FleetDeployTarget): string | null
  /** Controls shown beside the deploy's state. */
  actions?: React.ReactNode
}

export function FleetDeployCard({ deploy, now, logs, note, actions }: FleetDeployCardProps): React.JSX.Element {
  const colors = useColors()
  const chip = stateChip(deploy, now)
  const running = deploy.state === 'running' && !fleetDeployLost(deploy, now)
  const when = deploy.endedAt ? `ended ${formatAgo(deploy.endedAt, now)}` : `started ${formatAgo(deploy.startedAt, now)}`
  return (
    <section aria-label={`Deploy of ${deploy.source}`} style={{ padding: '10px 12px 4px', border: `1px solid ${colors.containerBorder}`, borderRadius: KIT.radius + 2, background: colors.surfacePrimary }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ fontSize: KIT.fontSmall, fontWeight: 600, color: colors.textPrimary }}>Deploy of {deploy.source}</span>
        <Chip tone={chip.tone}>{chip.text}</Chip>
        <span style={{ fontSize: KIT.fontTiny, color: colors.textTertiary }}>
          {fleetDeploySummary(deploy)} · {when}{deploy.reportedBy ? ` · from ${deploy.reportedBy.label}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        {actions}
      </header>
      {fleetDeployLost(deploy, now) && (
        <div style={{ fontSize: KIT.fontTiny, color: colors.statusWarning, marginBottom: 6 }}>
          The device running this deploy stopped reporting {formatAgo(deploy.receivedAt, now)}. It may have been closed, or lost its connection.
        </div>
      )}
      <div role="list" aria-label="Servers in this deploy">
        {deploy.targets.map((target) => (
          <TargetRow key={target.host} target={target} running={running} now={now} log={logs?.get(target.host)} note={note?.(target) ?? null} />
        ))}
      </div>
    </section>
  )
}
