import React, { useEffect, useRef } from 'react'
import { PushPin, PushPinSlash } from '@phosphor-icons/react'
import { createPortal } from 'react-dom'
import { ContextMenuItem } from '../../components/ContextMenuItem'
import { useAnchoredPopover } from '../../hooks/useAnchoredPopover'
import { usePopoverLayer } from '../../components/PopoverLayer'
import { useColors } from '../../theme'
import { rWarn } from '../../rendererLogger'
import { scrollableMenuStyle } from '../../menu-viewport'
import { useSessionStore } from '../../stores/sessionStore'

export function InboxBenchTerminalMenu({
  anchor,
  tabId,
  pinned,
  onClose,
}: {
  anchor: { x: number; y: number }
  tabId: string
  pinned: boolean
  onClose: () => void
}): React.JSX.Element {
  const colors = useColors()
  const layer = usePopoverLayer()
  const menuRef = useRef<HTMLDivElement>(null)
  const pos = useAnchoredPopover(anchor)

  useEffect(() => {
    const dismiss = (event: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose()
    }
    const dismissKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', dismiss, true)
    document.addEventListener('keydown', dismissKey, true)
    return () => {
      document.removeEventListener('mousedown', dismiss, true)
      document.removeEventListener('keydown', dismissKey, true)
    }
  }, [onClose])

  const menu = (
    <div
      ref={(node) => {
        menuRef.current = node
        pos.ref(node)
      }}
      data-ion-ui
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}
      style={{
        position: 'fixed', left: pos.left, top: pos.top,
        visibility: pos.ready ? 'visible' : 'hidden',
        ...scrollableMenuStyle(), minWidth: 160, padding: 4,
        background: colors.popoverBg, border: `1px solid ${colors.popoverBorder}`,
        borderRadius: 8, boxShadow: colors.popoverShadow,
        pointerEvents: 'auto', zIndex: 99999,
      }}
    >
      <ContextMenuItem onClick={() => {
        if (pinned) {
          useSessionStore.getState().unpinTab(tabId)
        } else if (!useSessionStore.getState().pinTab(tabId)) {
          rWarn('inbox.terminal', 'pin request refused', { tab_id: tabId.slice(0, 8) })
        }
        onClose()
      }}>
        {pinned
          ? <PushPinSlash size={14} color={colors.textSecondary} />
          : <PushPin size={14} color={colors.textSecondary} />}
        <span>{pinned ? 'Unpin terminal' : 'Pin terminal'}</span>
      </ContextMenuItem>
    </div>
  )
  return layer ? createPortal(menu, layer) : menu
}
