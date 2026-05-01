import React, { useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { X } from '@phosphor-icons/react'
// Editor portals to document.body (not PopoverLayer) so z-index can go behind main UI
import { useColors } from '../theme'
import { useSessionStore } from '../stores/sessionStore'
import { useFileEditorPanel } from '../hooks/useFileEditorPanel'
import { useFileEditorContent } from '../hooks/useFileEditorContent'
import { isMarkdownFile } from './FileEditorShared'
import { FileEditorTabBar } from './FileEditorTabBar'
import { FileEditorPreview } from './FileEditorPreview'
import { FileEditorCodeMirror } from './FileEditorCodeMirror'

interface FileEditorProps {
  dir: string
  tabId: string
}

export function FileEditor({ dir, tabId }: FileEditorProps) {
  const colors = useColors()

  // Panel position and size — managed via refs + direct DOM mutation during
  // drag to avoid re-renders that interfere with framer-motion Reorder
  // layout animations. Geometry is persisted to the global session store.
  const { panelRef, posRef, size, handleDragStart, handleResizeStart } = useFileEditorPanel()

  // Store selectors
  const editorState = useSessionStore((s) => s.fileEditorStates.get(dir))
  const toggleFileEditor = useSessionStore((s) => s.toggleFileEditor)

  const files = editorState?.files ?? []
  const activeFileId = editorState?.activeFileId ?? null
  const activeFile = files.find((f) => f.id === activeFileId) ?? null

  const handleClose = useCallback(() => toggleFileEditor(tabId), [toggleFileEditor, tabId])

  // File loading, watcher, and save handler.
  const { handleSave } = useFileEditorContent({ dir, activeFile })

  if (typeof document === 'undefined') return null

  const tabTitle = useSessionStore((s) => {
    const tab = s.tabs.find((t) => t.id === tabId)
    return tab?.customTitle || tab?.title || ''
  })
  const isFocused = useSessionStore((s) => s.fileEditorFocused)
  const focusFileEditor = useSessionStore((s) => s.focusFileEditor)

  const baseDirName = dir.split('/').pop() || dir
  const headerTitle = [
    baseDirName,
    tabTitle,
    activeFile?.fileName,
  ].filter(Boolean).join(' - ') || 'File Editor'

  const panel = (
    <motion.div
      ref={panelRef}
      data-ion-ui
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.15 }}
      className="glass-surface rounded-xl"
      onMouseDown={focusFileEditor}
      style={{
        position: 'fixed',
        left: posRef.current.x,
        top: posRef.current.y,
        width: size.w,
        height: size.h,
        display: 'flex',
        flexDirection: 'column',
        background: colors.containerBg,
        border: `1px solid ${colors.containerBorder}`,
        boxShadow: isFocused ? '0 16px 48px rgba(0, 0, 0, 0.4)' : '0 4px 12px rgba(0, 0, 0, 0.2)',
        overflow: 'hidden',
        pointerEvents: 'auto',
        zIndex: isFocused ? 10000 : 5,
        opacity: isFocused ? 1 : 0.85,
        transition: 'box-shadow 0.15s, opacity 0.15s',
      }}
    >
      {/* Draggable header */}
      <div
        data-ion-ui
        className="flex items-center px-3"
        style={{
          height: 32,
          minHeight: 32,
          borderBottom: `1px solid ${colors.containerBorder}`,
          background: colors.surfacePrimary,
          cursor: 'grab',
          userSelect: 'none',
        }}
        onMouseDown={handleDragStart}
      >
        <button
          onClick={handleClose}
          className="flex-shrink-0 p-0.5 rounded transition-colors"
          style={{ color: colors.textTertiary, cursor: 'pointer' }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <X size={12} />
        </button>
        <span
          className="text-[11px] truncate"
          style={{ color: colors.textSecondary, fontFamily: 'monospace', flex: 1, textAlign: 'center' }}
        >
          {headerTitle}
        </span>
      </div>

      {/* Tab strip + right-side actions */}
      <FileEditorTabBar
        dir={dir}
        files={files}
        activeFile={activeFile}
        activeFileId={activeFileId}
      />

      {/* Editor / Preview area */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {activeFile ? (
          activeFile.isPreview && isMarkdownFile(activeFile.fileName) ? (
            <FileEditorPreview dir={dir} tabId={tabId} activeFile={activeFile} />
          ) : (
            <FileEditorCodeMirror dir={dir} activeFile={activeFile} onSave={handleSave} />
          )
        ) : (
          /* No file open */
          <div
            className="flex items-center justify-center"
            style={{ flex: 1, color: colors.textTertiary, fontSize: 12, fontFamily: 'monospace' }}
          >
            No file open
          </div>
        )}
      </div>

      {/* Resize handle */}
      <div
        data-ion-ui
        onMouseDown={handleResizeStart}
        style={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          width: 16,
          height: 16,
          cursor: 'nwse-resize',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" style={{ opacity: 0.25 }}>
          <line x1="14" y1="6" x2="6" y2="14" stroke={colors.textTertiary} strokeWidth="1.5" />
          <line x1="14" y1="10" x2="10" y2="14" stroke={colors.textTertiary} strokeWidth="1.5" />
        </svg>
      </div>
    </motion.div>
  )

  return createPortal(panel, document.body)
}
