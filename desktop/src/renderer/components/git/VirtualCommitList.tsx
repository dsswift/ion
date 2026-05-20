/**
 * Virtualized commit list for the graph pane.
 *
 * Fixed row height for unexpanded rows; uses measureElement when a row is
 * expanded (CommitDetailsPane inline) so the virtualizer reacts to height
 * changes. Auto-disables virtualization below threshold.
 *
 * Lane SVG continuity across virtualization boundaries is handled in the
 * swimlane port (separate change); today's per-row SVG sits inside each row.
 */

import React from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { GraphRow } from '../GitGraphRow'
import { CommitDetailsPane } from './CommitDetailsPane'
import type { GitCommit, GitCommitDetail, GitCommitFile } from '../../../shared/types'
import type { GitGraphNode } from '../../utils/gitGraphLayout'

const ROW_HEIGHT = 22
const VIRT_THRESHOLD = 80

interface Props {
  graphNodes: GitGraphNode[]
  expandedHash: string | null
  selectedHash?: string | null
  commitDetail: GitCommitDetail | null
  commitFiles: GitCommitFile[]
  scrollRef: React.RefObject<HTMLDivElement | null>
  onHover: (commit: GitCommit, rect: DOMRect) => void
  onLeave: () => void
  onContextMenu: (e: React.MouseEvent, commit: GitCommit) => void
  onClick: (commit: GitCommit) => void
  onFileClick: (file: GitCommitFile) => void
}

export function VirtualCommitList({
  graphNodes, expandedHash, selectedHash, commitDetail, commitFiles, scrollRef,
  onHover, onLeave, onContextMenu, onClick, onFileClick,
}: Props) {
  if (graphNodes.length < VIRT_THRESHOLD) {
    return (
      <>
        {graphNodes.map((node) => (
          <React.Fragment key={node.commit.hash}>
            <GraphRow
              node={node}
              onHover={onHover}
              onLeave={onLeave}
              onContextMenu={onContextMenu}
              onClick={() => onClick(node.commit)}
              isExpanded={expandedHash === node.commit.hash}
              selectedHash={selectedHash ?? expandedHash}
            />
            {expandedHash === node.commit.hash && (
              <CommitDetailsPane
                commit={node.commit}
                detail={commitDetail}
                files={commitFiles}
                onFileClick={onFileClick}
              />
            )}
          </React.Fragment>
        ))}
      </>
    )
  }

  const virtualizer = useVirtualizer({
    count: graphNodes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (graphNodes[i].commit.hash === expandedHash ? 280 : ROW_HEIGHT),
    overscan: 10,
  })

  return (
    <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
      {virtualizer.getVirtualItems().map((vi) => {
        const node = graphNodes[vi.index]
        return (
          <div
            key={node.commit.hash}
            ref={virtualizer.measureElement}
            data-index={vi.index}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)` }}
          >
            <GraphRow
              node={node}
              onHover={onHover}
              onLeave={onLeave}
              onContextMenu={onContextMenu}
              onClick={() => onClick(node.commit)}
              isExpanded={expandedHash === node.commit.hash}
              selectedHash={selectedHash ?? expandedHash}
            />
            {expandedHash === node.commit.hash && (
              <CommitDetailsPane
                commit={node.commit}
                detail={commitDetail}
                files={commitFiles}
                onFileClick={onFileClick}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
