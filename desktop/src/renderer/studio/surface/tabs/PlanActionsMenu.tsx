import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { usePopoverLayer } from '../../../components/PopoverLayer'
import { useAnchoredPopover } from '../../../hooks/useAnchoredPopover'
import { useInteractiveState, interactiveBg } from '../../../hooks/useInteractiveState'
import { scrollableMenuStyle } from '../../../menu-viewport'
import { useColors } from '../../../theme'
import { transitions } from '../../../theme-tokens'

function MenuButton({ label, onSelect }: { label: string; onSelect: () => void }): React.JSX.Element {
  const colors = useColors()
  const { hover, pressed, handlers } = useInteractiveState()

  return (
    <button
      type="button"
      role="menuitem"
      className="ion-focusable"
      onClick={onSelect}
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

interface PlanActionsMenuProps {
  anchor: { x: number; y: number }
  trigger: HTMLElement | null
  onClose: () => void
  onCopyPath: () => void
  onCopyContents: () => void
  onDownload: () => void
}

/** Shortcuts for the plan currently shown in the Studio plan surface. */
export function PlanActionsMenu({
  anchor,
  trigger,
  onClose,
  onCopyPath,
  onCopyContents,
  onDownload,
}: PlanActionsMenuProps): React.JSX.Element {
  const colors = useColors()
  const layer = usePopoverLayer()
  const menuRef = useRef<HTMLDivElement>(null)
  const pos = useAnchoredPopover(anchor, { deps: [3] })

  useEffect(() => {
    const handleClick = (event: MouseEvent): void => {
      if (trigger?.contains(event.target as Node)) return
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose()
    }
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClick, true)
    document.addEventListener('keydown', handleKey, true)
    return () => {
      document.removeEventListener('mousedown', handleClick, true)
      document.removeEventListener('keydown', handleKey, true)
    }
  }, [onClose, trigger])

  const select = (action: () => void): void => {
    action()
    onClose()
  }

  const menu = (
    <div
      ref={(node) => {
        ;(menuRef as React.MutableRefObject<HTMLDivElement | null>).current = node
        pos.ref(node)
      }}
      role="menu"
      aria-label="Plan actions"
      data-ion-ui
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        visibility: pos.ready ? 'visible' : 'hidden',
        ...scrollableMenuStyle(),
        width: 190,
        padding: '4px 0',
        background: colors.popoverBg,
        border: `1px solid ${colors.popoverBorder}`,
        borderRadius: 8,
        boxShadow: colors.popoverShadow,
        zIndex: 99999,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        pointerEvents: 'auto',
      }}
    >
      <MenuButton label="Copy Plan Path" onSelect={() => select(onCopyPath)} />
      <MenuButton label="Copy Plan Contents" onSelect={() => select(onCopyContents)} />
      <div style={{ height: 1, background: colors.containerBorder, margin: '4px 0' }} />
      <MenuButton label="Download Plan" onSelect={() => select(onDownload)} />
    </div>
  )

  return layer ? createPortal(menu, layer) : menu
}
