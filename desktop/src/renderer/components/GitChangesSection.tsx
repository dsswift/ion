import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Plus, Minus, Tray } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { FloatingPanel } from './FloatingPanel'
import { DiffPane } from './git/DiffPane'
import { Tooltip } from './git/Tooltip'
import type { GitChangedFile } from '../../shared/types'
import { buildFileTree, type FileTreeNode } from './GitPanelTypes'
import { useRepoGroups } from '../stores/git'
import { ConflictResolver } from './git/ConflictResolver'
import { SectionBlock } from './git/SectionBlock'
import { rError, rDebug } from '../rendererLogger'

// ─── Changes Section ───

export function GitChangesSection({
  directory,
  files,
  onRefresh,
  treeView,
}: {
  directory: string
  files: GitChangedFile[]
  onRefresh: () => void
  treeView: boolean
}) {
  const colors = useColors()
  const [diffFile, setDiffFile] = useState<{ path: string; staged: boolean } | null>(null)
  const [diffData, setDiffData] = useState<{ diff: string; fileName: string } | null>(null)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [_selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [lastClickedPath, setLastClickedPath] = useState<string | null>(null)
  const [stashes, setStashes] = useState<Array<{ ref: string; message: string; date: string }>>([])
  const [stashExpanded, setStashExpanded] = useState(false)
  const [conflicts, setConflicts] = useState<string[]>([])
  const [showResolver, setShowResolver] = useState(false)

  // Load stashes
  const loadStashes = useCallback(async () => {
    try {
      const result = await window.ion.gitStashList(directory)
      setStashes(result.stashes)
    } catch { setStashes([]) }
  }, [directory])

  useEffect(() => { void loadStashes().catch((err) => rDebug('git-changes', 'load stashes failed', { error: String(err) })) }, [loadStashes])

  // Detect merge conflicts
  useEffect(() => {
    window.ion.gitConflicts(directory).then(r => {
      if (r.ok) setConflicts(r.files)
      else setConflicts([])
    }).catch(() => setConflicts([]))
  }, [directory, files])

  const handleStashSave = async () => {
    const result = await window.ion.gitStashSave(directory)
    if (!result.ok) { setError(result.error || 'Stash failed'); return }
    onRefresh(); void loadStashes().catch((err) => rDebug('git-changes', 'load stashes failed', { error: String(err) }))
  }

  const handleStashPop = async (ref: string) => {
    const result = await window.ion.gitStashPop(directory, ref)
    if (!result.ok) { setError(result.error || 'Stash pop failed'); return }
    onRefresh(); void loadStashes().catch((err) => rDebug('git-changes', 'load stashes failed', { error: String(err) }))
  }

  const handleStashDrop = async (ref: string) => {
    const result = await window.ion.gitStashDrop(directory, ref)
    if (!result.ok) { setError(result.error || 'Stash drop failed'); return }
    void loadStashes().catch((err) => rDebug('git-changes', 'load stashes failed', { error: String(err) }))
  }

  useEffect(() => {
    if (!error) return
    const t = setTimeout(() => setError(null), 5_000)
    return () => clearTimeout(t)
  }, [error])

  const groups = useRepoGroups(directory)
  const stagedFiles = useMemo(() => groups?.index ?? files.filter((f) => f.staged), [groups, files])
  // Merge untracked into unstaged — untracked files already show a yellow U icon
  const unstagedFiles = useMemo(() => {
    const wt = groups?.workingTree ?? files.filter((f) => !f.staged && f.status !== 'untracked' && f.status !== 'conflict')
    const ut = groups?.untracked ?? files.filter((f) => f.status === 'untracked')
    return wt.length + ut.length > 0 ? [...wt, ...ut] : []
  }, [groups, files])
  const mergeFiles = useMemo(() => groups?.merge ?? files.filter((f) => f.status === 'conflict'), [groups, files])

  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() => {
    if (typeof localStorage === 'undefined') return { merge: true, staged: true, changes: true }
    try {
      return JSON.parse(localStorage.getItem('ion:git-section-open') ?? '') || { merge: true, staged: true, changes: true }
    } catch {
      return { merge: true, staged: true, changes: true }
    }
  })
  const toggleSection = useCallback((k: string) => {
    setOpenSections((prev) => {
      const next = { ...prev, [k]: !prev[k] }
      try { localStorage.setItem('ion:git-section-open', JSON.stringify(next)) } catch (err) { rDebug('git-changes', 'persist section state failed', { error: String(err) }) }
      return next
    })
  }, [])

  // Collect all directory paths from a file tree
  const collectDirPaths = useCallback((nodes: FileTreeNode[]): string[] => {
    const paths: string[] = []
    for (const node of nodes) {
      if (node.isDir) {
        paths.push(node.path)
        paths.push(...collectDirPaths(node.children))
      }
    }
    return paths
  }, [])

  // Default all dirs expanded when files change
  const fileKeys = files.map((f) => `${f.path}:${f.staged}`).join(',')
  useEffect(() => {
    if (!treeView) return
    const sTree = buildFileTree(stagedFiles)
    const uTree = buildFileTree(unstagedFiles)
    const allDirs = new Set([...collectDirPaths(sTree), ...collectDirPaths(uTree)])
    setExpandedDirs(allDirs)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKeys, treeView])

  const toggleDirExpand = useCallback((path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const handleStage = useCallback(async (path: string) => {
    const result = await window.ion.gitStage(directory, [path])
    if (!result.ok) { setError(result.error || 'Failed to stage file'); return }
    onRefresh()
  }, [directory, onRefresh])

  const handleUnstage = useCallback(async (path: string) => {
    const result = await window.ion.gitUnstage(directory, [path])
    if (!result.ok) { setError(result.error || 'Failed to unstage file'); return }
    onRefresh()
  }, [directory, onRefresh])

  const [discardConfirm, setDiscardConfirm] = useState<string | null>(null)
  const handleDiscard = useCallback((path: string) => {
    setDiscardConfirm(path)
  }, [])
  const confirmDiscard = async () => {
    if (!discardConfirm) return
    const result = await window.ion.gitDiscard(directory, [discardConfirm])
    setDiscardConfirm(null)
    if (!result.ok) { setError(result.error || 'Failed to discard changes'); return }
    onRefresh()
  }

  const handleStageAll = async () => {
    const paths = unstagedFiles.map((f) => f.path)
    if (paths.length > 0) {
      const result = await window.ion.gitStage(directory, paths)
      if (!result.ok) { setError(result.error || 'Failed to stage files'); return }
      onRefresh()
    }
  }

  const handleUnstageAll = async () => {
    const paths = stagedFiles.map((f) => f.path)
    if (paths.length > 0) {
      const result = await window.ion.gitUnstage(directory, paths)
      if (!result.ok) { setError(result.error || 'Failed to unstage files'); return }
      onRefresh()
    }
  }

  const handleFileClick = useCallback(async (file: GitChangedFile) => {
    if (diffFile?.path === file.path && diffFile?.staged === file.staged) {
      setDiffFile(null)
      setDiffData(null)
      return
    }
    setDiffFile({ path: file.path, staged: file.staged })
    const data = await window.ion.gitDiff(directory, file.path, file.staged)
    setDiffData(data)
  }, [diffFile, directory])

  const allFiles = useMemo(() => [...stagedFiles, ...unstagedFiles], [stagedFiles, unstagedFiles])

  const _handleFileSelect = useCallback((file: GitChangedFile, event: React.MouseEvent) => {
    const key = `${file.staged ? 's' : 'u'}:${file.path}`
    if (event.metaKey || event.ctrlKey) {
      // Toggle selection
      setSelectedPaths(prev => {
        const next = new Set(prev)
        if (next.has(key)) { next.delete(key) } else { next.add(key) }
        return next
      })
    } else if (event.shiftKey && lastClickedPath) {
      // Range selection
      const keys = allFiles.map(f => `${f.staged ? 's' : 'u'}:${f.path}`)
      const startIdx = keys.indexOf(lastClickedPath)
      const endIdx = keys.indexOf(key)
      if (startIdx >= 0 && endIdx >= 0) {
        const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx]
        setSelectedPaths(new Set(keys.slice(lo, hi + 1)))
      }
    } else {
      // Single click — open diff
      void handleFileClick(file).catch((err) => rError('git-changes', 'open diff failed', { error: String(err) }))
      setSelectedPaths(new Set([key]))
    }
    setLastClickedPath(key)
  }, [allFiles, lastClickedPath, handleFileClick])

  const [focusIndex, setFocusIndex] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (allFiles.length === 0) return
    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        e.preventDefault()
        setFocusIndex(i => Math.min(i + 1, allFiles.length - 1))
        break
      case 'k':
      case 'ArrowUp':
        e.preventDefault()
        setFocusIndex(i => Math.max(i - 1, 0))
        break
      case ' ':
        e.preventDefault()
        if (focusIndex >= 0 && focusIndex < allFiles.length) {
          const file = allFiles[focusIndex]
          if (file.staged) void handleUnstage(file.path).catch((err) => rError('git-changes', 'unstage failed', { error: String(err) }))
          else void handleStage(file.path).catch((err) => rError('git-changes', 'stage failed', { error: String(err) }))
        }
        break
      case 'Enter':
        e.preventDefault()
        if (focusIndex >= 0 && focusIndex < allFiles.length) {
          void handleFileClick(allFiles[focusIndex]).catch((err) => rError('git-changes', 'open diff failed', { error: String(err) }))
        }
        break
      case 'd':
        if (focusIndex >= 0 && focusIndex < allFiles.length) {
          const file = allFiles[focusIndex]
          if (!file.staged) handleDiscard(file.path)
        }
        break
    }
  }, [allFiles, focusIndex, handleStage, handleUnstage, handleFileClick, handleDiscard])

  // Voided wrappers so async handlers can be passed to void-returning JSX props
  const onStageVoid = useCallback((path: string) => { void handleStage(path).catch((err) => rError('git-changes', 'stage failed', { error: String(err) })) }, [handleStage])
  const onUnstageVoid = useCallback((path: string) => { void handleUnstage(path).catch((err) => rError('git-changes', 'unstage failed', { error: String(err) })) }, [handleUnstage])
  const onFileClickVoid = useCallback((file: GitChangedFile) => { void handleFileClick(file).catch((err) => rError('git-changes', 'open diff failed', { error: String(err) })) }, [handleFileClick])
  const onStashSaveVoid = () => { void handleStashSave().catch((err) => rError('git-changes', 'stash save failed', { error: String(err) })) }
  const onStageAllVoid = () => { void handleStageAll().catch((err) => rError('git-changes', 'stage all failed', { error: String(err) })) }
  const onUnstageAllVoid = () => { void handleUnstageAll().catch((err) => rError('git-changes', 'unstage all failed', { error: String(err) })) }

  return (
    <>
      {/* File list */}
      <div ref={containerRef} className="flex-1 overflow-y-auto" style={{ minHeight: 0 }} tabIndex={0} onKeyDown={handleKeyDown}>
        <SectionBlock
          label="Merge"
          files={mergeFiles}
          open={openSections.merge}
          onToggle={() => toggleSection('merge')}
          accentColor="#c47060"
          actions={mergeFiles.length > 0 && (
            <button
              onClick={() => setShowResolver(true)}
              className="text-[9px] px-1.5 py-0.5 rounded"
              style={{ color: colors.accent }}
            >Resolve</button>
          )}
          directory={directory}
          treeView={treeView}
          expandedDirs={expandedDirs}
          onToggleDirExpand={toggleDirExpand}
          onStage={onStageVoid}
          onUnstage={onUnstageVoid}
          onDiscard={handleDiscard}
          onClick={onFileClickVoid}
          selectedFile={diffFile}
        />

        <SectionBlock
          label="Staged Changes"
          files={stagedFiles}
          open={openSections.staged}
          onToggle={() => toggleSection('staged')}
          actions={(
            <Tooltip text="Unstage all">
              <button onClick={onUnstageAllVoid} className="text-[9px] px-1.5 py-0.5 rounded" style={{ color: colors.textTertiary }}>
                <Minus size={11} />
              </button>
            </Tooltip>
          )}
          directory={directory}
          treeView={treeView}
          expandedDirs={expandedDirs}
          onToggleDirExpand={toggleDirExpand}
          onStage={onStageVoid}
          onUnstage={onUnstageVoid}
          onDiscard={handleDiscard}
          onClick={onFileClickVoid}
          selectedFile={diffFile}
        />

        <SectionBlock
          label="Changes"
          files={unstagedFiles}
          open={openSections.changes}
          onToggle={() => toggleSection('changes')}
          actions={(
            <>
              <Tooltip text="Stash changes">
                <button onClick={onStashSaveVoid} className="text-[9px] px-1 py-0.5 rounded" style={{ color: colors.textTertiary }}>
                  <Tray size={11} />
                </button>
              </Tooltip>
              <Tooltip text="Stage all">
                <button onClick={onStageAllVoid} className="text-[9px] px-1.5 py-0.5 rounded" style={{ color: colors.textTertiary }}>
                  <Plus size={11} />
                </button>
              </Tooltip>
            </>
          )}
          directory={directory}
          treeView={treeView}
          expandedDirs={expandedDirs}
          onToggleDirExpand={toggleDirExpand}
          onStage={onStageVoid}
          onUnstage={onUnstageVoid}
          onDiscard={handleDiscard}
          onClick={onFileClickVoid}
          selectedFile={diffFile}
        />

        {files.length === 0 && (
          <div className="px-3 py-4 text-center text-[10px]" style={{ color: colors.textTertiary }}>
            No changes
          </div>
        )}

        {/* Stash section */}
        {stashes.length > 0 && (
          <div>
            <div
              className="flex items-center justify-between px-2 py-1"
              style={{ fontSize: 10, color: colors.textTertiary, borderTop: `1px solid ${colors.containerBorder}` }}
            >
              <button onClick={() => setStashExpanded(!stashExpanded)} className="flex items-center gap-1">
                <span style={{ fontSize: 8, display: 'inline-block', transform: stashExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
                Stashes ({stashes.length})
              </button>
              <Tooltip text="Stash current changes">
                <button onClick={onStashSaveVoid} className="text-[9px] px-1.5 py-0.5 rounded" style={{ color: colors.textTertiary }}>
                  + Stash
                </button>
              </Tooltip>
            </div>
            {stashExpanded && stashes.map((s) => (
              <div key={s.ref} className="flex items-center px-2 group" style={{ height: 22 }}>
                <span className="text-[9px] font-mono flex-shrink-0" style={{ color: colors.textMuted, width: 50 }}>{s.ref}</span>
                <span className="text-[10px] flex-1 truncate" style={{ color: colors.textSecondary }}>{s.message}</span>
                <Tooltip text="Apply and remove stash">
                  <button onClick={() => { void handleStashPop(s.ref).catch((err) => rError('git-changes', 'stash pop failed', { error: String(err) })) }} className="text-[9px] px-1 opacity-0 group-hover:opacity-100" style={{ color: colors.accent }}>Pop</button>
                </Tooltip>
                <Tooltip text="Delete stash">
                  <button onClick={() => { void handleStashDrop(s.ref).catch((err) => rError('git-changes', 'stash drop failed', { error: String(err) })) }} className="text-[9px] px-1 opacity-0 group-hover:opacity-100" style={{ color: '#c47060' }}>Drop</button>
                </Tooltip>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div
          className="flex items-center justify-between px-2 py-1.5"
          style={{ borderTop: `1px solid ${colors.containerBorder}`, background: colors.surfacePrimary, flexShrink: 0 }}
        >
          <span className="text-[10px] truncate" style={{ color: '#c47060' }}>{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0"
            style={{ color: colors.textTertiary }}
          >
            Dismiss
          </button>
        </div>
      )}

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
              onClick={() => { void confirmDiscard().catch((err) => rError('git-changes', 'discard failed', { error: String(err) })) }}
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

      {/* Diff popup */}
      {diffFile && diffData && (
        <FloatingPanel title={diffData.fileName} onClose={() => { setDiffFile(null); setDiffData(null) }} filePath={diffFile.path} workingDir={directory}>
          <DiffPane
            diff={diffData.diff}
            fileName={diffData.fileName}
            filePath={diffFile.path}
            staged={diffFile.staged}
            directory={directory}
            onClose={() => { setDiffFile(null); setDiffData(null) }}
            onRefresh={onRefresh}
          />
        </FloatingPanel>
      )}

      {/* Conflict resolver */}
      {showResolver && conflicts.length > 0 && (
        <ConflictResolver
          directory={directory}
          files={conflicts}
          onClose={() => setShowResolver(false)}
          onResolved={() => { setShowResolver(false); setConflicts([]); onRefresh() }}
        />
      )}
    </>
  )
}
