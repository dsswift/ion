/**
 * WorktreeReviewSlot — the operator's verdict on a bench member.
 *
 * The two verdicts make different statements with different lifetimes: `good`
 * ("the feature works") is a statement about the feature and survives pin
 * advances, syncs, and assemblies; `issue` ("this contribution has a bug") is
 * scoped to the pinned content and auto-clears when the pin advances, giving
 * the operator a clean slate to retest. See ADR-024 § "The two verdicts have
 * different lifetimes".
 *
 * ── Why it lives on line 2, in the gutter's column ──────────────────────────
 * A verdict is not a state the row DISCOVERS, it is one the operator RECORDS, so
 * it needs a control that is always present and always clickable. The line-1
 * state slot cannot provide that: it holds one indicator chosen by severity, and
 * a verdict loses that contest to nearly everything (a conflict, failed
 * provisioning, a behind pin, a moved base). On a real bench most members are
 * behind or syncing, so the verdict buttons were reachable only through the row
 * menu -- present, but invisible exactly when a review pass is happening.
 *
 * Putting the pair on line 2 under the state column costs no row height: line 2
 * already reserves the full gutter width and left it empty. Unenrolled rows show
 * nothing, which is what every other gutter slot already does.
 *
 * ── Why not a third line of buttons ─────────────────────────────────────────
 * A third line costs ~14px on EVERY row, enrolled or not -- roughly one row of
 * visible list in a panel this size -- to serve a control that only applies to
 * bench members. Reusing the column line 2 already reserves gets the same
 * always-visible affordance for free.
 */
import React from 'react'
import { Bug, Check } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { Tooltip } from './git/Tooltip'
import type { IntegrationMember } from '../../shared/types'

export interface WorktreeReviewSlotProps {
  /** Absent for an unenrolled worktree: there is no pin to have a verdict on. */
  membership?: IntegrationMember
  branchName: string
  /** Set or clear the verdict. `null` clears. */
  onSetReview?(review: 'good' | 'issue' | null): void
}

export function WorktreeReviewSlot(props: WorktreeReviewSlotProps): React.JSX.Element | null {
  const colors = useColors()
  const { membership, branchName } = props

  // No membership, no pin, no verdict. The caller still reserves the width, so
  // the commit subject on line 2 starts at the same x on every row.
  if (!membership || !props.onSetReview) return null

  const review = membership.review

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
      <Tooltip text={review === 'good'
        ? 'Reviewed good. Click to clear.'
        : 'Mark the feature reviewed and working'}>
        <button
          data-testid={`worktree-review-good-btn-${branchName}`}
          aria-pressed={review === 'good'}
          onClick={(e) => {
            e.stopPropagation()
            // Selecting the active verdict clears it, so neither verdict is
            // sticky once the operator revisits the evidence.
            props.onSetReview?.(review === 'good' ? null : 'good')
          }}
          style={buttonStyle(review === 'good' ? colors.worktreeGreen : colors.textTertiary)}
        >
          <Check size={9} weight="bold" />
        </button>
      </Tooltip>

      <Tooltip text={review === 'issue'
        ? 'Flagged with an issue. Click to clear.'
        : `Flag a problem with this contribution (${membership.pinnedSha.slice(0, 7)})`}>
        <button
          data-testid={`worktree-review-issue-btn-${branchName}`}
          aria-pressed={review === 'issue'}
          onClick={(e) => {
            e.stopPropagation()
            props.onSetReview?.(review === 'issue' ? null : 'issue')
          }}
          style={buttonStyle(review === 'issue' ? colors.dangerFg : colors.textTertiary)}
        >
          <Bug size={9} weight={review === 'issue' ? 'fill' : 'regular'} />
        </button>
      </Tooltip>
    </span>
  )
}

/**
 * Shared button shape.
 *
 * An UNSET verdict renders in the tertiary colour rather than hidden: the
 * operator needs to see that a member is unreviewed, which is the state a review
 * pass is looking for. Hiding the buttons until hover would make "unreviewed"
 * indistinguishable from "not a member".
 */
function buttonStyle(color: string): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    padding: 0, width: 11, height: 11,
    background: 'transparent', border: 'none', color,
    cursor: 'pointer', flexShrink: 0,
  }
}
