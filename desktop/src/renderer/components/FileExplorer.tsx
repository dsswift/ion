import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  X, FilePlus, FolderPlus, ArrowsClockwise, ArrowsInLineVertical,
} from '@phosphor-icons/react'
import { useSessionStore, isTextFile } from '../stores/sessionStore'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { FileExplorerContextMenu, type ContextMenuState } from './FileExplorerContextMenu'
import { FileExplorerTreeRow, FileExplorerInlineInput } from './FileExplorerTreeRow'
import { ImageViewer } from './ImageViewer'
import type { FsEntry } from '../../shared/types'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.tiff'])

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
  const [ignoredPaths, setIgnoredPaths] = useState<Set<string>>(new Set())
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [inlineInput, setInlineInput] = useState<{ type: 'file' | 'folder'; parentDir: string; depth: number } | null>(null)
  /**
   * Inline-rename state. When set, the row whose `path === renaming.path`
   * is replaced (not augmented) by a `FileExplorerInlineInput` pre-filled
   * with `renaming.initialName`. The state is cleared on submit or
   * cancel. This pattern mirrors `inlineInput` above but operates on an
   * existing entry rather than synthesizing a new one above its
   * siblings.
   */
  const [renaming, setRenaming] = useState<{ path: string; initialName: string } | null>(null)
  const [imagePreview, setImagePreview] = useState<{ path: string; name: string } | null>(null)
  const refreshCounter = useRef(0)

  const fetchDir = useCallback(async (dirPath: string) => {
    const result = await window.ion.fsReadDir(dirPath)
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

  // Fetch gitignored files
  const fetchIgnored = useCallback((dir: string) => {
    window.ion.gitIgnoredFiles(dir).then(result => {
      setIgnoredPaths(new Set(result.paths))
    }).catch(() => {})
  }, [])

  // Initial load + auto-refresh every 5 seconds
  useEffect(() => {
    if (!workingDir) return
    refreshAll()
    fetchIgnored(workingDir)
    const interval = setInterval(() => {
      refreshCounter.current++
      refreshAll()
      fetchIgnored(workingDir)
    }, 5000)
    return () => clearInterval(interval)
  }, [workingDir, refreshAll, fetchIgnored])

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
    console.log('[FileExplorer] handleFileClick', { name: entry.name, path: entry.path, workingDir, activeTabId, isText: isTextFile(entry.name) })
    if (!workingDir || !activeTabId) {
      console.log('[FileExplorer] handleFileClick bailed: no workingDir or activeTabId')
      return
    }
    setFileExplorerSelected(workingDir, entry.path)
    const ext = entry.name.includes('.') ? '.' + entry.name.split('.').pop()!.toLowerCase() : ''
    if (IMAGE_EXTS.has(ext)) {
      console.log('[FileExplorer] opening image preview', { path: entry.path })
      setImagePreview({ path: entry.path, name: entry.name })
    } else if (isTextFile(entry.name)) {
      console.log('[FileExplorer] calling openFileInEditor', { dir: workingDir, tabId: activeTabId, filePath: entry.path })
      openFileInEditor(workingDir, activeTabId, entry.path)
    } else {
      console.log('[FileExplorer] skipped: not a text or image file')
    }
  }, [workingDir, activeTabId])

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FsEntry) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, entry })
  }, [])

  // Find directory depth for inline-input placement.
  const findInlineTarget = useCallback((selectedPath: string | null): { dir: string; depth: number } => {
    if (!workingDir) return { dir: '', depth: 0 }
    if (!selectedPath) return { dir: workingDir, depth: 0 }
    const find = (dir: string, d: number): { dir: string; depth: number } | null => {
      const items = dirCache.get(dir)
      if (!items) return null
      for (const item of items) {
        if (item.path === selectedPath) {
          return item.isDirectory ? { dir: item.path, depth: d + 1 } : { dir, depth: d }
        }
        if (item.isDirectory && explorerState.expandedPaths.has(item.path)) {
          const found = find(item.path, d + 1)
          if (found) return found
        }
      }
      return null
    }
    return find(workingDir, 0) || { dir: workingDir, depth: 0 }
  }, [workingDir, explorerState.expandedPaths, dirCache])

  const handleNewFile = useCallback(() => {
    if (!workingDir) return
    const target = findInlineTarget(explorerState.selectedPath)
    setInlineInput({ type: 'file', parentDir: target.dir, depth: target.depth })
  }, [workingDir, explorerState.selectedPath, findInlineTarget])

  const handleNewFolder = useCallback(() => {
    if (!workingDir) return
    const target = findInlineTarget(explorerState.selectedPath)
    setInlineInput({ type: 'folder', parentDir: target.dir, depth: target.depth })
  }, [workingDir, explorerState.selectedPath, findInlineTarget])

  const handleInlineSubmit = useCallback(async (name: string) => {
    if (!inlineInput) return
    const fullPath = `${inlineInput.parentDir}/${name}`
    if (inlineInput.type === 'file') {
      await window.ion.fsCreateFile(fullPath)
    } else {
      await window.ion.fsCreateDir(fullPath)
    }
    setInlineInput(null)
    // Refresh the parent directory
    fetchDir(inlineInput.parentDir)
  }, [inlineInput, fetchDir])

  /**
   * Begin an in-place rename for `entry`. Called from the context menu.
   * The row is swapped for an inline input pre-filled with the current
   * name. Submit calls `window.ion.fsRename`; cancel restores the row.
   */
  const handleRenameStart = useCallback((entry: FsEntry) => {
    console.log('[FileExplorer] handleRenameStart', { path: entry.path, name: entry.name })
    setRenaming({ path: entry.path, initialName: entry.name })
  }, [])

  /**
   * Submit an in-place rename. Builds the new path under the same parent
   * directory as the original entry (rename, not move), invokes the
   * existing IPC, and refreshes the parent listing. Logs both success
   * and failure with the `[FileExplorer]` tag so the renderer log
   * stream tells the full story (see CLAUDE.md → Logging policy).
   */
  const handleRenameSubmit = useCallback(async (newName: string) => {
    if (!renaming) return
    const trimmed = newName.trim()
    // No-op when the user submitted the same name (or empty after trim).
    if (!trimmed || trimmed === renaming.initialName) {
      console.log('[FileExplorer] handleRenameSubmit: skipped', { reason: trimmed ? 'unchanged' : 'empty', oldPath: renaming.path })
      setRenaming(null)
      return
    }
    const lastSlash = renaming.path.lastIndexOf('/')
    const parentDir = lastSlash >= 0 ? renaming.path.slice(0, lastSlash) : renaming.path
    const newPath = `${parentDir}/${trimmed}`
    console.log('[FileExplorer] handleRenameSubmit: invoking fsRename', { oldPath: renaming.path, newPath })
    try {
      const result = await window.ion.fsRename(renaming.path, newPath)
      if (result.ok) {
        console.log('[FileExplorer] handleRenameSubmit: success', { oldPath: renaming.path, newPath })
      } else {
        console.log('[FileExplorer] handleRenameSubmit: failed', { oldPath: renaming.path, newPath, error: result.error })
      }
    } catch (err) {
      console.log('[FileExplorer] handleRenameSubmit: threw', { oldPath: renaming.path, newPath, error: (err as Error).message })
    }
    setRenaming(null)
    fetchDir(parentDir)
  }, [renaming, fetchDir])

  const handleRenameCancel = useCallback(() => {
    console.log('[FileExplorer] handleRenameCancel', { path: renaming?.path })
    setRenaming(null)
  }, [renaming])

  const isIgnored = useCallback((filePath: string) => {
    if (ignoredPaths.has(filePath)) return true
    // Directory entries from git end with '/' but FsEntry paths don't
    if (ignoredPaths.has(filePath + '/')) return true
    // Check if any parent directory is ignored
    for (const p of ignoredPaths) {
      if (p.endsWith('/') && filePath.startsWith(p)) return true
      if (!p.endsWith('/') && filePath.startsWith(p + '/')) return true
    }
    return false
  }, [ignoredPaths])

  // Render tree recursively
  const renderTree = useCallback((dirPath: string, depth: number): React.ReactNode[] => {
    const entries = dirCache.get(dirPath) || []
    const nodes: React.ReactNode[] = []

    // Show inline input at this level if applicable
    if (inlineInput && inlineInput.parentDir === dirPath) {
      nodes.push(
        <FileExplorerInlineInput
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

      if (renaming && renaming.path === entry.path) {
        // Replace the row with the inline input (NOT add above siblings).
        // The placeholder mirrors the file/folder placeholder used for
        // new-entry creation; the pre-filled `initialValue` makes the
        // distinction obvious to the user.
        nodes.push(
          <FileExplorerInlineInput
            key={`__rename__${entry.path}`}
            depth={depth}
            onSubmit={handleRenameSubmit}
            onCancel={handleRenameCancel}
            placeholder={entry.isDirectory ? 'folder name' : 'filename'}
            initialValue={renaming.initialName}
            colors={colors}
          />,
        )
      } else {
        nodes.push(
          <FileExplorerTreeRow
            key={entry.path}
            entry={entry}
            depth={depth}
            expanded={isExpanded}
            selected={isSelected}
            isGitIgnored={isIgnored(entry.path)}
            onToggle={() => handleToggleDir(entry)}
            onClick={() => handleFileClick(entry)}
            onContextMenu={(e) => handleContextMenu(e, entry)}
            colors={colors}
          />,
        )
      }

      if (entry.isDirectory && isExpanded) {
        nodes.push(...renderTree(entry.path, depth + 1))
      }
    }

    return nodes
  }, [dirCache, explorerState, inlineInput, renaming, handleInlineSubmit, handleRenameSubmit, handleRenameCancel, handleToggleDir, handleFileClick, handleContextMenu, isIgnored, colors])

  const expandedUI = usePreferencesStore((s) => s.expandedUI)

  if (!workingDir) return null

  const projectName = workingDir.split('/').pop()?.toUpperCase() || 'PROJECT'
  // Match git panel height: bodyMaxHeight + 82 (tabStrip + border + gap + input pill)
  const bodyMaxHeight = expandedUI ? 520 : 400
  const panelHeight = bodyMaxHeight + 82

  return (
    <div
      data-ion-ui
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
        <FileExplorerContextMenu
          menu={contextMenu}
          workingDir={workingDir}
          onClose={() => setContextMenu(null)}
          onRename={handleRenameStart}
          portalTarget={popoverLayer}
        />
      )}

      {/* Image preview */}
      {imagePreview && (
        <ImageViewer
          filePath={imagePreview.path}
          fileName={imagePreview.name}
          onClose={() => setImagePreview(null)}
        />
      )}
    </div>
  )
}
