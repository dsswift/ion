/**
 * WorktreeStageSlot — the operator's workflow marker for a worktree.
 *
 * One optional stage per worktree, from the curated `WORK_STAGES` vocabulary
 * (shared/types-git.ts). The stage is a note the operator writes to their
 * future self ("needs testing", "issue found", "ready to land") so parallel
 * worktrees can be scanned at a glance; no verb is gated on it, and any subset
 * of the stages is a complete workflow. It replaces the two-verdict review
 * pair (good / issue): two states could not carry a real pipeline, and the
 * verdict lived on the bench member, so unenrolled worktrees had nowhere to
 * hold a marker at all.
 *
 * ── Why it lives on the secondary line ──────────────────────────────────────
 * A stage is not a state the row DISCOVERS, it is one the operator RECORDS, so
 * it needs a control that is always present and always clickable. The primary
 * state slot cannot provide that: it holds one indicator chosen by severity,
 * and an operator marker loses that contest to nearly everything (a conflict,
 * failed provisioning, a behind pin, a moved base). The secondary line gives
 * the selector a stable place without adding row height. A list row can align
 * it in a fixed gutter; a group header can keep it at the trailing edge.
 *
 * ── Interaction ─────────────────────────────────────────────────────────────
 * The chip shows the current stage's glyph (or a dashed circle when unset) and
 * opens a one-row strip of all stages. One click sets any stage; clicking the
 * active stage clears it — so any jump, forward or backward, is at most two
 * clicks. Bench pin advances are semantic automation events; they do not
 * prescribe a stage transition.
 */
import React, { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import {
  Bug, Check, CircleDashed, Compass, Flask, GitMerge, Hammer, RocketLaunch,
} from '@phosphor-icons/react'
import { useColors } from '../theme'
import type { ColorPalette } from '../theme/palette-dark'
import { Tooltip } from './git/Tooltip'
import { usePopoverLayer } from './PopoverLayer'
import { useOutsideDismiss } from '../hooks/useOutsideDismiss'
import { useAnchoredPopover } from '../hooks/useAnchoredPopover'
import { zoomRect } from '../viewport-zoom'
import { WORK_STAGES, workStageDescriptor, type WorkStage } from '../../shared/types-git'

export interface WorktreeStageSlotProps {
  stage?: WorkStage
  branchName: string
  /** Set or clear the stage. `null` clears. Absent hides the control. */
  onSetStage?(stage: WorkStage | null): void
}

/** Glyph for one stage, sized for wherever it is mounted. */
export function workStageIcon(stage: WorkStage, size: number, active: boolean): React.ReactNode {
  switch (stage) {
    case 'plan': return <Compass size={size} weight={active ? 'fill' : 'regular'} />
    case 'build': return <Hammer size={size} weight={active ? 'fill' : 'regular'} />
    case 'test': return <Flask size={size} weight={active ? 'fill' : 'regular'} />
    case 'bug': return <Bug size={size} weight={active ? 'fill' : 'regular'} />
    case 'verified': return <Check size={size} weight="bold" />
    // GitMerge has no fill variant that reads at this size; bold marks active.
    case 'merge': return <GitMerge size={size} weight={active ? 'bold' : 'regular'} />
    case 'ready': return <RocketLaunch size={size} weight={active ? 'fill' : 'regular'} />
  }
}

/**
 * Colour for one stage. A function of the palette rather than a token map on
 * the descriptor, because the descriptor table is shared with the main process
 * and the wire — colour is a renderer opinion.
 */
export function workStageColor(stage: WorkStage, colors: ColorPalette): string {
  switch (stage) {
    case 'plan': return colors.infoFg
    case 'build': return colors.warningFg
    // The waiting-on-you purple: `test` means "look at this again", which is
    // exactly the question dot's meaning — and it must be a different hue from
    // `plan`'s blue at 9px.
    case 'test': return colors.statusQuestion
    case 'bug': return colors.dangerFg
    case 'verified': return colors.worktreeGreen
    case 'merge': return colors.accent
    case 'ready': return colors.successFg
  }
}

export function WorktreeStageSlot(props: WorktreeStageSlotProps): React.JSX.Element | null {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const chipRef = useRef<HTMLButtonElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const { branchName } = props

  // No handler, no control. The caller still reserves the width, so the commit
  // subject on line 2 starts at the same x on every row.
  if (!props.onSetStage) return null

  const active = workStageDescriptor(props.stage)

  const openStrip = (): void => {
    setOpen(true)
  }

  return (
    <>
      <Tooltip text={active
        ? `${active.label} — click to change the stage`
        : 'Set a workflow stage for this worktree'}>
        <button
          ref={chipRef}
          data-testid={`worktree-stage-chip-${branchName}`}
          aria-expanded={open}
          onClick={(e) => {
            e.stopPropagation()
            openStrip()
          }}
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            padding: 0, width: 12, height: 12,
            background: 'transparent', border: 'none',
            // An UNSET stage renders as a faint dashed circle rather than
            // nothing: the operator needs to see that a row is unstaged, which
            // is the state a triage pass is looking for. Hiding the chip until
            // hover would make "unstaged" indistinguishable from "no control".
            color: active ? workStageColor(active.id, colors) : colors.textTertiary,
            cursor: 'pointer', flexShrink: 0,
          }}
        >
          {active
            ? workStageIcon(active.id, 10, true)
            : <CircleDashed size={10} />}
        </button>
      </Tooltip>

      {open && popoverLayer && chipRef.current && (() => {
        const rect = zoomRect(chipRef.current!.getBoundingClientRect())
        return createPortal(
          <StageStrip
            anchor={{ x: rect.left, y: rect.bottom }}
            anchorSpace="css"
            activeStage={active?.id}
            branchName={branchName}
            stripRef={stripRef}
            colors={colors}
            onPick={(stage) => {
              props.onSetStage?.(stage === active?.id ? null : stage)
              setOpen(false)
            }}
            onDismiss={() => setOpen(false)}
          />,
          popoverLayer,
        )
      })()}
    </>
  )
}

/**
 * The one-row stage picker. A strip rather than a vertical menu: seven glyphs
 * with labels underneath fit in one compact row, every option is one click,
 * and the workflow order reads left to right the way the operator walks it.
 */
function StageStrip({
  anchor,
  anchorSpace,
  activeStage,
  branchName,
  stripRef,
  colors,
  onPick,
  onDismiss,
}: {
  anchor: { x: number; y: number }
  anchorSpace: 'viewport' | 'css'
  activeStage?: WorkStage
  branchName: string
  stripRef: React.RefObject<HTMLDivElement | null>
  colors: ColorPalette
  onPick(stage: WorkStage): void
  onDismiss(): void
}): React.JSX.Element {
  useOutsideDismiss([stripRef], onDismiss)
  const pos = useAnchoredPopover(anchor, { prefer: 'below', offsetY: 4, anchorSpace })

  const setRefs = (node: HTMLDivElement | null): void => {
    pos.ref(node)
    ;(stripRef as React.MutableRefObject<HTMLDivElement | null>).current = node
  }

  return (
    <motion.div
      ref={setRefs}
      data-ion-ui
      data-testid={`worktree-stage-strip-${branchName}`}
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.1 }}
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        visibility: pos.ready ? 'visible' : 'hidden',
        display: 'flex', alignItems: 'stretch', gap: 2,
        padding: 4,
        pointerEvents: 'auto',
        background: colors.popoverBg,
        border: `1px solid ${colors.popoverBorder}`,
        borderRadius: 6, zIndex: 10000,
        boxShadow: colors.popoverShadow,
      }}
    >
      {WORK_STAGES.map((s) => {
        const isActive = s.id === activeStage
        const color = workStageColor(s.id, colors)
        return (
          <Tooltip key={s.id} text={isActive ? `${s.hint}. Click to clear.` : s.hint}>
            <button
              data-testid={`worktree-stage-option-${branchName}-${s.id}`}
              aria-pressed={isActive}
              onClick={(e) => {
                e.stopPropagation()
                onPick(s.id)
              }}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                padding: '4px 5px', minWidth: 32,
                background: isActive ? colors.surfaceHover : 'transparent',
                border: 'none', borderRadius: 4,
                color: isActive ? color : colors.textSecondary,
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.surfaceHover }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = isActive ? colors.surfaceHover : 'transparent' }}
            >
              {workStageIcon(s.id, 12, isActive)}
              <span style={{ fontSize: 8, lineHeight: 1 }}>{s.label}</span>
            </button>
          </Tooltip>
        )
      })}
    </motion.div>
  )
}
