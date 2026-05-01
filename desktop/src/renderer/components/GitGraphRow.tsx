import React, { useRef } from 'react'
import { useColors } from '../theme'
import type { GitCommit, GitCommitFile } from '../../shared/types'
import type { GitGraphNode } from '../utils/gitGraphLayout'
import { relativeDate } from './GitPanelTypes'

// ─── Graph layout constants ───
export const LANE_SPACING = 12
export const LANE_OFFSET = 8
export const MAX_GRAPH_WIDTH = 60
export const ROW_HEIGHT = 32

export function GraphRow({ node, onHover, onLeave, onContextMenu, onClick, isExpanded }: {
  node: GitGraphNode
  onHover: (commit: GitCommit, rect: DOMRect) => void
  onLeave: () => void
  onContextMenu: (e: React.MouseEvent, commit: GitCommit) => void
  onClick: () => void
  isExpanded: boolean
}) {
  const colors = useColors()
  const commit = node.commit
  const rowMaxLane = Math.max(
    node.lane,
    ...node.passThroughLanes.map(pt => pt.lane),
    ...node.connections.map(c => Math.max(c.fromLane, c.toLane))
  )
  const graphWidth = Math.min(MAX_GRAPH_WIDTH, (rowMaxLane + 1) * LANE_SPACING + LANE_OFFSET)
  const cx = node.lane * LANE_SPACING + LANE_OFFSET
  const cy = ROW_HEIGHT / 2
  const rowRef = useRef<HTMLDivElement>(null)

  return (
    <div
      ref={rowRef}
      className="flex"
      style={{ height: ROW_HEIGHT, whiteSpace: 'nowrap', minWidth: 'fit-content', cursor: 'pointer', background: isExpanded ? colors.surfaceHover : undefined }}
      onClick={onClick}
      onMouseEnter={() => {
        if (rowRef.current) onHover(commit, rowRef.current.getBoundingClientRect())
      }}
      onMouseLeave={onLeave}
      onContextMenu={(e) => onContextMenu(e, commit)}
    >
      {/* SVG lane column */}
      <svg
        width={graphWidth}
        height={ROW_HEIGHT}
        style={{ flexShrink: 0 }}
      >
        {/* Pass-through lanes: other active branches that run through this row */}
        {node.passThroughLanes.map((pt, i) => {
          const px = pt.lane * LANE_SPACING + LANE_OFFSET
          return (
            <line key={`pt-${i}`} x1={px} y1={0} x2={px} y2={ROW_HEIGHT}
              stroke={pt.color} strokeWidth={1.5} opacity={0.4} />
          )
        })}

        {/* Connections from this commit to its parents */}
        {node.connections.map((conn, i) => {
          const x1 = conn.fromLane * LANE_SPACING + LANE_OFFSET
          const x2 = conn.toLane * LANE_SPACING + LANE_OFFSET

          if (conn.type === 'straight') {
            return (
              <line key={i} x1={x1} y1={cy} x2={x2} y2={ROW_HEIGHT}
                stroke={conn.color} strokeWidth={1.5} opacity={0.6} />
            )
          }
          if (conn.type === 'fork') {
            return (
              <path key={i}
                d={`M ${x1} ${cy} C ${x1} ${ROW_HEIGHT}, ${x2} ${cy}, ${x2} ${ROW_HEIGHT}`}
                stroke={conn.color} strokeWidth={1.5} fill="none" opacity={0.5} />
            )
          }
          return (
            <path key={i}
              d={`M ${x1} ${cy} C ${x1} ${ROW_HEIGHT}, ${x2} ${cy}, ${x2} ${ROW_HEIGHT}`}
              stroke={conn.color} strokeWidth={1.5} fill="none" opacity={0.5} />
          )
        })}

        {/* Incoming line */}
        {node.hasIncoming && (
          <line x1={cx} y1={0} x2={cx} y2={cy}
            stroke={node.color} strokeWidth={1.5} opacity={0.6} />
        )}

        {/* Commit dot */}
        <circle cx={cx} cy={cy} r={4} fill={node.color} />
      </svg>

      {/* Info column */}
      <div className="flex flex-col justify-center px-1" style={{ minWidth: 0 }}>
        <div className="flex items-center gap-1">
          {/* Ref badges */}
          {commit.refs.map((ref, i) => (
            <span
              key={i}
              className="text-[9px] px-1 rounded-sm"
              style={{
                border: `1px solid ${ref.isCurrent ? colors.accent : colors.containerBorder}`,
                background: ref.isCurrent ? colors.accentLight : 'transparent',
                color: ref.isCurrent ? colors.accent : colors.textTertiary,
                flexShrink: 0,
              }}
            >
              {ref.name}
            </span>
          ))}
          <span className="text-[11px]" style={{ color: colors.textSecondary }}>
            {commit.subject}
          </span>
        </div>
        <div className="text-[10px]" style={{ color: colors.textTertiary }}>
          {commit.authorName} · {relativeDate(commit.authorDate)}
        </div>
      </div>
    </div>
  )
}

export function CommitFileList({ files, directory: _directory, hash: _hash, onFileClick }: {
  files: GitCommitFile[]
  directory: string
  hash: string
  onFileClick: (file: GitCommitFile) => void
}) {
  const colors = useColors()

  const STATUS_COLORS_COMMIT: Record<string, string> = {
    added: '#7aac8c',
    modified: '#6b9bd2',
    deleted: '#c47060',
    renamed: '#b08fd8',
  }

  const STATUS_LETTERS_COMMIT: Record<string, string> = {
    added: 'A',
    modified: 'M',
    deleted: 'D',
    renamed: 'R',
  }

  return (
    <div style={{ background: colors.surfacePrimary, borderBottom: `1px solid ${colors.containerBorder}` }}>
      {files.map((file) => (
        <div
          key={file.path}
          className="flex items-center cursor-pointer group"
          style={{ height: 22, paddingLeft: 20, paddingRight: 8 }}
          onClick={() => onFileClick(file)}
          onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = colors.surfaceHover }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
        >
          <span
            className="text-[9px] font-mono flex-shrink-0"
            style={{ color: STATUS_COLORS_COMMIT[file.status] || colors.textTertiary, width: 14, textAlign: 'center' }}
          >
            {STATUS_LETTERS_COMMIT[file.status] || '?'}
          </span>
          <span
            className="text-[10px] truncate flex-1"
            style={{ color: colors.textSecondary, marginLeft: 6 }}
            title={file.path}
          >
            {file.path}
          </span>
        </div>
      ))}
    </div>
  )
}
