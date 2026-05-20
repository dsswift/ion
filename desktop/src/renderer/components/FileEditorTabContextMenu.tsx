import React, { useEffect, useRef } from 'react'
import { useColors } from '../theme'

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

  const menuW = 200
  const menuH = items.length * 28
  const left = Math.min(x, window.innerWidth - menuW - 8)
  const top = Math.min(y, window.innerHeight - menuH - 8)

  return (
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        left,
        top,
        width: menuW,
        background: colors.containerBg,
        border: `1px solid ${colors.containerBorder}`,
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
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
          <button
            key={item.label}
            onClick={item.action}
            disabled={item.disabled}
            style={{
              display: 'flex',
              alignItems: 'center',
              width: '100%',
              padding: '5px 12px',
              border: 'none',
              background: 'transparent',
              color: item.disabled ? colors.textTertiary : colors.textPrimary,
              cursor: item.disabled ? 'default' : 'pointer',
              textAlign: 'left',
              fontSize: 12,
            }}
            onMouseEnter={(e) => {
              if (!item.disabled) (e.target as HTMLElement).style.background = colors.surfaceHover
            }}
            onMouseLeave={(e) => {
              (e.target as HTMLElement).style.background = 'transparent'
            }}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
