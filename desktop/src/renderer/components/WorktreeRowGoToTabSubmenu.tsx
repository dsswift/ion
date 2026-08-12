/**
 * WorktreeRowGoToTabSubmenu — a "Go to tab" list of every open conversation in
 * a worktree or bench directory, for direct focus.
 *
 * Lists every conversation open in the directory, ALL-INCLUSIVE (built from
 * `collectAllDirConversations`, not the operator-only `collectDirConversations`
 * every display surface uses) — so a `conflict-auto-fix` conversation that
 * moved tab groups, or one the operator just wants to check on, is reachable
 * from here even though it is invisible to the row's "open ×N" hint and the
 * hover card. See the module doc-comment in `shared/worktree-conversations.ts`
 * for why the two collectors are kept deliberately separate.
 *
 * Two hosts, two anchor directions:
 * - The worktree row menu (`WorktreeRowMenu`) opens this as a hover submenu to
 *   the RIGHT of its own "Go to tab" row, modeled on `TabStripMoveToGroupSubmenu`.
 * - `BenchBar`'s toolbar button opens this straight BELOW itself — there is no
 *   parent menu row to sit beside, just a persistent toolbar icon.
 * `prefer` selects between them; defaults to the row-menu behaviour since that
 * was this component's original (and still primary) host.
 *
 * Dismissal (outside mousedown + Escape) is self-contained here rather than
 * relying on a host's own outside-dismiss listener, because one host (BenchBar)
 * has no such listener to share — it is a persistent toolbar, not a dismissible
 * popover itself.
 */
import React, { useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import { useAnchoredPopover } from '../hooks/useAnchoredPopover'
import { zoomViewport } from '../viewport-zoom'
import { statusColor } from './WorktreeConversationsCard'
import type { DirConversation } from '../../shared/worktree-conversations'

interface WorktreeRowGoToTabSubmenuProps {
  anchor: { x: number; y: number }
  conversations: readonly DirConversation[]
  /** Closes this portalled submenu while keeping its parent menu open. */
  onClose: () => void
  /** Runs after a conversation selection, when host should close whole hierarchy. */
  onSelect?: () => void
  /**
   * The button that opens this submenu. Its mousedown belongs to the parent
   * menu interaction, not an outside dismissal of this portalled sibling.
   */
  triggerRef?: React.RefObject<HTMLElement | null>
  /**
   * The bounding rect of the parent menu row that triggered this submenu.
   * Same purpose as `MoveToGroupSubmenu`'s `parentRect`: lets the submenu
   * flip to the left of the parent row when there isn't room to the right.
   * Unused when `prefer === 'below'` (BenchBar has no parent row to flip
   * around; the position hook's `anchor`-only fallback is what it uses).
   */
  parentRect?: { left: number; right: number; top: number; bottom: number }
  /**
   * Exposes this submenu's own root node up to a host that runs its own
   * `useOutsideDismiss` alongside this component's self-contained one — the
   * row menu, mirroring `MoveToGroupSubmenu`'s `containerRef`.
   *
   * When hosted inside `WorktreeRowMenu`, this submenu portals as a SIBLING of
   * the row menu's root, not a descendant. The row menu runs its own
   * `useOutsideDismiss` on just its own root, so without this ref a mousedown
   * on a row here reads as "outside the menu" from the ROW MENU's dismiss
   * handler — `dismiss()` fires there and unmounts the whole tree (this
   * submenu included) before the subsequent `click` can reach this
   * component's own `onClick` below. Not needed by `BenchBar`, which has no
   * competing outside-dismiss listener of its own.
   */
  containerRef?: React.RefObject<HTMLDivElement | null>
  /**
   * Anchor direction. `'rightOf'` (default) opens beside a parent menu row —
   * the row menu's usage. `'below'` opens straight under the anchor, for a
   * standalone toolbar button with no parent row to sit beside.
   */
  prefer?: 'below' | 'rightOf'
}

/** Submenu listing every open conversation in a directory, for direct focus. */
export function WorktreeRowGoToTabSubmenu({
  anchor,
  conversations,
  onClose,
  onSelect,
  triggerRef,
  parentRect,
  containerRef,
  prefer = 'rightOf',
}: WorktreeRowGoToTabSubmenuProps): React.JSX.Element | null {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (ref.current?.contains(target) || triggerRef?.current?.contains(target)) return
      onClose()
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('mousedown', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [onClose, triggerRef])

  const vp = zoomViewport()
  const pos = useAnchoredPopover(anchor, {
    prefer,
    parentRect,
    deps: [conversations.length],
  })

  if (!popoverLayer) return null

  return createPortal(
    <motion.div
      ref={(node) => {
        (ref as React.MutableRefObject<HTMLDivElement | null>).current = node
        if (containerRef) (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = node
        pos.ref(node)
      }}
      data-ion-ui
      data-testid="worktree-row-go-to-tab-submenu"
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.1 }}
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        visibility: pos.ready ? 'visible' : 'hidden',
        maxHeight: vp.height - 16,
        overflowY: 'auto',
        pointerEvents: 'auto',
        background: colors.popoverBg,
        border: `1px solid ${colors.popoverBorder}`,
        borderRadius: 8,
        padding: 4,
        zIndex: 10001,
        minWidth: 180,
      }}
    >
      <div className="px-2 py-1 text-[10px] font-medium" style={{ color: colors.textTertiary }}>
        Go to tab
      </div>
      {conversations.map((c) => (
        <button
          key={c.tabId}
          data-testid={`worktree-go-to-tab-${c.tabId}`}
          className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left"
          style={{ fontSize: 12, color: colors.textPrimary, background: 'transparent', border: 'none', cursor: 'pointer' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          onClick={() => {
            useSessionStore.getState().selectTab(c.tabId)
            if (onSelect) onSelect()
            else onClose()
          }}
        >
          <span style={{
            width: 6, height: 6, borderRadius: 3, flexShrink: 0,
            background: statusColor(c.status, colors),
          }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
        </button>
      ))}
    </motion.div>,
    popoverLayer,
  )
}
