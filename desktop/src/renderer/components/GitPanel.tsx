import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  CaretDown, CaretRight, ArrowsClockwise, Robot, Check, X, ListBullets, TreeStructure,
} from '@phosphor-icons/react'
import { useShallow } from 'zustand/shallow'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { useGitPollingStore } from '../hooks/useGitPolling'
import { useGitDragSplit } from '../hooks/useGitDragSplit'
import { GitChangesSection } from './GitChangesSection'
import { GitGraphSection } from './GitGraphSection'

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
  const files = useGitPollingStore((s) => s.files)
  const refreshKey = useGitPollingStore((s) => s.refreshKey)
  const splitRatio = usePreferencesStore((s) => s.gitPanelSplitRatio)
  const setSplitRatio = usePreferencesStore((s) => s.setGitPanelSplitRatio)
  const containerRef = useRef<HTMLDivElement>(null)
  const commitCommand = usePreferencesStore((s) => s.commitCommand)
  const gitChangesTreeView = usePreferencesStore((s) => s.gitChangesTreeView)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const [commitMsg, setCommitMsg] = useState('')

  const stagedCount = useMemo(() => files.filter((f) => f.staged).length, [files])

  const handleCommit = useCallback(async () => {
    if (!commitMsg.trim() || stagedCount === 0) return
    const result = await window.ion.gitCommit(directory, commitMsg.trim())
    if (result.ok) {
      setCommitMsg('')
      useGitPollingStore.getState().refresh()
      // Move tab to done group after successful commit
      const { doneGroupId, tabGroupMode } = usePreferencesStore.getState()
      const { activeTabId: tabId, tabs: allTabs, moveTabToGroup } = useSessionStore.getState()
      const tab = allTabs.find(t => t.id === tabId)
      if (doneGroupId && tabGroupMode === 'manual' && tab && tab.groupId !== doneGroupId) {
        moveTabToGroup(tab.id, doneGroupId)
      }
    }
  }, [commitMsg, stagedCount, directory])

  const handleQuickCommit = useCallback(() => {
    if (commitCommand) {
      const safeCwd = directory.replace(/'/g, "'\\''")
      useSessionStore.getState().runInTerminal(activeTabId, `cd '${safeCwd}' && ${commitCommand}`)
    } else {
      useSessionStore.getState().sendMessage('commit the current changes')
    }
    // Move tab to done group -- user explicitly chose to commit
    const { doneGroupId, tabGroupMode } = usePreferencesStore.getState()
    const { activeTabId: tabId, tabs: allTabs, moveTabToGroup } = useSessionStore.getState()
    const tab = allTabs.find(t => t.id === tabId)
    if (doneGroupId && tabGroupMode === 'manual' && tab && tab.groupId !== doneGroupId) {
      moveTabToGroup(tab.id, doneGroupId)
    }
  }, [commitCommand, directory, activeTabId])

  const refresh = useGitPollingStore((s) => s.refresh)

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
              <input
                value={commitMsg}
                onChange={(e) => setCommitMsg(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) handleCommit() }}
                placeholder="Commit message..."
                onClick={(e) => e.stopPropagation()}
                className="text-[10px] bg-transparent outline-none rounded px-1.5"
                style={{
                  color: colors.textPrimary,
                  border: `1px solid ${colors.containerBorder}`,
                  height: 20,
                  flex: '1 1 0',
                  minWidth: 0,
                  maxWidth: 160,
                }}
              />
              <button
                onClick={handleCommit}
                disabled={!commitMsg.trim() || stagedCount === 0}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: '0 2px',
                  cursor: (!commitMsg.trim() || stagedCount === 0) ? 'not-allowed' : 'pointer',
                  color: (!commitMsg.trim() || stagedCount === 0) ? colors.textMuted : colors.accent,
                  display: 'flex',
                  alignItems: 'center',
                }}
                title="Commit staged changes"
              >
                <Check size={13} weight="bold" />
              </button>
              <button
                onClick={handleQuickCommit}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: '0 2px',
                  cursor: 'pointer',
                  color: colors.textTertiary,
                  display: 'flex',
                  alignItems: 'center',
                }}
                title={commitCommand ? `Run: ${commitCommand}` : 'Let Ion commit'}
              >
                <Robot size={13} />
              </button>
            </>
          )}
        </div>
        {changesOpen && (
          <div style={{ height: changesContentHeight, overflow: 'auto' }}>
            <GitChangesSection directory={directory} files={files} onRefresh={refresh} commitMsg={commitMsg} setCommitMsg={setCommitMsg} treeView={gitChangesTreeView} />
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
