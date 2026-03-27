import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import {
  CaretDown, CaretRight, Folder, FolderOpen, X,
  FilePlus, FolderPlus, ArrowsClockwise, ArrowsInLineVertical,
  File, FileTs, FileJs, FileCode, FileText, FileCss, FileHtml, FilePy,
  Image, GearSix,
  Paperclip, Copy, FolderOpen as FolderOpenIcon, ArrowSquareOut,
} from '@phosphor-icons/react'
import { useSessionStore, isTextFile } from '../stores/sessionStore'
import { usePopoverLayer } from './PopoverLayer'
import { useColors, useThemeStore } from '../theme'
import { maybeCloseExplorerBeforeExternal } from '../utils/externalLaunch'
import type { FsEntry } from '../../shared/types'

// ─── File icon mapping ───

interface FileIconInfo {
  icon: React.ComponentType<{ size?: number; color?: string; weight?: 'fill' | 'regular' | 'bold' }>
  color: string
}

function getFileIcon(name: string, fallbackColor: string): FileIconInfo {
  const ext = name.includes('.') ? '.' + name.split('.').pop()!.toLowerCase() : ''
  const base = name.toLowerCase()

  switch (ext) {
    case '.ts':
    case '.tsx':
      return { icon: FileTs, color: '#3b82f6' }
    case '.js':
    case '.jsx':
      return { icon: FileJs, color: '#eab308' }
    case '.json':
      return { icon: FileCode, color: '#22c55e' }
    case '.md':
      return { icon: FileText, color: '#60a5fa' }
    case '.css':
    case '.scss':
      return { icon: FileCss, color: '#a855f7' }
    case '.html':
      return { icon: FileHtml, color: '#f97316' }
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.svg':
    case '.gif':
    case '.ico':
    case '.webp':
      return { icon: Image, color: '#a855f7' }
    case '.py':
      return { icon: FilePy, color: '#3b82f6' }
    default:
      break
  }

  // Config files by name
  if (['.gitignore', '.env', '.editorconfig', '.prettierrc'].includes(base)) {
    return { icon: GearSix, color: '#9ca3af' }
  }

  return { icon: File, color: fallbackColor }
}

// ─── Context Menu ───

interface ContextMenuState {
  x: number
  y: number
  entry: FsEntry
}

function ContextMenu({
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

  type MenuItem = { label: string; action: () => void; icon: React.ComponentType<{ size?: number; color?: string }>} | { separator: true }

  const items: MenuItem[] = useMemo(() => {
    const relativePath = menu.entry.path.startsWith(workingDir + '/')
      ? menu.entry.path.slice(workingDir.length + 1)
      : menu.entry.path
    return [
      { label: 'Attach to Conversation', icon: Paperclip, action: async () => {
        const attachment = await window.coda.attachFileByPath(menu.entry.path)
        if (attachment) addAttachments([attachment])
        maybeCloseExplorerBeforeExternal()
      }},
      { separator: true as const },
      { label: 'Copy Path', icon: Copy, action: () => navigator.clipboard.writeText(menu.entry.path) },
      { label: 'Copy Relative Path', icon: Copy, action: () => navigator.clipboard.writeText(relativePath) },
      { separator: true as const },
      { label: 'Reveal in Finder', icon: FolderOpenIcon, action: () => { maybeCloseExplorerBeforeExternal(); window.coda.fsRevealInFinder(menu.entry.path) } },
      { label: 'Open in Native App', icon: ArrowSquareOut, action: () => { maybeCloseExplorerBeforeExternal(); window.coda.fsOpenNative(menu.entry.path) } },
    ]
  }, [menu.entry.path, workingDir])

  return createPortal(
    <div
      ref={ref}
      data-coda-ui
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

// ─── Tree Row ───

function TreeRow({
  entry,
  depth,
  expanded,
  selected,
  onToggle,
  onClick,
  onContextMenu,
  colors,
}: {
  entry: FsEntry
  depth: number
  expanded: boolean
  selected: boolean
  onToggle: () => void
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
  colors: ReturnType<typeof useColors>
}) {
  const paddingLeft = depth * 16 + 4
  const iconInfo = entry.isDirectory ? null : getFileIcon(entry.name, colors.textTertiary)

  return (
    <div
      onClick={entry.isDirectory ? onToggle : onClick}
      onContextMenu={onContextMenu}
      style={{
        height: 24,
        display: 'flex',
        alignItems: 'center',
        paddingLeft,
        paddingRight: 8,
        cursor: 'pointer',
        userSelect: 'none',
        background: selected ? colors.surfaceHover : 'transparent',
        borderRadius: selected ? 4 : 0,
        gap: 4,
      }}
      onMouseEnter={(e) => {
        if (!selected) (e.currentTarget as HTMLDivElement).style.background = colors.surfaceHover
      }}
      onMouseLeave={(e) => {
        if (!selected) (e.currentTarget as HTMLDivElement).style.background = 'transparent'
      }}
    >
      {entry.isDirectory ? (
        <>
          {expanded
            ? <CaretDown size={10} color={colors.textTertiary} weight="fill" />
            : <CaretRight size={10} color={colors.textTertiary} weight="fill" />
          }
          {expanded
            ? <FolderOpen size={14} color={colors.accent} weight="fill" />
            : <Folder size={14} color={colors.accent} weight="fill" />
          }
        </>
      ) : (
        <>
          {/* Spacer matching chevron width */}
          <span style={{ width: 10, flexShrink: 0 }} />
          {iconInfo && <iconInfo.icon size={14} color={iconInfo.color} />}
        </>
      )}
      <span
        style={{
          fontSize: 12,
          color: colors.textPrimary,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          marginLeft: 2,
        }}
      >
        {entry.name}
      </span>
    </div>
  )
}

// ─── Inline Input ───

function InlineInput({
  depth,
  onSubmit,
  onCancel,
  placeholder,
  colors,
}: {
  depth: number
  onSubmit: (name: string) => void
  onCancel: () => void
  placeholder: string
  colors: ReturnType<typeof useColors>
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && value.trim()) {
      onSubmit(value.trim())
    } else if (e.key === 'Escape') {
      onCancel()
    }
  }

  return (
    <div style={{ height: 24, display: 'flex', alignItems: 'center', paddingLeft: depth * 16 + 4 }}>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={onCancel}
        placeholder={placeholder}
        style={{
          fontSize: 12,
          color: colors.textPrimary,
          background: 'transparent',
          border: `1px solid ${colors.containerBorder}`,
          borderRadius: 4,
          outline: 'none',
          padding: '1px 6px',
          width: '100%',
          marginRight: 8,
        }}
      />
    </div>
  )
}

// ─── FileExplorer ───

export function FileExplorer() {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const tabs = useSessionStore((s) => s.tabs)
  const explorerStates = useSessionStore((s) => s.fileExplorerStates)
  const {
    setFileExplorerExpanded,
    setFileExplorerSelected,
    collapseAllExplorer,
    openFileInEditor,
    toggleFileExplorer,
  } = useSessionStore.getState()

  const workingDir = useMemo(() => {
    const tab = tabs.find((t) => t.id === activeTabId)
    return tab?.workingDirectory || null
  }, [tabs, activeTabId])

  const explorerState = useMemo(() => {
    if (!workingDir) return { expandedPaths: new Set<string>(), selectedPath: null }
    return explorerStates.get(workingDir) || { expandedPaths: new Set<string>(), selectedPath: null }
  }, [explorerStates, workingDir])

  // Directory listing cache
  const [dirCache, setDirCache] = useState<Map<string, FsEntry[]>>(new Map())
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [inlineInput, setInlineInput] = useState<{ type: 'file' | 'folder'; parentDir: string; depth: number } | null>(null)
  const refreshCounter = useRef(0)

  const fetchDir = useCallback(async (dirPath: string) => {
    const result = await window.coda.fsReadDir(dirPath)
    if (result.entries) {
      setDirCache((prev) => {
        const next = new Map(prev)
        // Sort: directories first, then alphabetical
        const sorted = [...result.entries].sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        next.set(dirPath, sorted)
        return next
      })
    }
  }, [])

  // Refresh all expanded directories + root
  const refreshAll = useCallback(() => {
    if (!workingDir) return
    fetchDir(workingDir)
    for (const p of explorerState.expandedPaths) {
      fetchDir(p)
    }
  }, [workingDir, explorerState.expandedPaths, fetchDir])

  // Initial load + auto-refresh every 5 seconds
  useEffect(() => {
    if (!workingDir) return
    fetchDir(workingDir)
    const interval = setInterval(() => {
      refreshCounter.current++
      refreshAll()
    }, 5000)
    return () => clearInterval(interval)
  }, [workingDir, fetchDir, refreshAll])

  // Fetch newly expanded dirs
  const handleToggleDir = useCallback((entry: FsEntry) => {
    if (!workingDir) return
    const isExpanded = explorerState.expandedPaths.has(entry.path)
    setFileExplorerExpanded(workingDir, entry.path, !isExpanded)
    setFileExplorerSelected(workingDir, entry.path)
    if (!isExpanded && !dirCache.has(entry.path)) {
      fetchDir(entry.path)
    }
  }, [workingDir, explorerState.expandedPaths, dirCache, fetchDir])

  const handleFileClick = useCallback((entry: FsEntry) => {
    if (!workingDir || !activeTabId) return
    setFileExplorerSelected(workingDir, entry.path)
    if (isTextFile(entry.name)) {
      openFileInEditor(workingDir, activeTabId, entry.path)
    }
  }, [workingDir, activeTabId])

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FsEntry) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, entry })
  }, [])

  const handleNewFile = useCallback(() => {
    if (!workingDir) return
    const selectedPath = explorerState.selectedPath
    // Determine which directory to create in
    let parentDir = workingDir
    let depth = 0
    if (selectedPath) {
      // Check if selected path is a directory
      const entries = dirCache.get(workingDir) || []
      const findEntry = (dir: string, d: number): { dir: string; depth: number } | null => {
        const items = dirCache.get(dir)
        if (!items) return null
        for (const item of items) {
          if (item.path === selectedPath) {
            return item.isDirectory ? { dir: item.path, depth: d + 1 } : { dir, depth: d }
          }
          if (item.isDirectory && explorerState.expandedPaths.has(item.path)) {
            const found = findEntry(item.path, d + 1)
            if (found) return found
          }
        }
        return null
      }
      const result = findEntry(workingDir, 0)
      if (result) {
        parentDir = result.dir
        depth = result.depth
      }
    }
    setInlineInput({ type: 'file', parentDir, depth })
  }, [workingDir, explorerState, dirCache])

  const handleNewFolder = useCallback(() => {
    if (!workingDir) return
    const selectedPath = explorerState.selectedPath
    let parentDir = workingDir
    let depth = 0
    if (selectedPath) {
      const findEntry = (dir: string, d: number): { dir: string; depth: number } | null => {
        const items = dirCache.get(dir)
        if (!items) return null
        for (const item of items) {
          if (item.path === selectedPath) {
            return item.isDirectory ? { dir: item.path, depth: d + 1 } : { dir, depth: d }
          }
          if (item.isDirectory && explorerState.expandedPaths.has(item.path)) {
            const found = findEntry(item.path, d + 1)
            if (found) return found
          }
        }
        return null
      }
      const result = findEntry(workingDir, 0)
      if (result) {
        parentDir = result.dir
        depth = result.depth
      }
    }
    setInlineInput({ type: 'folder', parentDir, depth })
  }, [workingDir, explorerState, dirCache])

  const handleInlineSubmit = useCallback(async (name: string) => {
    if (!inlineInput) return
    const fullPath = `${inlineInput.parentDir}/${name}`
    if (inlineInput.type === 'file') {
      await window.coda.fsCreateFile(fullPath)
    } else {
      await window.coda.fsCreateDir(fullPath)
    }
    setInlineInput(null)
    // Refresh the parent directory
    fetchDir(inlineInput.parentDir)
  }, [inlineInput, fetchDir])

  // Render tree recursively
  const renderTree = useCallback((dirPath: string, depth: number): React.ReactNode[] => {
    const entries = dirCache.get(dirPath) || []
    const nodes: React.ReactNode[] = []

    // Show inline input at this level if applicable
    if (inlineInput && inlineInput.parentDir === dirPath) {
      nodes.push(
        <InlineInput
          key="__inline__"
          depth={depth}
          onSubmit={handleInlineSubmit}
          onCancel={() => setInlineInput(null)}
          placeholder={inlineInput.type === 'file' ? 'filename' : 'folder name'}
          colors={colors}
        />,
      )
    }

    for (const entry of entries) {
      const isExpanded = explorerState.expandedPaths.has(entry.path)
      const isSelected = explorerState.selectedPath === entry.path

      nodes.push(
        <TreeRow
          key={entry.path}
          entry={entry}
          depth={depth}
          expanded={isExpanded}
          selected={isSelected}
          onToggle={() => handleToggleDir(entry)}
          onClick={() => handleFileClick(entry)}
          onContextMenu={(e) => handleContextMenu(e, entry)}
          colors={colors}
        />,
      )

      if (entry.isDirectory && isExpanded) {
        nodes.push(...renderTree(entry.path, depth + 1))
      }
    }

    return nodes
  }, [dirCache, explorerState, inlineInput, handleInlineSubmit, handleToggleDir, handleFileClick, handleContextMenu, colors])

  const expandedUI = useThemeStore((s) => s.expandedUI)

  if (!workingDir) return null

  const projectName = workingDir.split('/').pop()?.toUpperCase() || 'PROJECT'
  // Match git panel height: bodyMaxHeight + 82 (tabStrip + border + gap + input pill)
  const bodyMaxHeight = expandedUI ? 520 : 400
  const panelHeight = bodyMaxHeight + 82

  return (
    <div
      data-coda-ui
      className="glass-surface"
      style={{
        width: '100%',
        height: panelHeight,
        display: 'flex',
        flexDirection: 'column',
        background: colors.containerBg,
        border: `1px solid ${colors.containerBorder}`,
        borderRadius: 16,
        boxShadow: colors.cardShadow,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 10px',
          background: colors.surfacePrimary,
          borderBottom: `1px solid ${colors.containerBorder}`,
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden' }}>
          <button
            onClick={() => toggleFileExplorer(activeTabId)}
            className="flex items-center justify-center rounded transition-colors"
            style={{ color: colors.textTertiary, cursor: 'pointer', flexShrink: 0, padding: 1 }}
            title="Close explorer"
          >
            <X size={11} />
          </button>
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.05em',
              color: colors.textTertiary,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {projectName}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {[
            { Icon: FilePlus, title: 'New File', action: handleNewFile },
            { Icon: FolderPlus, title: 'New Folder', action: handleNewFolder },
            { Icon: ArrowsClockwise, title: 'Refresh', action: refreshAll },
            { Icon: ArrowsInLineVertical, title: 'Collapse All', action: () => workingDir && collapseAllExplorer(workingDir) },
          ].map(({ Icon, title, action }) => (
            <button
              key={title}
              title={title}
              onClick={action}
              style={{
                background: 'none',
                border: 'none',
                padding: 2,
                cursor: 'pointer',
                color: colors.textTertiary,
                display: 'flex',
                alignItems: 'center',
                borderRadius: 4,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = colors.accent }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = colors.textTertiary }}
            >
              <Icon size={14} />
            </button>
          ))}
        </div>
      </div>

      {/* Tree */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '4px 0',
        }}
      >
        {renderTree(workingDir, 0)}
      </div>

      {/* Context menu */}
      {contextMenu && popoverLayer && (
        <ContextMenu
          menu={contextMenu}
          workingDir={workingDir}
          onClose={() => setContextMenu(null)}
          portalTarget={popoverLayer}
        />
      )}
    </div>
  )
}
