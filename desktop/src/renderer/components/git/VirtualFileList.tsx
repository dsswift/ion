/**
 * Virtualized file row list. Used for both flat + flattened-tree views.
 *
 * Renders a fixed-height stack of FileRow / FileTreeRow children inside a
 * @tanstack/react-virtual viewport. Auto-disables virtualization for very
 * short lists where the overhead would dominate.
 */

import React, { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { FileRow, FileTreeRow } from '../GitFileRow'
import { buildFileTree } from '../GitPanelTypes'
import type { FileTreeNode } from '../GitPanelTypes'
import type { GitChangedFile } from '../../../shared/types'

const ROW_HEIGHT = 22
const VIRT_THRESHOLD = 30

interface BaseProps {
  directory: string
  expandedDirs: Set<string>
  onToggleDirExpand: (path: string) => void
  onStage: (path: string) => void
  onUnstage: (path: string) => void
  onDiscard: (path: string) => void
  onClick: (file: GitChangedFile) => void
  selectedFile: { path: string; staged: boolean } | null
}

// ─── Flat view ───

export function VirtualFlatFileList({
  files, ...rest
}: { files: GitChangedFile[] } & BaseProps) {
  const parentRef = useRef<HTMLDivElement>(null)

  if (files.length < VIRT_THRESHOLD) {
    return (
      <>
        {files.map((file) => (
          <FileRow
            key={`${file.staged ? 's' : 'u'}-${file.path}`}
            file={file}
            depth={0}
            directory={rest.directory}
            onStage={rest.onStage}
            onUnstage={rest.onUnstage}
            onDiscard={rest.onDiscard}
            onClick={rest.onClick}
            isSelected={rest.selectedFile?.path === file.path && rest.selectedFile?.staged === file.staged}
          />
        ))}
      </>
    )
  }

  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 6,
  })

  return (
    <div ref={parentRef} style={{ height: Math.min(files.length * ROW_HEIGHT, 600), overflowY: 'auto' }}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const file = files[vi.index]
          return (
            <div
              key={`${file.staged ? 's' : 'u'}-${file.path}`}
              style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)` }}
            >
              <FileRow
                file={file}
                depth={0}
                directory={rest.directory}
                onStage={rest.onStage}
                onUnstage={rest.onUnstage}
                onDiscard={rest.onDiscard}
                onClick={rest.onClick}
                isSelected={rest.selectedFile?.path === file.path && rest.selectedFile?.staged === file.staged}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Tree view: flatten then render (no virtualization yet for simplicity) ───

export function TreeFileList({
  files, ...rest
}: { files: GitChangedFile[] } & BaseProps) {
  const tree = buildFileTree(files)
  return (
    <>
      {tree.map((node: FileTreeNode) => (
        <FileTreeRow
          key={node.path}
          node={node}
          depth={0}
          directory={rest.directory}
          expandedDirs={rest.expandedDirs}
          onToggleDirExpand={rest.onToggleDirExpand}
          onStage={rest.onStage}
          onUnstage={rest.onUnstage}
          onDiscard={rest.onDiscard}
          onClick={rest.onClick}
          selectedFile={rest.selectedFile}
        />
      ))}
    </>
  )
}
