import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence } from 'framer-motion'
import {
  ArrowsClockwise, ArrowDown, ArrowUp, CheckCircle, X, SpinnerGap,
} from '@phosphor-icons/react'
import { Tooltip } from './git/Tooltip'
import { useSessionStore } from '../stores/sessionStore'
import { usePopoverLayer } from './PopoverLayer'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { computeGraphLayout } from '../utils/gitGraphLayout'
import { FloatingPanel } from './FloatingPanel'
import { DiffPane } from './git/DiffPane'
import { useRepoBranch } from '../stores/git'
import type { GitCommit, GitCommitDetail, GitCommitFile } from '../../shared/types'
import { BranchPicker } from './GitBranchPicker'
import { GraphRow, CommitFileList } from './GitGraphRow'
import { CommitPopup } from './GitCommitPopup'
import { CommitContextMenu } from './GitCommitContextMenu'
import { FinishWorkContextMenu } from './GitFinishWorkMenu'
import { CommitDetailsPane } from './git/CommitDetailsPane'
import { VirtualCommitList } from './git/VirtualCommitList'
import { GraphFilterBar, EMPTY_FILTERS, type GraphFilters } from './git/GraphFilterBar'
import { RebaseEditor, type RebaseCommit } from './git/RebaseEditor'

// ─── Graph Section ───

export function GitGraphSection({
  directory,
  onRefresh,
  refreshKey,
  worktree,
  hasUncommittedChanges,
}: {
  directory: string
  onRefresh: () => void
  refreshKey: number
  worktree?: { branchName: string; sourceBranch: string; worktreePath: string; repoPath: string } | null
  hasUncommittedChanges: boolean
}) {
  const colors = useColors()
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const branch = useRepoBranch(directory)
  const [fetchingAction, setFetchingAction] = useState<string | null>(null)
  const [pushConfirm, setPushConfirm] = useState(false)
  const [rebaseError, setRebaseError] = useState<string | null>(null)
  const [finishMenuAnchor, setFinishMenuAnchor] = useState<{ x: number; y: number } | null>(null)
  const strategy = usePreferencesStore((s) => s.worktreeCompletionStrategy)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const [graphFilters, setGraphFilters] = useState<GraphFilters>(EMPTY_FILTERS)
  const [rebaseTarget, setRebaseTarget] = useState<{ onto: string; commits: RebaseCommit[] } | null>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const commitsRef = useRef<GitCommit[]>([])
  commitsRef.current = commits

  const loadGraph = useCallback(async (append = false) => {
    setLoading(true)
    try {
      const skip = append ? commitsRef.current.length : 0
      const result = await window.ion.gitGraph(
        directory, skip, 100,
        graphFilters.search || undefined,
        graphFilters.author || undefined,
        {
          path: graphFilters.path || undefined,
          refKind: graphFilters.refKind && graphFilters.refKind !== 'all' ? graphFilters.refKind : undefined,
          dateAfter: graphFilters.dateAfter || undefined,
          dateBefore: graphFilters.dateBefore || undefined,
        },
      )
      if (result.isGitRepo) {
        const newCommits = append ? [...commitsRef.current, ...result.commits] : result.commits
        setCommits(newCommits)
        setTotalCount(result.totalCount)
      }
    } catch {}
    setLoading(false)
  }, [directory, graphFilters])

  useEffect(() => {
    // Reset commits when directory or filters change, then load fresh
    setCommits([])
    setTotalCount(0)
    setExpandedHash(null)
    setCommitFiles([])
    setCommitFileDiff(null)
    loadGraph()
  }, [directory, loadGraph])

  // Reload graph when parent triggers a refresh (e.g. after commit)
  const initialRef = useRef(true)
  useEffect(() => {
    if (initialRef.current) { initialRef.current = false; return }
    loadGraph()
  }, [refreshKey, loadGraph])

  // Infinite scroll
  useEffect(() => {
    if (!sentinelRef.current) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && commits.length < totalCount && !loading) {
          loadGraph(true)
        }
      },
      { threshold: 0.1 }
    )
    observer.observe(sentinelRef.current)
    return () => observer.disconnect()
  }, [commits.length, totalCount, loading, loadGraph])

  const [stashes, setStashes] = useState<Array<{ ref: string; message: string; parentSha?: string }>>([])
  useEffect(() => {
    window.ion.gitStashList(directory).then((r) => setStashes(r.stashes)).catch(() => setStashes([]))
  }, [directory, refreshKey])

  const decoratedCommits = useMemo(() => {
    if (stashes.length === 0) return commits
    const byParent = new Map<string, typeof stashes>()
    for (const s of stashes) {
      if (!s.parentSha) continue
      const arr = byParent.get(s.parentSha) ?? []
      arr.push(s)
      byParent.set(s.parentSha, arr)
    }
    return commits.map((c) => {
      const matched = byParent.get(c.fullHash)
      if (!matched) return c
      const stashRefs = matched.map((s) => ({ name: s.ref, type: 'tag' as const, isCurrent: false }))
      return { ...c, refs: [...c.refs, ...stashRefs] }
    })
  }, [commits, stashes])

  const graphNodes = useMemo(() => computeGraphLayout(decoratedCommits), [decoratedCommits])


  // ─── Commit hover popup ───
  const popoverLayer = usePopoverLayer()
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; commit: GitCommit } | null>(null)
  const [hoveredCommit, setHoveredCommit] = useState<GitCommit | null>(null)
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null)
  const [hoverDetail, setHoverDetail] = useState<GitCommitDetail | null>(null)
  const [expandedHash, setExpandedHash] = useState<string | null>(null)
  const [expandedDetail, setExpandedDetail] = useState<GitCommitDetail | null>(null)
  const [commitFiles, setCommitFiles] = useState<GitCommitFile[]>([])
  const [commitFileDiff, setCommitFileDiff] = useState<{ diff: string; fileName: string } | null>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const popupHoveredRef = useRef(false)
  const activeHashRef = useRef<string | null>(null)

  const dismissPopup = useCallback(() => {
    activeHashRef.current = null
    setHoveredCommit(null)
    setHoverRect(null)
    setHoverDetail(null)
  }, [])

  const handleRowHover = useCallback((commit: GitCommit, rect: DOMRect) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    // Hovering a new commit: cancel any pending dismiss and clear old popup immediately
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    dismissTimerRef.current = null
    popupHoveredRef.current = false
    dismissPopup()
    hoverTimerRef.current = setTimeout(() => {
      setHoveredCommit(commit)
      setHoverRect(rect)
      setHoverDetail(null)
      activeHashRef.current = commit.hash
      window.ion.gitCommitDetail(directory, commit.hash).then((detail) => {
        if (activeHashRef.current === commit.hash) setHoverDetail(detail)
      }).catch(() => {})
    }, 300)
  }, [directory, dismissPopup])

  const handleRowLeave = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = null
    // Grace period: give user time to reach the popup
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    dismissTimerRef.current = setTimeout(() => {
      if (!popupHoveredRef.current) dismissPopup()
    }, 250)
  }, [dismissPopup])

  const handlePopupEnter = useCallback(() => {
    popupHoveredRef.current = true
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    dismissTimerRef.current = null
  }, [])

  const handlePopupLeave = useCallback(() => {
    popupHoveredRef.current = false
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    dismissTimerRef.current = setTimeout(() => {
      if (!popupHoveredRef.current) dismissPopup()
    }, 150)
  }, [dismissPopup])

  const handleContextMenu = useCallback((e: React.MouseEvent, commit: GitCommit) => {
    e.preventDefault()
    // Dismiss hover popup so it doesn't overlap
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = null
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    dismissTimerRef.current = null
    popupHoveredRef.current = false
    dismissPopup()
    setContextMenu({ x: e.clientX, y: e.clientY, commit })
  }, [dismissPopup])

  const handleCommitClick = useCallback(async (commit: GitCommit) => {
    // Dismiss hover popup
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = null
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
    dismissTimerRef.current = null
    popupHoveredRef.current = false
    dismissPopup()

    if (expandedHash === commit.hash) {
      // Collapse
      setExpandedHash(null)
      setCommitFiles([])
      setCommitFileDiff(null)
      return
    }

    // Expand
    setExpandedHash(commit.hash)
    setCommitFileDiff(null)
    setExpandedDetail(null)
    try {
      const [filesResult, detailResult] = await Promise.all([
        window.ion.gitCommitFiles(directory, commit.hash),
        window.ion.gitCommitDetail(directory, commit.hash),
      ])
      setCommitFiles(filesResult.files as GitCommitFile[])
      setExpandedDetail(detailResult)
    } catch {
      setCommitFiles([])
      setExpandedDetail(null)
    }
  }, [expandedHash, directory])

  const handleCommitFileClick = useCallback(async (file: GitCommitFile) => {
    if (!expandedHash) return
    try {
      const result = await window.ion.gitCommitFileDiff(directory, expandedHash, file.path)
      setCommitFileDiff(result)
    } catch {
      setCommitFileDiff(null)
    }
  }, [expandedHash, directory])

  const handleRebase = useCallback(async (commit: GitCommit) => {
    const result = await window.ion.gitRebaseTodo(directory, commit.fullHash)
    if (result.ok && result.commits.length > 0) {
      setRebaseTarget({
        onto: commit.fullHash,
        commits: result.commits.map(c => ({
          hash: c.hash,
          subject: c.subject,
          action: c.action as RebaseCommit['action'],
        })),
      })
    }
  }, [directory])

  // Clean up timers on unmount
  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current)
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current)
  }, [])

  const handleFetch = async () => {
    setFetchingAction('fetch')
    await window.ion.gitFetch(directory)
    setFetchingAction(null)
    loadGraph()
    onRefresh()
  }

  const handlePull = async () => {
    setFetchingAction('pull')
    if (worktree) {
      try {
        const result = await window.ion.gitWorktreeRebase(worktree.worktreePath, worktree.sourceBranch)
        if (result.hasConflicts) {
          setRebaseError(result.error || 'Rebase has conflicts -- resolve them before continuing')
        }
      } catch (e: unknown) {
        setRebaseError(e instanceof Error ? e.message : 'Rebase failed')
      }
    } else {
      await window.ion.gitPull(directory)
    }
    setFetchingAction(null)
    loadGraph()
    onRefresh()
  }

  const handlePush = async () => {
    if (worktree) return
    if (!pushConfirm) {
      setPushConfirm(true)
      return
    }
    setPushConfirm(false)
    setFetchingAction('push')
    await window.ion.gitPush(directory)
    setFetchingAction(null)
    loadGraph()
  }

  const handleBranchRefresh = () => {
    loadGraph()
    onRefresh()
  }

  return (
    <>
      {/* Graph header buttons */}
      <div
        className="flex items-center justify-between px-2"
        style={{ height: 24, borderBottom: `1px solid ${colors.containerBorder}` }}
      >
        <BranchPicker directory={directory} currentBranch={branch} onRefresh={handleBranchRefresh} worktree={worktree} />
        <div className="flex items-center gap-0.5">
          {pushConfirm ? (
            <div className="flex items-center gap-0.5 text-[9px]">
              <span style={{ color: colors.textTertiary }}>Push?</span>
              <button
                onClick={handlePush}
                className="px-1 rounded"
                style={{ color: colors.accent }}
              >
                Yes
              </button>
              <button
                onClick={() => setPushConfirm(false)}
                className="px-1 rounded"
                style={{ color: colors.textTertiary }}
              >
                No
              </button>
            </div>
          ) : (
            <>
              <Tooltip text="Fetch">
                <button
                  onClick={handleFetch}
                  disabled={!!fetchingAction}
                  className="p-0.5 rounded transition-colors"
                  style={{ color: colors.textTertiary }}
                >
                  {fetchingAction === 'fetch' ? <SpinnerGap size={11} className="animate-spin" /> : <ArrowsClockwise size={11} />}
                </button>
              </Tooltip>
              <Tooltip text={worktree ? `Rebase from ${worktree.sourceBranch}` : 'Pull'}>
                <button
                  onClick={handlePull}
                  disabled={!!fetchingAction}
                  className="p-0.5 rounded transition-colors"
                  style={{ color: colors.textTertiary }}
                >
                  {fetchingAction === 'pull' ? <SpinnerGap size={11} className="animate-spin" /> : <ArrowDown size={11} />}
                </button>
              </Tooltip>
              {worktree ? (
                <Tooltip text={hasUncommittedChanges
                    ? 'Commit all changes before finishing'
                    : strategy === 'merge-ff'
                      ? `Finish: fast-forward into ${worktree.sourceBranch}`
                      : strategy === 'merge'
                      ? `Finish: merge into ${worktree.sourceBranch}`
                      : `Finish: push and create PR against ${worktree.sourceBranch}`}>
                  <button
                    onClick={() => {
                      if (!hasUncommittedChanges) {
                        useSessionStore.getState().finishWorktreeTab(activeTabId)
                      }
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      if (!hasUncommittedChanges) {
                        setFinishMenuAnchor({ x: e.clientX, y: e.clientY })
                      }
                    }}
                    disabled={hasUncommittedChanges}
                    className="p-0.5 rounded transition-colors"
                    style={{
                      color: hasUncommittedChanges ? colors.textTertiary : '#4ade80',
                      opacity: hasUncommittedChanges ? 0.35 : 1,
                      cursor: hasUncommittedChanges ? 'not-allowed' : 'pointer',
                    }}
                  >
                    <CheckCircle size={11} weight="fill" />
                  </button>
                </Tooltip>
              ) : (
                <Tooltip text="Push">
                  <button
                    onClick={handlePush}
                    disabled={!!fetchingAction}
                    className="p-0.5 rounded transition-colors"
                    style={{ color: colors.textTertiary }}
                  >
                    {fetchingAction === 'push' ? <SpinnerGap size={11} className="animate-spin" /> : <ArrowUp size={11} />}
                  </button>
                </Tooltip>
              )}
            </>
          )}
        </div>
      </div>

      <GraphFilterBar filters={graphFilters} onFilterChange={setGraphFilters} />

      {/* Rebase error */}
      {rebaseError && (
        <div
          className="flex items-center justify-between px-2 py-1.5 text-[10px]"
          style={{ color: '#c47060', borderBottom: `1px solid ${colors.containerBorder}`, background: colors.surfacePrimary, flexShrink: 0 }}
        >
          <span className="truncate flex-1">{rebaseError}</span>
          <button
            onClick={() => setRebaseError(null)}
            className="ml-1 flex-shrink-0"
            style={{ color: colors.textTertiary }}
          >
            <X size={10} />
          </button>
        </div>
      )}

      {/* Commit list */}
      <div ref={scrollRef} className="flex-1 overflow-auto" style={{ minHeight: 0 }}>
        <VirtualCommitList
          graphNodes={graphNodes}
          expandedHash={expandedHash}
          commitDetail={expandedDetail}
          commitFiles={commitFiles}
          scrollRef={scrollRef}
          onHover={handleRowHover}
          onLeave={handleRowLeave}
          onContextMenu={handleContextMenu}
          onClick={handleCommitClick}
          onFileClick={handleCommitFileClick}
        />
        {commits.length < totalCount && (
          <div ref={sentinelRef} className="py-2 text-center text-[10px]" style={{ color: colors.textTertiary }}>
            {loading ? 'Loading...' : ''}
          </div>
        )}
        {commits.length === 0 && !loading && (
          <div className="px-3 py-4 text-center text-[10px]" style={{ color: colors.textTertiary }}>
            No commits
          </div>
        )}
      </div>

      {/* Commit detail popup */}
      {popoverLayer && hoveredCommit && hoverRect && createPortal(
        <CommitPopup commit={hoveredCommit} rect={hoverRect} detail={hoverDetail} panelRight={scrollRef.current?.getBoundingClientRect().right ?? hoverRect.right} onMouseEnter={handlePopupEnter} onMouseLeave={handlePopupLeave} />,
        popoverLayer,
      )}

      {/* Commit context menu */}
      {popoverLayer && contextMenu && createPortal(
        <CommitContextMenu anchor={contextMenu} commit={contextMenu.commit} directory={directory} onRefresh={() => loadGraph()} onClose={() => setContextMenu(null)} onRebase={handleRebase} />,
        popoverLayer,
      )}

      {/* Finish Work right-click context menu */}
      {finishMenuAnchor && worktree && (
        <FinishWorkContextMenu
          anchor={finishMenuAnchor}
          worktree={worktree}
          onClose={() => setFinishMenuAnchor(null)}
        />
      )}

      {/* Commit file diff viewer */}
      <AnimatePresence>
        {commitFileDiff && (
          <FloatingPanel title={commitFileDiff.fileName} onClose={() => setCommitFileDiff(null)}>
            <DiffPane
              diff={commitFileDiff.diff}
              fileName={commitFileDiff.fileName}
              filePath={commitFileDiff.fileName}
              staged={false}
              directory={directory}
              onClose={() => setCommitFileDiff(null)}
              onRefresh={() => {}}
            />
          </FloatingPanel>
        )}
      </AnimatePresence>

      {/* Rebase editor */}
      {rebaseTarget && (
        <RebaseEditor
          directory={directory}
          onto={rebaseTarget.onto}
          initialCommits={rebaseTarget.commits}
          onClose={() => setRebaseTarget(null)}
          onComplete={() => {
            setRebaseTarget(null)
            loadGraph()
            onRefresh()
          }}
        />
      )}
    </>
  )
}
