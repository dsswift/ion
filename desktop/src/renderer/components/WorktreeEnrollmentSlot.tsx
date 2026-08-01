/**
 * WorktreeEnrollmentSlot — the bench toggle, and the rail that makes the bench
 * look like the ordered stack it is.
 *
 * ── Why enrollment is a row control and not a second list ───────────────────
 * Bench membership is a property of a worktree, not a different kind of object.
 * It used to be expressed by putting the worktree in a SECOND list with a
 * second row component and a second vocabulary, which meant an enrolled
 * worktree appeared twice in one panel. Here it is one row and one glyph:
 * hollow = not in the bench, filled = included, filled-and-dim = enrolled but
 * skipped.
 *
 * ── The rail ────────────────────────────────────────────────────────────────
 * A bench merges its members IN ORDER, and that order used to be invisible --
 * implicit in an array nothing rendered. Enrolled rows sort together at the top
 * of the list, and the rail draws a line through their toggles connecting them
 * into a visible stack, numbered by merge position. The number is the fact that
 * matters when a conflict is attributed to "an earlier member".
 */
import React from 'react'
import { useColors } from '../theme'
import { Tooltip } from './git/Tooltip'
import type { EnrollmentState } from '../../shared/types'

export interface WorktreeEnrollmentSlotProps {
  enrollment: EnrollmentState
  /** 1-based merge position. Present exactly when enrolled. */
  order?: number
  /** True when another enrolled row follows this one, so the rail continues. */
  railContinues: boolean
  /** True when an enrolled row precedes this one. */
  railStarts: boolean
  branchName: string
  /** Enroll an unenrolled worktree, or unenroll an enrolled one. */
  onToggleEnrollment(): void
  /** Flip included/excluded on an already-enrolled worktree. */
  onToggleIncluded(): void
  /** Width of the slot, so the rail can be centred without a magic number. */
  width: number
}

export function WorktreeEnrollmentSlot(props: WorktreeEnrollmentSlotProps): React.JSX.Element {
  const colors = useColors()
  const { enrollment, order, branchName, width } = props
  const enrolled = enrollment !== 'none'

  const tooltip = enrollment === 'none'
    ? 'Not in the integration bench. Click to add it.'
    : enrollment === 'included'
      ? `Merged into the bench at position ${order}. Click to remove; ⌥click to exclude without removing.`
      : `In the bench at position ${order} but excluded from the merge. ⌥click to include; click to remove.`

  return (
    <span
      data-ion-slot
      data-testid={`worktree-enrollment-${branchName}`}
      data-enrollment={enrollment}
      style={{
        position: 'relative',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width, flexShrink: 0, alignSelf: 'stretch',
      }}
    >
      {/* Rail segments are absolutely positioned so they span the row's full
          height regardless of how tall the two text lines make it. Drawn behind
          the glyph, which sits on the same centre line. */}
      {enrolled && props.railStarts && (
        <span
          data-testid={`worktree-rail-up-${branchName}`}
          style={{
            position: 'absolute', top: 0, bottom: '50%', left: '50%',
            width: 1, marginLeft: -0.5,
            background: enrollment === 'included' ? colors.accent : colors.textTertiary,
            opacity: enrollment === 'included' ? 0.5 : 0.3,
          }}
        />
      )}
      {enrolled && props.railContinues && (
        <span
          data-testid={`worktree-rail-down-${branchName}`}
          style={{
            position: 'absolute', top: '50%', bottom: 0, left: '50%',
            width: 1, marginLeft: -0.5,
            background: enrollment === 'included' ? colors.accent : colors.textTertiary,
            opacity: enrollment === 'included' ? 0.5 : 0.3,
          }}
        />
      )}

      <Tooltip text={tooltip}>
        <button
          data-testid={`worktree-bench-toggle-${branchName}`}
          aria-pressed={enrolled}
          onClick={(e) => {
            e.stopPropagation()
            // ⌥click is the include/exclude flip, because excluding is a
            // refinement OF membership -- pairing it with the membership control
            // keeps one concept on one control instead of spending a second
            // gutter slot on a state most rows never enter.
            if (e.altKey && enrolled) props.onToggleIncluded()
            else props.onToggleEnrollment()
          }}
          style={{
            position: 'relative',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            padding: 0, border: 'none', background: 'transparent',
            cursor: 'pointer', flexShrink: 0,
            // The dot sits on the panel background so the rail does not run
            // visually through the glyph.
            borderRadius: 5,
            boxShadow: enrolled ? `0 0 0 2px ${colors.containerBg}` : 'none',
          }}
        >
          <BenchGlyph enrollment={enrollment} colors={colors} />
        </button>
      </Tooltip>
    </span>
  )
}

/**
 * Hollow / filled / dimmed, in one shape.
 *
 * A diamond rather than a checkbox: the row already carries a round dirty dot
 * and a round conversation bubble, and three circles in one gutter read as one
 * control with three states rather than three controls.
 */
/**
 * Three readings that must be distinguishable at 7px.
 *
 * The first attempt made `excluded` a dimmed grey FILL and `none` a hollow grey
 * outline. At this size those are the same picture: an operator with four
 * excluded members read all of them as unenrolled, because the only difference
 * was 0.45 opacity on a 7px shape. Distinguishing enrolled-from-not is the whole
 * job of this control, so the axes are now separated by SHAPE and HUE rather
 * than by opacity:
 *
 *   - `none`     — hollow, grey. Nothing to do with the bench.
 *   - `included` — solid, accent. In the bench and merged.
 *   - `excluded` — accent OUTLINE with a slash. Still the bench's colour, so it
 *                  reads as membership; the slash says the merge skips it.
 *
 * A diamond rather than a checkbox: the row already carries a round dirty dot
 * and a round conversation bubble, and three circles in one gutter read as one
 * control with three states rather than three controls.
 */
function BenchGlyph({
  enrollment,
  colors,
}: {
  enrollment: EnrollmentState
  colors: ReturnType<typeof useColors>
}): React.JSX.Element {
  // Excluded keeps the bench's own colour. Greying it out was what made it
  // indistinguishable from "not a member" -- the fact it needs to convey is
  // "IS a member, currently skipped".
  const color = enrollment === 'none' ? colors.textTertiary : colors.accent
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <span
        style={{
          width: 7, height: 7, transform: 'rotate(45deg)',
          border: `1px solid ${color}`,
          background: enrollment === 'included' ? color : 'transparent',
        }}
      />
      {/* The slash is the excluded marker: a shape difference, legible at 7px in
          a way a fill-opacity difference is not. */}
      {enrollment === 'excluded' && (
        <span
          data-testid="bench-excluded-slash"
          style={{
            position: 'absolute', top: '50%', left: -2, right: -2,
            height: 1, marginTop: -0.5,
            background: color,
          }}
        />
      )}
    </span>
  )
}
