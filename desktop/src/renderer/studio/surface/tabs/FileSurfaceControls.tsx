/**
 * FileSurfaceControls — per-tab control bar for a file surface tab:
 * preview↔edit (markdown only), read-only toggle, per-tab word wrap, save.
 *
 * Word wrap is the per-tab override (FileEditorTab.wordWrap via
 * toggleEditorWordWrap, MIRROR_LOCAL); the editorWordWrap preference stays
 * the default for tabs without an override, and the overlay floating
 * editor's global toggle is untouched.
 */
import React from 'react'
import { Eye, PencilSimple, LockSimple, LockSimpleOpen, TextAlignLeft, FloppyDisk } from '@phosphor-icons/react'
import { useSessionStore } from '../../../stores/sessionStore'
import { usePreferencesStore } from '../../../preferences'
import { isMarkdownFile } from '../../../components/FileEditorShared'
import { useColors } from '../../../theme'
import { useInteractiveState, interactiveBg } from '../../../hooks/useInteractiveState'
import { transitions } from '../../../theme-tokens'
import type { FileEditorTab } from '../../../stores/sessionStore'

function ControlButton({
  title,
  active,
  onClick,
  children,
}: {
  title: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const colors = useColors()
  const { hover, pressed, handlers } = useInteractiveState()
  return (
    <button
      title={title}
      onClick={onClick}
      className="ion-focusable"
      {...handlers}
      style={{
        border: 'none',
        borderRadius: 4,
        padding: '2px 4px',
        display: 'flex',
        alignItems: 'center',
        cursor: 'pointer',
        color: active ? colors.accent : colors.textTertiary,
        background: interactiveBg(colors, { hover, pressed }, active ? colors.accentLight : 'transparent'),
        transition: `color ${transitions.base}, background ${transitions.base}`,
      }}
    >
      {children}
    </button>
  )
}

export function FileSurfaceControls({
  dir,
  file,
  onSave,
  onTogglePreview,
  onToggleReadOnly,
  onToggleWordWrap,
  showReadOnly = true,
}: {
  dir: string
  file: FileEditorTab
  onSave: () => void
  onTogglePreview?: () => void
  onToggleReadOnly?: () => void
  onToggleWordWrap?: () => void
  showReadOnly?: boolean
}): React.JSX.Element {
  const colors = useColors()
  const toggleEditorPreview = useSessionStore((s) => s.toggleEditorPreview)
  const toggleEditorReadOnly = useSessionStore((s) => s.toggleEditorReadOnly)
  const toggleEditorWordWrap = useSessionStore((s) => s.toggleEditorWordWrap)
  const wordWrapPref = usePreferencesStore((s) => s.editorWordWrap)
  const effectiveWrap = file.wordWrap ?? wordWrapPref
  const isMd = isMarkdownFile(file.fileName)

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '3px 8px',
        borderBottom: `1px solid ${colors.containerBorder}`,
        fontFamily: 'system-ui, sans-serif',
        fontSize: 11,
        flexShrink: 0,
      }}
    >
      <span style={{ color: colors.textTertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: 'auto' }}>
        {file.fileName}
        {file.isDirty ? ' •' : ''}
      </span>
      {isMd && (
        <ControlButton
          title={file.isPreview ? 'Edit source' : 'Preview'}
          active={file.isPreview}
          onClick={onTogglePreview ?? (() => toggleEditorPreview(dir, file.id))}
        >
          {file.isPreview ? <PencilSimple size={13} /> : <Eye size={13} />}
        </ControlButton>
      )}
      {showReadOnly && (
        <ControlButton
          title={file.isReadOnly ? 'Unlock (read-only)' : 'Lock (read-only)'}
          active={file.isReadOnly}
          onClick={onToggleReadOnly ?? (() => toggleEditorReadOnly(dir, file.id))}
        >
          {file.isReadOnly ? <LockSimple size={13} /> : <LockSimpleOpen size={13} />}
        </ControlButton>
      )}
      <ControlButton title={`Word wrap ${effectiveWrap ? 'off' : 'on'} (this tab)`} active={effectiveWrap} onClick={onToggleWordWrap ?? (() => toggleEditorWordWrap(dir, file.id))}>
        <TextAlignLeft size={13} />
      </ControlButton>
      <ControlButton title="Save" onClick={onSave}>
        <FloppyDisk size={13} />
      </ControlButton>
    </div>
  )
}
