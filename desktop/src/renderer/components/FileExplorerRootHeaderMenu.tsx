/**
 * FileExplorerRootHeaderMenu — context menu on a workspace-root header.
 *
 * Every root has one, the source repository root included: with New File and
 * New Folder gone from the explorer header, right-clicking the root is the only
 * way to create at the top level of a root, so a root that cannot be
 * right-clicked would have no create path at all.
 *
 * Remove from Workspace appears on mounted folders only — the source
 * repository root is not something the workspace can unmount.
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
  onCreate,
}: {
  x: number
  y: number
  rootDir: string
  onClose: () => void
  /** Mounted folders only; absent on the source repository root. */
  onRemoveFromWorkspace?: () => void
  onCollapseAllInFolder: () => void
  /** Create at the top level of this root (depth 0). */
  onCreate: (type: 'file' | 'folder') => void
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

  type Item = { label: string; action: () => void } | { separator: true }
  const items: Item[] = [
    { label: 'New File', action: () => onCreate('file') },
    { label: 'New Folder', action: () => onCreate('folder') },
    { separator: true },
    { label: 'Reveal in Finder', action: () => void window.ion.fsRevealInFinder(rootDir) },
    { label: 'Collapse All in Folder', action: onCollapseAllInFolder },
    ...(onRemoveFromWorkspace ? [{ separator: true as const }, { label: 'Remove from Workspace', action: onRemoveFromWorkspace }] : []),
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
      {items.map((item, i) => (
        'separator' in item ? (
          <div key={`sep-${i}`} style={{ height: 1, background: colors.containerBorder, margin: '4px 8px' }} />
        ) : (
          <MenuButton
            key={item.label}
            label={item.label}
            onSelect={() => {
              item.action()
              onClose()
            }}
          />
        )
      ))}
    </div>
  )
  return layer ? createPortal(menu, layer) : menu
}
