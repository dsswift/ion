/**
 * FileExplorer — multi-root workspace orchestrator.
 *
 * Renders one FileExplorerRootSection per workspace root: the active tab's
 * own directory first (primary, accent header), then the project's extra
 * workspace folders (per-project setting, D3) in localeCompare order —
 * ordering/dedupe via the shared orderedWorkspaceRoots helper the git panel
 * also consumes, so the two surfaces can never diverge.
 *
 * A no-directory tab ('~') renders nothing. Mounted folders are keyed by the
 * PROJECT that owns the active directory (useProjectDir), so a worktree or
 * bench tab shows the same set as a tab in the base repo.
 *
 * The header carries only explorer-wide actions. Creating a file or folder is
 * a folder-scoped action and lives on the right-click menus (entry rows and
 * root headers), where the target is explicit instead of inferred from an
 * invisible selection. Root collapse is window-local session state
 * (fileExplorerRootCollapsed, MIRROR_LOCAL).
 */
import React, { useState, useCallback, useMemo } from 'react'
import { X, ArrowsClockwise, ArrowsInLineVertical, Eye, EyeSlash, Folders } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { transitions } from '../theme-tokens'
import { usePreferencesStore } from '../preferences'
import { usePanelVerticalResize } from '../hooks/usePanelVerticalResize'
import { FileExplorerRootSection } from './FileExplorerRootSection'
import { ImageViewer } from './ImageViewer'
import { orderedWorkspaceRoots } from '../../shared/workspace-roots'
import { useProjectDir } from '../hooks/useProjectDir'
import { Tooltip } from './git/Tooltip'
import { rDebug, rError } from '../rendererLogger'
import { pathSegments } from '../../shared/paths'

/**
 * Header icon button (close X, Add Folder to Workspace, Refresh, Collapse All).
 * Standard interactive states.
 *
 * The label rides `<Tooltip>` rather than the HTML `title` attribute: a native
 * tooltip renders behind the Electron overlay, so these labels were invisible
 * in the Overlay presentation.
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
    <Tooltip text={title}>
    <button
      aria-label={title}
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
    </Tooltip>
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
  const rootCollapsed = useSessionStore((s) => s.fileExplorerRootCollapsed)
  const { collapseAllExplorer, toggleFileExplorer, setExplorerRootCollapsed } = useSessionStore.getState()
  const workspaceFolders = usePreferencesStore((s) => s.workspaceFolders)
  const showHiddenFiles = usePreferencesStore((s) => s.showHiddenFiles)
  const setShowHiddenFiles = usePreferencesStore((s) => s.setShowHiddenFiles)
  const addWorkspaceFolder = usePreferencesStore((s) => s.addWorkspaceFolder)
  const removeWorkspaceFolder = usePreferencesStore((s) => s.removeWorkspaceFolder)

  const activeTab = useMemo(() => tabs.find((t) => t.id === activeTabId), [tabs, activeTabId])
  const workingDir = activeTab?.workingDirectory || null
  const projectDir = useProjectDir(workingDir, activeTab?.worktree)

  const roots = useMemo(() => orderedWorkspaceRoots(workingDir, projectDir, workspaceFolders), [workingDir, projectDir, workspaceFolders])
  const allRoots = useMemo(
    () => (roots.primary ? [roots.primary, ...roots.secondary] : []),
    [roots],
  )

  const [imagePreview, setImagePreview] = useState<{ path: string; name: string } | null>(null)
  const [inlineCreate, setInlineCreate] = useState<{ rootDir: string; type: 'file' | 'folder'; parentDir: string; depth: number } | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)

  /**
   * Both right-click menus name their target, so the explorer no longer has to
   * infer one from the selection: the root that asked, the folder to create in,
   * and the indent to render the input at all arrive with the request.
   */
  const handleRequestCreate = useCallback(
    (rootDir: string, type: 'file' | 'folder', parentDir: string, depth: number) => {
      setInlineCreate({ rootDir, type, parentDir, depth })
      rDebug('file-explorer', 'inline create started', { type, root: rootDir, parent: parentDir, depth })
    },
    [],
  )

  const handleAddFolder = useCallback(() => {
    if (!projectDir) return
    void window.ion
      .selectDirectory()
      .then((dir) => {
        if (dir) addWorkspaceFolder(projectDir, dir)
      })
      .catch((err) => rError('file-explorer', 'add workspace folder failed', { error: String(err) }))
  }, [projectDir, addWorkspaceFolder])

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
            {roots.secondary.length > 0 ? 'WORKSPACE' : (pathSegments(primary).pop()?.toUpperCase() || 'PROJECT')}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {[
            // Explorer-wide only. Anything scoped to one folder is a right-click
            // action on that folder, not a header button with an invisible target.
            { Icon: Folders, title: 'Add Folder to Workspace', action: handleAddFolder },
            // Explorer-wide, so it belongs here rather than on a folder's
            // context menu. The label states the resulting action, not the
            // current state, so it reads unambiguously either way.
            {
              Icon: showHiddenFiles ? EyeSlash : Eye,
              title: showHiddenFiles ? 'Hide Hidden Files' : 'Show Hidden Files',
              action: () => setShowHiddenFiles(!showHiddenFiles),
            },
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
            onRemoveFromWorkspace={root === primary || !projectDir ? undefined : () => removeWorkspaceFolder(projectDir, root)}
            inlineCreate={inlineCreate && inlineCreate.rootDir === root ? inlineCreate : null}
            onInlineCreateDone={() => setInlineCreate(null)}
            onRequestCreate={(type, parentDir, depth) => handleRequestCreate(root, type, parentDir, depth)}
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
