/**
 * FileExplorerRootSection — one workspace root's tree inside the explorer:
 * per-root directory cache, gitignored paths, inline create/rename, refresh
 * on change (nothing is read while collapsed), and the entry context menu.
 *
 * Extracted from FileExplorer for multi-root workspaces: the explorer
 * renders one section per root ([primary, ...workspace roots]); tree
 * expansion state stays SHARED per-directory by design (two mounts of the
 * same root show the same expansion — fileExplorerStates is keyed by
 * directory), while per-mount UI (inline create/rename inputs, dir cache)
 * is component-local.
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { CaretDown, CaretRight, DotsThree } from '@phosphor-icons/react'
import { useSessionStore, isTextFile } from '@ion/server/store/sessionStore'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { FileExplorerContextMenu, type ContextMenuState } from './FileExplorerContextMenu'
import { FileExplorerTreeRow, FileExplorerInlineInput } from './FileExplorerTreeRow'
import { FileExplorerRootHeaderMenu } from './FileExplorerRootHeaderMenu'
import type { FsEntry } from '@ion/shared/types'
import { surfaceRouter } from '../lib/file-open-router'
import { fileOpenIntent, type FileClickModifiers } from '../lib/open-file-intent'
import { rDebug, rInfo, rWarn, rError } from '../rendererLogger'
import { pathSegments } from '@ion/shared/paths'
import { usePreferencesStore } from '../preferences'
import { host } from '../host/host-instance'
import { joinPath, pathDirname } from '@ion/shared/paths'
import { relativeTreeDirectory, type FsTreeChange } from '@ion/shared/fs-tree-watch'
import { useFileTreeWatch } from '../hooks/useFileTreeWatch'
import { ignoredPathMatcher, sameIgnoredPaths, sameListing } from './file-explorer-listing'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.tiff'])

export interface FileExplorerRootSectionProps {
  rootDir: string
  isPrimary: boolean
  collapsed: boolean
  onToggleCollapsed: () => void
  /** Legacy image-popup fallback (overlay). Studio routes via the router. */
  onOpenImage: (preview: { path: string; name: string }) => void
  /** Present on mounted folders only: Remove from Workspace. */
  onRemoveFromWorkspace?: () => void
  /** Set by the orchestrator when New File/Folder targets this root. */
  inlineCreate: { type: 'file' | 'folder'; parentDir: string; depth: number } | null
  onInlineCreateDone: () => void
  /**
   * Ask the explorer to open an inline create input in `parentDir` at `depth`.
   * Raised by both right-click menus; the section makes the target visible
   * first (see requestCreate) so the input is never created off-screen.
   */
  onRequestCreate: (type: 'file' | 'folder', parentDir: string, depth: number) => void
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

  const showHiddenFiles = usePreferencesStore((s) => s.showHiddenFiles)
  const [dirCache, setDirCache] = useState<Map<string, FsEntry[]>>(new Map())
  const [ignoredPaths, setIgnoredPaths] = useState<Set<string>>(new Set())
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [renaming, setRenaming] = useState<{ path: string; initialName: string } | null>(null)
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null)

  // What is shown, readable from a callback without making the callback
  // depend on it. A refresh that depended on the expansion set re-read every
  // open folder each time one folder was opened or closed.
  const dirCacheRef = useRef(dirCache)
  const expandedRef = useRef(explorerState.expandedPaths)
  expandedRef.current = explorerState.expandedPaths
  /** Directories being read, and whether another read was asked for meanwhile. */
  const readsInFlight = useRef(new Map<string, boolean>())
  const ignoredReadInFlight = useRef<boolean | null>(null)

  /**
   * Read one directory into the cache. Resolves true when the set of entries
   * differs from what was shown. A read asked for while one is under way runs
   * once more after it instead of alongside it.
   */
  const fetchDir = useCallback(async (dirPath: string): Promise<boolean> => {
    const reads = readsInFlight.current
    if (reads.has(dirPath)) {
      reads.set(dirPath, true)
      return false
    }
    let changed = false
    try {
      do {
        reads.set(dirPath, false)
        const result = await host.shell.fsReadDir(dirPath)
        if (!result.entries) continue
        // Every listing is also the evidence that decides which remembered
        // expansions are still real. Expansion outlives the window now, so a
        // folder renamed or deleted outside Ion would otherwise stay in the set
        // forever.
        useSessionStore.getState().pruneExplorerExpanded(
          dirPath,
          result.entries.filter((entry) => entry.isDirectory).map((entry) => entry.path),
        )
        const sorted = [...result.entries].sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        // An unchanged listing writes nothing, so it renders nothing.
        if (sameListing(dirCacheRef.current.get(dirPath), sorted)) continue
        changed = true
        const next = new Map(dirCacheRef.current)
        next.set(dirPath, sorted)
        dirCacheRef.current = next
        setDirCache(next)
      } while (reads.get(dirPath))
    } finally {
      reads.delete(dirPath)
    }
    return changed
  }, [])

  const fetchIgnored = useCallback((dir: string) => {
    if (ignoredReadInFlight.current !== null) {
      ignoredReadInFlight.current = true
      return
    }
    ignoredReadInFlight.current = false
    host.shell.gitIgnoredFiles(dir).then((result) => {
      setIgnoredPaths((prev) => (sameIgnoredPaths(prev, result.paths) ? prev : new Set(result.paths)))
    }).catch((err) => rDebug('file-explorer', 'gitIgnoredFiles failed', { dir, error: String(err) })).finally(() => {
      const again = ignoredReadInFlight.current
      ignoredReadInFlight.current = null
      if (again) fetchIgnored(dir)
    })
  }, [])

  /** Re-read `dirs`, then the ignored paths when any of them gained or lost an entry. */
  const refreshDirs = useCallback((dirs: string[], ignoredToo: boolean) => {
    void Promise.all(dirs.map((dir) => fetchDir(dir).catch((err) => {
      rWarn('file-explorer', 'directory refresh failed', { dir, error: String(err) })
      return false
    }))).then((changed) => {
      if (ignoredToo || changed.some(Boolean)) fetchIgnored(rootDir)
    })
  }, [rootDir, fetchDir, fetchIgnored])

  // Everything shown is read when the root is first shown and each time it is
  // un-collapsed. Nothing is read while it is collapsed.
  useEffect(() => {
    if (collapsed) return
    refreshDirs([rootDir, ...expandedRef.current], true)
  }, [rootDir, collapsed, refreshDirs])

  // An expanded directory that has never been read is read now. Expansion can
  // arrive after mount, from the state another window or a past session left.
  useEffect(() => {
    if (collapsed) return
    const unread = [...explorerState.expandedPaths].filter((dir) => !dirCacheRef.current.has(dir) && !readsInFlight.current.has(dir))
    if (unread.length > 0) refreshDirs(unread, false)
  }, [collapsed, explorerState.expandedPaths, refreshDirs])

  // After that the tree is re-read only where the server reports a change.
  const handleTreeChange = useCallback((change: FsTreeChange) => {
    const shown = [rootDir, ...expandedRef.current]
    if (change.overflow) {
      rDebug('file-explorer', 're-reading everything shown', { root: rootDir, directories: shown.length })
      refreshDirs(shown, true)
      return
    }
    const changed = new Set(change.directories)
    const affected = shown.filter((dir) => {
      const relativeDir = relativeTreeDirectory(rootDir, dir)
      return relativeDir !== null && changed.has(relativeDir)
    })
    if (affected.length === 0 && !change.ignoreRulesChanged) return
    rDebug('file-explorer', 're-reading changed directories', { root: rootDir, directories: affected.length, ignore_rules_changed: change.ignoreRulesChanged })
    refreshDirs(affected, change.ignoreRulesChanged)
  }, [rootDir, refreshDirs])
  useFileTreeWatch(rootDir, !collapsed, handleTreeChange)

  const handleToggleDir = useCallback((entry: FsEntry) => {
    const isExpanded = explorerState.expandedPaths.has(entry.path)
    setFileExplorerExpanded(rootDir, entry.path, !isExpanded)
    setFileExplorerSelected(rootDir, entry.path)
    if (!isExpanded && !dirCache.has(entry.path)) {
      fetchDir(entry.path).catch((err) => rWarn('file-explorer', 'expand dir fetch failed', { dir: entry.path, error: String(err) }))
    }
  }, [rootDir, explorerState.expandedPaths, dirCache, fetchDir, setFileExplorerExpanded, setFileExplorerSelected])

  const handleFileClick = useCallback((entry: FsEntry, event?: FileClickModifiers) => {
    if (!activeTabId) return
    setFileExplorerSelected(rootDir, entry.path)
    const ext = entry.name.includes('.') ? '.' + entry.name.split('.').pop()!.toLowerCase() : ''
    const router = surfaceRouter()
    const intent = fileOpenIntent(event)

    // The explorer gains the two gestures it never had, so all surfaces agree:
    // ⌥⌘ opens in the operating system, ⇧⌘ reads source even for HTML.
    if (intent === 'native') {
      // Opening in the OS needs 'nativeShell' -- a browser client has the
      // filesystem over the wire but no operating system.
      if (!host.capabilities().includes('nativeShell')) return
      void host.shell.fsOpenNative(entry.path).catch((err) => rWarn('file-explorer', 'open native failed', { path: entry.path, error: String(err) }))
      return
    }
    if (intent === 'source' && isTextFile(entry.name)) {
      if (router) router.openTextFile(rootDir, activeTabId, entry.path)
      else openFileInEditor(rootDir, activeTabId, entry.path)
      return
    }
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

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FsEntry, depth: number) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, entry, depth })
  }, [])

  /**
   * Make the create target visible, then raise the request.
   *
   * The header buttons this replaced could only ever target an already-rendered
   * directory, so two cases are new: a collapsed root renders no tree at all,
   * and `renderTree` only emits the inline input when its parent directory is
   * itself rendered. Un-collapsing the root and expanding (plus fetching) the
   * parent are what keep the input from being created where nothing shows it.
   */
  const requestCreate = useCallback((type: 'file' | 'folder', parentDir: string, depth: number) => {
    if (collapsed) props.onToggleCollapsed()
    if (parentDir !== rootDir && !explorerState.expandedPaths.has(parentDir)) {
      rDebug('file-explorer', 'expanding create target', { dir: parentDir })
      setFileExplorerExpanded(rootDir, parentDir, true)
      fetchDir(parentDir).catch((err) => rWarn('file-explorer', 'create target fetch failed', { dir: parentDir, error: String(err) }))
    }
    props.onRequestCreate(type, parentDir, depth)
  }, [collapsed, props, rootDir, explorerState.expandedPaths, setFileExplorerExpanded, fetchDir])

  const handleInlineSubmit = useCallback(async (name: string) => {
    const input = props.inlineCreate
    if (!input) return
    const fullPath = `${input.parentDir}/${name}`
    if (input.type === 'file') await host.shell.fsCreateFile(fullPath)
    else await host.shell.fsCreateDir(fullPath)
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
    const parentDir = pathDirname(renaming.path) || renaming.path
    const newPath = joinPath(parentDir, trimmed)
    rInfo('file-explorer', 'handleRenameSubmit', { old_path: renaming.path, new_path: newPath })
    try {
      const result = await host.shell.fsRename(renaming.path, newPath)
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

  // Built once per change to the ignored paths, not once per row per render.
  const isIgnored = useMemo(() => ignoredPathMatcher(ignoredPaths), [ignoredPaths])

  const renderTree = useCallback((dirPath: string, depth: number): React.ReactNode[] => {
    // Filtered at render, not at fetch, so toggling the preference re-renders
    // from the existing cache instead of re-reading every open directory.
    const allEntries = dirCache.get(dirPath) || []
    const entries = showHiddenFiles ? allEntries : allEntries.filter((e) => !e.isHidden)
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
            isHidden={entry.isHidden}
            onToggle={() => handleToggleDir(entry)}
            onClick={(e) => handleFileClick(entry, e)}
            onContextMenu={(e) => handleContextMenu(e, entry, depth)}
            colors={colors}
          />,
        )
      }

      if (entry.isDirectory && isExpanded) {
        nodes.push(...renderTree(entry.path, depth + 1))
      }
    }

    return nodes
  }, [dirCache, explorerState, props.inlineCreate, props.onInlineCreateDone, renaming, handleInlineSubmit, handleRenameSubmit, handleRenameCancel, handleToggleDir, handleFileClick, handleContextMenu, isIgnored, showHiddenFiles, colors])

  const baseName = pathSegments(rootDir).pop() || rootDir
  const parentPath = rootDir.slice(0, rootDir.length - baseName.length).replace(/\/$/, '')

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Root header: caret + basename (+ dimmed parent path). */}
      <div
        onClick={props.onToggleCollapsed}
        onContextMenu={(e) => {
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
        {/* Every root carries the menu, the source repository root included:
            with New File and New Folder gone from the explorer header, this is
            the only way to create at the top level of a root. */}
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
      </div>
      {!collapsed && <div style={{ padding: '0 0 4px' }}>{renderTree(rootDir, 0)}</div>}

      {contextMenu && popoverLayer && (
        <FileExplorerContextMenu
          menu={contextMenu}
          workingDir={rootDir}
          onClose={() => setContextMenu(null)}
          onRename={handleRenameStart}
          onCreate={requestCreate}
          portalTarget={popoverLayer}
        />
      )}
      {headerMenu && (
        <FileExplorerRootHeaderMenu
          x={headerMenu.x}
          y={headerMenu.y}
          rootDir={rootDir}
          onClose={() => setHeaderMenu(null)}
          onRemoveFromWorkspace={props.onRemoveFromWorkspace}
          onCollapseAllInFolder={() => useSessionStore.getState().collapseAllExplorer(rootDir)}
          onCreate={(type) => requestCreate(type, rootDir, 0)}
        />
      )}
    </div>
  )
}
