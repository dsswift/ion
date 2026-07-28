import React, { useEffect, useRef, useCallback, useMemo } from 'react'
import {
  ArrowsClockwise, X, ListBullets, TreeStructure, Info, Flask,
} from '@phosphor-icons/react'
import { useShallow } from 'zustand/shallow'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { transitions } from '../theme-tokens'
import { Chevron } from './Chevron'
import { usePreferencesStore } from '../preferences'
import { useRepoState } from '../stores/git'
import { GitChangesSection } from './GitChangesSection'
import { GitGraphSection } from './GitGraphSection'
import { WorktreesSection } from './WorktreesSection'
import { IntegrationSection } from './IntegrationSection'
import { CommitForm } from './git/CommitForm'
import {
  computePaneLayout,
  SECTION_HEADER,
  type PaneId,
  type PaneState,
  type PaneLayoutInput,
} from './git/paneLayout'
import { usePaneSash } from '../hooks/usePaneSash'
import { resolveBenchContext } from './git/benchContext'
import { Sash } from './git/Sash'
import { rDebug, rError } from '../rendererLogger'

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


export function GitPanel() {
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
  const worktreesOpen = usePreferencesStore((s) => s.gitPanelWorktreesOpen)
  const integrationOpen = usePreferencesStore((s) => s.gitPanelIntegrationOpen)
  const setIntegrationOpen = usePreferencesStore((s) => s.setGitPanelIntegrationOpen)
  const setWorktreesOpen = usePreferencesStore((s) => s.setGitPanelWorktreesOpen)
  const setGraphOpen = usePreferencesStore((s) => s.setGitPanelGraphOpen)
  const repoState = useRepoState(directory)
  const files = useMemo(() => repoState?.files ?? [], [repoState?.files])
  const refreshKey = repoState?.revision ?? 0
  const paneProportions = usePreferencesStore((s) => s.gitPanelPaneProportions)
  const setPaneProportions = usePreferencesStore((s) => s.setGitPanelPaneProportions)
  const containerRef = useRef<HTMLDivElement>(null)
  const commitCommand = usePreferencesStore((s) => s.commitCommand)
  const gitChangesTreeView = usePreferencesStore((s) => s.gitChangesTreeView)
  const activeTabId = useSessionStore((s) => s.activeTabId)

  const stagedCount = useMemo(() => files.filter((f) => f.staged).length, [files])

  const handleQuickCommit = useCallback(() => {
    if (commitCommand) {
      const safeCwd = directory.replace(/'/g, "'\\''")
      useSessionStore.getState().runInTerminal(activeTabId, `cd '${safeCwd}' && ${commitCommand}`)
    } else {
      useSessionStore.getState().submit(activeTabId, 'commit the current changes')
    }
  }, [commitCommand, directory, activeTabId])

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

  // The repo root for worktree listing. When the active tab IS a worktree, its
  // worktrees belong to the parent repo, not to the worktree directory -- so
  // resolve through the worktree metadata rather than using `directory`.
  const repoRootPath = worktree?.repoPath ?? directory
  const worktreeEntries = useSessionStore((s) => s.worktreeInventory.get(repoRootPath))
  const worktreeCount = worktreeEntries?.length ?? 0
  const staleWorktreeCount = (worktreeEntries ?? []).filter((w) => w.needsSync).length
  const benchWorkspaces = useSessionStore((s) => s.benchWorkspaces.get(repoRootPath))
  const benchMemberCount = (benchWorkspaces ?? []).reduce((n, w) => n + w.members.length, 0)
  const benchStaleCount = (benchWorkspaces ?? [])
    .reduce((n, w) => n + w.members.filter((m) => m.status === 'stale').length, 0)

  // Is this panel looking AT a bench (rather than at a repo that owns one)?
  // A bench is rebuilt from scratch on every rebuild, so it must never hold
  // uncommitted changes and its history is synthetic — Changes and Graph are
  // hidden rather than merely collapsed. See git/benchContext.ts.
  const benchContext = resolveBenchContext(directory, benchWorkspaces)
  const inBench = benchContext !== null

  // Every pane's expanded state, in render order. Hidden panes (bench mode)
  // are excluded entirely rather than collapsed, so they contribute no header.
  const panes: PaneState[] = useMemo(() => ([
    { id: 'changes', expanded: changesOpen },
    { id: 'worktrees', expanded: worktreesOpen },
    { id: 'integration', expanded: integrationOpen },
    { id: 'graph', expanded: graphOpen },
  ]), [changesOpen, worktreesOpen, integrationOpen, graphOpen])

  const hiddenPanes = useMemo<PaneId[]>(() => (inBench ? ['changes', 'graph'] : []), [inBench])

  // The panel keeps its full height in every state. Space freed by a collapsed
  // pane is redistributed to the expanded ones (distributeEmptySpace), never
  // left as slack and never taken off the panel — which is what previously made
  // it shrink and stranded the bottom of the screen.
  const panelHeight = (expandedUI ? 520 : 400) + 82

  const layoutInput: PaneLayoutInput = useMemo(() => ({
    height: panelHeight,
    panes,
    proportions: paneProportions,
    hidden: hiddenPanes,
  }), [panelHeight, panes, paneProportions, hiddenPanes])

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

  // Cursor override during drag
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
        width: 320,
        // maxHeight, not height: the flex column shrink-wraps its sections, so
        // collapsing Changes and Graph shortens the panel instead of leaving an
        // unusable band at the bottom. No child may carry `flex: 1` -- a grow
        // sink would re-absorb the freed space and restore the dead band.
        height: layout.total,
        background: colors.containerBg,
        border: `1px solid ${colors.containerBorder}`,
        overflow: 'hidden',
      }}
    >
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
          <PanelIconButton
            onClick={() => useSessionStore.getState().closeGitPanel()}
            className="justify-center rounded"
            style={{ padding: 1 }}
            title="Close git panel"
            colors={colors}
          >
            <X size={11} />
          </PanelIconButton>
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

      {/* Changes section. Absent in a bench: a bench must never hold
          uncommitted changes, because the next rebuild discards them, so
          offering the section would invite exactly the work that gets lost. */}
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
            label="Changes"
            onClick={() => setChangesOpen(!changesOpen)}
            className="flex items-center gap-1"
            style={{ color: 'inherit', padding: 0, borderRadius: 4 }}
            colors={colors}
          />
          {files.length > 0 && (
            <span
              className="text-[9px] px-1 rounded-full"
              style={{ background: colors.accentLight, color: colors.accent }}
            >
              {files.length}
            </span>
          )}
          {changesOpen && files.length > 0 && (
            <>
              <div style={{ flex: 1 }} />
              <PanelIconButton
                onClick={() => usePreferencesStore.getState().setGitChangesTreeView(!gitChangesTreeView)}
                className="p-0.5 rounded"
                title={gitChangesTreeView ? 'List view' : 'Tree view'}
                colors={colors}
              >
                {gitChangesTreeView ? <ListBullets size={11} /> : <TreeStructure size={11} />}
              </PanelIconButton>
            </>
          )}
        </div>
        {changesOpen && (
          <div style={{ height: bodyOf('changes'), display: 'flex', flexDirection: 'column' }}>
            <CommitForm
              directory={directory}
              branch={repoState?.branch ?? ''}
              stagedCount={stagedCount}
              onCommit={async (message, amend, opts) => {
                const result = await window.ion.gitCommit(directory, message, { amend, signoff: opts?.signoff, gpg: opts?.gpg })
                if (result.ok) { refresh(); return true }
                return false
              }}
              onQuickCommit={handleQuickCommit}
              onPush={() => {
                void (async () => {
                  await window.ion.gitPush(directory)
                  refresh()
                })().catch((err) => rError('git-panel', 'push failed', { error: String(err) }))
              }}
            />
            <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
              <GitChangesSection directory={directory} files={files} onRefresh={refresh} treeView={gitChangesTreeView} />
            </div>
          </div>
        )}
      </div>

      )}

      <Sash index={sashAfter('changes')} isDragging={isDragging} colors={colors} onSashMouseDown={onSashMouseDown} />

      {/* Worktrees section — the re-entry surface. Sized by the pane layout like
          every other section: it used to be pinned to a 132px constant, which is
          why a five-worktree list clipped the last row no matter how much free
          space the panel had. */}
      <div className="flex flex-col" style={{
        height: totalOf('worktrees'),
        flexShrink: 0,
        overflow: 'hidden',
        borderTop: `1px solid ${colors.containerBorder}`,
      }}>
        <div
          className="flex items-center gap-1 px-2.5"
          style={{
            height: SECTION_HEADER,
            background: colors.surfacePrimary,
            borderBottom: worktreesOpen ? `1px solid ${colors.containerBorder}` : 'none',
            color: colors.textSecondary,
            fontSize: 11,
            flexShrink: 0,
          }}
        >
          <SectionToggleButton
            open={worktreesOpen}
            label="Worktrees"
            onClick={() => setWorktreesOpen(!worktreesOpen)}
            className="flex items-center gap-1"
            style={{ color: 'inherit', padding: 0, borderRadius: 4 }}
            colors={colors}
          />
          {worktreeCount > 0 && (
            <span
              data-testid="worktree-count"
              className="text-[9px] px-1 rounded-full"
              style={{ background: colors.accentLight, color: colors.accent }}
            >
              {worktreeCount}
            </span>
          )}
          {staleWorktreeCount > 0 && (
            <span
              data-testid="worktree-stale-count"
              className="text-[9px]"
              style={{ color: colors.warningFg }}
            >
              {staleWorktreeCount} stale
            </span>
          )}
        </div>
        {worktreesOpen && (
          <div style={{ height: bodyOf('worktrees'), minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <WorktreesSection repoPath={repoRootPath} refreshKey={refreshKey} />
          </div>
        )}
      </div>

      <Sash index={sashAfter('worktrees')} isDragging={isDragging} colors={colors} onSashMouseDown={onSashMouseDown} />

      {/* Integration (bench) section — sized by the pane layout; formerly pinned
          to a 148px constant. */}
      <div className="flex flex-col" style={{
        height: totalOf('integration'),
        flexShrink: 0,
        overflow: 'hidden',
        borderTop: `1px solid ${colors.containerBorder}`,
      }}>
        <div
          className="flex items-center gap-1 px-2.5"
          style={{
            height: SECTION_HEADER,
            background: colors.surfacePrimary,
            borderBottom: integrationOpen ? `1px solid ${colors.containerBorder}` : 'none',
            color: colors.textSecondary,
            fontSize: 11,
            flexShrink: 0,
          }}
        >
          <SectionToggleButton
            open={integrationOpen}
            label={inBench ? 'Integration (Bench)' : 'Integration'}
            onClick={() => setIntegrationOpen(!integrationOpen)}
            className="flex items-center gap-1"
            style={{ color: 'inherit', padding: 0, borderRadius: 4 }}
            colors={colors}
          />
          {benchMemberCount > 0 && (
            <span
              data-testid="bench-member-count"
              className="text-[9px] px-1 rounded-full"
              style={{ background: colors.accentLight, color: colors.accent }}
            >
              {benchMemberCount}
            </span>
          )}
          {benchStaleCount > 0 && (
            <span
              data-testid="bench-stale-count"
              className="text-[9px]"
              style={{ color: colors.warningFg }}
            >
              {benchStaleCount} stale
            </span>
          )}
        </div>
        {integrationOpen && (
          <div style={{ height: bodyOf('integration'), minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <IntegrationSection repoPath={repoRootPath} refreshKey={refreshKey} />
          </div>
        )}
      </div>

      <Sash index={sashAfter('integration')} isDragging={isDragging} colors={colors} onSashMouseDown={onSashMouseDown} />

      {/* Graph section. No `flex: 1` here (and no trailing spacer): the layout
          assigns every pixel, so a grow sink could only hold dead space.
          Absent in a bench: the history there is synthetic — one merge commit
          per member, recreated from scratch on every rebuild — so reading it
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
