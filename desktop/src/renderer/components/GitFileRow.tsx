import React from 'react'
import {
  CaretDown, CaretRight, Plus, Minus, ArrowCounterClockwise,
  Folder, FolderOpen,
} from '@phosphor-icons/react'
import { useColors } from '../theme'
import { useCmdHeld, useNavigableText } from '../hooks/useNavigableLinks'
import type { GitChangedFile } from '../../shared/types'
import { STATUS_COLORS, STATUS_LETTERS, type FileTreeNode } from './GitPanelTypes'

// ─── File Row ───

export function FileRow({
  file,
  depth,
  directory,
  onStage,
  onUnstage,
  onDiscard,
  onClick,
  isSelected,
}: {
  file: GitChangedFile
  depth: number
  directory: string
  onStage: (path: string) => void
  onUnstage: (path: string) => void
  onDiscard: (path: string) => void
  onClick: (file: GitChangedFile) => void
  isSelected: boolean
}) {
  const colors = useColors()
  const cmdHeld = useCmdHeld()
  const { onOpenFile } = useNavigableText()
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
      onClick={(e) => {
        if (e.metaKey) {
          e.preventDefault()
          onOpenFile(directory + '/' + file.path)
          return
        }
        onClick(file)
      }}
    >
      <span
        className="text-[10px] font-mono flex-shrink-0"
        style={{ color: STATUS_COLORS[file.status] || colors.textTertiary, width: 14, display: 'inline-block', textAlign: 'center' }}
      >
        {STATUS_LETTERS[file.status] || '?'}
      </span>
      <span
        className="text-[10px] truncate flex-1"
        style={{
          color: cmdHeld ? colors.accent : colors.textSecondary,
          textDecoration: cmdHeld ? 'underline' : undefined,
          textUnderlineOffset: 2,
          marginLeft: 6,
        }}
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

// ─── File Tree Row (tree view mode) ───

export function FileTreeRow({
  node,
  depth,
  directory,
  expandedDirs,
  onToggleDirExpand,
  onStage,
  onUnstage,
  onDiscard,
  onClick,
  selectedFile,
}: {
  node: FileTreeNode
  depth: number
  directory: string
  expandedDirs: Set<string>
  onToggleDirExpand: (path: string) => void
  onStage: (path: string) => void
  onUnstage: (path: string) => void
  onDiscard: (path: string) => void
  onClick: (file: GitChangedFile) => void
  selectedFile: { path: string; staged: boolean } | null
}) {
  const colors = useColors()
  const isExpanded = expandedDirs.has(node.path)

  if (node.isDir) {
    return (
      <>
        <div
          className="flex items-center cursor-pointer"
          style={{
            height: 24,
            paddingLeft: 8 + depth * 12,
            paddingRight: 4,
          }}
          onClick={() => onToggleDirExpand(node.path)}
          onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = colors.surfaceHover }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
        >
          {isExpanded ? <CaretDown size={10} color={colors.textTertiary} /> : <CaretRight size={10} color={colors.textTertiary} />}
          {isExpanded
            ? <FolderOpen size={12} color={colors.accent} weight="fill" style={{ marginLeft: 2 }} />
            : <Folder size={12} color={colors.accent} weight="fill" style={{ marginLeft: 2 }} />
          }
          <span className="text-[10px] truncate" style={{ color: colors.textSecondary, marginLeft: 4 }}>
            {node.name}
          </span>
        </div>
        {isExpanded && node.children.map((child) => (
          <FileTreeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            directory={directory}
            expandedDirs={expandedDirs}
            onToggleDirExpand={onToggleDirExpand}
            onStage={onStage}
            onUnstage={onUnstage}
            onDiscard={onDiscard}
            onClick={onClick}
            selectedFile={selectedFile}
          />
        ))}
      </>
    )
  }

  // File node - delegate to FileRow
  return (
    <FileRow
      file={node.file!}
      depth={depth}
      directory={directory}
      onStage={onStage}
      onUnstage={onUnstage}
      onDiscard={onDiscard}
      onClick={onClick}
      isSelected={selectedFile?.path === node.file!.path && selectedFile?.staged === node.file!.staged}
    />
  )
}
