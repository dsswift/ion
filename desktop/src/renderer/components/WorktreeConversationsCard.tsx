/**
 * WorktreeConversationsCard — what a worktree (or bench) actually IS, on hover.
 *
 * ── The problem it answers ──────────────────────────────────────────────────
 * A worktree row can only show one line of text, and every identifier competing
 * for that line is a machine string: the directory slug (`ion-a3f1`), the branch
 * (`wt/ion-a3f1`), a commit sha. The row therefore shows the human title and
 * nothing else useful — which is right for scanning, but leaves the operator
 * with no way to reach the identifiers git verbs actually name, and no idea
 * which conversations are living in there.
 *
 * The hover card carries both: the machine identity the row gave up, and the
 * conversation list that tells the operator what the worktree holds right now.
 *
 * Shared by the worktree rows, the bench member rows, and the bench header, so
 * the vocabulary cannot differ between them.
 */
import React from 'react'
import { useColors } from '../theme'
import { conversationRoleLabel, type DirConversation } from '../../shared/worktree-conversations'

export interface WorktreeConversationsCardProps {
  /** Human title when the worktree has one; the caller falls back to the slug. */
  heading: string
  /**
   * The machine identifiers, in the order they matter: branch first (every git
   * verb names it), then the directory slug, then the absolute path.
   */
  identifiers: Array<{ label: string; value: string }>
  conversations: readonly DirConversation[]
  /**
   * Footer naming the right-click menu.
   *
   * The row's `⋯` button was removed as a duplicate of the right-click gesture,
   * so the card is where that gesture gets advertised -- a menu reachable only
   * by a gesture nothing mentions is a menu most operators never find.
   */
  menuHint?: boolean
  /** Names what the conversations are open IN, e.g. 'worktree' or 'bench'. */
  emptyNoun?: string
  /**
   * Navigate to a conversation when its row is clicked. Optional because some
   * hosts render the card purely informationally; when present, rows become
   * real navigation targets (which is what the status-dot comment promises).
   */
  onSelectConversation?: (tabId: string) => void
}

/**
 * A status is rendered as a dot in the same vocabulary the tab strip uses:
 * running is the only state worth a colour here, because it is the only one
 * that changes what clicking through will find.
 *
 * Exported so `WorktreeRowGoToTabSubmenu` (the row menu's "Go to tab" list)
 * renders the identical dot vocabulary rather than a second, drifting copy of
 * this cascade — the two are the only surfaces that render a conversation
 * list with a status dot per row.
 */
export function statusColor(status: string, colors: ReturnType<typeof useColors>): string {
  if (status === 'running' || status === 'connecting') return colors.accent
  if (status === 'error') return colors.dangerFg
  return colors.textTertiary
}

export function WorktreeConversationsCard({
  heading,
  identifiers,
  conversations,
  emptyNoun = 'worktree',
  menuHint = false,
  onSelectConversation,
}: WorktreeConversationsCardProps): React.JSX.Element {
  const colors = useColors()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, padding: '2px 0', minWidth: 180 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: colors.textPrimary }}>
        {heading}
      </span>

      {/* The identifiers the row no longer shouts. Monospace because these are
          strings the operator copies into a terminal, not prose. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {identifiers.map((id) => (
          <div key={id.label} style={{ display: 'flex', gap: 5, alignItems: 'baseline' }}>
            <span style={{ fontSize: 9, color: colors.textTertiary, flexShrink: 0 }}>{id.label}</span>
            <span style={{
              fontSize: 9, color: colors.textSecondary, fontFamily: 'monospace',
              overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {id.value}
            </span>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {conversations.length === 0 ? (
          <span data-testid="hover-card-no-conversations" style={{ fontSize: 9, color: colors.textTertiary, fontStyle: 'italic' }}>
            No conversations open in this {emptyNoun}
          </span>
        ) : (
          conversations.map((c) => (
            <div
              key={c.tabId}
              data-testid={`hover-card-conversation-${c.tabId}`}
              onClick={onSelectConversation ? () => onSelectConversation(c.tabId) : undefined}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                cursor: onSelectConversation ? 'pointer' : 'default',
              }}
            >
              <span style={{
                width: 5, height: 5, borderRadius: 3, flexShrink: 0,
                background: statusColor(c.status, colors),
              }} />
              <span style={{
                fontSize: 10, color: colors.textPrimary,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {c.title}
              </span>
              {conversationRoleLabel(c.tabRole) && (
                <span style={{ fontSize: 9, color: colors.accent, flexShrink: 0 }}>
                  {conversationRoleLabel(c.tabRole)}
                </span>
              )}
              {/* The status dot is the only trailing detail worth the space.
                  This used to print `tab {c.index}` -- a number the tab strip
                  never shows, so the operator could not act on it, and one that
                  goes wrong the moment tabs are reordered. Clicking the row goes
                  to the conversation (onSelectConversation), which is what the
                  number was standing in for. */}
            </div>
          ))
        )}
      </div>

      {menuHint && (
        <span style={{ fontSize: 9, color: colors.textTertiary, fontStyle: 'italic' }}>
          Right-click for actions
        </span>
      )}
    </div>
  )
}
