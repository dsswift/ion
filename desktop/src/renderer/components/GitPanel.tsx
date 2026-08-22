import React, { useEffect, useRef, useCallback, useMemo } from 'react'
import {
  ArrowsClockwise, X, Info, Flask, TreeStructure,
} from '@phosphor-icons/react'
import { useShallow } from 'zustand/shallow'
import { useSessionStore } from '../stores/sessionStore'
import { usePanelVerticalResize } from '../hooks/usePanelVerticalResize'
import { useElementHeight } from '../hooks/useWindowGeometry'
import { GIT_PANEL_WIDTH } from './panelGeometry'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { transitions } from '../theme-tokens'
import { Chevron } from './Chevron'
import { usePreferencesStore } from '../preferences'
import { useRepoState } from '../stores/git'
import { GitGraphSection } from './GitGraphSection'
import { GitPanelRepoSection } from './GitPanelRepoSection'
import { GitConflictBanner } from './GitConflictBanner'
import {
  computePaneLayout,
  SECTION_HEADER,
  type PaneId,
  type PaneState,
  type PaneLayoutInput,
} from './git/paneLayout'
import { usePaneSash } from '../hooks/usePaneSash'
import { resolveBenchContextAcrossRepos } from './git/benchContext'
import { orderedWorkspaceRoots } from '../../shared/workspace-roots'
import { useWorkspaceRepos } from '../hooks/useWorkspaceRepos'
import { surfaceRouter } from '../lib/file-open-router'
import { Sash } from './git/Sash'
import { rDebug, rTrace } from '../rendererLogger'

/** Panel-header icon button (close, refresh, tree/list toggle). */
function PanelIconButton({
  title,
  onClick,
  colors,
  className,
  style,
  children,
}: {
  title?: string
  onClick: () => void
  colors: ReturnType<typeof useColors>
  className?: string
  style?: React.CSSProperties
  children: React.ReactNode
}) {
  const { hover, pressed, handlers } = useInteractiveState()
  return (
    <button
      title={title}
      onClick={onClick}
      className={`${className ?? ''} ion-focusable`}
      {...handlers}
      style={{
        color: hover ? colors.accent : colors.textTertiary,
        cursor: 'pointer',
        border: 'none',
        background: interactiveBg(colors, { hover: false, pressed }),
        display: 'flex',
        alignItems: 'center',
        transition: `color ${transitions.base}, background ${transitions.base}`,
        ...style,
      }}
    >
      {children}
    </button>
  )
}

/** Collapsible-section header toggle (Changes / Graph) with rotating chevron. */
function SectionToggleButton({
  open,
  label,
  onClick,
  colors,
  className,
  style,
  opaqueBase,
}: {
  open: boolean
  label: string
  onClick: () => void
  colors: ReturnType<typeof useColors>
  className?: string
  style?: React.CSSProperties
  /**
   * Opaque base background (e.g. surfacePrimary). The translucent
   * hover/pressed token is layered over it so the header never turns
   * see-through.
   */
  opaqueBase?: string
}) {
  const { hover, pressed, handlers } = useInteractiveState()
  const overlay = interactiveBg(colors, { hover, pressed })
  const background = opaqueBase
    ? (overlay === 'transparent' ? opaqueBase : `linear-gradient(${overlay}, ${overlay}), ${opaqueBase}`)
    : overlay
  return (
    <button
      onClick={onClick}
      className={`${className ?? ''} ion-focusable`}
      {...handlers}
      style={{
        background,
        border: 'none',
        cursor: 'pointer',
        transition: `background ${transitions.base}`,
        ...style,
      }}
    >
      <Chevron open={open} size={10} weight="regular" />
      {label}
    </button>
  )
}

// ─── Main GitPanel ───


export function GitPanel({
  docked = false,
  onClose,
}: {
  docked?: boolean
  onClose?: () => void
}) {
  const colors = useColors()
  const expandedUI = usePreferencesStore((s) => s.expandedUI)
  const tab = useSessionStore(
    useShallow((s) => {
      const t = s.tabs.find((t) => t.id === s.activeTabId)
      return t ? { workingDirectory: t.workingDirectory, worktree: t.worktree } : undefined
    }),
  )
  const directory = tab?.workingDirectory || '~'
  const worktree = tab?.worktree ?? null

  const changesOpen = usePreferencesStore((s) => s.gitPanelChangesOpen)
  const setChangesOpen = usePreferencesStore((s) => s.setGitPanelChangesOpen)
  const graphOpen = usePreferencesStore((s) => s.gitPanelGraphOpen)
  const setGraphOpen = usePreferencesStore((s) => s.setGitPanelGraphOpen)
  const repoState = useRepoState(directory)
  const files = useMemo(() => repoState?.files ?? [], [repoState?.files])
  const refreshKey = repoState?.revision ?? 0
  const paneProportions = usePreferencesStore((s) => s.gitPanelPaneProportions)
  const setPaneProportions = usePreferencesStore((s) => s.setGitPanelPaneProportions)
  const containerRef = useRef<HTMLDivElement>(null)
  const activeTabId = useSessionStore((s) => s.activeTabId)

  // Workspace repos: the active repo plus every workspace root that is a
  // git repo (non-repos silently omitted). Same ordering helper the
  // explorer uses, so the two surfaces can never disagree.
  const workspaceFolders = usePreferencesStore((s) => s.workspaceFolders)
  const workspaceRoots = useMemo(() => orderedWorkspaceRoots(directory, workspaceFolders), [directory, workspaceFolders])
  const { repos: secondaryRepos } = useWorkspaceRepos(workspaceRoots.secondary)

  // Diff-click override: present only when a surface router is registered
  // (Studio). Overlay keeps the in-section FloatingPanel diff popup.
  const onFileDiffClick = useMemo(() => {
    const router = surfaceRouter()
    if (!router) return undefined
    return (target: { repoDir: string; filePath: string; staged: boolean }) => router.openGitDiff(target)
  }, [])

  const refresh = useCallback(() => {
    if (directory && directory !== '~') window.ion.gitRefresh(directory).catch((err) => rDebug("git", "gitRefresh failed", { directory, error: String(err) }))
  }, [directory])

  // Force a fresh snapshot whenever the panel opens. The git watcher is
  // best-effort — if it dropped events while the panel was closed, the
  // displayed state could be stale. This guarantees the user sees fresh
  // data the moment the panel becomes visible.
  useEffect(() => {
    if (directory && directory !== '~') {
      window.ion.gitRefresh(directory).catch((err) => rDebug("git", "gitRefresh failed", { directory, error: String(err) }))
    }
  }, [directory])

  // Track uncommitted changes for worktree tabs (used by context menus + finish button)
  useEffect(() => {
    if (worktree) {
      useSessionStore.getState().setWorktreeUncommitted(activeTabId, files.length > 0)
    }
  }, [worktree, activeTabId, files])

  // Resolve the owning repository for conflict banners and bench context. Worktree
  // navigation lives in Inbox; Git keeps only inspection and conflict surfaces.
  const allBenchWorkspaces = useSessionStore((s) => s.benchWorkspaces)
  const benchContext = useMemo(
    () => resolveBenchContextAcrossRepos(directory, allBenchWorkspaces),
    [directory, allBenchWorkspaces],
  )
  const repoRootPath = worktree?.repoPath ?? benchContext?.repoPath ?? directory

  // Is this panel looking AT a bench (rather than at a repo that owns one)?
  // A bench is recreated from scratch on every assembly, so it must never hold
  // uncommitted changes and its history is synthetic — Changes and Graph are
  // hidden rather than merely collapsed. See git/benchContext.ts. Resolved
  // above, because `repoRootPath` depends on it.
  const inBench = benchContext !== null

  // Every pane's expanded state, in render order. Hidden panes (bench mode)
  // are excluded entirely rather than collapsed, so they contribute no header.
  const panes: PaneState[] = useMemo(() => ([
    { id: 'changes', expanded: changesOpen },
    { id: 'graph', expanded: graphOpen },
  ]), [changesOpen, graphOpen])

  const hiddenPanes = useMemo<PaneId[]>(() => (inBench ? ['changes', 'graph'] : []), [inBench])

  // The panel keeps its full height in every state. Space freed by a collapsed
  // pane is redistributed to the expanded ones (distributeEmptySpace), never
  // left as slack and never taken off the panel — which is what previously made
  // it shrink and stranded the bottom of the screen.
  const { height: panelHeight, renderHandle } = usePanelVerticalResize({
    panelId: 'git-panel',
    expandedUI,
    override: usePreferencesStore((st) => st.gitPanelHeight),
    onCommit: usePreferencesStore((st) => st.setGitPanelHeight),
  })

  const dockedContainerHeight = useElementHeight(containerRef, panelHeight)
  const effectivePanelHeight = docked ? dockedContainerHeight : panelHeight

  useEffect(() => {
    rTrace('git', 'resolved panel layout height', {
      docked: String(docked),
      container_height: docked ? dockedContainerHeight : null,
      layout_height: effectivePanelHeight,
    })
  }, [docked, dockedContainerHeight, effectivePanelHeight])

  const layoutInput: PaneLayoutInput = useMemo(() => ({
    height: effectivePanelHeight,
    panes,
    proportions: paneProportions,
    hidden: hiddenPanes,
  }), [effectivePanelHeight, panes, paneProportions, hiddenPanes])

  const layout = useMemo(() => computePaneLayout(layoutInput), [layoutInput])

  /** Body height for one pane, or 0 when collapsed/hidden. */
  const bodyOf = useCallback(
    (id: PaneId): number => layout.sizes.find((p) => p.id === id)?.body ?? 0,
    [layout],
  )
  /** Total height for one pane; 0 when the pane is hidden entirely. */
  const totalOf = useCallback(
    (id: PaneId): number => layout.sizes.find((p) => p.id === id)?.total ?? 0,
    [layout],
  )
  /** Sash index for the boundary directly beneath `id`, or -1 when there is none. */
  const sashAfter = useCallback(
    (id: PaneId): number => layout.sashes.findIndex((sash) => sash.afterId === id),
    [layout],
  )

  // Live input getter: the drag must see the CURRENT pane states, not the ones
  // captured when the handler was created.
  const layoutInputRef = useRef(layoutInput)
  layoutInputRef.current = layoutInput
  const { onSashMouseDown, isDragging } = usePaneSash(
    useCallback(() => layoutInputRef.current, []),
    setPaneProportions,
  )

  // Cursor override during a SASH drag. The panel-height drag sets its own,
  // because it runs from a hook with no access to this effect.
  useEffect(() => {
    if (isDragging) {
      document.body.style.cursor = 'row-resize'
      return () => { document.body.style.cursor = '' }
    }
  }, [isDragging])

  return (
    <div
      ref={containerRef}
      data-ion-ui
      className="glass-surface rounded-xl flex flex-col"
      style={{
        width: docked ? '100%' : GIT_PANEL_WIDTH,
        height: docked ? '100%' : layout.total,
        flex: docked ? 1 : undefined,
        minHeight: 0,
        background: colors.containerBg,
        border: docked ? 'none' : `1px solid ${colors.containerBorder}`,
        borderRadius: docked ? 0 : undefined,
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {!docked && renderHandle()}

      {/* Panel header */}
      <div
        className="flex items-center justify-between px-2.5"
        style={{
          height: SECTION_HEADER,
          borderBottom: `1px solid ${colors.containerBorder}`,
          background: colors.surfacePrimary,
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {!docked && (
            <PanelIconButton
              onClick={() => onClose ? onClose() : useSessionStore.getState().closeGitPanel()}
              className="justify-center rounded"
              style={{ padding: 1 }}
              title="Close git panel"
              colors={colors}
            >
              <X size={11} />
            </PanelIconButton>
          )}
          <span className="text-[10px] font-medium" style={{ color: colors.textTertiary }}>
            Git
            <span style={{ color: colors.textMuted, marginLeft: 4 }}>
              {directory.split('/').filter(Boolean).pop() || '~'}
            </span>
          </span>
        </div>
        {repoState?.watcherIgnored && (
          <span
            title="Live watching is off for this directory. The panel refreshes automatically when you open it, switch tabs, or focus the window. Use refresh for an immediate update."
            style={{ color: colors.textTertiary, flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}
          >
            <Info size={11} />
          </span>
        )}
        <PanelIconButton
          onClick={refresh}
          className="p-0.5 rounded"
          title="Refresh"
          colors={colors}
        >
          <ArrowsClockwise size={11} />
        </PanelIconButton>
      </div>

      {/* Conflict banner: any directory of this project mid-operation with
          conflicts. Lives above the bench banner because a conflict blocks
          everything else the panel offers. */}
      <GitConflictBanner repoPath={repoRootPath} />

      {/* Bench banner: names WHICH bench, so the operator can tell without
          opening Integration. Only rendered in a bench. */}
      {inBench && benchContext && (
        <div
          data-testid="git-panel-bench-banner"
          className="flex items-center gap-1 px-2.5"
          style={{
            height: SECTION_HEADER,
            flexShrink: 0,
            fontSize: 10,
            color: colors.textTertiary,
            borderBottom: `1px solid ${colors.containerBorder}`,
          }}
        >
          <Flask size={11} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            Integration bench for <strong style={{ color: colors.textSecondary }}>{benchContext.sourceBranch}</strong>
            {' '}— edits belong in the member worktrees
          </span>
        </div>
      )}

      {/* Changes zone: one repo section per workspace repo — the active
          repo first (default expanded), then workspace repos (default
          collapsed; persisted per-repo). Absent in a bench: a bench must
          never hold uncommitted changes, because the next assembly discards
          them, so offering the zone would invite exactly the work that gets
          lost. */}
      {!inBench && (
      <div className="flex flex-col" style={{
        height: totalOf('changes'),
        flexShrink: 0,
        overflow: 'hidden',
      }}>
        <div
          className="flex items-center gap-1 px-2.5"
          style={{
            height: SECTION_HEADER,
            background: colors.surfacePrimary,
            borderBottom: `1px solid ${colors.containerBorder}`,
            color: colors.textSecondary,
            fontSize: 11,
            flexShrink: 0,
          }}
        >
          <SectionToggleButton
            open={changesOpen}
            label={secondaryRepos.length > 0 ? 'Changes (Workspace)' : 'Changes'}
            onClick={() => setChangesOpen(!changesOpen)}
            className="flex items-center gap-1"
            style={{ color: 'inherit', padding: 0, borderRadius: 4 }}
            colors={colors}
          />
          {changesOpen && (
            <>
              <div style={{ flex: 1 }} />
              <PanelIconButton
                onClick={() => usePreferencesStore.getState().setGitChangesTreeView(!usePreferencesStore.getState().gitChangesTreeView)}
                className="p-0.5 rounded"
                title="Toggle tree view"
                colors={colors}
              >
                <TreeStructure size={11} />
              </PanelIconButton>
            </>
          )}
        </div>
        {changesOpen && (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
            {directory !== '~' && (
              <GitPanelRepoSection
                directory={directory}
                isPrimary
                onFileDiffClick={onFileDiffClick}
              />
            )}
            {secondaryRepos.map((repo) => (
              <GitPanelRepoSection
                key={repo}
                directory={repo}
                isPrimary={false}
                onFileDiffClick={onFileDiffClick}
              />
            ))}
          </div>
        )}
      </div>

      )}

      <Sash index={sashAfter('changes')} isDragging={isDragging} colors={colors} onSashMouseDown={onSashMouseDown} />

      {/* Graph section. No `flex: 1` here (and no trailing spacer): the layout
          assigns every pixel, so a grow sink could only hold dead space.
          Absent in a bench: the history there is synthetic — one merge commit
          per member, recreated from scratch on every assembly — so reading it
          tells the operator nothing about real history. */}
      {!inBench && (
      <div className="flex flex-col" style={{
        height: totalOf('graph'),
        flexShrink: 0,
        minHeight: 0,
      }}>
        <SectionToggleButton
          open={graphOpen}
          label="Graph"
          onClick={() => setGraphOpen(!graphOpen)}
          className="flex items-center gap-1 px-2.5 w-full text-left"
          style={{
            height: SECTION_HEADER,
            borderBottom: `1px solid ${colors.containerBorder}`,
            color: colors.textSecondary,
            fontSize: 11,
            flexShrink: 0,
          }}
          opaqueBase={colors.surfacePrimary}
          colors={colors}
        />
        {graphOpen && (
          <div style={{ height: bodyOf('graph'), minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <GitGraphSection directory={directory} onRefresh={refresh} refreshKey={refreshKey} worktree={worktree} hasUncommittedChanges={files.length > 0} />
          </div>
        )}
      </div>
      )}
    </div>
  )
}
