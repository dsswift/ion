import React, { useRef } from 'react'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { transitions } from '../theme-tokens'
import type { GitCommit, GitCommitFile } from '../../shared/types'
import type { GitGraphNode } from '../utils/gitGraphLayout'
import { GIT_STATUS_COLOR_KEYS, relativeDate } from './GitPanelTypes'
import { forkOrMergePath } from './git/laneGeometry'

// ─── Graph layout constants ───
export const LANE_SPACING = 12
export const LANE_OFFSET = 8
export const MAX_GRAPH_WIDTH = 60
export const ROW_HEIGHT = 32

export function GraphRow({ node, onHover, onLeave, onContextMenu, onClick, isExpanded, selectedHash }: {
  node: GitGraphNode
  onHover: (commit: GitCommit, rect: DOMRect) => void
  onLeave: () => void
  onContextMenu: (e: React.MouseEvent, commit: GitCommit) => void
  onClick: () => void
  isExpanded: boolean
  selectedHash?: string | null
}) {
  const colors = useColors()
  const { hover, pressed, handlers } = useInteractiveState()
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
      {...handlers}
      style={{
        height: ROW_HEIGHT,
        whiteSpace: 'nowrap',
        minWidth: 'fit-content',
        cursor: 'pointer',
        background: interactiveBg(colors, { hover, pressed, selected: isExpanded }),
        transition: `background ${transitions.base}`,
      }}
      onClick={onClick}
      onMouseEnter={() => {
        handlers.onMouseEnter()
        if (rowRef.current) onHover(commit, rowRef.current.getBoundingClientRect())
      }}
      onMouseLeave={() => {
        handlers.onMouseLeave()
        onLeave()
      }}
      onContextMenu={(e) => onContextMenu(e, commit)}
    >
      {/* SVG lane column */}
      <svg
        width={graphWidth}
        height={ROW_HEIGHT}
        style={{ flexShrink: 0 }}
      >
        {(() => {
          const selected = selectedHash != null
          const isSel = selected && selectedHash === commit.fullHash
          const dim = (_lineColor: string) => (selected && !isSel ? 0.25 : 0.6)
          return (
            <>
              {node.passThroughLanes.map((pt, i) => {
                const px = pt.lane * LANE_SPACING + LANE_OFFSET
                return (
                  <line key={`pt-${i}`} x1={px} y1={0} x2={px} y2={ROW_HEIGHT}
                    stroke={pt.color} strokeWidth={1.5} opacity={selected ? 0.18 : 0.4} />
                )
              })}

              {node.connections.map((conn, i) => {
                const x1 = conn.fromLane * LANE_SPACING + LANE_OFFSET
                const x2 = conn.toLane * LANE_SPACING + LANE_OFFSET

                if (conn.type === 'straight') {
                  return (
                    <line key={i} x1={x1} y1={cy} x2={x2} y2={ROW_HEIGHT}
                      stroke={conn.color} strokeWidth={1.5} opacity={dim(conn.color)} />
                  )
                }
                return (
                  <path key={i}
                    d={forkOrMergePath(x1, x2, cy, ROW_HEIGHT)}
                    stroke={conn.color} strokeWidth={1.5} fill="none" opacity={dim(conn.color)} />
                )
              })}

              {node.hasIncoming && (
                <line x1={cx} y1={0} x2={cx} y2={cy}
                  stroke={node.color} strokeWidth={1.5} opacity={dim(node.color)} />
              )}

              <circle cx={cx} cy={cy} r={isSel ? 5 : 4} fill={node.color} opacity={selected && !isSel ? 0.4 : 1} />
            </>
          )
        })()}
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

const STATUS_LETTERS_COMMIT: Record<string, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
}

/** Single file row in an expanded commit — standard hover/pressed states. */
function CommitFileRow({ file, onFileClick }: {
  file: GitCommitFile
  onFileClick: (file: GitCommitFile) => void
}) {
  const colors = useColors()
  const { hover, pressed, handlers } = useInteractiveState()
  return (
    <div
      className="flex items-center cursor-pointer group"
      {...handlers}
      style={{
        height: 22,
        paddingLeft: 20,
        paddingRight: 8,
        background: interactiveBg(colors, { hover, pressed }),
        transition: `background ${transitions.base}`,
      }}
      onClick={() => onFileClick(file)}
    >
      <span
        className="text-[9px] font-mono flex-shrink-0"
        style={{ color: GIT_STATUS_COLOR_KEYS[file.status] ? colors[GIT_STATUS_COLOR_KEYS[file.status]] : colors.textTertiary, width: 14, textAlign: 'center' }}
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
  )
}

export function CommitFileList({ files, directory: _directory, hash: _hash, onFileClick }: {
  files: GitCommitFile[]
  directory: string
  hash: string
  onFileClick: (file: GitCommitFile) => void
}) {
  const colors = useColors()

  return (
    <div style={{ background: colors.surfacePrimary, borderBottom: `1px solid ${colors.containerBorder}` }}>
      {files.map((file) => (
        <CommitFileRow key={file.path} file={file} onFileClick={onFileClick} />
      ))}
    </div>
  )
}
