/**
 * FileSurface — a `file:` surface tab body: the shared editor machinery
 * (fileEditorStates buffers, useFileEditorContent load/watch/save,
 * CodeMirror / markdown preview) inside a surface pane instead of the
 * floating FileEditor panel.
 *
 * The tab is a DESCRIPTOR: the buffer lives in sessionStore.fileEditorStates
 * keyed by dir. Deleted/unreadable paths surface the same explicit
 * readError banner the floating editor shows (D10: never a silent blank
 * buffer).
 */
import React, { useCallback, useRef, useState } from 'react'
import type { EditorView } from '@codemirror/view'
import { useSessionStore } from '../../../stores/sessionStore'
import { useFileEditorContent } from '../../../hooks/useFileEditorContent'
import { gotoLine } from '@codemirror/search'
import { FileEditorCodeMirror, type CursorPosition } from '../../../components/FileEditorCodeMirror'
import { FileEditorPreview } from '../../../components/FileEditorPreview'
import { FileEditorStatusBar } from '../../../components/FileEditorStatusBar'
import { FileSurfaceControls } from './FileSurfaceControls'
import { useColors } from '../../../theme'
import { rError } from '../../../rendererLogger'

export function FileSurface({ dir, filePath }: { dir: string; filePath: string }): React.JSX.Element {
  const colors = useColors()
  const activeTabId = useSessionStore((s) => s.activeTabId)
  // The buffer for this surface tab: located by path within the dir's state.
  const activeFile = useSessionStore((s) => {
    const dirState = s.fileEditorStates.get(dir)
    return dirState?.files.find((f) => f.filePath === filePath) ?? null
  })

  const { handleSave } = useFileEditorContent({ dir, activeFile })
  const handleSaveSync = useCallback(() => {
    void handleSave().catch((err) => rError('studio.file-surface', 'save failed', { path: filePath, error: String(err) }))
  }, [handleSave, filePath])

  const [cursorPos, setCursorPos] = useState<CursorPosition>({ line: 1, col: 1 })
  const [langOverride, setLangOverride] = useState<string | null>(null)
  const editorViewRef = useRef<EditorView | null>(null)
  const handleGoToLine = useCallback(() => {
    if (editorViewRef.current) gotoLine(editorViewRef.current)
  }, [])

  if (!activeFile) {
    // Buffer gone (closed via the floating editor or dirty-close): the tab
    // outlived its buffer. Explicit state, user closes the tab.
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.textTertiary, fontSize: 12, fontFamily: 'system-ui, sans-serif' }}>
        Buffer closed — reopen the file from the explorer.
      </div>
    )
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <FileSurfaceControls dir={dir} file={activeFile} onSave={handleSaveSync} />
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {activeFile.readError && (
          <div style={{ padding: '4px 10px', fontSize: 11, color: colors.dangerFg, background: colors.statusErrorBg, borderBottom: `1px solid ${colors.containerBorder}` }}>
            {activeFile.readError} — the file may have been moved or deleted. Buffer is read-only.
          </div>
        )}
        {activeFile.isPreview ? (
          <FileEditorPreview dir={dir} tabId={activeTabId} activeFile={activeFile} />
        ) : (
          <FileEditorCodeMirror
            dir={dir}
            activeFile={activeFile}
            onSave={handleSaveSync}
            onCursorChange={setCursorPos}
            editorViewRef={editorViewRef}
            languageOverride={langOverride}
          />
        )}
      </div>
      {!activeFile.isPreview && (
        <FileEditorStatusBar
          fileName={activeFile.fileName}
          cursorPos={cursorPos}
          languageOverride={langOverride}
          onLanguageChange={setLangOverride}
          onGoToLine={handleGoToLine}
        />
      )}
    </div>
  )
}
