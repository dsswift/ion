import React, { useEffect, useRef } from 'react'
import { useColors } from '../theme'
import { useAnchoredPopover } from '../hooks/useAnchoredPopover'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { transitions } from '../theme-tokens'
import { scrollableMenuStyle } from '../menu-viewport'

/** Menu entry button with the standard hover/pressed/disabled states. */
function TabMenuButton({
  label,
  disabled,
  onSelect,
  colors,
}: {
  label: string
  disabled?: boolean
  onSelect: () => void
  colors: ReturnType<typeof useColors>
}) {
  const { hover, pressed, handlers } = useInteractiveState()
  return (
    <button
      onClick={onSelect}
      disabled={disabled}
      className="ion-focusable"
      {...handlers}
      style={{
        display: 'flex',
        alignItems: 'center',
        width: '100%',
        padding: '5px 12px',
        border: 'none',
        background: disabled ? 'transparent' : interactiveBg(colors, { hover, pressed }),
        color: colors.textPrimary,
        opacity: disabled ? 0.45 : undefined,
        cursor: disabled ? 'default' : 'pointer',
        textAlign: 'left',
        fontSize: 12,
        transition: `background ${transitions.base}`,
      }}
    >
      {label}
    </button>
  )
}

interface TabContextMenuProps {
  x: number
  y: number
  filePath: string | null
  onClose: () => void
  onCloseTab: () => void
  onCloseOthers: () => void
  onCloseAll: () => void
  onCloseToRight: () => void
  onCopyPath: () => void
  onCopyRelativePath: () => void
  onRevealInFinder: () => void
  onOpenInVSCode: () => void
}

export function FileEditorTabContextMenu({
  x, y, filePath, onClose,
  onCloseTab, onCloseOthers, onCloseAll, onCloseToRight,
  onCopyPath, onCopyRelativePath, onRevealInFinder, onOpenInVSCode,
}: TabContextMenuProps) {
  const colors = useColors()
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClick, true)
    document.addEventListener('keydown', handleKey, true)
    return () => {
      document.removeEventListener('mousedown', handleClick, true)
      document.removeEventListener('keydown', handleKey, true)
    }
  }, [onClose])

  const exec = (fn: () => void) => { fn(); onClose() }

  type Item = { label: string; action: () => void; disabled?: boolean } | 'separator'

  const items: Item[] = [
    { label: 'Close', action: () => exec(onCloseTab) },
    { label: 'Close Others', action: () => exec(onCloseOthers) },
    { label: 'Close All', action: () => exec(onCloseAll) },
    { label: 'Close to the Right', action: () => exec(onCloseToRight) },
    'separator',
    { label: 'Copy Path', action: () => exec(onCopyPath), disabled: !filePath },
    { label: 'Copy Relative Path', action: () => exec(onCopyRelativePath), disabled: !filePath },
    { label: 'Reveal in Finder', action: () => exec(onRevealInFinder), disabled: !filePath },
    { label: 'Open in VS Code', action: () => exec(onOpenInVSCode), disabled: !filePath },
  ]

  // Measured placement. This used to derive the menu height from
  // `items.length * 28` — a guess that silently drifts the moment a row is
  // added, a label wraps, or the font size changes, and the drift is invisible
  // until the menu hangs off the screen edge again.
  const pos = useAnchoredPopover({ x, y }, { deps: [items.length] })

  const menuW = 200

  return (
    <div
      ref={(node) => { (menuRef as React.MutableRefObject<HTMLDivElement | null>).current = node; pos.ref(node) }}
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        visibility: pos.ready ? 'visible' : 'hidden',
        ...scrollableMenuStyle(),
        width: menuW,
        background: colors.containerBg,
        border: `1px solid ${colors.containerBorder}`,
        borderRadius: 8,
        boxShadow: colors.popoverShadow,
        padding: '4px 0',
        zIndex: 99999,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: 12,
      }}
    >
      {items.map((item, i) => {
        if (item === 'separator') {
          return (
            <div
              key={`sep-${i}`}
              style={{ height: 1, background: colors.containerBorder, margin: '4px 8px' }}
            />
          )
        }
        return (
          <TabMenuButton
            key={item.label}
            label={item.label}
            disabled={item.disabled}
            onSelect={item.action}
            colors={colors}
          />
        )
      })}
    </div>
  )
}
