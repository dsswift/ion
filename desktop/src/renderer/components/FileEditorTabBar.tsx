import React, { useState } from 'react'
import { Reorder } from 'framer-motion'
import { X, Plus, Eye, PencilSimple, TextAlignLeft } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { useSessionStore, FileEditorTab } from '../stores/sessionStore'
import { isMarkdownFile } from './FileEditorShared'

interface FileEditorTabBarProps {
  dir: string
  files: FileEditorTab[]
  activeFile: FileEditorTab | null
  activeFileId: string | null
}

/**
 * The strip of file tabs above the editor surface, plus the right-side
 * action buttons (preview toggle, read-only toggle, word-wrap toggle).
 */
export function FileEditorTabBar({ dir, files, activeFile, activeFileId }: FileEditorTabBarProps) {
  const colors = useColors()
  const setActiveEditorFile = useSessionStore((s) => s.setActiveEditorFile)
  const closeFileEditorTab = useSessionStore((s) => s.closeFileEditorTab)
  const createScratchFile = useSessionStore((s) => s.createScratchFile)
  const reorderEditorFiles = useSessionStore((s) => s.reorderEditorFiles)
  const toggleEditorPreview = useSessionStore((s) => s.toggleEditorPreview)
  const toggleEditorReadOnly = useSessionStore((s) => s.toggleEditorReadOnly)
  const editorWordWrap = usePreferencesStore((s) => s.editorWordWrap)
  const setEditorWordWrap = usePreferencesStore((s) => s.setEditorWordWrap)

  return (
    <div
      data-ion-ui
      className="flex items-center"
      style={{
        height: 30,
        minHeight: 30,
        background: colors.surfacePrimary,
        borderBottom: `1px solid ${colors.containerBorder}`,
        userSelect: 'none',
      }}
    >
      {/* Scrollable tabs (draggable reorder) */}
      <Reorder.Group
        as="div"
        axis="x"
        values={files}
        onReorder={(reordered) => reorderEditorFiles(dir, reordered)}
        className="flex items-center gap-0 flex-1 overflow-x-auto"
        style={{ scrollbarWidth: 'none' }}
      >
        {files.map((file) => (
          <Reorder.Item
            key={file.id}
            value={file}
            as="div"
            dragListener={true}
            dragConstraints={{ top: 0, bottom: 0 }}
            style={{ cursor: 'grab' }}
          >
            <FileEditorTabItem
              file={file}
              isActive={file.id === activeFileId}
              colors={colors}
              onSelect={() => setActiveEditorFile(dir, file.id)}
              onClose={(e) => {
                e.stopPropagation()
                closeFileEditorTab(dir, file.id)
              }}
            />
          </Reorder.Item>
        ))}
        <button
          className="flex items-center justify-center px-2 rounded transition-colors"
          style={{
            height: 30,
            color: colors.textTertiary,
            cursor: 'pointer',
          }}
          onClick={() => createScratchFile(dir)}
          title="New scratch file"
        >
          <Plus size={12} weight="bold" />
        </button>
      </Reorder.Group>

      {/* Right-side actions */}
      <div className="flex items-center gap-1 px-2">
        {activeFile && isMarkdownFile(activeFile.fileName) && (
          <button
            className="flex items-center justify-center rounded p-1 transition-colors"
            style={{
              color: activeFile.isPreview ? colors.accent : colors.textTertiary,
              cursor: 'pointer',
              background: activeFile.isPreview ? colors.accentLight : 'transparent',
            }}
            onClick={() => toggleEditorPreview(dir, activeFile.id)}
            title="Toggle preview"
          >
            <Eye size={13} />
          </button>
        )}
        {activeFile && activeFile.isReadOnly && (
          <button
            className="flex items-center justify-center rounded p-1 transition-colors"
            style={{
              color: colors.textTertiary,
              cursor: 'pointer',
            }}
            onClick={() => toggleEditorReadOnly(dir, activeFile.id)}
            title="Enable editing"
          >
            <PencilSimple size={13} />
          </button>
        )}
        <button
          className="flex items-center justify-center rounded p-1 transition-colors"
          style={{
            color: editorWordWrap ? colors.accent : colors.textTertiary,
            cursor: 'pointer',
          }}
          onClick={() => setEditorWordWrap(!editorWordWrap)}
          title={editorWordWrap ? 'Disable word wrap' : 'Enable word wrap'}
        >
          <TextAlignLeft size={13} />
        </button>
      </div>
    </div>
  )
}

// ---- Tab item sub-component ----

interface FileEditorTabItemProps {
  file: FileEditorTab
  isActive: boolean
  colors: ReturnType<typeof useColors>
  onSelect: () => void
  onClose: (e: React.MouseEvent) => void
}

function FileEditorTabItem({ file, isActive, colors, onSelect, onClose }: FileEditorTabItemProps) {
  const [confirmingClose, setConfirmingClose] = useState(false)

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (file.isDirty) {
      setConfirmingClose(true)
    } else {
      onClose(e)
    }
  }

  return (
    <div
      className="flex items-center gap-1.5 px-2 cursor-pointer transition-colors"
      style={{
        height: 30,
        background: isActive ? colors.surfaceSecondary : 'transparent',
        borderBottom: isActive ? `2px solid ${colors.accent}` : '2px solid transparent',
        fontFamily: 'monospace',
        fontSize: 11,
        color: isActive ? colors.textPrimary : colors.textTertiary,
        whiteSpace: 'nowrap',
      }}
      onClick={onSelect}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); handleClose(e) } }}
    >
      <span style={{ fontStyle: file.filePath === null ? 'italic' : 'normal' }}>
        {file.fileName}
      </span>
      {confirmingClose ? (
        <div className="flex items-center gap-0.5 text-[9px] flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => setConfirmingClose(false)}
            className="px-1 rounded"
            style={{ color: colors.textTertiary, background: 'none', border: 'none', cursor: 'pointer' }}
          >
            No
          </button>
          <button
            onClick={(e) => { onClose(e); setConfirmingClose(false) }}
            className="px-1 rounded"
            style={{ color: colors.accent, background: 'none', border: 'none', cursor: 'pointer' }}
          >
            Yes
          </button>
        </div>
      ) : (
        <>
          {file.isDirty && (
            <span
              style={{
                display: 'inline-block',
                width: 5,
                height: 5,
                borderRadius: '50%',
                backgroundColor: colors.accent,
                flexShrink: 0,
              }}
            />
          )}
          <button
            className="flex items-center justify-center rounded p-0.5 transition-colors"
            style={{
              color: colors.textTertiary,
              cursor: 'pointer',
              opacity: 0.6,
              flexShrink: 0,
            }}
            onClick={handleClose}
          >
            <X size={10} />
          </button>
        </>
      )}
    </div>
  )
}
