import { useCallback, useEffect } from 'react'
import { useSessionStore, FileEditorTab } from '../stores/sessionStore'
import { rDebug, rWarn, rError } from '../rendererLogger'

interface UseFileEditorContentParams {
  dir: string
  activeFile: FileEditorTab | null
}

interface UseFileEditorContentResult {
  handleSave: () => Promise<void>
}

/**
 * Loads the active file from disk, watches it for external changes, and
 * provides a save handler. All state mutations go through the session store.
 */
export function useFileEditorContent({
  dir,
  activeFile,
}: UseFileEditorContentParams): UseFileEditorContentResult {
  const markEditorSaved = useSessionStore((s) => s.markEditorSaved)

  // ---- File loading ----
  useEffect(() => {
    if (!activeFile) {
      rDebug('file-editor', 'no active file, skipping load')
      return
    }
    if (activeFile.filePath && activeFile.content === '' && activeFile.savedContent === '') {
      // Initial load for newly opened files
      rDebug('file-editor', 'initial load', { file_id: activeFile.id, path: activeFile.filePath })
      window.ion.fsReadFile(activeFile.filePath).then((result) => {
        rDebug('file-editor', 'fsReadFile result', { path: activeFile.filePath, has_content: result.content !== null, content_len: result.content?.length })
        if (result.content !== null) {
          // Set both content and savedContent so isDirty starts false
          useSessionStore.setState((s) => {
            const states = new Map(s.fileEditorStates)
            const current = states.get(dir)
            if (!current) return {}
            states.set(dir, {
              ...current,
              files: current.files.map((f) =>
                f.id === activeFile.id
                  ? { ...f, content: result.content!, savedContent: result.content!, isDirty: false, readError: undefined }
                  : f
              ),
            })
            return { fileEditorStates: states }
          })
        } else {
          // The file no longer exists or is unreadable. Surface an explicit
          // error state instead of a silent blank buffer — restored non-dirty
          // files reload through this path (their content is not persisted),
          // so a blank here would look like an empty file the user might save
          // over the real one. Read-only blocks that.
          rWarn('file-editor', 'initial load failed, marking read error', { path: activeFile.filePath })
          useSessionStore.setState((s) => {
            const states = new Map(s.fileEditorStates)
            const current = states.get(dir)
            if (!current) return {}
            states.set(dir, {
              ...current,
              files: current.files.map((f) =>
                f.id === activeFile.id
                  ? { ...f, isReadOnly: true, readError: `Could not read ${activeFile.filePath}` }
                  : f
              ),
            })
            return { fileEditorStates: states }
          })
        }
      }).catch((err) => rError('file-editor', 'initial file load failed', { path: activeFile.filePath, error: String(err) }))
    } else if (activeFile.filePath && !activeFile.isDirty && activeFile.content !== '') {
      // Background tab refresh: re-read from disk when switching to a non-dirty file
      window.ion.fsReadFile(activeFile.filePath).then((result) => {
        if (result.content !== null && result.content !== activeFile.savedContent) {
          useSessionStore.setState((s) => {
            const states = new Map(s.fileEditorStates)
            const current = states.get(dir)
            if (!current) return {}
            states.set(dir, {
              ...current,
              files: current.files.map((f) =>
                f.id === activeFile.id
                  ? { ...f, content: result.content!, savedContent: result.content!, isDirty: false }
                  : f
              ),
            })
            return { fileEditorStates: states }
          })
        }
      }).catch((err) => rDebug('file-editor', 'background refresh read failed', { path: activeFile.filePath, error: String(err) }))
    }
  }, [activeFile, activeFile?.id, activeFile?.filePath, dir])

  // ---- File watcher: auto-reload on disk changes ----
  useEffect(() => {
    if (!activeFile?.filePath) return
    const filePath = activeFile.filePath

    window.ion.fsWatchFile(filePath).catch((err) => rWarn('file-editor', 'fsWatchFile failed; external changes will not auto-reload', { path: filePath, error: String(err) }))

    const unsub = window.ion.onFileChanged((changedPath) => {
      if (changedPath !== filePath) return
      // Read fresh isDirty from store to avoid stale closure
      const state = useSessionStore.getState()
      const edState = state.fileEditorStates.get(dir)
      const file = edState?.files.find((f) => f.id === activeFile.id)
      if (!file || file.isDirty) return

      window.ion.fsReadFile(filePath).then((result) => {
        if (result.content === null) return
        // Re-read current state to get latest savedContent
        const freshState = useSessionStore.getState()
        const freshEdState = freshState.fileEditorStates.get(dir)
        const freshFile = freshEdState?.files.find((f) => f.id === activeFile.id)
        if (!freshFile || freshFile.isDirty || result.content === freshFile.savedContent) return

        useSessionStore.setState((s) => {
          const states = new Map(s.fileEditorStates)
          const current = states.get(dir)
          if (!current) return {}
          states.set(dir, {
            ...current,
            files: current.files.map((f) =>
              f.id === activeFile.id
                ? { ...f, content: result.content!, savedContent: result.content!, isDirty: false }
                : f
            ),
          })
          return { fileEditorStates: states }
        })
      }).catch((err) => rWarn('file-editor', 'watcher re-read failed', { path: filePath, error: String(err) }))
    })

    return () => {
      unsub()
      window.ion.fsUnwatchFile(filePath).catch((err) => rDebug('file-editor', 'fsUnwatchFile failed', { path: filePath, error: String(err) }))
    }
  }, [activeFile?.filePath, activeFile?.id, dir])

  // ---- Save handler ----
  const handleSave = useCallback(async () => {
    if (!activeFile || activeFile.isReadOnly) return
    if (activeFile.filePath) {
      const result = await window.ion.fsWriteFile(activeFile.filePath, activeFile.content)
      if (result.ok) {
        markEditorSaved(dir, activeFile.id, activeFile.filePath)
      }
    } else {
      const dialog = await window.ion.fsSaveDialog()
      if (dialog.filePath) {
        const result = await window.ion.fsWriteFile(dialog.filePath, activeFile.content)
        if (result.ok) {
          markEditorSaved(dir, activeFile.id, dialog.filePath)
        }
      }
    }
  }, [activeFile, dir, markEditorSaved])

  return { handleSave }
}
