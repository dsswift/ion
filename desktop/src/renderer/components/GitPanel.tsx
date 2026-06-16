import React, { useEffect, useRef, useCallback, useMemo } from 'react'
import {
  CaretDown, CaretRight, ArrowsClockwise, X, ListBullets, TreeStructure, Info,
} from '@phosphor-icons/react'
import { useShallow } from 'zustand/shallow'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { useRepoState } from '../stores/git'
import { useGitDragSplit } from '../hooks/useGitDragSplit'
import { GitChangesSection } from './GitChangesSection'
import { GitGraphSection } from './GitGraphSection'
import { CommitForm } from './git/CommitForm'

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
  const files = repoState?.files ?? []
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
      useSessionStore.getState().sendMessage('commit the current changes')
    }
  }, [commitCommand, directory, activeTabId])

  const refresh = useCallback(() => {
    if (directory && directory !== '~') window.ion.gitRefresh(directory).catch(() => {})
  }, [directory])

  // Force a fresh snapshot whenever the panel opens. The git watcher is
  // best-effort — if it dropped events while the panel was closed, the
  // displayed state could be stale. This guarantees the user sees fresh
  // data the moment the panel becomes visible.
  useEffect(() => {
    if (directory && directory !== '~') {
      window.ion.gitRefresh(directory).catch(() => {})
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
          <button
            onClick={() => useSessionStore.getState().closeGitPanel()}
            className="flex items-center justify-center rounded transition-colors"
            style={{ color: colors.textTertiary, cursor: 'pointer', padding: 1 }}
            title="Close git panel"
          >
            <X size={11} />
          </button>
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
        <button
          onClick={refresh}
          className="p-0.5 rounded transition-colors"
          style={{ color: colors.textTertiary }}
          title="Refresh"
        >
          <ArrowsClockwise size={11} />
        </button>
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
          <button
            onClick={() => setChangesOpen(!changesOpen)}
            className="flex items-center gap-1"
            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}
          >
            {changesOpen ? <CaretDown size={10} /> : <CaretRight size={10} />}
            Changes
          </button>
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
              <button
                onClick={() => usePreferencesStore.getState().setGitChangesTreeView(!gitChangesTreeView)}
                className="p-0.5 rounded transition-colors"
                style={{ color: colors.textTertiary, background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                title={gitChangesTreeView ? 'List view' : 'Tree view'}
              >
                {gitChangesTreeView ? <ListBullets size={11} /> : <TreeStructure size={11} />}
              </button>
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
              onPush={async () => {
                await window.ion.gitPush(directory)
                refresh()
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
        <button
          onClick={() => setGraphOpen(!graphOpen)}
          className="flex items-center gap-1 px-2.5 w-full text-left"
          style={{
            height: 28,
            background: colors.surfacePrimary,
            borderBottom: `1px solid ${colors.containerBorder}`,
            color: colors.textSecondary,
            fontSize: 11,
            flexShrink: 0,
          }}
        >
          {graphOpen ? <CaretDown size={10} /> : <CaretRight size={10} />}
          Graph
        </button>
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
