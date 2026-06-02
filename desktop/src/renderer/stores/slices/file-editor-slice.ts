import { usePreferencesStore } from '../../preferences'
import type { StoreSet, StoreGet, State, FileEditorTab } from '../session-store-types'
import { editorDirForTab, isEditableByDefault, nextEditorFileId, nextUntitledName } from '../session-store-helpers'

export function createFileEditorSlice(set: StoreSet, _get: StoreGet): Partial<State> {
  return {
    toggleFileEditor: (tabId) => {
      set((s) => {
        const tab = s.tabs.find((t) => t.id === tabId)
        if (!tab) {
          console.log('[FileEditor] toggleFileEditor: tab not found', { tabId })
          return {}
        }
        const dir = editorDirForTab(tab)
        const next = new Set(s.fileEditorOpenDirs)
        if (next.has(dir)) {
          console.log('[FileEditor] toggleFileEditor: closing', { dir, tabId })
          next.delete(dir)
          return { fileEditorOpenDirs: next }
        }
        next.add(dir)
        console.log('[FileEditor] toggleFileEditor: opening', { dir, tabId })
        set({ fileEditorFocused: true })
        const current = s.fileEditorStates.get(dir)
        if (!current || current.files.length === 0) {
          const states = new Map(s.fileEditorStates)
          const id = nextEditorFileId()
          const newFile: FileEditorTab = {
            id,
            filePath: null,
            fileName: nextUntitledName(s.fileEditorStates),
            content: '',
            savedContent: '',
            isDirty: false,
            isReadOnly: false,
            isPreview: false,
          }
          states.set(dir, { activeFileId: id, files: [newFile] })
          return { fileEditorOpenDirs: next, fileEditorStates: states }
        }
        return { fileEditorOpenDirs: next }
      })
    },

    focusFileEditor: () => set({ fileEditorFocused: true }),
    blurFileEditor: () => set({ fileEditorFocused: false }),

    openFileInEditor: (dir, _tabId, filePath, opts) => {
      const { closeExplorerOnFileOpen, openMarkdownInPreview } = usePreferencesStore.getState()
      set((s) => {
        // Resolve the canonical editor dir: if a tab's worktree repoPath
        // differs from its workingDirectory, callers may pass either one.
        // Normalize to editorDirForTab so the key matches what App.tsx checks.
        const tab = s.tabs.find((t) => t.id === _tabId)
        const resolvedDir = tab ? editorDirForTab(tab) : dir
        console.log('[FileEditor] openFileInEditor', { callerDir: dir, resolvedDir, filePath })
        const states = new Map(s.fileEditorStates)
        const current = states.get(resolvedDir) || { activeFileId: null, files: [] }
        const existing = current.files.find((f) => f.filePath === filePath)
        if (existing) {
          console.log('[FileEditor] file already open, activating', { fileId: existing.id })
          states.set(resolvedDir, { ...current, activeFileId: existing.id })
        } else {
          const fileName = filePath.split('/').pop() || filePath
          const ext = fileName.includes('.') ? '.' + fileName.split('.').pop()!.toLowerCase() : ''
          const isMd = ext === '.md'
          const id = nextEditorFileId()
          const newFile: FileEditorTab = {
            id,
            filePath,
            fileName,
            content: '',
            savedContent: '',
            isDirty: false,
            isReadOnly: !isEditableByDefault(fileName),
            isPreview: isMd && openMarkdownInPreview,
          }
          console.log('[FileEditor] creating new file tab', { id, fileName, isReadOnly: newFile.isReadOnly, isPreview: newFile.isPreview })
          if (opts?.insertAfterActive) {
            const activeIdx = current.files.findIndex(f => f.id === current.activeFileId)
            const files = [...current.files]
            files.splice(activeIdx + 1, 0, newFile)
            states.set(resolvedDir, { activeFileId: id, files })
          } else {
            states.set(resolvedDir, { activeFileId: id, files: [...current.files, newFile] })
          }
        }
        const editorOpen = new Set(s.fileEditorOpenDirs)
        editorOpen.add(resolvedDir)
        console.log('[FileEditor] fileEditorOpenDirs after add', [...editorOpen])
        const result: Record<string, any> = { fileEditorStates: states, fileEditorOpenDirs: editorOpen }
        if (closeExplorerOnFileOpen) {
          // Explorer uses workingDirectory as its key, so delete by caller's dir
          const explorerIds = new Set(s.fileExplorerOpenDirs)
          explorerIds.delete(dir)
          result.fileExplorerOpenDirs = explorerIds
          console.log('[FileEditor] closing explorer for dir', dir)
        }
        return result
      })
    },

    closeFileEditorTab: (dir, fileId) => {
      console.log('[FileEditor] closeFileEditorTab', { dir, fileId })
      set((s) => {
        const states = new Map(s.fileEditorStates)
        const current = states.get(dir)
        if (!current) return {}
        const files = current.files.filter((f) => f.id !== fileId)
        let activeFileId = current.activeFileId
        if (activeFileId === fileId) {
          activeFileId = files.length > 0 ? files[files.length - 1].id : null
        }
        states.set(dir, { activeFileId, files })
        if (files.length === 0) {
          const editorOpen = new Set(s.fileEditorOpenDirs)
          editorOpen.delete(dir)
          return { fileEditorStates: states, fileEditorOpenDirs: editorOpen }
        }
        return { fileEditorStates: states }
      })
    },

    setActiveEditorFile: (dir, fileId) => {
      set((s) => {
        const states = new Map(s.fileEditorStates)
        const current = states.get(dir)
        if (!current) return {}
        states.set(dir, { ...current, activeFileId: fileId })
        return { fileEditorStates: states }
      })
    },

    createScratchFile: (dir) => {
      set((s) => {
        const states = new Map(s.fileEditorStates)
        const current = states.get(dir) || { activeFileId: null, files: [] }
        const id = nextEditorFileId()
        const newFile: FileEditorTab = {
          id,
          filePath: null,
          fileName: nextUntitledName(s.fileEditorStates),
          content: '',
          savedContent: '',
          isDirty: false,
          isReadOnly: false,
          isPreview: false,
        }
        states.set(dir, { activeFileId: id, files: [...current.files, newFile] })
        return { fileEditorStates: states }
      })
    },

    updateEditorContent: (dir, fileId, content) => {
      set((s) => {
        const states = new Map(s.fileEditorStates)
        const current = states.get(dir)
        if (!current) return {}
        states.set(dir, {
          ...current,
          files: current.files.map((f) =>
            f.id === fileId ? { ...f, content, isDirty: content !== f.savedContent } : f
          ),
        })
        return { fileEditorStates: states }
      })
    },

    markEditorSaved: (dir, fileId, filePath) => {
      set((s) => {
        const states = new Map(s.fileEditorStates)
        const current = states.get(dir)
        if (!current) return {}
        states.set(dir, {
          ...current,
          files: current.files.map((f) =>
            f.id === fileId
              ? { ...f, filePath, fileName: filePath.split('/').pop() || filePath, savedContent: f.content, isDirty: false }
              : f
          ),
        })
        return { fileEditorStates: states }
      })
    },

    reorderEditorFiles: (dir, reordered) => {
      set((s) => {
        const states = new Map(s.fileEditorStates)
        const current = states.get(dir)
        if (!current) return {}
        states.set(dir, { ...current, files: reordered })
        return { fileEditorStates: states }
      })
    },

    toggleEditorPreview: (dir, fileId) => {
      set((s) => {
        const states = new Map(s.fileEditorStates)
        const current = states.get(dir)
        if (!current) return {}
        states.set(dir, {
          ...current,
          files: current.files.map((f) =>
            f.id === fileId ? { ...f, isPreview: !f.isPreview } : f
          ),
        })
        return { fileEditorStates: states }
      })
    },

    toggleEditorReadOnly: (dir, fileId) => {
      set((s) => {
        const states = new Map(s.fileEditorStates)
        const current = states.get(dir)
        if (!current) return {}
        states.set(dir, {
          ...current,
          files: current.files.map((f) =>
            f.id === fileId ? { ...f, isReadOnly: !f.isReadOnly } : f
          ),
        })
        return { fileEditorStates: states }
      })
    },

    setEditorGeometry: (geo) => set({ editorGeometry: geo }),
    setPlanGeometry: (geo) => set({ planGeometry: geo }),
    setAgentDetailGeometry: (geo) => set({ agentDetailGeometry: geo }),
  }
}
