import React, { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Paperclip, Copy, FolderOpen as FolderOpenIcon, ArrowSquareOut } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { maybeCloseExplorerBeforeExternal } from '../utils/externalLaunch'
import type { FsEntry } from '../../shared/types'

export interface ContextMenuState {
  x: number
  y: number
  entry: FsEntry
}

/** Right-click context menu for FileExplorer rows. */
export function FileExplorerContextMenu({
  menu,
  workingDir,
  onClose,
  portalTarget,
}: {
  menu: ContextMenuState
  workingDir: string
  onClose: () => void
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
      { label: 'Attach to Conversation', icon: Paperclip, action: async () => {
        const attachment = await window.ion.attachFileByPath(menu.entry.path)
        if (attachment) addAttachments([attachment])
        maybeCloseExplorerBeforeExternal()
      }},
      { separator: true as const },
      { label: 'Copy Path', icon: Copy, action: () => navigator.clipboard.writeText(menu.entry.path) },
      { label: 'Copy Relative Path', icon: Copy, action: () => navigator.clipboard.writeText(relativePath) },
      { separator: true as const },
      { label: 'Reveal in Finder', icon: FolderOpenIcon, action: () => { maybeCloseExplorerBeforeExternal(); window.ion.fsRevealInFinder(menu.entry.path) } },
      { label: 'Open in Native App', icon: ArrowSquareOut, action: () => { maybeCloseExplorerBeforeExternal(); window.ion.fsOpenNative(menu.entry.path) } },
    ]
  }, [menu.entry.path, workingDir])

  return createPortal(
    <div
      ref={ref}
      data-ion-ui
      className="glass-surface"
      style={{
        position: 'fixed',
        left: menu.x,
        top: menu.y,
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
        const Icon = item.icon
        return (
          <div
            key={item.label}
            onClick={() => { item.action(); onClose() }}
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
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = colors.surfaceHover }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
          >
            <Icon size={14} color={colors.textTertiary} />
            {item.label}
          </div>
        )
      })}
    </div>,
    portalTarget,
  )
}
