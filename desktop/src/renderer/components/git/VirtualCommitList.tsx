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

import React, { useEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { GraphRow, ROW_HEIGHT } from '../GitGraphRow'
import { CommitDetailsPane } from './CommitDetailsPane'
import type { GitCommit, GitCommitDetail, GitCommitFile } from '../../../shared/types'
import type { GitGraphNode } from '../../utils/gitGraphLayout'
import type { GraphFocusRequest } from './useGitGraphFocus'

const VIRT_THRESHOLD = 80

interface Props {
  graphNodes: GitGraphNode[]
  expandedHash: string | null
  selectedHash?: string | null
  commitDetail: GitCommitDetail | null
  commitFiles: GitCommitFile[]
  scrollRef: React.RefObject<HTMLDivElement | null>
  focusRequest?: GraphFocusRequest | null
  onHover: (commit: GitCommit, rect: DOMRect) => void
  onLeave: () => void
  onContextMenu: (e: React.MouseEvent, commit: GitCommit) => void
  onClick: (commit: GitCommit) => void
  onFileClick: (file: GitCommitFile) => void
}

/**
 * Centers a rendered non-virtual row using real element measurements. A fixed
 * row-height calculation would drift when expanded commit detail changes size.
 */
function centerRenderedRow(scrollElement: HTMLDivElement, index: number): void {
  const row = scrollElement.querySelector<HTMLElement>(`[data-git-graph-index="${index}"]`)
  if (!row) return
  const viewport = scrollElement.getBoundingClientRect()
  const rowRect = row.getBoundingClientRect()
  scrollElement.scrollTo({
    top: scrollElement.scrollTop + rowRect.top - viewport.top - (viewport.height - rowRect.height) / 2,
    behavior: 'smooth',
  })
}

export function VirtualCommitList({
  graphNodes, expandedHash, selectedHash, commitDetail, commitFiles, scrollRef, focusRequest,
  onHover, onLeave, onContextMenu, onClick, onFileClick,
}: Props) {
  const useVirt = graphNodes.length >= VIRT_THRESHOLD
  const focusedRequestRef = useRef<string | null>(null)

  // Always call the hook — conditional hook calls violate the rules of hooks.
  // When we're below the threshold we disable virtualization by passing count=0.
  const virtualizer = useVirtualizer({
    count: useVirt ? graphNodes.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (graphNodes[index]?.commit.hash === expandedHash ? 280 : ROW_HEIGHT),
    overscan: 10,
  })

  useEffect(() => {
    if (!focusRequest || focusedRequestRef.current === focusRequest.key) return
    if (focusRequest.index < 0 || focusRequest.index >= graphNodes.length) return

    const scrollElement = scrollRef.current
    if (!scrollElement) return

    focusedRequestRef.current = focusRequest.key
    if (useVirt) {
      virtualizer.scrollToIndex(focusRequest.index, { align: 'center' })
      return
    }
    centerRenderedRow(scrollElement, focusRequest.index)
  }, [focusRequest, graphNodes.length, scrollRef, useVirt, virtualizer])

  if (!useVirt) {
    return (
      <>
        {graphNodes.map((node, index) => (
          <React.Fragment key={node.commit.hash}>
            <div data-git-graph-index={index}>
              <GraphRow
                node={node}
                onHover={onHover}
                onLeave={onLeave}
                onContextMenu={onContextMenu}
                onClick={() => onClick(node.commit)}
                isExpanded={expandedHash === node.commit.hash}
                selectedHash={selectedHash ?? expandedHash}
              />
            </div>
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

  return (
    <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
      {virtualizer.getVirtualItems().map((virtualItem) => {
        const node = graphNodes[virtualItem.index]
        return (
          <div
            key={node.commit.hash}
            ref={virtualizer.measureElement}
            data-index={virtualItem.index}
            data-git-graph-index={virtualItem.index}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${virtualItem.start}px)` }}
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
