import React, { useState, useEffect, useCallback } from 'react'
import { AnimatePresence } from 'framer-motion'
import { Plus, Minus } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { DiffViewer } from './DiffViewer'
import type { GitChangedFile } from '../../shared/types'
import { buildFileTree, type FileTreeNode } from './GitPanelTypes'
import { FileRow, FileTreeRow } from './GitFileRow'

// ─── Changes Section ───

export function GitChangesSection({
  directory,
  files,
  onRefresh,
  commitMsg: _commitMsg,
  setCommitMsg: _setCommitMsg,
  treeView,
}: {
  directory: string
  files: GitChangedFile[]
  onRefresh: () => void
  commitMsg: string
  setCommitMsg: (msg: string) => void
  treeView: boolean
}) {
  const colors = useColors()
  const [diffFile, setDiffFile] = useState<{ path: string; staged: boolean } | null>(null)
  const [diffData, setDiffData] = useState<{ diff: string; fileName: string } | null>(null)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set())

  const stagedFiles = files.filter((f) => f.staged)
  const unstagedFiles = files.filter((f) => !f.staged)

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

  const handleStage = async (path: string) => {
    await window.ion.gitStage(directory, [path])
    onRefresh()
  }

  const handleUnstage = async (path: string) => {
    await window.ion.gitUnstage(directory, [path])
    onRefresh()
  }

  const [discardConfirm, setDiscardConfirm] = useState<string | null>(null)
  const handleDiscard = (path: string) => {
    setDiscardConfirm(path)
  }
  const confirmDiscard = async () => {
    if (!discardConfirm) return
    await window.ion.gitDiscard(directory, [discardConfirm])
    setDiscardConfirm(null)
    onRefresh()
  }

  const handleStageAll = async () => {
    const paths = unstagedFiles.map((f) => f.path)
    if (paths.length > 0) {
      await window.ion.gitStage(directory, paths)
      onRefresh()
    }
  }

  const handleUnstageAll = async () => {
    const paths = stagedFiles.map((f) => f.path)
    if (paths.length > 0) {
      await window.ion.gitUnstage(directory, paths)
      onRefresh()
    }
  }

  const handleFileClick = async (file: GitChangedFile) => {
    if (diffFile?.path === file.path && diffFile?.staged === file.staged) {
      setDiffFile(null)
      setDiffData(null)
      return
    }
    setDiffFile({ path: file.path, staged: file.staged })
    const data = await window.ion.gitDiff(directory, file.path, file.staged)
    setDiffData(data)
  }

  return (
    <>
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
            {treeView
              ? buildFileTree(stagedFiles).map((node) => (
                <FileTreeRow
                  key={node.path}
                  node={node}
                  depth={0}
                  directory={directory}
                  expandedDirs={expandedDirs}
                  onToggleDirExpand={toggleDirExpand}
                  onStage={handleStage}
                  onUnstage={handleUnstage}
                  onDiscard={handleDiscard}
                  onClick={handleFileClick}
                  selectedFile={diffFile}
                />
              ))
              : stagedFiles.map((file) => (
                <FileRow
                  key={`s-${file.path}`}
                  file={file}
                  depth={0}
                  directory={directory}
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
            {treeView
              ? buildFileTree(unstagedFiles).map((node) => (
                <FileTreeRow
                  key={node.path}
                  node={node}
                  depth={0}
                  directory={directory}
                  expandedDirs={expandedDirs}
                  onToggleDirExpand={toggleDirExpand}
                  onStage={handleStage}
                  onUnstage={handleUnstage}
                  onDiscard={handleDiscard}
                  onClick={handleFileClick}
                  selectedFile={diffFile}
                />
              ))
              : unstagedFiles.map((file) => (
                <FileRow
                  key={`u-${file.path}`}
                  file={file}
                  depth={0}
                  directory={directory}
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
