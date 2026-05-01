import React, { useEffect, useRef, useState } from 'react'
import { CaretDown, CaretRight, Folder, FolderOpen } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { getFileIcon } from './FileExplorerIcons'
import type { FsEntry } from '../../shared/types'

/** Single row in the tree (file or directory). */
export function FileExplorerTreeRow({
  entry,
  depth,
  expanded,
  selected,
  isGitIgnored,
  onToggle,
  onClick,
  onContextMenu,
  colors,
}: {
  entry: FsEntry
  depth: number
  expanded: boolean
  selected: boolean
  isGitIgnored?: boolean
  onToggle: () => void
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
  colors: ReturnType<typeof useColors>
}) {
  const paddingLeft = depth * 16 + 4
  const iconInfo = entry.isDirectory ? null : getFileIcon(entry.name, colors.textTertiary)

  return (
    <div
      onClick={entry.isDirectory ? onToggle : onClick}
      onContextMenu={onContextMenu}
      style={{
        height: 24,
        display: 'flex',
        alignItems: 'center',
        paddingLeft,
        paddingRight: 8,
        cursor: 'pointer',
        userSelect: 'none',
        background: selected ? colors.surfaceHover : 'transparent',
        borderRadius: selected ? 4 : 0,
        gap: 4,
        opacity: isGitIgnored ? 0.45 : undefined,
      }}
      onMouseEnter={(e) => {
        if (!selected) (e.currentTarget as HTMLDivElement).style.background = colors.surfaceHover
      }}
      onMouseLeave={(e) => {
        if (!selected) (e.currentTarget as HTMLDivElement).style.background = 'transparent'
      }}
    >
      {entry.isDirectory ? (
        <>
          {expanded
            ? <CaretDown size={10} color={colors.textTertiary} weight="fill" />
            : <CaretRight size={10} color={colors.textTertiary} weight="fill" />
          }
          {expanded
            ? <FolderOpen size={14} color={colors.accent} weight="fill" />
            : <Folder size={14} color={colors.accent} weight="fill" />
          }
        </>
      ) : (
        <>
          {/* Spacer matching chevron width */}
          <span style={{ width: 10, flexShrink: 0 }} />
          {iconInfo && <iconInfo.icon size={14} color={iconInfo.color} />}
        </>
      )}
      <span
        style={{
          fontSize: 12,
          color: isGitIgnored ? colors.textTertiary : colors.textPrimary,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          marginLeft: 2,
        }}
      >
        {entry.name}
      </span>
    </div>
  )
}

/** Inline new-file/new-folder input row (rendered above siblings). */
export function FileExplorerInlineInput({
  depth,
  onSubmit,
  onCancel,
  placeholder,
  colors,
}: {
  depth: number
  onSubmit: (name: string) => void
  onCancel: () => void
  placeholder: string
  colors: ReturnType<typeof useColors>
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState('')

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && value.trim()) {
      onSubmit(value.trim())
    } else if (e.key === 'Escape') {
      onCancel()
    }
  }

  return (
    <div style={{ height: 24, display: 'flex', alignItems: 'center', paddingLeft: depth * 16 + 4 }}>
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={onCancel}
        placeholder={placeholder}
        style={{
          fontSize: 12,
          color: colors.textPrimary,
          background: 'transparent',
          border: `1px solid ${colors.containerBorder}`,
          borderRadius: 4,
          outline: 'none',
          padding: '1px 6px',
          width: '100%',
          marginRight: 8,
        }}
      />
    </div>
  )
}
