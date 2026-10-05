import React, { useCallback, useRef } from 'react'
import { ChatCircle, GitBranch, GitFork } from '@phosphor-icons/react'
import { createPortal } from 'react-dom'
import { useColors } from '../../theme'
import { ContextMenuItem } from '../../components/ContextMenuItem'
import { useAnchoredPopover } from '../../hooks/useAnchoredPopover'
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss'
import { usePopoverLayer } from '../../components/PopoverLayer'
import { useEnvironmentDeveloperSurfaces } from '../connection/developer-surfaces'

interface InboxProjectMenuProps {
  anchor: { x: number; y: number }
  /** The machine the project's checkout is on. */
  environmentId: string
  onNewConversation(): void
  /**
   * `chooseBranch` asks for the branch step even when the project remembers a
   * branch: the "Choose branch…" row, or the worktree row clicked with Alt.
   */
  onNewWorktreeConversation(chooseBranch: boolean): void
  onClose(): void
}

/** Context actions for a project Inbox header. */
export function InboxProjectMenu({
  anchor,
  environmentId,
  onNewConversation,
  onNewWorktreeConversation,
  onClose,
}: InboxProjectMenuProps): React.JSX.Element | null {
  const colors = useColors()
  const layer = usePopoverLayer()
  const menuRef = useRef<HTMLDivElement>(null)
  const dismiss = useCallback(() => onClose(), [onClose])
  useOutsideDismiss([menuRef], dismiss)
  const worktreesOffered = useEnvironmentDeveloperSurfaces(environmentId).worktrees
  const pos = useAnchoredPopover(anchor, { deps: [worktreesOffered] })
  const menu = (
    <div
      ref={(node) => {
        ;(menuRef as React.MutableRefObject<HTMLDivElement | null>).current = node
        pos.ref(node)
      }}
      data-testid="inbox-project-menu"
      data-ion-ui
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        visibility: pos.ready ? 'visible' : 'hidden',
        zIndex: 1000,
        pointerEvents: 'auto',
        minWidth: 220,
        padding: 4,
        border: `1px solid ${colors.popoverBorder}`,
        borderRadius: 6,
        background: colors.popoverBg,
        boxShadow: colors.popoverShadow,
      }}
    >
      <ContextMenuItem onClick={() => { onNewConversation(); onClose() }}>
        <ChatCircle size={14} />
        <span>New conversation</span>
      </ContextMenuItem>
      {worktreesOffered && (
        <ContextMenuItem onClick={(event) => { onNewWorktreeConversation(event.altKey); onClose() }}>
          <GitBranch size={14} />
          <span>New conversation in worktree</span>
        </ContextMenuItem>
      )}
      {worktreesOffered && (
        <ContextMenuItem onClick={() => { onNewWorktreeConversation(true); onClose() }}>
          <GitFork size={14} />
          <span>Choose branch…</span>
        </ContextMenuItem>
      )}
    </div>
  )
  return layer ? createPortal(menu, layer) : menu
}
