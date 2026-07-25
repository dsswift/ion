import React from 'react'
import {
  Plus, Minus, ArrowCounterClockwise,
  Folder, FolderOpen, Warning, ArrowRight,
} from '@phosphor-icons/react'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { transitions } from '../theme-tokens'
import { Chevron } from './Chevron'
import { useCmdHeld, useNavigableText } from '../hooks/useNavigableLinks'
import { Tooltip } from './git/Tooltip'
import { rError } from '../rendererLogger'
import type { GitChangedFile } from '../../shared/types'
import { GIT_STATUS_COLOR_KEYS, STATUS_LETTERS, type FileTreeNode } from './GitPanelTypes'

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
  const { hover, pressed, handlers } = useInteractiveState()
  const fileName = file.path.split('/').pop() || file.path
  const oldName = file.oldPath?.split('/').pop()
  const isConflict = file.status === 'conflict'
  const statusKey = GIT_STATUS_COLOR_KEYS[file.status] as keyof typeof colors | undefined
  const statusColor = statusKey ? colors[statusKey] : colors.textTertiary

  return (
    <div
      className="flex items-center group cursor-pointer"
      {...handlers}
      style={{
        height: 24,
        paddingLeft: 8 + depth * 12,
        paddingRight: 4,
        background: interactiveBg(colors, { hover, pressed, selected: isSelected }),
        transition: `background ${transitions.base}`,
      }}
      onClick={(e) => {
        if (e.metaKey) {
          e.preventDefault()
          onOpenFile(directory + '/' + file.path).catch((err) => rError('git-file-row', 'open file failed', { error: String(err) }))
          return
        }
        onClick(file)
      }}
    >
      {isConflict ? (
        <Warning size={11} weight="fill" color={colors[GIT_STATUS_COLOR_KEYS.conflict]} style={{ width: 14, flexShrink: 0 }} />
      ) : (
        <span
          className="text-[10px] font-mono flex-shrink-0"
          style={{ color: statusColor, width: 14, display: 'inline-block', textAlign: 'center' }}
        >
          {STATUS_LETTERS[file.status] || '?'}
        </span>
      )}
      <span
        className="text-[10px] truncate flex-1 flex items-center gap-1"
        style={{
          color: cmdHeld ? colors.accent : colors.textSecondary,
          textDecoration: cmdHeld ? 'underline' : undefined,
          textUnderlineOffset: 2,
          marginLeft: 6,
        }}
      >
        {oldName && (
          <>
            <span style={{ color: colors.textMuted, textDecoration: 'line-through' }}>{oldName}</span>
            <ArrowRight size={9} color={colors.textMuted} />
          </>
        )}
        <span className="truncate" style={{ fontWeight: isSelected ? 500 : undefined }}>{fileName}</span>
        {isConflict && file.conflictKind && (
          <span className="text-[8px] font-mono" style={{ color: colors[GIT_STATUS_COLOR_KEYS.conflict], marginLeft: 2 }}>{file.conflictKind}</span>
        )}
      </span>
      {/* Hover actions */}
      <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
        {file.staged ? (
          <Tooltip text="Unstage">
            <button
              onClick={(e) => { e.stopPropagation(); onUnstage(file.path) }}
              className="px-1 py-1 rounded transition-colors ion-focusable"
              style={{ color: colors.textTertiary }}
            >
              <Minus size={12} />
            </button>
          </Tooltip>
        ) : (
          <Tooltip text="Stage">
            <button
              onClick={(e) => { e.stopPropagation(); onStage(file.path) }}
              className="px-1 py-1 rounded transition-colors ion-focusable"
              style={{ color: colors.textTertiary }}
            >
              <Plus size={12} />
            </button>
          </Tooltip>
        )}
        <Tooltip text="Discard changes">
          <button
            onClick={(e) => { e.stopPropagation(); onDiscard(file.path) }}
            className="px-1 py-1 rounded transition-colors ion-focusable"
            style={{ color: colors.textTertiary }}
          >
            <ArrowCounterClockwise size={12} />
          </button>
        </Tooltip>
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
  const { hover, pressed, handlers } = useInteractiveState()
  const isExpanded = expandedDirs.has(node.path)

  if (node.isDir) {
    return (
      <>
        <div
          className="flex items-center cursor-pointer"
          {...handlers}
          style={{
            height: 24,
            paddingLeft: 8 + depth * 12,
            paddingRight: 4,
            background: interactiveBg(colors, { hover, pressed }),
            transition: `background ${transitions.base}`,
          }}
          onClick={() => onToggleDirExpand(node.path)}
        >
          <Chevron open={isExpanded} size={10} color={colors.textTertiary} weight="regular" />
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
