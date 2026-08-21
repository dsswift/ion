import React, { useEffect, useRef } from 'react'
import { EditorView } from '@codemirror/view'
import { toggleComment } from '@codemirror/commands'
import { gotoLine } from '@codemirror/search'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { useAnchoredPopover } from '../hooks/useAnchoredPopover'
import { transitions } from '../theme-tokens'
import { rWarn, rError } from '../rendererLogger'
import { scrollableMenuStyle } from '../menu-viewport'

/** Menu entry button with the standard hover/pressed/disabled states. */
function EditorMenuButton({
  label,
  shortcut,
  disabled,
  onSelect,
  colors,
}: {
  label: string
  shortcut?: string
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
        justifyContent: 'space-between',
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
      <span>{label}</span>
      {shortcut && (
        <span style={{ color: colors.textTertiary, fontSize: 11 }}>{shortcut}</span>
      )}
    </button>
  )
}

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
        if (sel) navigator.clipboard.writeText(sel).catch((err) => rError('file-editor.contextmenu', 'cut clipboard write failed', { error: String(err) }))
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
        if (sel) navigator.clipboard.writeText(sel).catch((err) => rWarn('file-editor.contextmenu', 'copy clipboard write failed', { error: String(err) }))
        view.focus()
      }),
    },
    {
      label: 'Paste',
      shortcut: '⌘V',
      hidden: isReadOnly,
      action: () => exec(() => {
        const view = viewRef.current
        if (!view) return
        void (async () => {
          const text = await navigator.clipboard.readText()
          view.dispatch(view.state.replaceSelection(text))
          view.focus()
        })().catch((err) => rError('file-editor.contextmenu', 'paste failed', { error: String(err) }))
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

  const menuW = 200
  // Measured placement. This used to derive the menu height from
  // `visibleItems.length * 30` — a guess that drifts the moment a row is added
  // or a label wraps, and the drift is invisible until the menu hangs off the
  // screen edge again. Read-only mode hides rows, so the count is a dep.
  const pos = useAnchoredPopover({ x, y }, { deps: [visibleItems.length] })

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
          <EditorMenuButton
            key={item.label}
            label={item.label}
            shortcut={item.shortcut}
            disabled={item.disabled}
            onSelect={item.action}
            colors={colors}
          />
        )
      })}
    </div>
  )
}
