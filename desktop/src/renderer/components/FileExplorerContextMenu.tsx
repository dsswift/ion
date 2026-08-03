import React, { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Paperclip, Copy, FolderOpen as FolderOpenIcon, ArrowSquareOut, PencilSimple } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { useAnchoredPopover } from '../hooks/useAnchoredPopover'
import { zoomViewport } from '../viewport-zoom'
import { transitions } from '../theme-tokens'
import { maybeCloseExplorerBeforeExternal } from '../utils/externalLaunch'
import { rError } from '../rendererLogger'
import type { FsEntry } from '../../shared/types'

export interface ContextMenuState {
  x: number
  y: number
  entry: FsEntry
}

/** Menu row with the standard hover/pressed background cascade. */
function ContextMenuRow({
  label,
  Icon,
  onSelect,
  colors,
}: {
  label: string
  Icon: React.ComponentType<{ size?: number; color?: string }>
  onSelect: () => void
  colors: ReturnType<typeof useColors>
}) {
  const { hover, pressed, handlers } = useInteractiveState()
  return (
    <div
      onClick={onSelect}
      {...handlers}
      style={{
        height: 28,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 12px',
        fontSize: 11,
        color: colors.textPrimary,
        cursor: 'pointer',
        userSelect: 'none',
        background: interactiveBg(colors, { hover, pressed }),
        transition: `background ${transitions.base}`,
      }}
    >
      <Icon size={14} color={colors.textTertiary} />
      {label}
    </div>
  )
}

/** Right-click context menu for FileExplorer rows. */
export function FileExplorerContextMenu({
  menu,
  workingDir,
  onClose,
  onRename,
  portalTarget,
}: {
  menu: ContextMenuState
  workingDir: string
  onClose: () => void
  /**
   * Caller-supplied callback to start an inline-rename for `entry`.
   * The caller (FileExplorer) decides how to render the rename UI;
   * the context menu just signals intent.
   */
  onRename: (entry: FsEntry) => void
  portalTarget: HTMLDivElement
}) {
  const colors = useColors()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const { addAttachments } = useSessionStore.getState()

  type MenuItem =
    | { label: string; action: () => void; icon: React.ComponentType<{ size?: number; color?: string }> }
    | { separator: true }

  const items: MenuItem[] = useMemo(() => {
    const relativePath = menu.entry.path.startsWith(workingDir + '/')
      ? menu.entry.path.slice(workingDir.length + 1)
      : menu.entry.path
    return [
      { label: 'Attach to Conversation', icon: Paperclip, action: () => {
        void (async () => {
          const attachment = await window.ion.attachFileByPath(menu.entry.path)
          if (attachment) addAttachments([attachment])
          maybeCloseExplorerBeforeExternal()
        })().catch((err) => rError('file-explorer', 'attach file by path failed', { error: String(err) }))
      }},
      { separator: true as const },
      { label: 'Copy Path', icon: Copy, action: () => { void navigator.clipboard.writeText(menu.entry.path) } },
      { label: 'Copy Relative Path', icon: Copy, action: () => { void navigator.clipboard.writeText(relativePath) } },
      { separator: true as const },
      // Rename routes through the parent FileExplorer which renders the
      // inline-input row in place of the entry (reuses the same component
      // used by New File / New Folder, with the entry's current name
      // pre-filled). This avoids introducing a modal dialog and keeps the
      // rename UX consistent with creation.
      { label: 'Rename', icon: PencilSimple, action: () => onRename(menu.entry) },
      { separator: true as const },
      { label: 'Reveal in Finder', icon: FolderOpenIcon, action: () => { maybeCloseExplorerBeforeExternal(); void window.ion.fsRevealInFinder(menu.entry.path) } },
      { label: 'Open in Native App', icon: ArrowSquareOut, action: () => { maybeCloseExplorerBeforeExternal(); void window.ion.fsOpenNative(menu.entry.path) } },
    ]
  }, [menu.entry, workingDir, onRename, addAttachments])

  // Measured placement: a right-click low in the file tree used to open a menu
  // that ran off the bottom of the window. `items.length` is the only thing
  // that changes the rendered height.
  const pos = useAnchoredPopover({ x: menu.x, y: menu.y }, { deps: [items.length] })
  const vp = zoomViewport()

  return createPortal(
    <div
      ref={(node) => { (ref as React.MutableRefObject<HTMLDivElement | null>).current = node; pos.ref(node) }}
      data-ion-ui
      className="glass-surface"
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        visibility: pos.ready ? 'visible' : 'hidden',
        maxHeight: vp.height - 16,
        overflowY: 'auto',
        background: colors.popoverBg,
        border: `1px solid ${colors.popoverBorder}`,
        borderRadius: 8,
        boxShadow: colors.popoverShadow,
        padding: '4px 0',
        pointerEvents: 'auto',
        zIndex: 10000,
        minWidth: 160,
      }}
    >
      {items.map((item, i) => {
        if ('separator' in item) {
          return <div key={`sep-${i}`} style={{ height: 1, background: colors.containerBorder, margin: '4px 8px' }} />
        }
        return (
          <ContextMenuRow
            key={item.label}
            label={item.label}
            Icon={item.icon}
            onSelect={() => { item.action(); onClose() }}
            colors={colors}
          />
        )
      })}
    </div>,
    portalTarget,
  )
}
