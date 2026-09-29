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
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { EditorView } from '@codemirror/view'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { useFileEditorContent } from '../../../hooks/useFileEditorContent'
import { gotoLine } from '@codemirror/search'
import { FileEditorCodeMirror, type CursorPosition } from '../../../components/FileEditorCodeMirror'
import { FileEditorPreview } from '../../../components/FileEditorPreview'
import { FileEditorStatusBar } from '../../../components/FileEditorStatusBar'
import { FileSurfaceControls } from './FileSurfaceControls'
import { useColors } from '../../../theme'
import { rDebug, rError, rWarn } from '../../../rendererLogger'
import { useSurfaceStore } from '../surface-store'
import { applyFileReveal } from '../file-reveal'
import { useCodeMirrorFind } from '../surface-find'

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

  // Find drives the code editor while editing; a preview is searched as page text.
  useCodeMirrorFind(editorViewRef, !!activeFile && !activeFile.isPreview)

  // A Workspace Search result asked for a line in this file. It waits for the
  // buffer to load; a markdown tab in preview switches to its source, since a
  // line only exists there. Child effects run first, so the editor already
  // holds the loaded text when this runs.
  const reveal = useSurfaceStore((s) => (s.fileReveal?.filePath === filePath ? s.fileReveal : null))
  const toggleEditorPreview = useSessionStore((s) => s.toggleEditorPreview)
  useEffect(() => {
    if (!reveal || !activeFile) return
    const consume = useSurfaceStore.getState().consumeFileReveal
    if (activeFile.readError) {
      rWarn('studio.file-surface', 'file reveal dropped: file could not be read', { path: filePath, error: activeFile.readError })
      consume(reveal.nonce)
      return
    }
    if (!activeFile.isLoaded) return
    if (activeFile.isPreview) {
      toggleEditorPreview(dir, activeFile.id)
      return
    }
    const view = editorViewRef.current
    if (!view) return
    applyFileReveal(view, reveal)
    consume(reveal.nonce)
    rDebug('studio.file-surface', 'file reveal applied', { path: filePath, line: reveal.line, column: reveal.column })
  }, [reveal, activeFile, dir, filePath, toggleEditorPreview])

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
