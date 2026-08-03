/**
 * WorktreeRow — one worktree, rendered identically everywhere it appears.
 *
 * Used by the git-panel Worktrees section and the ATV mount. One component so
 * the state vocabulary (dirty dot, unlanded count, stale-base indicator) cannot
 * drift between surfaces.
 *
 * Clicking the row OPENS OR CYCLES conversations in the worktree. That is the
 * re-entry path: closing a worktree tab no longer destroys anything, so the
 * operator needs a way back in without knowing the `~/.ion/worktrees/...` path.
 * When several conversations are open there, each click advances to the next.
 *
 * ── Why the controls lead and the name trails ───────────────────────────────
 * Every control used to sit at the END of the row, after a label of unbounded
 * length. In a 320px panel a long label pushed the sync button, the unlanded
 * count, and the ⋯ menu past the right edge, so reaching them meant scrolling
 * sideways — and the badges that say whether a worktree needs attention were
 * off-screen entirely. The controls now sit in a FIXED-WIDTH leading gutter
 * whose slots reserve their space even when empty, so every name starts at the
 * same x, every control is at a stable position, and the name is the only thing
 * that ellipsises.
 *
 * ── Why iOS does not mirror this ────────────────────────────────────────────
 * `ios/IonRemote/Views/WorktreeRowView.swift` keeps its trailing badges
 * deliberately. The shared vocabulary (dirty dot, `n↑`, base-moved, provision
 * state) is identical on both sides and no snapshot field moved; only the
 * arrangement differs, because the failure this fixes is desktop-only. A
 * SwiftUI List row is full-width and truncates rather than scrolling, and iOS's
 * verbs are swipe actions and a context menu, not inline buttons — so there is
 * no unreachable control there to rescue.
 */
import React from 'react'

import { useColors } from '../theme'
import { Tooltip } from './git/Tooltip'
import { HoverCard } from './git/HoverCard'
import { WorktreeConversationsCard } from './WorktreeConversationsCard'
import { useSessionStore } from '../stores/sessionStore'
import { WorktreeStateSlot } from './WorktreeStateSlot'
import { WorktreeEnrollmentSlot } from './WorktreeEnrollmentSlot'
import { WorktreeReviewSlot } from './WorktreeReviewSlot'
import { resolveRowState, resolveRowWords } from './worktreeRowState'
import { describeOpenConversations, type DirConversation } from '../../shared/worktree-conversations'
import type { WorktreeInventoryEntry, IntegrationMember, EnrollmentState } from '../../shared/types'

/**
 * Width of every gutter slot, and the gutter total.
 *
 * Exported so the second line's indent is derived from the same numbers rather
 * than a hand-copied constant that drifts the moment a slot changes width.
 */
/**
 * `open` and `menu` are deliberately absent.
 *
 * A per-row conversation bubble duplicated the row's own click -- clicking
 * anywhere on a row already opens or cycles its conversations -- and it used the
 * SAME glyph as the bench bar's Open-conversation button while meaning something
 * different: the row's filled when conversations existed, the bar's never
 * filled. Two identical icons with different semantics in one panel, one of them
 * redundant. Creating a NEW conversation moved to the row menu, which is where a
 * distinct verb belongs.
 *
 * The `⋯` button went the same way: right-clicking anywhere on the row already
 * opens the same menu at the cursor, so the button was a second trigger for a
 * gesture the row already had -- and a permanently reserved 14px of a gutter
 * competing with the worktree name for width.
 */
const SLOT = { bench: 14, activity: 6, dirty: 7, unlanded: 16, state: 13 } as const
const GUTTER_GAP = 3
export const WORKTREE_ROW_GUTTER_WIDTH =
  SLOT.bench + SLOT.activity + SLOT.dirty + SLOT.unlanded + SLOT.state + GUTTER_GAP * 4

export interface WorktreeRowProps {
  entry: WorktreeInventoryEntry
  /**
   * Every conversation currently open in this worktree, in tab order. Empty
   * when none are. This used to be a single `openTabId`/`openTabIndex` pair,
   * which could name only the FIRST conversation — so a worktree hosting three
   * of them advertised one and hid the rest.
   */
  openConversations?: readonly DirConversation[]
  /**
   * This worktree's bench membership, when it has one. Absent means unenrolled
   * -- a different fact from `enabled: false`, which is enrolled-but-skipped.
   */
  membership?: IntegrationMember
  /** 1-based merge position within the bench. Present exactly when enrolled. */
  order?: number
  /** True when an enrolled row sits directly above / below this one. */
  railStarts?: boolean
  railContinues?: boolean
  /**
   * Aggregate conversation status for this worktree, from
   * `getGroupStatusColor` -- the same fold the tab-group pills use.
   *
   * Passed in rather than derived here because the row is given
   * `DirConversation`s (a display projection), not `TabState`s. Reusing the
   * group cascade is the point: a coloured dot already means "what is happening
   * in these conversations" everywhere else in the app, so the worktree row
   * should not invent a second vocabulary for the same question.
   */
  activity?: { bg: string; pulse: boolean; glow: boolean; glowColor: string }
  /** True while a sync is in flight for this worktree. */
  syncing?: boolean
  onOpen(): void
  onSync(): void
  onMenu(anchor: { x: number; y: number }): void
  /** Open the conflict-resolution dialog. Offered when `operationState` is set. */
  onResolve?(): void
  /** Add to / remove from the bench. */
  onToggleEnrollment?(): void
  /** Flip included/excluded on an already-enrolled worktree. */
  onToggleIncluded?(): void
  /** Advance the bench pin to this worktree's current contribution. */
  onUpdatePin?(): void
  /** Reveal the bench's conflict detail for this member. */
  onShowBenchConflict?(): void
  /** Record or clear the operator's verdict on this member's current pin. */
  onSetReview?(review: 'good' | 'issue' | null): void
  /**
   * Native drag props for bench reordering, supplied only for enrolled rows.
   * Spread onto the row root rather than handled here: the ORDER lives in the
   * list, so the list owns the gesture and the row just carries it.
   */
  dragHandlers?: {
    draggable?: boolean
    onDragStart?(e: React.DragEvent): void
    onDragOver?(e: React.DragEvent): void
    onDragEnd?(): void
    onDrop?(e: React.DragEvent): void
  }
  /** True while this row is the one being dragged. */
  dragging?: boolean
  /** True while a drop on this row would land here. */
  dropTarget?: boolean
}

export function WorktreeRow(props: WorktreeRowProps): React.JSX.Element {
  const colors = useColors()
  const { entry, syncing } = props
  const openConversations = props.openConversations ?? []

  // Two separate facts, two separate indicators. They used to share one dot:
  // the circle reported DIRTY in worktreeGreen, which said "success" about a
  // worktree holding unsaved work, and said nothing at all about whether
  // anything was running in it.
  //
  //  - The circle is now ACTIVITY -- the aggregate of this worktree's
  //    conversations, using the same cascade and the same colours as the tab
  //    and group pills. A round coloured dot already means "what is happening
  //    here" everywhere else in the app.
  //  - Dirty gets its own marker beside it (see the `worktreeDirty` token):
  //    not green, which claims success; not red, since work in progress is the
  //    normal state of a worktree in use; and not amber, which is already the
  //    base-moved sync signal in this same gutter.
  const activity = props.activity

  // The human title when the worktree has earned one, else the directory slug.
  // The slug is never a good name -- it is just the only one available before
  // the first prompt names the work.
  const displayName = entry.title || entry.label
  const openLabel = describeOpenConversations(openConversations)

  // WHICH indicator the state slot shows, and which facts it could not show,
  // are both decided by one pure function so the row and its tests agree.
  const rowState = resolveRowState({ entry, membership: props.membership, syncing })
  const words = resolveRowWords({ entry, membership: props.membership, syncing })
  const enrollment: EnrollmentState = props.membership
    ? (props.membership.enabled ? 'included' : 'excluded')
    : 'none'

  return (
    <div
      data-ion-ui
      data-testid={`worktree-row-${entry.branchName}`}
      {...(props.dragHandlers ?? {})}
      onClick={props.onOpen}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        props.onMenu({ x: e.clientX, y: e.clientY })
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        padding: '3px 6px',
        borderRadius: 4,
        cursor: 'pointer',
        userSelect: 'none',
        flexShrink: 0,
        // Drag feedback. The dragged row fades; the row it would land on grows a
        // top rule, so the destination is a LINE between rows rather than a
        // highlight that reads as "this row is selected".
        opacity: props.dragging ? 0.4 : 1,
        boxShadow: props.dropTarget && !props.dragging
          ? `inset 0 1px 0 0 ${colors.accent}`
          : 'none',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = colors.surfaceHover }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
        {/* ── Control gutter ──────────────────────────────────────────────
            Fixed width, never shrinks. Each slot keeps its width when it has
            nothing to show, which is what aligns every name in the list to the
            same x — a gutter that collapsed its empty slots would reproduce the
            ragged left edge this layout exists to remove. */}
        <div
          data-testid={`worktree-gutter-${entry.branchName}`}
          style={{
            display: 'flex', alignItems: 'center', gap: GUTTER_GAP,
            width: WORKTREE_ROW_GUTTER_WIDTH, flexShrink: 0,
          }}
        >
          {/* Bench membership leads the gutter: it is the only control that
              changes what the BUILD contains, and grouping enrolled rows at the
              top of the list makes its column read as the bench's stack. */}
          <WorktreeEnrollmentSlot
            enrollment={enrollment}
            order={props.order}
            railStarts={!!props.railStarts}
            railContinues={!!props.railContinues}
            branchName={entry.branchName}
            width={SLOT.bench}
            onToggleEnrollment={() => props.onToggleEnrollment?.()}
            onToggleIncluded={() => props.onToggleIncluded?.()}
          />

          {/* Activity: the aggregate of this worktree's conversations, in the
              app's existing dot vocabulary -- same colours, same pulse, same
              cascade as the tab and group pills. Idle worktrees render the
              hollow grey ring, so only the ones doing something advertise it. */}
          <Slot width={SLOT.activity}>
            <Tooltip text={activityLabel(openConversations.length, !!activity?.pulse)}>
              <span
                data-testid={`worktree-activity-${entry.branchName}`}
                className={activity?.pulse ? 'animate-pulse' : undefined}
                style={{
                  width: SLOT.activity, height: SLOT.activity, borderRadius: SLOT.activity / 2,
                  flexShrink: 0,
                  background: activity ? activity.bg : 'transparent',
                  border: activity ? 'none' : `1px solid ${colors.statusIdle}`,
                  boxShadow: activity?.glow ? `0 0 5px ${activity.glowColor}` : 'none',
                }}
              />
            </Tooltip>
          </Slot>

          {/* Dirty: uncommitted work. Its own indicator, because it answers a
              different question from the activity dot and gates different verbs
              -- sync and land both refuse while it is set.

              An exclamation, not a filled shape. That is what lets it borrow the
              danger hue without reading as a failure: `git status` has trained
              everyone that a terse mark beside a path means "this has changes",
              and sitting next to the commit count is exactly the context that
              makes it read as a git state rather than an error. It also keeps the
              two markers distinct by SHAPE, which a colour difference alone
              cannot do at this size -- or at all, for an operator who cannot
              separate the hues. */}
          <Slot width={SLOT.dirty}>
            {entry.isDirty && (
              <Tooltip text="Uncommitted changes. Sync and land are blocked until they are committed or stashed.">
                <span
                  data-testid={`worktree-dirty-${entry.branchName}`}
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    color: colors.worktreeDirty, flexShrink: 0,
                    fontSize: 11, fontWeight: 700, lineHeight: 1,
                  }}
                >
                  !
                </span>
              </Tooltip>
            )}
          </Slot>

          {/* Unlanded commits: what this worktree is holding that the feature
              branch does not have yet. Right-aligned so the digits line up
              down the list rather than jittering with the count's width. */}
          <Slot width={SLOT.unlanded} justify="flex-end">
            {entry.unlandedCommitCount > 0 && (
              <Tooltip text={`${entry.unlandedCommitCount} commit${entry.unlandedCommitCount === 1 ? '' : 's'} not yet landed`}>
                <span
                  data-testid={`worktree-unlanded-${entry.branchName}`}
                  style={{ fontSize: 9, color: colors.unlandedCount, flexShrink: 0 }}
                >
                  {entry.unlandedCommitCount}↑
                </span>
              </Tooltip>
            )}
          </Slot>

          {/* One slot, strict priority -- see worktreeRowState for the order
              and why each rung outranks the next. Every fact the slot cannot
              show reaches line 2 below, so the summary never hides anything. */}
          <Slot width={SLOT.state}>
            <WorktreeStateSlot
              state={rowState}
              branchName={entry.branchName}
              onResolve={props.onResolve}
              onSync={props.onSync}
              onUpdatePin={props.onUpdatePin}
              onShowBenchConflict={props.onShowBenchConflict}
            />
          </Slot>

        </div>

        {/* ONE identifier on the row, and it is the human one when it exists.
            The machine strings (branch, slug, path) move into the hover card:
            they are what git verbs name, so they must stay reachable, but they
            describe nothing about the work and so do not earn the row. */}
        <HoverCard
          maxWidth={320}
          fallbackTitle={`Branch ${entry.branchName}`}
          content={
            <WorktreeConversationsCard
              heading={displayName}
              identifiers={[
                { label: 'branch', value: entry.branchName },
                { label: 'dir', value: entry.label },
                { label: 'path', value: entry.worktreePath },
              ]}
              conversations={openConversations}
              onSelectConversation={(tabId) => useSessionStore.getState().selectTab(tabId)}
              menuHint
            />
          }
          style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}
        >
          <span
            data-testid={`worktree-name-${entry.branchName}`}
            style={{ fontSize: 11, color: colors.textPrimary, fontWeight: 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {displayName}
          </span>
        </HoverCard>

        {/* Open-or-focus sits next to the name it qualifies. With several
            conversations open it names the COUNT, not one of the tabs:
            "open in tab 3" would be true of one of them and false of the row. */}
        {openLabel && (
          <span
            data-testid={`worktree-open-label-${entry.branchName}`}
            style={{ fontSize: 9, color: colors.accent, flexShrink: 0 }}
          >
            {openLabel}
          </span>
        )}
      </div>

      {/* Second line, aligned under the name: the WORDS.
          Every fact the single state slot could not show lands here and never
          shrinks, because "why is this excluded" and "why can I not sync" are
          more urgent than which commit is on top. The commit subject then takes
          what is left and ellipsises -- it tells worktrees apart far better
          than a generated slug does. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
        {/* Line 2 mirrors line 1's gutter instead of a bare paddingLeft, so the
            review pair lands in a fixed column the pointer can rely on -- and so
            the commit subject starts at the same x whether or not a row has
            verdict buttons. */}
        <div
          data-testid={`worktree-gutter2-${entry.branchName}`}
          style={{
            display: 'flex', alignItems: 'center', gap: GUTTER_GAP,
            width: WORKTREE_ROW_GUTTER_WIDTH, flexShrink: 0,
            justifyContent: 'flex-end',
          }}
        >
          <WorktreeReviewSlot
            membership={props.membership}
            branchName={entry.branchName}
            onSetReview={props.onSetReview}
          />
        </div>
        {words.map((word) => (
          <span
            key={word}
            data-testid={`worktree-word-${entry.branchName}-${word.replace(/[^a-z]+/gi, '-')}`}
            style={{ fontSize: 9, flexShrink: 0, color: wordColor(word, colors) }}
          >
            {word}
          </span>
        ))}
        <span style={{ fontSize: 9, color: colors.textTertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1, minWidth: 0 }}>
          {entry.lastCommitSubject || 'no commits yet'}
        </span>
        {!entry.sourceBranch && (
          <Tooltip text="Ion did not create this worktree, so its source branch is unknown. Land and sync will ask.">
            <span
              data-testid={`worktree-unknown-source-${entry.branchName}`}
              style={{ fontSize: 9, color: colors.textTertiary, flexShrink: 0, fontStyle: 'italic' }}
            >
              source unknown
            </span>
          </Tooltip>
        )}
      </div>
    </div>
  )
}

/**
 * Tooltip for the activity dot.
 *
 * Names the COUNT and whether anything is live, rather than the exact status:
 * the dot's colour already carries the specific state through the shared
 * vocabulary, and restating it here would be a second place to keep in sync
 * with the cascade.
 */
function activityLabel(count: number, live: boolean): string {
  if (count === 0) return 'No conversations open here'
  const noun = count === 1 ? 'conversation' : 'conversations'
  return live
    ? `${count} ${noun} here, one of them active`
    : `${count} ${noun} here, all idle`
}

/**
 * Colour for a line-2 word, by severity.
 *
 * Keyed on the word itself rather than passed alongside it: the words come from
 * `resolveRowWords`, which is pure data with no styling opinion, and threading a
 * colour through would put a renderer concern into the state model.
 */
function wordColor(word: string, colors: ReturnType<typeof useColors>): string {
  if (word.startsWith('conflict') || word === 'bench conflict' || word === 'setup failed') return colors.dangerFg
  if (word === 'behind' || word === 'syncing') return colors.warningFg
  return colors.textTertiary
}

/**
 * One gutter cell: a fixed-width box that holds its space when empty.
 *
 * The reserved width is the whole point — it is what keeps every name in the
 * list starting at the same x and every control at a stable position, so the
 * operator's pointer lands on the same button in every row.
 */
function Slot({
  width,
  justify = 'center',
  children,
}: {
  width: number
  justify?: 'center' | 'flex-end'
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <span
      data-ion-slot
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: justify,
        width, flexShrink: 0,
      }}
    >
      {children}
    </span>
  )
}
