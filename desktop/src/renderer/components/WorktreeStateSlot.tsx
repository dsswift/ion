/**
 * WorktreeStateSlot — the one indicator a worktree row shows in its gutter.
 *
 * Split out of `WorktreeRow` rather than inlined: the chain has eight branches
 * with distinct affordances (three are buttons, four are glyphs, one is empty),
 * and keeping them in the row pushed it past the file cap while burying the
 * row's structure under the branch bodies.
 *
 * WHICH indicator to show is not decided here -- `resolveRowState` decides, so
 * the decision is testable without rendering and the row and its test cannot
 * disagree. This component only draws what it is handed.
 */
import React from 'react'
import { ArrowsClockwise, ArrowCircleUp, CircleNotch, Warning } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { Tooltip } from './git/Tooltip'
import type { RowStateIndicator } from './worktreeRowState'

export interface WorktreeStateSlotProps {
  state: RowStateIndicator
  /** Identifies this row's controls in tests; the branch is the stable key. */
  branchName: string
  /** Open the in-worktree conflict resolver. */
  onResolve?(): void
  /** Sync from the source branch. */
  onSync(): void
  /** Advance the bench pin to this worktree's current contribution. */
  onUpdatePin?(): void
  /** Show the bench's conflict detail for this member. */
  onShowBenchConflict?(): void
  /** Show the bench's verification-failure detail (this member is a suspect). */
  onShowVerificationFailure?(): void
}

/** Shared shape for the glyph-only buttons, so they cannot drift apart. */
function iconButtonStyle(color: string, interactive = true): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', padding: 0,
    background: 'transparent', border: 'none', color,
    cursor: interactive ? 'pointer' : 'default', flexShrink: 0,
  }
}

export function WorktreeStateSlot(props: WorktreeStateSlotProps): React.JSX.Element | null {
  const colors = useColors()
  const { state, branchName } = props

  switch (state.kind) {
    case 'operation-conflict': {
      const verb = state.operation === 'rebasing' ? 'rebase'
        : state.operation === 'merging' ? 'merge' : 'cherry-pick'
      const files = state.conflictedCount > 0
        ? ` with ${state.conflictedCount} conflicted file${state.conflictedCount === 1 ? '' : 's'}`
        : ''
      return (
        <Tooltip text={`A ${verb} is in progress${files}. Click to resolve.`}>
          <button
            data-testid={`worktree-conflict-${branchName}`}
            onClick={(e) => { e.stopPropagation(); props.onResolve?.() }}
            style={iconButtonStyle(colors.dangerFg)}
          >
            <Warning size={11} />
          </button>
        </Tooltip>
      )
    }

    case 'bench-conflict': {
      const withWhom = state.conflictsWith.length > 0
        ? ` Collides with ${state.conflictsWith.join(', ')}.`
        : ''
      const files = state.paths.length > 0
        ? ` ${state.paths.length} file${state.paths.length === 1 ? '' : 's'}.`
        : ''
      return (
        <Tooltip text={`This contribution conflicts, so the assembly failed and the bench is empty.${files}${withWhom} Click for detail and resolution.`}>
          <button
            data-testid={`worktree-bench-conflict-${branchName}`}
            onClick={(e) => { e.stopPropagation(); props.onShowBenchConflict?.() }}
            style={iconButtonStyle(colors.dangerFg)}
          >
            <Warning size={11} weight="fill" />
          </button>
        </Tooltip>
      )
    }

    case 'bench-verification':
      return (
        <Tooltip text="This contribution merged, but the assembly failed project verification. Click for detail.">
          <button
            data-testid={`worktree-bench-verification-${branchName}`}
            onClick={(e) => { e.stopPropagation(); props.onShowVerificationFailure?.() }}
            style={iconButtonStyle(colors.warningFg)}
          >
            <Warning size={11} />
          </button>
        </Tooltip>
      )

    case 'provision-failed':
      return (
        <Tooltip text={state.reason
          ? `Dependency setup failed: ${state.reason}`
          : 'Dependency setup failed. Use Re-provision in the row menu.'}>
          <span
            data-testid={`worktree-provision-failed-${branchName}`}
            style={iconButtonStyle(colors.dangerFg, false)}
          >
            <Warning size={11} />
          </span>
        </Tooltip>
      )

    case 'pin-behind':
      return (
        <Tooltip text={`The bench holds an older contribution (${state.pinnedSha.slice(0, 7)}). Click to update the pin and reassemble.`}>
          <button
            data-testid={`worktree-pin-behind-${branchName}`}
            onClick={(e) => { e.stopPropagation(); props.onUpdatePin?.() }}
            style={iconButtonStyle(colors.warningFg)}
          >
            <ArrowCircleUp size={11} />
          </button>
        </Tooltip>
      )

    case 'needs-sync':
      return (
        <Tooltip text={state.blocked
          ? 'Base moved, but this worktree has uncommitted changes. Commit or stash them, then sync.'
          : 'Base moved: sync from the source branch'}>
          {/* Genuinely disabled when dirty, not merely greyed.
              The earlier version let the click through so the refusal toast
              could carry the remediation -- reasonable when the alternative was
              an inert button with no explanation, but the tooltip now states the
              remediation before the click, so firing a verb that is guaranteed
              to refuse only spends a round trip to say what the row already
              says. `pointerEvents: none` keeps the hover on the wrapper so the
              tooltip still opens on a disabled control. */}
          <button
            data-testid={`worktree-sync-${branchName}`}
            onClick={(e) => { e.stopPropagation(); props.onSync() }}
            disabled={state.syncing || state.blocked}
            aria-disabled={state.syncing || state.blocked}
            style={{
              ...iconButtonStyle(state.blocked ? colors.textTertiary : colors.warningFg, !state.syncing && !state.blocked),
              pointerEvents: state.blocked ? 'none' : undefined,
            }}
          >
            {state.syncing
              ? <CircleNotch size={11} className="animate-spin" />
              : <ArrowsClockwise size={11} />}
          </button>
        </Tooltip>
      )

    case 'provisioning':
      return (
        <Tooltip text="Installing dependencies for this worktree">
          <span
            data-testid={`worktree-provisioning-${branchName}`}
            style={iconButtonStyle(colors.textTertiary, false)}
          >
            <CircleNotch size={11} className="animate-spin" />
          </span>
        </Tooltip>
      )

    case 'none':
      // The slot still reserves its width in the gutter -- that is what keeps
      // every name in the list starting at the same x.
      return null
  }
}
