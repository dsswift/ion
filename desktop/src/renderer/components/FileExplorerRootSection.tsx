/**
 * FileExplorerRootSection — one workspace root's tree inside the explorer:
 * per-root directory cache, gitignored paths, inline create/rename, 5s
 * auto-refresh (skipped while collapsed), and the entry context menu.
 *
 * Extracted from FileExplorer for multi-root workspaces: the explorer
 * renders one section per root ([primary, ...workspace roots]); tree
 * expansion state stays SHARED per-directory by design (two mounts of the
 * same root show the same expansion — fileExplorerStates is keyed by
 * directory), while per-mount UI (inline create/rename inputs, dir cache)
 * is component-local.
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { CaretDown, CaretRight, DotsThree } from '@phosphor-icons/react'
import { useSessionStore, isTextFile } from '../stores/sessionStore'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { FileExplorerContextMenu, type ContextMenuState } from './FileExplorerContextMenu'
import { FileExplorerTreeRow, FileExplorerInlineInput } from './FileExplorerTreeRow'
import { FileExplorerRootHeaderMenu } from './FileExplorerRootHeaderMenu'
import type { FsEntry } from '../../shared/types'
import { surfaceRouter } from '../lib/file-open-router'
import { rDebug, rInfo, rWarn, rError } from '../rendererLogger'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.tiff'])

export interface FileExplorerRootSectionProps {
  rootDir: string
  isPrimary: boolean
  collapsed: boolean
  onToggleCollapsed: () => void
  /** Legacy image-popup fallback (overlay). Studio routes via the router. */
  onOpenImage: (preview: { path: string; name: string }) => void
  /** Present on secondary roots only: Remove from Workspace. */
  onRemoveFromWorkspace?: () => void
  /** Set by the orchestrator when New File/Folder targets this root. */
  inlineCreate: { type: 'file' | 'folder'; parentDir: string; depth: number } | null
  onInlineCreateDone: () => void
}

export function FileExplorerRootSection(props: FileExplorerRootSectionProps): React.JSX.Element {
  const { rootDir, collapsed } = props
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const explorerStates = useSessionStore((s) => s.fileExplorerStates)
  const { setFileExplorerExpanded, setFileExplorerSelected, openFileInEditor } = useSessionStore.getState()

  const explorerState = useMemo(
    () => explorerStates.get(rootDir) || { expandedPaths: new Set<string>(), selectedPath: null },
    [explorerStates, rootDir],
  )

  const [dirCache, setDirCache] = useState<Map<string, FsEntry[]>>(new Map())
  const [ignoredPaths, setIgnoredPaths] = useState<Set<string>>(new Set())
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [renaming, setRenaming] = useState<{ path: string; initialName: string } | null>(null)
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null)

  const fetchDir = useCallback(async (dirPath: string) => {
    const result = await window.ion.fsReadDir(dirPath)
    if (result.entries) {
      setDirCache((prev) => {
        const next = new Map(prev)
        const sorted = [...result.entries].sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        next.set(dirPath, sorted)
        return next
      })
    }
  }, [])

  const refreshAll = useCallback(() => {
    fetchDir(rootDir).catch((err) => rWarn('file-explorer', 'refreshAll root fetch failed', { dir: rootDir, error: String(err) }))
    for (const p of explorerState.expandedPaths) {
      fetchDir(p).catch((err) => rWarn('file-explorer', 'refreshAll expanded fetch failed', { dir: p, error: String(err) }))
    }
  }, [rootDir, explorerState.expandedPaths, fetchDir])

  const fetchIgnored = useCallback((dir: string) => {
    window.ion.gitIgnoredFiles(dir).then((result) => {
      setIgnoredPaths(new Set(result.paths))
    }).catch((err) => rDebug('file-explorer', 'gitIgnoredFiles failed', { dir, error: String(err) }))
  }, [])

  // Initial load + 5s auto-refresh — SKIPPED while the section is collapsed
  // (a collapsed root costs zero fs traffic).
  useEffect(() => {
    if (collapsed) return
    refreshAll()
    fetchIgnored(rootDir)
    const interval = setInterval(() => {
      refreshAll()
      fetchIgnored(rootDir)
    }, 5000)
    return () => clearInterval(interval)
  }, [rootDir, collapsed, refreshAll, fetchIgnored])

  const handleToggleDir = useCallback((entry: FsEntry) => {
    const isExpanded = explorerState.expandedPaths.has(entry.path)
    setFileExplorerExpanded(rootDir, entry.path, !isExpanded)
    setFileExplorerSelected(rootDir, entry.path)
    if (!isExpanded && !dirCache.has(entry.path)) {
      fetchDir(entry.path).catch((err) => rWarn('file-explorer', 'expand dir fetch failed', { dir: entry.path, error: String(err) }))
    }
  }, [rootDir, explorerState.expandedPaths, dirCache, fetchDir, setFileExplorerExpanded, setFileExplorerSelected])

  const handleFileClick = useCallback((entry: FsEntry) => {
    if (!activeTabId) return
    setFileExplorerSelected(rootDir, entry.path)
    const ext = entry.name.includes('.') ? '.' + entry.name.split('.').pop()!.toLowerCase() : ''
    const router = surfaceRouter()
    if (IMAGE_EXTS.has(ext)) {
      if (router) router.openImage(entry.path)
      else props.onOpenImage({ path: entry.path, name: entry.name })
    } else if (ext === '.html' || ext === '.htm') {
      if (router) router.openHtml(entry.path)
      else if (isTextFile(entry.name)) openFileInEditor(rootDir, activeTabId, entry.path)
    } else if (isTextFile(entry.name)) {
      if (router) router.openTextFile(rootDir, activeTabId, entry.path)
      else openFileInEditor(rootDir, activeTabId, entry.path)
    } else {
      rDebug('file-explorer', 'skipped: not a text or image file', { path: entry.path })
    }
  }, [rootDir, activeTabId, openFileInEditor, setFileExplorerSelected, props])

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FsEntry) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, entry })
  }, [])

  const handleInlineSubmit = useCallback(async (name: string) => {
    const input = props.inlineCreate
    if (!input) return
    const fullPath = `${input.parentDir}/${name}`
    if (input.type === 'file') await window.ion.fsCreateFile(fullPath)
    else await window.ion.fsCreateDir(fullPath)
    props.onInlineCreateDone()
    fetchDir(input.parentDir).catch((err) => rWarn('file-explorer', 'inline submit refresh failed', { dir: input.parentDir, error: String(err) }))
  }, [props, fetchDir])

  const handleRenameStart = useCallback((entry: FsEntry) => {
    rDebug('file-explorer', 'handleRenameStart', { path: entry.path, name: entry.name })
    setRenaming({ path: entry.path, initialName: entry.name })
  }, [])

  const handleRenameSubmit = useCallback(async (newName: string) => {
    if (!renaming) return
    const trimmed = newName.trim()
    if (!trimmed || trimmed === renaming.initialName) {
      rDebug('file-explorer', 'handleRenameSubmit: skipped', { reason: trimmed ? 'unchanged' : 'empty', old_path: renaming.path })
      setRenaming(null)
      return
    }
    const lastSlash = renaming.path.lastIndexOf('/')
    const parentDir = lastSlash >= 0 ? renaming.path.slice(0, lastSlash) : renaming.path
    const newPath = `${parentDir}/${trimmed}`
    rInfo('file-explorer', 'handleRenameSubmit', { old_path: renaming.path, new_path: newPath })
    try {
      const result = await window.ion.fsRename(renaming.path, newPath)
      if (result.ok) rInfo('file-explorer', 'rename success', { old_path: renaming.path, new_path: newPath })
      else rDebug('file-explorer', 'rename failed', { old_path: renaming.path, new_path: newPath, error: result.error })
    } catch (err) {
      rDebug('file-explorer', 'rename threw', { old_path: renaming.path, new_path: newPath, error: (err as Error).message })
    }
    setRenaming(null)
    fetchDir(parentDir).catch((err) => rWarn('file-explorer', 'rename submit refresh failed', { dir: parentDir, error: String(err) }))
  }, [renaming, fetchDir])

  const handleRenameCancel = useCallback(() => {
    setRenaming(null)
  }, [])

  const isIgnored = useCallback((filePath: string) => {
    if (ignoredPaths.has(filePath)) return true
    if (ignoredPaths.has(filePath + '/')) return true
    for (const p of ignoredPaths) {
      if (p.endsWith('/') && filePath.startsWith(p)) return true
      if (!p.endsWith('/') && filePath.startsWith(p + '/')) return true
    }
    return false
  }, [ignoredPaths])

  const renderTree = useCallback((dirPath: string, depth: number): React.ReactNode[] => {
    const entries = dirCache.get(dirPath) || []
    const nodes: React.ReactNode[] = []
    const inlineInput = props.inlineCreate

    if (inlineInput && inlineInput.parentDir === dirPath) {
      nodes.push(
        <FileExplorerInlineInput
          key="__inline__"
          depth={depth}
          onSubmit={(name) => { void handleInlineSubmit(name).catch((err) => rError('file-explorer', 'inline submit failed', { error: String(err) })) }}
          onCancel={props.onInlineCreateDone}
          placeholder={inlineInput.type === 'file' ? 'filename' : 'folder name'}
          colors={colors}
        />,
      )
    }

    for (const entry of entries) {
      const isExpanded = explorerState.expandedPaths.has(entry.path)
      const isSelected = explorerState.selectedPath === entry.path

      if (renaming && renaming.path === entry.path) {
        nodes.push(
          <FileExplorerInlineInput
            key={`__rename__${entry.path}`}
            depth={depth}
            onSubmit={(name) => { void handleRenameSubmit(name).catch((err) => rError('file-explorer', 'rename submit failed', { error: String(err) })) }}
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
  }, [dirCache, explorerState, props.inlineCreate, props.onInlineCreateDone, renaming, handleInlineSubmit, handleRenameSubmit, handleRenameCancel, handleToggleDir, handleFileClick, handleContextMenu, isIgnored, colors])

  const baseName = rootDir.split('/').pop() || rootDir
  const parentPath = rootDir.slice(0, rootDir.length - baseName.length).replace(/\/$/, '')

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Root header: caret + basename (+ dimmed parent path). */}
      <div
        onClick={props.onToggleCollapsed}
        onContextMenu={(e) => {
          if (!props.onRemoveFromWorkspace) return
          e.preventDefault()
          setHeaderMenu({ x: e.clientX, y: e.clientY })
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '3px 8px',
          cursor: 'pointer',
          userSelect: 'none',
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.05em',
          color: props.isPrimary ? colors.accent : colors.textTertiary,
          flexShrink: 0,
        }}
      >
        {collapsed ? <CaretRight size={9} /> : <CaretDown size={9} />}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{baseName.toUpperCase()}</span>
        {parentPath && (
          <span style={{ fontWeight: 400, color: colors.textTertiary, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textTransform: 'none' }}>
            {parentPath}
          </span>
        )}
        {props.onRemoveFromWorkspace && (
          <span
            onClick={(e) => {
              e.stopPropagation()
              setHeaderMenu({ x: e.clientX, y: e.clientY })
            }}
            style={{ marginLeft: 'auto', display: 'flex', color: colors.textTertiary }}
            aria-label={`Root menu for ${baseName}`}
          >
            <DotsThree size={13} />
          </span>
        )}
      </div>
      {!collapsed && <div style={{ padding: '0 0 4px' }}>{renderTree(rootDir, 0)}</div>}

      {contextMenu && popoverLayer && (
        <FileExplorerContextMenu
          menu={contextMenu}
          workingDir={rootDir}
          onClose={() => setContextMenu(null)}
          onRename={handleRenameStart}
          portalTarget={popoverLayer}
        />
      )}
      {headerMenu && props.onRemoveFromWorkspace && (
        <FileExplorerRootHeaderMenu
          x={headerMenu.x}
          y={headerMenu.y}
          rootDir={rootDir}
          onClose={() => setHeaderMenu(null)}
          onRemoveFromWorkspace={props.onRemoveFromWorkspace}
          onCollapseAllInFolder={() => useSessionStore.getState().collapseAllExplorer(rootDir)}
        />
      )}
    </div>
  )
}
