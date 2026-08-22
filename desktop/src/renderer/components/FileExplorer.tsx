/**
 * FileExplorer — multi-root workspace orchestrator.
 *
 * Renders one FileExplorerRootSection per workspace root: the active tab's
 * own directory first (primary, accent header), then the project's extra
 * workspace folders (per-project setting, D3) in localeCompare order —
 * ordering/dedupe via the shared orderedWorkspaceRoots helper the git panel
 * also consumes, so the two surfaces can never diverge.
 *
 * A no-directory tab ('~') renders nothing (no project, no workspace
 * entry). New File/Folder target the root containing the current selection
 * (default primary). Root collapse is window-local session state
 * (fileExplorerRootCollapsed, MIRROR_LOCAL).
 */
import React, { useState, useCallback, useMemo } from 'react'
import {
  X, FilePlus, FolderPlus, ArrowsClockwise, ArrowsInLineVertical, FolderSimplePlus,
} from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { transitions } from '../theme-tokens'
import { usePreferencesStore } from '../preferences'
import { usePanelVerticalResize } from '../hooks/usePanelVerticalResize'
import { FileExplorerRootSection } from './FileExplorerRootSection'
import { ImageViewer } from './ImageViewer'
import { orderedWorkspaceRoots } from '../../shared/workspace-roots'
import { rDebug, rError } from '../rendererLogger'

/**
 * Header icon button (close X, New File, New Folder, Refresh, Collapse All,
 * Add Folder). Standard interactive states.
 */
function ExplorerHeaderButton({
  title,
  onClick,
  colors,
  style,
  children,
}: {
  title: string
  onClick: () => void
  colors: ReturnType<typeof useColors>
  style?: React.CSSProperties
  children: React.ReactNode
}) {
  const { hover, pressed, handlers } = useInteractiveState()
  return (
    <button
      title={title}
      onClick={onClick}
      className="ion-focusable"
      {...handlers}
      style={{
        background: interactiveBg(colors, { hover: false, pressed }),
        border: 'none',
        padding: 2,
        cursor: 'pointer',
        color: hover ? colors.accent : colors.textTertiary,
        display: 'flex',
        alignItems: 'center',
        borderRadius: 4,
        transition: `color ${transitions.base}, background ${transitions.base}`,
        ...style,
      }}
    >
      {children}
    </button>
  )
}

export function FileExplorer({
  docked = false,
  onClose,
}: {
  docked?: boolean
  onClose?: () => void
}) {
  const colors = useColors()
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const tabs = useSessionStore((s) => s.tabs)
  const explorerStates = useSessionStore((s) => s.fileExplorerStates)
  const rootCollapsed = useSessionStore((s) => s.fileExplorerRootCollapsed)
  const { collapseAllExplorer, toggleFileExplorer, setExplorerRootCollapsed } = useSessionStore.getState()
  const workspaceFolders = usePreferencesStore((s) => s.workspaceFolders)
  const addWorkspaceFolder = usePreferencesStore((s) => s.addWorkspaceFolder)
  const removeWorkspaceFolder = usePreferencesStore((s) => s.removeWorkspaceFolder)

  const workingDir = useMemo(() => {
    const tab = tabs.find((t) => t.id === activeTabId)
    return tab?.workingDirectory || null
  }, [tabs, activeTabId])

  const roots = useMemo(() => orderedWorkspaceRoots(workingDir, workspaceFolders), [workingDir, workspaceFolders])
  const allRoots = useMemo(
    () => (roots.primary ? [roots.primary, ...roots.secondary] : []),
    [roots],
  )

  const [imagePreview, setImagePreview] = useState<{ path: string; name: string } | null>(null)
  const [inlineCreate, setInlineCreate] = useState<{ rootDir: string; type: 'file' | 'folder'; parentDir: string; depth: number } | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)

  /** The root that owns the current selection (New File/Folder target). */
  const selectionRoot = useMemo(() => {
    for (const root of allRoots) {
      if (explorerStates.get(root)?.selectedPath) return root
    }
    return roots.primary
  }, [allRoots, explorerStates, roots.primary])

  const startInlineCreate = useCallback(
    (type: 'file' | 'folder') => {
      const rootDir = selectionRoot
      if (!rootDir) return
      // Target the selected directory when the selection is a dir path,
      // else the root itself. Depth is visual only; the section resolves
      // placement by parentDir.
      const selected = explorerStates.get(rootDir)?.selectedPath
      const expandedPaths = explorerStates.get(rootDir)?.expandedPaths ?? new Set<string>()
      const parentDir = selected && expandedPaths.has(selected) ? selected : rootDir
      setInlineCreate({ rootDir, type, parentDir, depth: 0 })
      rDebug('file-explorer', 'inline create started', { type, root: rootDir, parent: parentDir })
    },
    [selectionRoot, explorerStates],
  )

  const handleAddFolder = useCallback(() => {
    if (!roots.primary) return
    const primary = roots.primary
    void window.ion
      .selectDirectory()
      .then((dir) => {
        if (dir) addWorkspaceFolder(primary, dir)
      })
      .catch((err) => rError('file-explorer', 'add workspace folder failed', { error: String(err) }))
  }, [roots.primary, addWorkspaceFolder])

  const expandedUI = usePreferencesStore((s) => s.expandedUI)
  // Declared BEFORE the early return: hooks must run on every render. The same
  // hook the git panel uses, so the two cannot drift apart in either their
  // default height or their drag behaviour.
  const { height: panelHeight, renderHandle } = usePanelVerticalResize({
    panelId: 'file-explorer',
    expandedUI,
    override: usePreferencesStore((s) => s.fileExplorerHeight),
    onCommit: usePreferencesStore((s) => s.setFileExplorerHeight),
  })

  if (!roots.primary) return null
  const primary = roots.primary

  return (
    <div
      data-ion-ui
      className="glass-surface"
      style={{
        width: '100%',
        height: docked ? '100%' : panelHeight,
        flex: docked ? 1 : undefined,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: colors.containerBg,
        border: docked ? 'none' : `1px solid ${colors.containerBorder}`,
        borderRadius: docked ? 0 : 16,
        boxShadow: docked ? 'none' : colors.cardShadow,
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {!docked && renderHandle()}

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
          {!docked && (
            <ExplorerHeaderButton
              title="Close explorer"
              onClick={() => onClose ? onClose() : toggleFileExplorer(activeTabId)}
              colors={colors}
              style={{ flexShrink: 0, padding: 1, justifyContent: 'center' }}
            >
              <X size={11} />
            </ExplorerHeaderButton>
          )}
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
            {roots.secondary.length > 0 ? 'WORKSPACE' : (primary.split('/').pop()?.toUpperCase() || 'PROJECT')}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {[
            { Icon: FilePlus, title: 'New File', action: () => startInlineCreate('file') },
            { Icon: FolderPlus, title: 'New Folder', action: () => startInlineCreate('folder') },
            { Icon: FolderSimplePlus, title: 'Add Folder to Workspace', action: handleAddFolder },
            { Icon: ArrowsClockwise, title: 'Refresh', action: () => setRefreshNonce((n) => n + 1) },
            { Icon: ArrowsInLineVertical, title: 'Collapse All', action: () => allRoots.forEach((r) => collapseAllExplorer(r)) },
          ].map(({ Icon, title, action }) => (
            <ExplorerHeaderButton key={title} title={title} onClick={action} colors={colors}>
              <Icon size={14} />
            </ExplorerHeaderButton>
          ))}
        </div>
      </div>

      {/* Root sections */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
        {allRoots.map((root) => (
          <FileExplorerRootSection
            // refreshNonce in the key forces a remount (and thereby a fresh
            // fetch) on manual refresh — cheap and unambiguous.
            key={`${root}:${refreshNonce}`}
            rootDir={root}
            isPrimary={root === primary}
            collapsed={rootCollapsed.has(root)}
            onToggleCollapsed={() => setExplorerRootCollapsed(root, !rootCollapsed.has(root))}
            onOpenImage={setImagePreview}
            onRemoveFromWorkspace={root === primary ? undefined : () => removeWorkspaceFolder(primary, root)}
            inlineCreate={inlineCreate && inlineCreate.rootDir === root ? inlineCreate : null}
            onInlineCreateDone={() => setInlineCreate(null)}
          />
        ))}
      </div>

      {/* Image preview (overlay legacy popup; Studio routes via the router) */}
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
