import React, { useCallback, useRef } from 'react'
import { ChatCircle, GitBranch } from '@phosphor-icons/react'
import { createPortal } from 'react-dom'
import { useColors } from '../../theme'
import { ContextMenuItem } from '../../components/ContextMenuItem'
import { useAnchoredPopover } from '../../hooks/useAnchoredPopover'
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss'
import { usePopoverLayer } from '../../components/PopoverLayer'

interface InboxProjectMenuProps {
  anchor: { x: number; y: number }
  onNewConversation(): void
  onNewWorktreeConversation(): void
  onClose(): void
}

/** Context actions for a project Inbox header. */
export function InboxProjectMenu({
  anchor,
  onNewConversation,
  onNewWorktreeConversation,
  onClose,
}: InboxProjectMenuProps): React.JSX.Element | null {
  const colors = useColors()
  const layer = usePopoverLayer()
  const menuRef = useRef<HTMLDivElement>(null)
  const dismiss = useCallback(() => onClose(), [onClose])
  useOutsideDismiss([menuRef], dismiss)
  const pos = useAnchoredPopover(anchor)
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
      <ContextMenuItem onClick={() => { onNewWorktreeConversation(); onClose() }}>
        <GitBranch size={14} />
        <span>New conversation in worktree</span>
      </ContextMenuItem>
    </div>
  )
  return layer ? createPortal(menu, layer) : menu
}
