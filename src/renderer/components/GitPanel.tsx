import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  CaretDown, CaretRight, Plus, Minus, ArrowCounterClockwise,
  ArrowsClockwise, ArrowDown, ArrowUp, GitBranch, Folder, FolderOpen,
  Trash, Robot, Check, X, SpinnerGap,
} from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { usePopoverLayer } from './PopoverLayer'
import { useColors, useThemeStore } from '../theme'
import { computeGraphLayout } from '../utils/gitGraphLayout'
import { DiffViewer } from './DiffViewer'
import type { GitChangedFile, GitCommit, GitBranchInfo } from '../../shared/types'
import type { GitGraphNode } from '../utils/gitGraphLayout'

// ─── Status badge colors ───
const STATUS_COLORS: Record<string, string> = {
  added: '#7aac8c',
  modified: '#6b9bd2',
  deleted: '#c47060',
  renamed: '#b08fd8',
  untracked: '#d4a843',
}

const STATUS_LETTERS: Record<string, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
}

// ─── File tree grouping ───
interface FileTreeNode {
  name: string
  path: string
  isDir: boolean
  children: FileTreeNode[]
  file?: GitChangedFile
}

function buildFileTree(files: GitChangedFile[]): FileTreeNode[] {
  const root: FileTreeNode[] = []

  for (const file of files) {
    const parts = file.path.split('/')
    let current = root

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]
      const isLast = i === parts.length - 1
      const path = parts.slice(0, i + 1).join('/')

      let existing = current.find((n) => n.name === name && n.isDir === !isLast)
      if (!existing) {
        existing = {
          name,
          path,
          isDir: !isLast,
          children: [],
          file: isLast ? file : undefined,
        }
        current.push(existing)
      }
      if (!isLast) {
        current = existing.children
      }
    }
  }

  // Collapse single-child directories
  function collapse(nodes: FileTreeNode[]): FileTreeNode[] {
    return nodes.map((node) => {
      if (node.isDir && node.children.length === 1 && node.children[0].isDir) {
        const child = node.children[0]
        return {
          ...child,
          name: `${node.name}/${child.name}`,
          children: collapse(child.children),
        }
      }
      return { ...node, children: node.isDir ? collapse(node.children) : [] }
    })
  }

  return collapse(root)
}

// ─── Branch Picker ───

function BranchPicker({
  directory,
  currentBranch,
  onRefresh,
}: {
  directory: string
  currentBranch: string
  onRefresh: () => void
}) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const [open, setOpen] = useState(false)
  const [branches, setBranches] = useState<GitBranchInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ bottom: 0, left: 0 })

  const loadBranches = useCallback(async () => {
    try {
      const result = await window.coda.gitBranches(directory)
      setBranches(result.branches)
      setError(null)
    } catch {}
  }, [directory])

  useEffect(() => {
    if (open) loadBranches()
  }, [open, loadBranches])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleToggle = () => {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect()
      setPos({ bottom: window.innerHeight - rect.bottom - rect.height + 6, left: rect.left })
    }
    setOpen((o) => !o)
    setCreating(false)
    setNewName('')
    setError(null)
  }

  const handleCheckout = async (branch: string) => {
    const result = await window.coda.gitCheckout(directory, branch)
    if (result.ok) {
      setOpen(false)
      onRefresh()
    } else {
      setError(result.error || 'Checkout failed')
    }
  }

  const handleCreate = async () => {
    if (!newName.trim()) return
    const result = await window.coda.gitCreateBranch(directory, newName.trim())
    if (result.ok) {
      setOpen(false)
      setCreating(false)
      setNewName('')
      onRefresh()
    } else {
      setError(result.error || 'Create failed')
    }
  }

  const handleDelete = async (branch: string) => {
    const result = await window.coda.gitDeleteBranch(directory, branch)
    if (result.ok) {
      loadBranches()
    } else {
      setError(result.error || 'Delete failed')
    }
  }

  const localBranches = branches.filter((b) => !b.isRemote)
  const remoteBranches = branches.filter((b) => b.isRemote)

  return (
    <>
      <button
        ref={triggerRef}
        onClick={handleToggle}
        className="flex items-center gap-0.5 text-[10px] rounded px-1 py-0.5 truncate"
        style={{ color: colors.textSecondary, maxWidth: 100 }}
        title={currentBranch}
      >
        <GitBranch size={10} style={{ flexShrink: 0 }} />
        <span className="truncate">{currentBranch || 'detached'}</span>
        <CaretDown size={8} style={{ flexShrink: 0, opacity: 0.6 }} />
      </button>

      {popoverLayer && open && createPortal(
        <motion.div
          ref={popoverRef}
          data-coda-ui
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.12 }}
          className="rounded-xl"
          style={{
            position: 'fixed',
            bottom: pos.bottom,
            left: Math.min(pos.left, window.innerWidth - 220),
            width: 210,
            maxHeight: 320,
            pointerEvents: 'auto',
            background: colors.popoverBg,
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            boxShadow: colors.popoverShadow,
            border: `1px solid ${colors.popoverBorder}`,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div className="overflow-y-auto py-1" style={{ flex: 1 }}>
            {/* Local branches */}
            {localBranches.map((b) => (
              <div
                key={b.name}
                className="flex items-center justify-between px-2 py-1 text-[11px] group"
                style={{ color: b.isCurrent ? colors.textPrimary : colors.textSecondary }}
              >
                <button
                  onClick={() => !b.isCurrent && handleCheckout(b.name)}
                  className="flex items-center gap-1 truncate flex-1 text-left"
                  style={{ cursor: b.isCurrent ? 'default' : 'pointer' }}
                >
                  {b.isCurrent && <Check size={10} style={{ color: colors.accent, flexShrink: 0 }} />}
                  <span className="truncate">{b.name}</span>
                </button>
                {!b.isCurrent && (
                  <button
                    onClick={() => handleDelete(b.name)}
                    className="opacity-0 group-hover:opacity-60 hover:!opacity-100 p-0.5 transition-opacity"
                    style={{ color: colors.textTertiary }}
                    title="Delete branch"
                  >
                    <Trash size={10} />
                  </button>
                )}
              </div>
            ))}

            {/* Remote branches */}
            {remoteBranches.length > 0 && (
              <>
                <div className="mx-2 my-1" style={{ height: 1, background: colors.popoverBorder }} />
                <div className="px-2 py-0.5 text-[9px] uppercase tracking-wider" style={{ color: colors.textTertiary }}>
                  Remotes
                </div>
                {remoteBranches.map((b) => (
                  <button
                    key={b.name}
                    onClick={() => handleCheckout(b.name)}
                    className="w-full text-left px-2 py-1 text-[11px] truncate"
                    style={{ color: colors.textTertiary }}
                  >
                    {b.name}
                  </button>
                ))}
              </>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="px-2 py-1.5 text-[10px]" style={{ color: '#c47060', borderTop: `1px solid ${colors.popoverBorder}` }}>
              {error}
            </div>
          )}

          {/* Create branch */}
          <div style={{ borderTop: `1px solid ${colors.popoverBorder}` }}>
            {creating ? (
              <div className="flex items-center gap-1 px-2 py-1.5">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreating(false) }}
                  placeholder="branch-name"
                  className="flex-1 text-[11px] bg-transparent outline-none"
                  style={{ color: colors.textPrimary }}
                />
                <button onClick={handleCreate} className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: colors.accent }}>
                  Create
                </button>
              </div>
            ) : (
              <button
                onClick={() => setCreating(true)}
                className="w-full flex items-center gap-1 px-2 py-1.5 text-[11px]"
                style={{ color: colors.accent }}
              >
                <Plus size={10} />
                New branch...
              </button>
            )}
          </div>
        </motion.div>,
        popoverLayer,
      )}
    </>
  )
}

// ─── File Row ───

function FileRow({
  file,
  depth,
  onStage,
  onUnstage,
  onDiscard,
  onClick,
  isSelected,
}: {
  file: GitChangedFile
  depth: number
  onStage: (path: string) => void
  onUnstage: (path: string) => void
  onDiscard: (path: string) => void
  onClick: (file: GitChangedFile) => void
  isSelected: boolean
}) {
  const colors = useColors()
  const fileName = file.path.split('/').pop() || file.path

  return (
    <div
      className="flex items-center group cursor-pointer"
      style={{
        height: 24,
        paddingLeft: 8 + depth * 12,
        paddingRight: 4,
        background: isSelected ? colors.surfaceHover : undefined,
      }}
      onClick={() => onClick(file)}
    >
      <span
        className="text-[10px] font-mono flex-shrink-0"
        style={{ color: STATUS_COLORS[file.status] || colors.textTertiary, width: 14, display: 'inline-block', textAlign: 'center' }}
      >
        {STATUS_LETTERS[file.status] || '?'}
      </span>
      <span
        className="text-[10px] truncate flex-1"
        style={{ color: colors.textSecondary, marginLeft: 6 }}
        title={file.path}
      >
        {fileName}
      </span>
      {/* Hover actions */}
      <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
        {file.staged ? (
          <button
            onClick={(e) => { e.stopPropagation(); onUnstage(file.path) }}
            className="px-1 py-1 rounded transition-colors"
            style={{ color: colors.textTertiary }}
            title="Unstage"
          >
            <Minus size={12} />
          </button>
        ) : (
          <button
            onClick={(e) => { e.stopPropagation(); onStage(file.path) }}
            className="px-1 py-1 rounded transition-colors"
            style={{ color: colors.textTertiary }}
            title="Stage"
          >
            <Plus size={12} />
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onDiscard(file.path) }}
          className="px-1 py-1 rounded transition-colors"
          style={{ color: colors.textTertiary }}
          title="Discard changes"
        >
          <ArrowCounterClockwise size={12} />
        </button>
      </div>
    </div>
  )
}

// ─── Changes Section ───

function GitChangesSection({
  directory,
  files,
  onRefresh,
}: {
  directory: string
  files: GitChangedFile[]
  onRefresh: () => void
}) {
  const colors = useColors()
  const [commitMsg, setCommitMsg] = useState('')
  const [diffFile, setDiffFile] = useState<{ path: string; staged: boolean } | null>(null)
  const [diffData, setDiffData] = useState<{ diff: string; fileName: string } | null>(null)

  const stagedFiles = files.filter((f) => f.staged)
  const unstagedFiles = files.filter((f) => !f.staged)

  const handleStage = async (path: string) => {
    await window.coda.gitStage(directory, [path])
    onRefresh()
  }

  const handleUnstage = async (path: string) => {
    await window.coda.gitUnstage(directory, [path])
    onRefresh()
  }

  const [discardConfirm, setDiscardConfirm] = useState<string | null>(null)
  const handleDiscard = (path: string) => {
    setDiscardConfirm(path)
  }
  const confirmDiscard = async () => {
    if (!discardConfirm) return
    await window.coda.gitDiscard(directory, [discardConfirm])
    setDiscardConfirm(null)
    onRefresh()
  }

  const handleStageAll = async () => {
    const paths = unstagedFiles.map((f) => f.path)
    if (paths.length > 0) {
      await window.coda.gitStage(directory, paths)
      onRefresh()
    }
  }

  const handleUnstageAll = async () => {
    const paths = stagedFiles.map((f) => f.path)
    if (paths.length > 0) {
      await window.coda.gitUnstage(directory, paths)
      onRefresh()
    }
  }

  const handleCommit = async () => {
    if (!commitMsg.trim() || stagedFiles.length === 0) return
    const result = await window.coda.gitCommit(directory, commitMsg.trim())
    if (result.ok) {
      setCommitMsg('')
      onRefresh()
    }
  }

  const handleQuickCommit = () => {
    useSessionStore.getState().sendMessage('commit the current changes')
  }

  const handleFileClick = async (file: GitChangedFile) => {
    if (diffFile?.path === file.path && diffFile?.staged === file.staged) {
      setDiffFile(null)
      setDiffData(null)
      return
    }
    setDiffFile({ path: file.path, staged: file.staged })
    const data = await window.coda.gitDiff(directory, file.path, file.staged)
    setDiffData(data)
  }

  return (
    <>
      {/* Commit controls (top) */}
      <div
        className="px-2 py-2 flex flex-col gap-1.5"
        style={{ borderBottom: `1px solid ${colors.containerBorder}`, flexShrink: 0 }}
      >
        <input
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) handleCommit() }}
          placeholder="Commit message..."
          className="w-full text-[11px] bg-transparent outline-none rounded px-2 py-1.5"
          style={{
            color: colors.textPrimary,
            border: `1px solid ${colors.containerBorder}`,
          }}
        />
        <div className="flex items-center gap-1">
          <button
            onClick={handleCommit}
            disabled={!commitMsg.trim() || stagedFiles.length === 0}
            className="flex-1 text-[10px] py-1 rounded transition-colors"
            style={{
              color: (!commitMsg.trim() || stagedFiles.length === 0) ? colors.textMuted : colors.textOnAccent,
              background: (!commitMsg.trim() || stagedFiles.length === 0) ? colors.surfacePrimary : colors.accent,
              cursor: (!commitMsg.trim() || stagedFiles.length === 0) ? 'not-allowed' : 'pointer',
            }}
          >
            Commit
          </button>
          <button
            onClick={handleQuickCommit}
            className="px-2 py-1 rounded transition-colors"
            style={{
              color: colors.textTertiary,
              background: colors.surfacePrimary,
            }}
            title="Let Claude commit"
          >
            <Robot size={12} />
          </button>
        </div>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto" style={{ minHeight: 0 }}>
        {/* Staged changes */}
        {stagedFiles.length > 0 && (
          <div>
            <div
              className="flex items-center justify-between px-2 py-1"
              style={{ fontSize: 10, color: colors.textTertiary }}
            >
              <span>Staged Changes ({stagedFiles.length})</span>
              <button
                onClick={handleUnstageAll}
                className="text-[9px] px-1.5 py-1 rounded transition-colors"
                style={{ color: colors.textTertiary }}
                title="Unstage all"
              >
                <Minus size={12} />
              </button>
            </div>
            {stagedFiles.map((file) => (
              <FileRow
                key={`s-${file.path}`}
                file={file}
                depth={0}
                onStage={handleStage}
                onUnstage={handleUnstage}
                onDiscard={handleDiscard}
                onClick={handleFileClick}
                isSelected={diffFile?.path === file.path && diffFile?.staged === file.staged}
              />
            ))}
          </div>
        )}

        {/* Unstaged changes */}
        {unstagedFiles.length > 0 && (
          <div>
            <div
              className="flex items-center justify-between px-2 py-1"
              style={{ fontSize: 10, color: colors.textTertiary }}
            >
              <span>Changes ({unstagedFiles.length})</span>
              <button
                onClick={handleStageAll}
                className="text-[9px] px-1.5 py-1 rounded transition-colors"
                style={{ color: colors.textTertiary }}
                title="Stage all"
              >
                <Plus size={12} />
              </button>
            </div>
            {unstagedFiles.map((file) => (
              <FileRow
                key={`u-${file.path}`}
                file={file}
                depth={0}
                onStage={handleStage}
                onUnstage={handleUnstage}
                onDiscard={handleDiscard}
                onClick={handleFileClick}
                isSelected={diffFile?.path === file.path && diffFile?.staged === file.staged}
              />
            ))}
          </div>
        )}

        {files.length === 0 && (
          <div className="px-3 py-4 text-center text-[10px]" style={{ color: colors.textTertiary }}>
            No changes
          </div>
        )}
      </div>

      {/* Discard confirmation */}
      {discardConfirm && (
        <div
          className="flex items-center justify-between px-2 py-1.5"
          style={{ borderTop: `1px solid ${colors.containerBorder}`, background: colors.surfacePrimary, flexShrink: 0 }}
        >
          <span className="text-[10px] truncate" style={{ color: colors.textSecondary }}>
            Discard {discardConfirm.split('/').pop()}?
          </span>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={confirmDiscard}
              className="text-[10px] px-1.5 py-0.5 rounded"
              style={{ color: '#c47060' }}
            >
              Discard
            </button>
            <button
              onClick={() => setDiscardConfirm(null)}
              className="text-[10px] px-1.5 py-0.5 rounded"
              style={{ color: colors.textTertiary }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Diff viewer overlay */}
      <AnimatePresence>
        {diffFile && diffData && (
          <DiffViewer
            diff={diffData.diff}
            fileName={diffData.fileName}
            onClose={() => { setDiffFile(null); setDiffData(null) }}
          />
        )}
      </AnimatePresence>
    </>
  )
}

// ─── Graph Section ───

const LANE_SPACING = 16
const MAX_GRAPH_WIDTH = 80
const ROW_HEIGHT = 32

function GraphRow({ node, maxLanes }: { node: GitGraphNode; maxLanes: number }) {
  const colors = useColors()
  const commit = node.commit
  const graphWidth = Math.min(MAX_GRAPH_WIDTH, Math.max(28, (maxLanes + 1) * LANE_SPACING))
  const cx = node.lane * LANE_SPACING + 12
  const cy = ROW_HEIGHT / 2

  return (
    <div className="flex" style={{ height: ROW_HEIGHT }}>
      {/* SVG lane column */}
      <svg
        width={graphWidth}
        height={ROW_HEIGHT}
        style={{ flexShrink: 0 }}
      >
        {/* Pass-through lanes: other active branches that run through this row */}
        {node.passThroughLanes.map((pt, i) => {
          const px = pt.lane * LANE_SPACING + 12
          return (
            <line key={`pt-${i}`} x1={px} y1={0} x2={px} y2={ROW_HEIGHT}
              stroke={pt.color} strokeWidth={1.5} opacity={0.4} />
          )
        })}

        {/* Connections from this commit to its parents */}
        {node.connections.map((conn, i) => {
          const x1 = conn.fromLane * LANE_SPACING + 12
          const x2 = conn.toLane * LANE_SPACING + 12

          if (conn.type === 'straight') {
            // Vertical line from dot center down to bottom (continues to next row)
            return (
              <line key={i} x1={x1} y1={cy} x2={x2} y2={ROW_HEIGHT}
                stroke={conn.color} strokeWidth={1.5} opacity={0.6} />
            )
          }
          if (conn.type === 'fork') {
            // Curve from dot center down to the forked lane at bottom
            return (
              <path key={i}
                d={`M ${x1} ${cy} C ${x1} ${ROW_HEIGHT}, ${x2} ${cy}, ${x2} ${ROW_HEIGHT}`}
                stroke={conn.color} strokeWidth={1.5} fill="none" opacity={0.5} />
            )
          }
          // Merge: curve from dot center down to the target lane at bottom
          return (
            <path key={i}
              d={`M ${x1} ${cy} C ${x1} ${ROW_HEIGHT}, ${x2} ${cy}, ${x2} ${ROW_HEIGHT}`}
              stroke={conn.color} strokeWidth={1.5} fill="none" opacity={0.5} />
          )
        })}

        {/* Incoming line: draw from top of row to dot center (connects to previous row) */}
        {node.hasIncoming && (
          <line x1={cx} y1={0} x2={cx} y2={cy}
            stroke={node.color} strokeWidth={1.5} opacity={0.6} />
        )}

        {/* Commit dot */}
        <circle cx={cx} cy={cy} r={4} fill={node.color} />
      </svg>

      {/* Info column */}
      <div className="flex-1 flex flex-col justify-center overflow-hidden px-1" style={{ minWidth: 0 }}>
        <div className="flex items-center gap-1">
          {/* Ref badges */}
          {commit.refs.map((ref, i) => (
            <span
              key={i}
              className="text-[9px] px-1 rounded-sm truncate"
              style={{
                border: `1px solid ${ref.isCurrent ? colors.accent : colors.containerBorder}`,
                background: ref.isCurrent ? colors.accentLight : 'transparent',
                color: ref.isCurrent ? colors.accent : colors.textTertiary,
                maxWidth: 80,
              }}
            >
              {ref.name}
            </span>
          ))}
          <span className="text-[11px] truncate" style={{ color: colors.textSecondary }}>
            {commit.subject}
          </span>
        </div>
        <div className="text-[10px] truncate" style={{ color: colors.textTertiary }}>
          {commit.authorName} · {relativeDate(commit.authorDate)}
        </div>
      </div>
    </div>
  )
}

function relativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

function GitGraphSection({
  directory,
  onRefresh,
  refreshKey,
}: {
  directory: string
  onRefresh: () => void
  refreshKey: number
}) {
  const colors = useColors()
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [branch, setBranch] = useState('')
  const [fetchingAction, setFetchingAction] = useState<string | null>(null)
  const [pushConfirm, setPushConfirm] = useState(false)
  const sentinelRef = useRef<HTMLDivElement>(null)

  const commitsRef = useRef<GitCommit[]>([])
  commitsRef.current = commits

  const loadGraph = useCallback(async (append = false) => {
    setLoading(true)
    try {
      const skip = append ? commitsRef.current.length : 0
      const result = await window.coda.gitGraph(directory, skip, 100)
      if (result.isGitRepo) {
        const newCommits = append ? [...commitsRef.current, ...result.commits] : result.commits
        setCommits(newCommits)
        setTotalCount(result.totalCount)
      }
    } catch {}
    setLoading(false)
  }, [directory])

  useEffect(() => {
    // Reset commits when directory changes, then load fresh
    setCommits([])
    setTotalCount(0)
    loadGraph()
    window.coda.gitChanges(directory).then((r) => setBranch(r.branch)).catch(() => {})
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

  const graphNodes = useMemo(() => computeGraphLayout(commits), [commits])
  const maxLanes = graphNodes.reduce((max, n) => Math.max(max, n.lane), 0) + 1

  const handleFetch = async () => {
    setFetchingAction('fetch')
    await window.coda.gitFetch(directory)
    setFetchingAction(null)
    loadGraph()
    onRefresh()
  }

  const handlePull = async () => {
    setFetchingAction('pull')
    await window.coda.gitPull(directory)
    setFetchingAction(null)
    loadGraph()
    onRefresh()
  }

  const handlePush = async () => {
    if (!pushConfirm) {
      setPushConfirm(true)
      return
    }
    setPushConfirm(false)
    setFetchingAction('push')
    await window.coda.gitPush(directory)
    setFetchingAction(null)
    loadGraph()
  }

  const handleBranchRefresh = () => {
    loadGraph()
    window.coda.gitChanges(directory).then((r) => setBranch(r.branch)).catch(() => {})
    onRefresh()
  }

  return (
    <>
      {/* Graph header buttons */}
      <div
        className="flex items-center justify-between px-2"
        style={{ height: 24, borderBottom: `1px solid ${colors.containerBorder}` }}
      >
        <BranchPicker directory={directory} currentBranch={branch} onRefresh={handleBranchRefresh} />
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
              <button
                onClick={handleFetch}
                disabled={!!fetchingAction}
                className="p-0.5 rounded transition-colors"
                style={{ color: colors.textTertiary }}
                title="Fetch"
              >
                {fetchingAction === 'fetch' ? <SpinnerGap size={11} className="animate-spin" /> : <ArrowsClockwise size={11} />}
              </button>
              <button
                onClick={handlePull}
                disabled={!!fetchingAction}
                className="p-0.5 rounded transition-colors"
                style={{ color: colors.textTertiary }}
                title="Pull"
              >
                {fetchingAction === 'pull' ? <SpinnerGap size={11} className="animate-spin" /> : <ArrowDown size={11} />}
              </button>
              <button
                onClick={handlePush}
                disabled={!!fetchingAction}
                className="p-0.5 rounded transition-colors"
                style={{ color: colors.textTertiary }}
                title="Push"
              >
                {fetchingAction === 'push' ? <SpinnerGap size={11} className="animate-spin" /> : <ArrowUp size={11} />}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Commit list */}
      <div className="flex-1 overflow-y-auto" style={{ minHeight: 0 }}>
        {graphNodes.map((node, idx) => (
          <GraphRow key={node.commit.hash} node={node} maxLanes={maxLanes} />
        ))}
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
    </>
  )
}

// ─── Drag split hook ───

function useDragSplit(
  containerRef: React.RefObject<HTMLDivElement | null>,
  splitRatio: number,
  setSplitRatio: (r: number) => void,
  fixedChrome: number,
) {
  const [isDragging, setIsDragging] = useState(false)
  const startRef = useRef({ y: 0, ratio: 0 })

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    startRef.current = { y: e.clientY, ratio: splitRatio }
    setIsDragging(true)

    const onMouseMove = (ev: MouseEvent) => {
      const container = containerRef.current
      if (!container) return
      const availableHeight = container.clientHeight - fixedChrome
      if (availableHeight <= 0) return
      const deltaY = ev.clientY - startRef.current.y
      const deltaRatio = deltaY / availableHeight
      const newRatio = Math.min(0.85, Math.max(0.15, startRef.current.ratio + deltaRatio))
      setSplitRatio(newRatio)
    }

    const onMouseUp = () => {
      setIsDragging(false)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [splitRatio, containerRef, setSplitRatio, fixedChrome])

  return { onMouseDown, isDragging }
}

// ─── Main GitPanel ───

export function GitPanel() {
  const colors = useColors()
  const expandedUI = useThemeStore((s) => s.expandedUI)
  const tab = useSessionStore(
    (s) => s.tabs.find((t) => t.id === s.activeTabId),
    (a, b) => a === b || (!!a && !!b && a.workingDirectory === b.workingDirectory),
  )
  const directory = tab?.workingDirectory || '~'

  const changesOpen = useThemeStore((s) => s.gitPanelChangesOpen)
  const setChangesOpen = useThemeStore((s) => s.setGitPanelChangesOpen)
  const graphOpen = useThemeStore((s) => s.gitPanelGraphOpen)
  const setGraphOpen = useThemeStore((s) => s.setGitPanelGraphOpen)
  const [files, setFiles] = useState<GitChangedFile[]>([])
  const [refreshKey, setRefreshKey] = useState(0)
  const splitRatio = useThemeStore((s) => s.gitPanelSplitRatio)
  const setSplitRatio = useThemeStore((s) => s.setGitPanelSplitRatio)
  const containerRef = useRef<HTMLDivElement>(null)
  const prevSignatureRef = useRef<string>('')

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1)
  }, [])

  // Load changes (auto-refresh every 5s, also triggers graph reload on change)
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const result = await window.coda.gitChanges(directory)
        if (cancelled) return
        setFiles(result.files)
        const sig = result.branch + '\n' + result.files.map((f) => f.status + f.path).join('\n')
        if (prevSignatureRef.current && sig !== prevSignatureRef.current) {
          setRefreshKey((k) => k + 1)
        }
        prevSignatureRef.current = sig
      } catch {}
    }
    load()
    // Auto-refresh every 5s
    const interval = setInterval(load, 5000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [directory, refreshKey])

  // Drag split between Changes and Graph
  const FIXED_CHROME = 28 + 28 + 28 + 6 // panel header + changes header + graph header + divider
  const { onMouseDown: onDividerMouseDown, isDragging } = useDragSplit(
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
      data-coda-ui
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
          <span className="text-[10px] font-medium" style={{ color: colors.textTertiary }}>Git</span>
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
        <button
          onClick={() => setChangesOpen(!changesOpen)}
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
          {changesOpen ? <CaretDown size={10} /> : <CaretRight size={10} />}
          Changes
          {files.length > 0 && (
            <span
              className="text-[9px] px-1 rounded-full ml-auto"
              style={{ background: colors.accentLight, color: colors.accent }}
            >
              {files.length}
            </span>
          )}
        </button>
        {changesOpen && (
          <div style={{ height: changesContentHeight, overflow: 'auto' }}>
            <GitChangesSection directory={directory} files={files} onRefresh={refresh} />
          </div>
        )}
      </div>

      {/* Draggable divider */}
      {bothOpen && (
        <div
          data-coda-ui
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
        overflow: 'hidden',
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
          <div style={{ height: graphContentHeight, minHeight: 0, overflow: 'hidden' }}>
            <GitGraphSection directory={directory} onRefresh={refresh} refreshKey={refreshKey} />
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
