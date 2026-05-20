/**
 * Thin wrapper around the graph that pre-applies a path filter.
 *
 * Entry points (FileEditor / FileExplorer context menus) open this panel for a
 * specific file. Clicking a commit opens that file's diff at that revision.
 */

import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { useColors } from '../../theme'
import { X, File } from '@phosphor-icons/react'
import { computeGraphLayout } from '../../utils/gitGraphLayout'
import { VirtualCommitList } from './VirtualCommitList'
import { FloatingPanel } from '../FloatingPanel'
import { DiffPane } from './DiffPane'
import type { GitCommit, GitCommitDetail, GitCommitFile } from '../../../shared/types'

interface Props {
  directory: string
  path: string
  onClose: () => void
}

export function FileHistoryPanel({ directory, path, onClose }: Props) {
  const colors = useColors()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [diffPair, setDiffPair] = useState<{ diff: string; fileName: string } | null>(null)
  const [commitDetail, setCommitDetail] = useState<GitCommitDetail | null>(null)
  const [commitFiles, setCommitFiles] = useState<GitCommitFile[]>([])

  useEffect(() => {
    setLoading(true)
    window.ion.gitGraph(directory, 0, 200, undefined, undefined, { path })
      .then((r) => setCommits(r.commits))
      .catch(() => setCommits([]))
      .finally(() => setLoading(false))
  }, [directory, path])

  const graphNodes = useMemo(() => computeGraphLayout(commits), [commits])

  const handleCommitClick = useCallback(async (commit: GitCommit) => {
    if (expanded === commit.hash) { setExpanded(null); return }
    setExpanded(commit.hash)
    try {
      const [detail, files, fileDiff] = await Promise.all([
        window.ion.gitCommitDetail(directory, commit.hash),
        window.ion.gitCommitFiles(directory, commit.hash),
        window.ion.gitCommitFileDiff(directory, commit.hash, path),
      ])
      setCommitDetail(detail)
      setCommitFiles(files.files as GitCommitFile[])
      setDiffPair({ diff: fileDiff.diff, fileName: path.split('/').pop() ?? path })
    } catch {
      setCommitDetail(null); setCommitFiles([]); setDiffPair(null)
    }
  }, [directory, path, expanded])

  return (
    <FloatingPanel
      title={`History: ${path}`}
      onClose={onClose}
      defaultWidth={780}
      defaultHeight={520}
      filePath={path}
      workingDir={directory}
    >
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div className="flex items-center gap-2 px-2 py-1 text-[10px]" style={{ color: colors.textTertiary, borderBottom: `1px solid ${colors.containerBorder}`, background: colors.surfacePrimary }}>
          <File size={10} />
          <span className="truncate">{path}</span>
          <div style={{ flex: 1 }} />
          <span>{commits.length} commits{loading ? '…' : ''}</span>
          <button onClick={onClose} className="p-0.5 rounded" style={{ color: colors.textTertiary }}>
            <X size={10} />
          </button>
        </div>

        <div ref={scrollRef} style={{ flex: diffPair ? 1 : 2, overflow: 'auto', minHeight: 0 }}>
          <VirtualCommitList
            graphNodes={graphNodes}
            expandedHash={expanded}
            commitDetail={commitDetail}
            commitFiles={commitFiles}
            scrollRef={scrollRef}
            onHover={() => {}}
            onLeave={() => {}}
            onContextMenu={() => {}}
            onClick={handleCommitClick}
            onFileClick={() => {}}
          />
        </div>

        {diffPair && expanded && (
          <div style={{ flex: 1, minHeight: 0, borderTop: `1px solid ${colors.containerBorder}` }}>
            <DiffPane
              diff={diffPair.diff}
              fileName={diffPair.fileName}
              filePath={path}
              staged={false}
              directory={directory}
              onClose={() => { setExpanded(null); setDiffPair(null) }}
              onRefresh={() => {}}
            />
          </div>
        )}
      </div>
    </FloatingPanel>
  )
}
