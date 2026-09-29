import React, { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Paperclip, Copy, FolderOpen as FolderOpenIcon, ArrowSquareOut, PencilSimple, FilePlus, FolderPlus } from '@phosphor-icons/react'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { useAnchoredPopover } from '../hooks/useAnchoredPopover'
import { transitions } from '../theme-tokens'
import { surfaceRouter } from '../lib/file-open-router'
import { rError } from '../rendererLogger'
import type { FsEntry } from '@ion/shared/types'
import { scrollableMenuStyle } from '../menu-viewport'
import { host } from '../host/host-instance'
import { pathDirname } from '@ion/shared/paths'

export interface ContextMenuState {
  x: number
  y: number
  entry: FsEntry
  /** Indent the right-clicked row renders at; the inline input matches it. */
  depth: number
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
  onCreate,
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
  /**
   * Create in `parentDir`, rendering the inline input at `depth`. The menu
   * resolves the target from the right-clicked row — a directory receives the
   * new entry as a child, a file receives it as a sibling — so creation always
   * names its folder instead of inferring one from the selection.
   */
  onCreate: (type: 'file' | 'folder', parentDir: string, depth: number) => void
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
    const ext = menu.entry.name.includes('.') ? '.' + menu.entry.name.split('.').pop()!.toLowerCase() : ''
    const isHtml = ext === '.html' || ext === '.htm'
    const entryParent = pathDirname(menu.entry.path)
    const createParent = menu.entry.isDirectory ? menu.entry.path : (entryParent && entryParent !== '/' ? entryParent : workingDir)
    const createDepth = menu.entry.isDirectory ? menu.depth + 1 : menu.depth
    return [
      { label: 'New File', icon: FilePlus, action: () => onCreate('file', createParent, createDepth) },
      { label: 'New Folder', icon: FolderPlus, action: () => onCreate('folder', createParent, createDepth) },
      { separator: true as const },
      // HTML defaults to browser preview on click (Studio); "Edit" is the
      // explicit editor path. Overlay (no router) opens the floating editor.
      ...(isHtml && !menu.entry.isDirectory
        ? [
            {
              label: 'Edit',
              icon: PencilSimple,
              action: () => {
                const s = useSessionStore.getState()
                const tabId = s.activeTabId
                if (!tabId) return
                const router = surfaceRouter()
                if (router) router.openTextFile(workingDir, tabId, menu.entry.path)
                else s.openFileInEditor(workingDir, tabId, menu.entry.path)
              },
            },
            { separator: true as const },
          ]
        : []),
      // Describing a file for attachment is a filesystem read, which the
      // server performs over the wire ('fs.attachByPath'). Unlike Reveal and
      // Open Natively below, this needs no operating system.
      { label: 'Attach to Conversation', icon: Paperclip, action: () => {
        const tabId = useSessionStore.getState().activeTabId
        if (!tabId) return
        void (async () => {
          const attachment = await host.shell.attachFileByPath(tabId, menu.entry.path)
          if (attachment) addAttachments([attachment])
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
      { label: 'Reveal in Finder', icon: FolderOpenIcon, action: () => { if (!host.capabilities().includes('nativeShell')) return; void host.shell.fsRevealInFinder(menu.entry.path) } },
      { label: 'Open in Native App', icon: ArrowSquareOut, action: () => { if (!host.capabilities().includes('nativeShell')) return; void host.shell.fsOpenNative(menu.entry.path) } },
    ]
  }, [menu.entry, menu.depth, workingDir, onRename, onCreate, addAttachments])

  // Measured placement: a right-click low in the file tree used to open a menu
  // that ran off the bottom of the window. `items.length` is the only thing
  // that changes the rendered height.
  const pos = useAnchoredPopover({ x: menu.x, y: menu.y }, { deps: [items.length] })

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
        ...scrollableMenuStyle(),
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
