/**
 * FileExplorerRootHeaderMenu — context menu on a secondary workspace-root
 * header: Remove from Workspace / Reveal in Finder / Collapse All in Folder.
 */
import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { useAnchoredPopover } from '../hooks/useAnchoredPopover'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { transitions } from '../theme-tokens'
import { scrollableMenuStyle } from '../menu-viewport'

function MenuButton({ label, onSelect }: { label: string; onSelect: () => void }): React.JSX.Element {
  const colors = useColors()
  const { hover, pressed, handlers } = useInteractiveState()
  return (
    <button
      onClick={onSelect}
      className="ion-focusable"
      {...handlers}
      style={{
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        padding: '5px 12px',
        border: 'none',
        background: interactiveBg(colors, { hover, pressed }),
        color: colors.textPrimary,
        cursor: 'pointer',
        textAlign: 'left',
        fontSize: 12,
        transition: `background ${transitions.base}`,
      }}
    >
      {label}
    </button>
  )
}

export function FileExplorerRootHeaderMenu({
  x,
  y,
  rootDir,
  onClose,
  onRemoveFromWorkspace,
  onCollapseAllInFolder,
}: {
  x: number
  y: number
  rootDir: string
  onClose: () => void
  onRemoveFromWorkspace: () => void
  onCollapseAllInFolder: () => void
}): React.JSX.Element {
  const colors = useColors()
  const layer = usePopoverLayer()
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClick, true)
    document.addEventListener('keydown', handleKey, true)
    return () => {
      document.removeEventListener('mousedown', handleClick, true)
      document.removeEventListener('keydown', handleKey, true)
    }
  }, [onClose])

  const items = [
    { label: 'Remove from Workspace', action: onRemoveFromWorkspace },
    { label: 'Reveal in Finder', action: () => void window.ion.fsRevealInFinder(rootDir) },
    { label: 'Collapse All in Folder', action: onCollapseAllInFolder },
  ]

  const pos = useAnchoredPopover({ x, y }, { deps: [items.length] })

  const menu = (
    <div
      ref={(node) => {
        ;(menuRef as React.MutableRefObject<HTMLDivElement | null>).current = node
        pos.ref(node)
      }}
      data-ion-ui
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        visibility: pos.ready ? 'visible' : 'hidden',
        ...scrollableMenuStyle(),
        width: 210,
        background: colors.popoverBg,
        border: `1px solid ${colors.popoverBorder}`,
        borderRadius: 8,
        boxShadow: colors.popoverShadow,
        padding: '4px 0',
        zIndex: 99999,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        pointerEvents: 'auto',
      }}
    >
      {items.map((item) => (
        <MenuButton
          key={item.label}
          label={item.label}
          onSelect={() => {
            item.action()
            onClose()
          }}
        />
      ))}
    </div>
  )
  return layer ? createPortal(menu, layer) : menu
}
