import React, { useEffect, useRef, useCallback, useMemo } from 'react'
import {
  ArrowsClockwise, X, ListBullets, TreeStructure, Info,
} from '@phosphor-icons/react'
import { useShallow } from 'zustand/shallow'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { transitions } from '../theme-tokens'
import { Chevron } from './Chevron'
import { usePreferencesStore } from '../preferences'
import { useRepoState } from '../stores/git'
import { useGitDragSplit } from '../hooks/useGitDragSplit'
import { GitChangesSection } from './GitChangesSection'
import { GitGraphSection } from './GitGraphSection'
import { CommitForm } from './git/CommitForm'
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
  const setGraphOpen = usePreferencesStore((s) => s.setGitPanelGraphOpen)
  const repoState = useRepoState(directory)
  const files = useMemo(() => repoState?.files ?? [], [repoState?.files])
  const refreshKey = repoState?.revision ?? 0
  const splitRatio = usePreferencesStore((s) => s.gitPanelSplitRatio)
  const setSplitRatio = usePreferencesStore((s) => s.setGitPanelSplitRatio)
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

  // Drag split between Changes and Graph
  const FIXED_CHROME = 28 + 28 + 28 + 6 // panel header + changes header + graph header + divider
  const { onMouseDown: onDividerMouseDown, isDragging } = useGitDragSplit(
    containerRef, splitRatio, setSplitRatio, FIXED_CHROME,
  )

  // Cursor override during drag
  useEffect(() => {
    if (isDragging) {
      document.body.style.cursor = 'row-resize'
      return () => { document.body.style.cursor = '' }
    }
  }, [isDragging])

  // Panel height = conversation card + gap + input pill so top edges align
  // card: bodyMaxHeight + tabStrip(40) + border(2), gap: 10, input pill: 38
  const bodyMaxHeight = expandedUI ? 520 : 400
  const panelHeight = bodyMaxHeight + 82
  const bothOpen = changesOpen && graphOpen
  const availableHeight = panelHeight - FIXED_CHROME

  let changesContentHeight: number | undefined
  let graphContentHeight: number | undefined

  if (bothOpen) {
    changesContentHeight = Math.round(availableHeight * splitRatio)
    graphContentHeight = availableHeight - changesContentHeight
  } else if (changesOpen) {
    // Reclaim divider space only — collapsed graph header stays visible
    changesContentHeight = availableHeight + 6
  } else if (graphOpen) {
    // Reclaim divider space only — collapsed changes header stays visible
    graphContentHeight = availableHeight + 6
  }

  return (
    <div
      ref={containerRef}
      data-ion-ui
      className="glass-surface rounded-xl flex flex-col"
      style={{
        width: 280,
        height: panelHeight,
        background: colors.containerBg,
        border: `1px solid ${colors.containerBorder}`,
        overflow: 'hidden',
      }}
    >
      {/* Panel header */}
      <div
        className="flex items-center justify-between px-2.5"
        style={{
          height: 28,
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

      {/* Changes section */}
      <div className="flex flex-col" style={{
        height: changesOpen ? (changesContentHeight! + 28) : 28,
        flexShrink: 0,
        overflow: 'hidden',
      }}>
        <div
          className="flex items-center gap-1 px-2.5"
          style={{
            height: 28,
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
          <div style={{ height: changesContentHeight, display: 'flex', flexDirection: 'column' }}>
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

      {/* Draggable divider */}
      {bothOpen && (
        <div
          data-ion-ui
          onMouseDown={onDividerMouseDown}
          style={{
            height: 6,
            flexShrink: 0,
            cursor: 'row-resize',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: isDragging ? colors.surfaceHover : 'transparent',
            transition: isDragging ? 'none' : 'background 0.15s',
          }}
          onMouseEnter={(e) => {
            if (!isDragging) (e.currentTarget as HTMLElement).style.background = colors.surfaceHover
          }}
          onMouseLeave={(e) => {
            if (!isDragging) (e.currentTarget as HTMLElement).style.background = 'transparent'
          }}
        >
          <div style={{
            width: 24,
            height: 2,
            borderRadius: 1,
            background: colors.textTertiary,
            opacity: isDragging ? 0.8 : 0.4,
          }} />
        </div>
      )}

      {/* Graph section */}
      <div className="flex flex-col" style={{
        height: graphOpen ? (graphContentHeight! + 28) : 28,
        flex: (!changesOpen && !graphOpen) ? 1 : undefined,
        minHeight: 0,
      }}>
        <SectionToggleButton
          open={graphOpen}
          label="Graph"
          onClick={() => setGraphOpen(!graphOpen)}
          className="flex items-center gap-1 px-2.5 w-full text-left"
          style={{
            height: 28,
            borderBottom: `1px solid ${colors.containerBorder}`,
            color: colors.textSecondary,
            fontSize: 11,
            flexShrink: 0,
          }}
          opaqueBase={colors.surfacePrimary}
          colors={colors}
        />
        {graphOpen && (
          <div style={{ height: graphContentHeight, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <GitGraphSection directory={directory} onRefresh={refresh} refreshKey={refreshKey} worktree={worktree} hasUncommittedChanges={files.length > 0} />
          </div>
        )}
      </div>

      {/* Spacer when both collapsed */}
      {!changesOpen && !graphOpen && (
        <div style={{ flex: 1 }} />
      )}
    </div>
  )
}
