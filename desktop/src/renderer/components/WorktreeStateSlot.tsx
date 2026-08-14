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
  /** AI is resolving this worktree's native merge/rebase conflict. */
  hasActiveWorktreeResolver?: boolean
  /** Focus the active worktree resolver rather than opening resolution again. */
  onFocusActiveWorktreeResolver?(): void
  /** Open the in-worktree conflict resolver. */
  onResolve?(): void
  /** Sync from the source branch. */
  onSync(): void
  /** Flash this row's update marker while its pin update and reassembly runs. */
  updatingPin?: boolean
  /** A different member update is reassembling this bench; refuse competing pins. */
  pinUpdateLocked?: boolean
  /** Advance the bench pin to this worktree's current contribution. */
  onUpdatePin?(): void
  /** Show the bench's conflict detail for this member. */
  onShowBenchConflict?(): void
  /** Focus an existing auto-fix tab resolving this bench conflict. */
  onFocusActiveResolver?(): void
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
      const resolving = !!props.hasActiveWorktreeResolver
      const tip = resolving
        ? 'AI resolution in progress. Click to focus.'
        : `A ${verb} is in progress${files}. Click to resolve.`
      return (
        <Tooltip text={tip}>
          <button
            data-testid={`worktree-conflict-${branchName}`}
            onClick={(e) => {
              e.stopPropagation()
              if (resolving) props.onFocusActiveWorktreeResolver?.()
              else props.onResolve?.()
            }}
            style={{
              ...iconButtonStyle(colors.dangerFg),
              ...(resolving ? { animation: 'bench-conflict-flash 1.2s ease-in-out infinite' } : {}),
            }}
          >
            <Warning size={11} weight={resolving ? 'fill' : 'regular'} />
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
      const resolving = !!state.hasActiveResolver
      const tip = resolving
        ? 'AI resolution in progress. Click to focus.'
        : `This contribution conflicts, so the assembly failed and the bench is empty.${files}${withWhom} Click for detail and resolution.`
      return (
        <Tooltip text={tip}>
          <button
            data-testid={`worktree-bench-conflict-${branchName}`}
            onClick={(e) => {
              e.stopPropagation()
              if (resolving) props.onFocusActiveResolver?.()
              else props.onShowBenchConflict?.()
            }}
            style={{
              ...iconButtonStyle(colors.dangerFg),
              ...(resolving ? { animation: 'bench-conflict-flash 1.2s ease-in-out infinite' } : {}),
            }}
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

    case 'pin-behind': {
      const updating = !!props.updatingPin
      const locked = !!props.pinUpdateLocked
      const tip = updating
        ? 'Updating this pin and reassembling the bench.'
        : locked
          ? 'Another pin update is reassembling this bench. Wait for it to finish.'
          : `The bench holds an older contribution (${state.pinnedSha.slice(0, 7)}). Click to update the pin and reassemble.`
      return (
        <Tooltip text={tip}>
          <button
            data-testid={`worktree-pin-behind-${branchName}`}
            onClick={(e) => { e.stopPropagation(); props.onUpdatePin?.() }}
            disabled={updating || locked}
            aria-disabled={updating || locked}
            style={{
              ...iconButtonStyle(updating || locked ? colors.textTertiary : colors.warningFg, !updating && !locked),
              ...(updating ? { animation: 'bench-conflict-flash 1.2s ease-in-out infinite' } : {}),
            }}
          >
            {updating ? <CircleNotch size={11} className="animate-spin" /> : <ArrowCircleUp size={11} />}
          </button>
        </Tooltip>
      )
    }

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
