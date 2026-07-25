/**
 * Collapsible, sticky-header section for the changes panel.
 *
 * Renders a header with caret, label, count pill, and optional per-section
 * action buttons; sticky position keeps it visible during long scroll.
 * Hosts a virtualized file list inside.
 */

import React from 'react'
import { useColors } from '../../theme'
import { useInteractiveState, interactiveBg } from '../../hooks/useInteractiveState'
import { transitions } from '../../theme-tokens'
import { Chevron } from '../Chevron'
import type { GitChangedFile } from '../../../shared/types'
import { VirtualFlatFileList, TreeFileList } from './VirtualFileList'

interface Props {
  label: string
  files: GitChangedFile[]
  open: boolean
  onToggle: () => void
  actions?: React.ReactNode
  accentColor?: string
  directory: string
  treeView: boolean
  expandedDirs: Set<string>
  onToggleDirExpand: (path: string) => void
  onStage: (path: string) => void
  onUnstage: (path: string) => void
  onDiscard: (path: string) => void
  onClick: (file: GitChangedFile) => void
  selectedFile: { path: string; staged: boolean } | null
}

export function SectionBlock(props: Props) {
  const colors = useColors()
  const { hover, pressed, handlers } = useInteractiveState()
  const { label, files, open, onToggle, actions, accentColor, treeView } = props
  // The header is sticky and must stay opaque while rows scroll beneath it,
  // so the (translucent) hover/pressed token is layered over surfacePrimary
  // instead of replacing it.
  const overlay = interactiveBg(colors, { hover, pressed })
  const headerBg = overlay === 'transparent'
    ? colors.surfacePrimary
    : `linear-gradient(${overlay}, ${overlay}), ${colors.surfacePrimary}`
  if (files.length === 0) return null

  return (
    <div>
      <div
        className="flex items-center justify-between px-2 cursor-pointer"
        onClick={onToggle}
        {...handlers}
        style={{
          fontSize: 10,
          color: accentColor ?? colors.textTertiary,
          position: 'sticky',
          top: 0,
          zIndex: 2,
          background: headerBg,
          borderBottom: `1px solid ${colors.containerBorder}`,
          height: 22,
          transition: `background ${transitions.base}`,
        }}
      >
        <span className="flex items-center gap-1">
          <Chevron open={open} size={9} weight="regular" />
          {label} ({files.length})
        </span>
        <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          {actions}
        </div>
      </div>
      {open && (
        treeView
          ? <TreeFileList files={files} {...inner(props)} />
          : <VirtualFlatFileList files={files} {...inner(props)} />
      )}
    </div>
  )
}

function inner(p: Props) {
  return {
    directory: p.directory,
    expandedDirs: p.expandedDirs,
    onToggleDirExpand: p.onToggleDirExpand,
    onStage: p.onStage,
    onUnstage: p.onUnstage,
    onDiscard: p.onDiscard,
    onClick: p.onClick,
    selectedFile: p.selectedFile,
  }
}
