import React, { useEffect, useRef, useState } from 'react'
import { Folder, FolderOpen } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { transitions } from '../theme-tokens'
import { Chevron } from './Chevron'
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
  /** Receives the click so ⇧/⌥ modifiers reach the open-intent rules. */
  onClick: (event: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
  colors: ReturnType<typeof useColors>
}) {
  const { hover, pressed, handlers } = useInteractiveState()
  const paddingLeft = depth * 16 + 4
  const iconInfo = entry.isDirectory ? null : getFileIcon(entry.name)

  return (
    <div
      onClick={entry.isDirectory ? () => onToggle() : onClick}
      onContextMenu={onContextMenu}
      {...handlers}
      style={{
        height: 24,
        display: 'flex',
        alignItems: 'center',
        paddingLeft,
        paddingRight: 8,
        cursor: 'pointer',
        userSelect: 'none',
        background: interactiveBg(colors, { hover, pressed, selected }),
        borderRadius: selected ? 4 : 0,
        gap: 4,
        opacity: isGitIgnored ? 0.45 : undefined,
        transition: `background ${transitions.base}`,
      }}
    >
      {entry.isDirectory ? (
        <>
          <Chevron open={expanded} size={10} color={colors.textTertiary} />
          {expanded
            ? <FolderOpen size={14} color={colors.accent} weight="fill" />
            : <Folder size={14} color={colors.accent} weight="fill" />
          }
        </>
      ) : (
        <>
          {/* Spacer matching chevron width */}
          <span style={{ width: 10, flexShrink: 0 }} />
          {iconInfo && <iconInfo.icon size={14} color={colors[iconInfo.colorKey]} />}
        </>
      )}
      <span
        style={{
          fontSize: 12,
          fontWeight: selected ? 500 : undefined,
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

/** Inline new-file/new-folder/rename input row (rendered above siblings or in-place). */
export function FileExplorerInlineInput({
  depth,
  onSubmit,
  onCancel,
  placeholder,
  colors,
  initialValue = '',
}: {
  depth: number
  onSubmit: (name: string) => void
  onCancel: () => void
  placeholder: string
  colors: ReturnType<typeof useColors>
  /**
   * Pre-filled value (used for rename so the user starts with the
   * current name selected). Defaults to empty for new-file / new-folder
   * flows where the row appears above siblings with no preset.
   */
  initialValue?: string
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(initialValue)

  useEffect(() => {
    // Focus the field, and when starting with a preset (rename) select
    // the basename portion (everything before the last `.`) so typing
    // immediately replaces the name while preserving the extension as
    // the obvious starting selection — matches Finder / VSCode behavior.
    const el = inputRef.current
    if (!el) return
    el.focus()
    if (initialValue) {
      const lastDot = initialValue.lastIndexOf('.')
      if (lastDot > 0) {
        el.setSelectionRange(0, lastDot)
      } else {
        el.select()
      }
    }
  }, [initialValue])

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
