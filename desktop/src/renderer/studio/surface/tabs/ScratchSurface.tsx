import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { EditorView } from '@codemirror/view'
import { gotoLine } from '@codemirror/search'
import type { ScratchDocument } from '../../../../shared/studio-surface-types'
import type { FileEditorTab } from '../../../stores/sessionStore'
import { FileEditorCodeMirror, type CursorPosition } from '../../../components/FileEditorCodeMirror'
import { FileEditorPreview } from '../../../components/FileEditorPreview'
import { FileEditorStatusBar } from '../../../components/FileEditorStatusBar'
import { FileSurfaceControls } from './FileSurfaceControls'
import { useColors } from '../../../theme'
import { useSurfaceStore } from '../surface-store'
import { useSessionStore } from '../../../stores/sessionStore'
import { rInfo, rWarn } from '../../../rendererLogger'

interface ScratchSaveDependencies {
  showSaveDialog(defaultPath: string): Promise<{ filePath: string | null; error?: string }>
  writeFile(filePath: string, content: string): Promise<{ ok: boolean; error?: string }>
  setError(error: string | undefined): void
  promote(filePath: string): void
}

export async function saveScratchDocument(
  document: ScratchDocument,
  workingDirectory: string,
  projectKey: string,
  deps: ScratchSaveDependencies,
): Promise<void> {
  deps.setError(undefined)
  try {
    const defaultPath = `${workingDirectory.replace(/\/$/, '')}/${document.fileName}`
    const dialog = await deps.showSaveDialog(defaultPath)
    if (dialog.error) {
      deps.setError(dialog.error)
      rWarn('studio.scratch', 'scratch save dialog failed', { project_key: projectKey, document_id: document.id, error: dialog.error })
      return
    }
    if (!dialog.filePath) {
      rInfo('studio.scratch', 'scratch save cancelled', { project_key: projectKey, document_id: document.id })
      return
    }
    const result = await deps.writeFile(dialog.filePath, document.content)
    if (!result.ok) {
      const message = result.error || 'Could not save the Scratch Document'
      deps.setError(message)
      rWarn('studio.scratch', 'scratch save failed', { project_key: projectKey, document_id: document.id, file_path: dialog.filePath, error: message })
      return
    }
    deps.promote(dialog.filePath)
  } catch (error) {
    const message = String(error)
    deps.setError(message)
    rWarn('studio.scratch', 'scratch save operation failed', { project_key: projectKey, document_id: document.id, error: message })
  }
}

function asEditorFile(document: ScratchDocument): FileEditorTab {
  return {
    id: document.id,
    filePath: null,
    fileName: document.fileName,
    content: document.content,
    savedContent: document.savedContent,
    isDirty: document.content !== document.savedContent,
    isReadOnly: false,
    isPreview: document.isPreview,
    wordWrap: document.wordWrap,
  }
}

export function ScratchSurface({ projectKey, documentId }: { projectKey: string; documentId: string }): React.JSX.Element {
  const colors = useColors()
  const activeTabId = useSurfaceStore((state) => state.currentConversationId)
  const workingDirectory = useSessionStore((state) => state.tabs.find((tab) => tab.id === activeTabId)?.workingDirectory ?? projectKey)
  const document = useSurfaceStore((state) => state.scratchProjects[projectKey]?.documents.find((item) => item.id === documentId) ?? null)
  const updateScratch = useSurfaceStore((state) => state.updateScratch)
  const toggleScratchPreview = useSurfaceStore((state) => state.toggleScratchPreview)
  const toggleScratchWordWrap = useSurfaceStore((state) => state.toggleScratchWordWrap)
  const setScratchSaveError = useSurfaceStore((state) => state.setScratchSaveError)
  const promoteScratch = useSurfaceStore((state) => state.promoteScratch)
  const [cursorPos, setCursorPos] = useState<CursorPosition>({ line: 1, col: 1 })
  const [langOverride, setLangOverride] = useState<string | null>(null)
  const editorViewRef = useRef<EditorView | null>(null)

  // Document resolution is the seam a "content only in one conversation" report
  // lives in: a null document means this conversation resolved a projectKey the
  // store has no record under (key divergence), an empty content means the
  // shared record exists but carries nothing, and a non-empty length means the
  // render received the shared body. Keyed on the resolution and identity, not
  // the content length, so the log marks a conversation switch rather than every
  // keystroke; the length is read at fire time to describe that transition.
  const resolved = document !== null
  const contentLenRef = useRef(0)
  contentLenRef.current = document?.content.length ?? 0
  useEffect(() => {
    if (resolved) {
      rInfo('studio.scratch', 'scratch document resolved for render', { project_key: projectKey, document_id: documentId, content_len: contentLenRef.current })
    } else {
      rWarn('studio.scratch', 'scratch document not found for render', { project_key: projectKey, document_id: documentId })
    }
  }, [resolved, projectKey, documentId])

  const handleSave = useCallback(async () => {
    if (!document) return
    await saveScratchDocument(document, workingDirectory, projectKey, {
      showSaveDialog: (defaultPath) => window.ion.fsSaveDialog(defaultPath),
      writeFile: (filePath, content) => window.ion.fsWriteFile(filePath, content),
      setError: (error) => setScratchSaveError(projectKey, documentId, error),
      promote: (filePath) => {
        if (activeTabId) promoteScratch(projectKey, documentId, filePath, activeTabId)
      },
    })
  }, [activeTabId, document, documentId, projectKey, promoteScratch, setScratchSaveError, workingDirectory])

  const handleGoToLine = useCallback(() => {
    if (editorViewRef.current) gotoLine(editorViewRef.current)
  }, [])

  if (!document) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.textTertiary, fontSize: 12 }}>
        Scratch Document closed.
      </div>
    )
  }

  const file = asEditorFile(document)
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <FileSurfaceControls
        dir={projectKey}
        file={file}
        onSave={() => { void handleSave() }}
        onTogglePreview={() => toggleScratchPreview(projectKey, documentId)}
        onToggleWordWrap={() => toggleScratchWordWrap(projectKey, documentId)}
        showReadOnly={false}
      />
      {document.saveError && (
        <div style={{ padding: '4px 10px', fontSize: 11, color: colors.dangerFg, background: colors.statusErrorBg, borderBottom: `1px solid ${colors.containerBorder}` }}>
          {document.saveError}
        </div>
      )}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {document.isPreview ? (
          <FileEditorPreview dir={projectKey} tabId={activeTabId ?? ''} activeFile={file} />
        ) : (
          <FileEditorCodeMirror
            dir={projectKey}
            activeFile={file}
            onSave={() => { void handleSave() }}
            onContentChange={(content) => updateScratch(projectKey, documentId, content)}
            showBlame={false}
            onCursorChange={setCursorPos}
            editorViewRef={editorViewRef}
            languageOverride={langOverride}
          />
        )}
      </div>
      {!document.isPreview && (
        <FileEditorStatusBar
          fileName={document.fileName}
          cursorPos={cursorPos}
          languageOverride={langOverride}
          onLanguageChange={setLangOverride}
          onGoToLine={handleGoToLine}
        />
      )}
    </div>
  )
}
