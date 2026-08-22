import React from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { getTabStatusColor } from './TabStripShared'
import { StatusDot } from './TabStripStatusDot'

/**
 * WorktreeConversationStatusDot — live tab-status indicator for a conversation
 * named in a worktree or bench list.
 *
 * Directory-list projections deliberately retain only display identity and the
 * coarse tab status. The full status vocabulary lives on TabState and its
 * ConversationPane, so this component resolves the current tab by identity and
 * reuses the exact cascade and renderer used by tab pills. A missing tab renders
 * nothing: a just-closed conversation must not leave its old status behind in a
 * portal that is closing a frame later.
 */
export function WorktreeConversationStatusDot({ tabId }: { tabId: string }): React.JSX.Element | null {
  const colors = useColors()
  const tab = useSessionStore((s) => s.tabs.find((candidate) => candidate.id === tabId) ?? null)

  // getTabStatusColor reads the pane through getState for its activity and
  // waiting folds. Subscribe only to this conversation's pane so a stream in an
  // unrelated tab does not repaint every row in an open worktree list.
  useSessionStore((s) => s.conversationPanes.get(tabId))

  if (!tab) return null

  return (
    <span
      data-testid={`worktree-conversation-status-${tabId}`}
      style={{ display: 'inline-flex', width: 6, height: 6, flexShrink: 0 }}
    >
      <StatusDot derived={getTabStatusColor(tab, colors)} pillIcon={tab.pillIcon} />
    </span>
  )
}
