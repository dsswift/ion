import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightSpecialChars } from '@codemirror/view'
import { EditorState, Extension } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { bracketMatching, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { oneDark } from '@codemirror/theme-one-dark'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { useSessionStore, FileEditorTab } from '../stores/sessionStore'
import { getLanguageExtension } from './FileEditorShared'

interface FileEditorCodeMirrorProps {
  dir: string
  activeFile: FileEditorTab
  onSave: () => void
}

/**
 * The CodeMirror editing surface. Lives only when a non-preview file is
 * active; preview rendering is handled by FileEditorPreview.
 */
export function FileEditorCodeMirror({ dir, activeFile, onSave }: FileEditorCodeMirrorProps) {
  const colors = useColors()
  const editorWordWrap = usePreferencesStore((s) => s.editorWordWrap)
  const updateEditorContent = useSessionStore((s) => s.updateEditorContent)

  const editorContainerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const activeFileIdRef = useRef<string | null>(null)

  // Keep save handler ref current for CodeMirror keybinding
  const saveHandlerRef = useRef(onSave)
  saveHandlerRef.current = onSave

  // ---- CodeMirror theme ----
  const ionTheme = useMemo(() => EditorView.theme({
    '&': {
      backgroundColor: colors.containerBg,
      color: colors.textPrimary,
      fontSize: '12px',
      fontFamily: 'monospace',
      height: '100%',
    },
    '.cm-scroller': {
      overflow: 'auto',
    },
    '.cm-content': {
      caretColor: colors.accent,
    },
    '&.cm-focused .cm-cursor': {
      borderLeftColor: colors.accent,
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: `${colors.surfaceActive} !important`,
    },
    '.cm-gutters': {
      backgroundColor: colors.surfacePrimary,
      color: colors.textTertiary,
      borderRight: `1px solid ${colors.containerBorder}`,
    },
    '.cm-activeLineGutter': {
      backgroundColor: colors.surfaceSecondary,
    },
    '.cm-activeLine': {
      backgroundColor: colors.surfaceHover,
    },
  }), [colors])

  // ---- Build extensions for active file ----
  const buildExtensions = useCallback((file: FileEditorTab): Extension[] => {
    const exts: Extension[] = [
      oneDark,
      ionTheme,
      lineNumbers(),
      highlightActiveLine(),
      highlightSpecialChars(),
      bracketMatching(),
      highlightSelectionMatches(),
      history(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        {
          key: 'Mod-s',
          run: () => {
            saveHandlerRef.current()
            return true
          },
        },
      ]),
    ]

    if (editorWordWrap) exts.push(EditorView.lineWrapping)

    const langExt = getLanguageExtension(file.fileName)
    if (langExt) exts.push(langExt)

    if (file.isReadOnly) {
      exts.push(EditorState.readOnly.of(true))
      exts.push(EditorView.editable.of(false))
    }

    // Update content on change (non-readOnly)
    if (!file.isReadOnly) {
      exts.push(EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const newContent = update.state.doc.toString()
          updateEditorContent(dir, file.id, newContent)
        }
      }))
    }

    return exts
  }, [ionTheme, dir, updateEditorContent, editorWordWrap])

  // ---- CodeMirror lifecycle ----
  useEffect(() => {
    if (!editorContainerRef.current) {
      if (viewRef.current) {
        viewRef.current.destroy()
        viewRef.current = null
        activeFileIdRef.current = null
      }
      return
    }

    const container = editorContainerRef.current
    const stateKey = `${activeFile.id}:${activeFile.isReadOnly}:${editorWordWrap}`

    // If same file with same config, skip recreation
    if (viewRef.current && activeFileIdRef.current === stateKey) {
      return
    }

    // Destroy previous view
    if (viewRef.current) {
      viewRef.current.destroy()
      viewRef.current = null
    }

    const state = EditorState.create({
      doc: activeFile.content,
      extensions: buildExtensions(activeFile),
    })

    const view = new EditorView({ state, parent: container })
    viewRef.current = view
    activeFileIdRef.current = stateKey

    return () => {
      // Only destroy if switching away or unmounting
      // The next effect run will handle re-creation
    }
  }, [activeFile.id, activeFile.isReadOnly, buildExtensions, editorWordWrap])

  // Sync external content changes into the editor (e.g., after file load)
  useEffect(() => {
    if (!viewRef.current) return
    const stateKey = `${activeFile.id}:${activeFile.isReadOnly}:${editorWordWrap}`
    if (activeFileIdRef.current !== stateKey) return

    const currentDoc = viewRef.current.state.doc.toString()
    if (currentDoc !== activeFile.content) {
      viewRef.current.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: activeFile.content },
      })
    }
  }, [activeFile.content, activeFile.id, activeFile.isReadOnly, editorWordWrap])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (viewRef.current) {
        viewRef.current.destroy()
        viewRef.current = null
      }
    }
  }, [])

  return (
    <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
      <div
        ref={editorContainerRef}
        style={{ position: 'absolute', inset: 0 }}
      />
      {activeFile.isReadOnly && (
        <div
          style={{
            position: 'absolute',
            top: 6,
            right: 12,
            fontSize: 9,
            fontFamily: 'monospace',
            color: colors.textTertiary,
            background: colors.surfacePrimary,
            padding: '1px 6px',
            borderRadius: 3,
            opacity: 0.7,
            pointerEvents: 'none',
          }}
        >
          READ-ONLY
        </div>
      )}
    </div>
  )
}
