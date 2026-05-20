import React, { useEffect, useRef } from 'react'
import { EditorView } from '@codemirror/view'
import { toggleComment } from '@codemirror/commands'
import { gotoLine } from '@codemirror/search'
import { useColors } from '../theme'

interface FileEditorContextMenuProps {
  x: number
  y: number
  isReadOnly: boolean
  viewRef: React.RefObject<EditorView | null>
  onClose: () => void
}

interface MenuItem {
  label: string
  shortcut?: string
  action: () => void
  hidden?: boolean
  disabled?: boolean
}

export function FileEditorContextMenu({ x, y, isReadOnly, viewRef, onClose }: FileEditorContextMenuProps) {
  const colors = useColors()
  const menuRef = useRef<HTMLDivElement>(null)

  // Close on click-away or Escape
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

  const exec = (fn: () => void) => {
    fn()
    onClose()
  }

  const items: (MenuItem | 'separator')[] = [
    {
      label: 'Cut',
      shortcut: '⌘X',
      hidden: isReadOnly,
      action: () => exec(() => {
        const view = viewRef.current
        if (!view) return
        const sel = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)
        if (sel) navigator.clipboard.writeText(sel)
        view.dispatch(view.state.replaceSelection(''))
        view.focus()
      }),
    },
    {
      label: 'Copy',
      shortcut: '⌘C',
      action: () => exec(() => {
        const view = viewRef.current
        if (!view) return
        const sel = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)
        if (sel) navigator.clipboard.writeText(sel)
        view.focus()
      }),
    },
    {
      label: 'Paste',
      shortcut: '⌘V',
      hidden: isReadOnly,
      action: () => exec(async () => {
        const view = viewRef.current
        if (!view) return
        const text = await navigator.clipboard.readText()
        view.dispatch(view.state.replaceSelection(text))
        view.focus()
      }),
    },
    {
      label: 'Select All',
      shortcut: '⌘A',
      action: () => exec(() => {
        const view = viewRef.current
        if (!view) return
        view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
        view.focus()
      }),
    },
    'separator',
    {
      label: 'Toggle Comment',
      shortcut: '⌘/',
      hidden: isReadOnly,
      action: () => exec(() => {
        const view = viewRef.current
        if (!view) return
        toggleComment(view)
        view.focus()
      }),
    },
    {
      label: 'Go to Line...',
      shortcut: '⌘G',
      action: () => exec(() => {
        const view = viewRef.current
        if (!view) return
        gotoLine(view)
      }),
    },
  ]

  const visibleItems = items.filter((it) => it === 'separator' || !it.hidden)

  // Clamp menu position to viewport
  const menuW = 200
  const menuH = visibleItems.length * 30
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
      {visibleItems.map((item, i) => {
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
              justifyContent: 'space-between',
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
            <span>{item.label}</span>
            {item.shortcut && (
              <span style={{ color: colors.textTertiary, fontSize: 11 }}>{item.shortcut}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
