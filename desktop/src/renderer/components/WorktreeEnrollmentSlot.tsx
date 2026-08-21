/**
 * WorktreeEnrollmentSlot — the binary bench-membership control and the rail
 * that makes ordered bench members read as one stack.
 */
import React from 'react'
import { useColors } from '../theme'
import { Tooltip } from './git/Tooltip'

export interface WorktreeEnrollmentSlotProps {
  enrolled: boolean
  /** 1-based merge position. Present exactly when enrolled. */
  order?: number
  /** True when another enrolled row follows this one, so the rail continues. */
  railContinues: boolean
  /** True when an enrolled row precedes this one. */
  railStarts: boolean
  branchName: string
  /** Add an unenrolled worktree, or remove an enrolled worktree. */
  onToggleMembership(): void
  /** Width of the slot, so the rail can be centred without a magic number. */
  width: number
  /** Disable changes while the operation ledger owns this worktree or bench. */
  pending?: boolean
  /** Explains the pending or lock state. */
  pendingMessage?: string
}

export function WorktreeEnrollmentSlot(props: WorktreeEnrollmentSlotProps): React.JSX.Element {
  const colors = useColors()
  const { enrolled, order, branchName, width, pending = false, pendingMessage } = props
  const tooltip = pending
    ? (pendingMessage ?? 'A worktree operation is in progress.')
    : enrolled
    ? `In the integration bench at position ${order}. Click to remove it.`
    : 'Not in the integration bench. Click to add it.'

  return (
    <span
      data-ion-slot
      data-testid={`worktree-enrollment-${branchName}`}
      data-enrollment={enrolled ? 'member' : 'none'}
      style={{
        position: 'relative',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width, flexShrink: 0, alignSelf: 'stretch',
      }}
    >
      {enrolled && props.railStarts && <RailSegment position="up" color={colors.accent} testId={`worktree-rail-up-${branchName}`} />}
      {enrolled && props.railContinues && <RailSegment position="down" color={colors.accent} testId={`worktree-rail-down-${branchName}`} />}
      <Tooltip text={tooltip}>
        <button
          data-testid={`worktree-bench-toggle-${branchName}`}
          aria-pressed={enrolled}
          aria-disabled={pending}
          disabled={pending}
          onClick={(event) => {
            event.stopPropagation()
            props.onToggleMembership()
          }}
          style={{
            position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            padding: 0, border: 'none', background: 'transparent', cursor: 'pointer', flexShrink: 0,
            borderRadius: 5, boxShadow: enrolled ? `0 0 0 2px ${colors.containerBg}` : 'none',
          }}
        >
          <span style={{ width: 7, height: 7, transform: 'rotate(45deg)', border: `1px solid ${enrolled ? colors.accent : colors.textTertiary}`, background: enrolled ? colors.accent : 'transparent' }} />
        </button>
      </Tooltip>
    </span>
  )
}

function RailSegment({ position, color, testId }: { position: 'up' | 'down'; color: string; testId: string }): React.JSX.Element {
  return <span
    data-testid={testId}
    style={{
      position: 'absolute', left: '50%', width: 1, marginLeft: -0.5, background: color, opacity: 0.5,
      ...(position === 'up' ? { top: 0, bottom: '50%' } : { top: '50%', bottom: 0 }),
    }}
  />
}
