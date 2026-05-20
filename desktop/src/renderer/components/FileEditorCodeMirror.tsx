import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightSpecialChars,
  highlightActiveLineGutter, scrollPastEnd, dropCursor, rectangularSelection, crosshairCursor,
} from '@codemirror/view'
import { EditorState, Extension } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from '@codemirror/commands'
import { bracketMatching, syntaxHighlighting, defaultHighlightStyle, indentOnInput } from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches, search, selectNextOccurrence, gotoLine } from '@codemirror/search'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { oneDark } from '@codemirror/theme-one-dark'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { useSessionStore, FileEditorTab } from '../stores/sessionStore'
import { getLanguageExtension, getLanguageExtensionById } from './FileEditorShared'
import { blameExtension, dispatchBlame, clearBlame } from './git/blameGutter'
import { FileEditorContextMenu } from './FileEditorContextMenu'

export interface CursorPosition {
  line: number
  col: number
}

interface FileEditorCodeMirrorProps {
  dir: string
  activeFile: FileEditorTab
  onSave: () => void
  onCursorChange?: (pos: CursorPosition) => void
  editorViewRef?: React.MutableRefObject<EditorView | null>
  languageOverride?: string | null
}

/**
 * The CodeMirror editing surface. Lives only when a non-preview file is
 * active; preview rendering is handled by FileEditorPreview.
 */
export function FileEditorCodeMirror({ dir, activeFile, onSave, onCursorChange, editorViewRef, languageOverride }: FileEditorCodeMirrorProps) {
  console.log('[FileEditorCodeMirror] render', { dir, fileId: activeFile.id, fileName: activeFile.fileName, isReadOnly: activeFile.isReadOnly, contentLen: activeFile.content.length })
  const colors = useColors()
  const editorWordWrap = usePreferencesStore((s) => s.editorWordWrap)
  const editorFontSize = usePreferencesStore((s) => s.editorFontSize)
  const updateEditorContent = useSessionStore((s) => s.updateEditorContent)

  const editorContainerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const activeFileIdRef = useRef<string | null>(null)
  const cursorCbRef = useRef(onCursorChange)
  cursorCbRef.current = onCursorChange
  const setEditorFontSize = usePreferencesStore((s) => s.setEditorFontSize)

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)

  // Keep save handler ref current for CodeMirror keybinding
  const saveHandlerRef = useRef(onSave)
  saveHandlerRef.current = onSave

  const [blameActive, setBlameActive] = useState(false)

  // Toggle blame
  const handleToggleBlame = useCallback(async () => {
    if (!viewRef.current) return
    if (blameActive) {
      clearBlame(viewRef.current)
      setBlameActive(false)
    } else {
      const result = await window.ion.gitBlame(dir, activeFile.filePath || activeFile.fileName)
      if (result.ok && result.lines.length > 0 && viewRef.current) {
        dispatchBlame(viewRef.current, result.lines)
        setBlameActive(true)
      }
    }
  }, [blameActive, dir, activeFile])

  // ---- CodeMirror theme ----
  const ionTheme = useMemo(() => EditorView.theme({
    '&': {
      backgroundColor: colors.containerBg,
      color: colors.textPrimary,
      fontSize: `${editorFontSize}px`,
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
  }), [colors, editorFontSize])

  // ---- Build extensions for active file ----
  const buildExtensions = useCallback((file: FileEditorTab): Extension[] => {
    const exts: Extension[] = [
      oneDark,
      ionTheme,
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      bracketMatching(),
      closeBrackets(),
      highlightSelectionMatches(),
      history(),
      indentOnInput(),
      search(),
      dropCursor(),
      rectangularSelection(),
      crosshairCursor(),
      scrollPastEnd(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
        { key: 'Mod-/', run: toggleComment },
        { key: 'Mod-d', run: selectNextOccurrence, preventDefault: true },
        { key: 'Mod-g', run: gotoLine },
        {
          key: 'Mod-s',
          run: () => {
            saveHandlerRef.current()
            return true
          },
        },
        {
          key: 'Mod-=',
          run: () => {
            setEditorFontSize(usePreferencesStore.getState().editorFontSize + 1)
            return true
          },
        },
        {
          key: 'Mod--',
          run: () => {
            setEditorFontSize(usePreferencesStore.getState().editorFontSize - 1)
            return true
          },
        },
      ]),
    ]

    if (editorWordWrap) exts.push(EditorView.lineWrapping)

    const langExt = languageOverride
      ? getLanguageExtensionById(languageOverride)
      : getLanguageExtension(file.fileName)
    if (langExt) exts.push(langExt)

    if (file.isReadOnly) {
      exts.push(EditorState.readOnly.of(true))
      exts.push(EditorView.editable.of(false))
    }

    exts.push(blameExtension())

    // Track cursor position for status bar
    exts.push(EditorView.updateListener.of((update) => {
      if (update.selectionSet || update.docChanged) {
        const pos = update.state.selection.main.head
        const line = update.state.doc.lineAt(pos)
        cursorCbRef.current?.({ line: line.number, col: pos - line.from + 1 })
      }
    }))

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
  }, [ionTheme, dir, updateEditorContent, editorWordWrap, editorFontSize, languageOverride])

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
    const stateKey = `${activeFile.id}:${activeFile.isReadOnly}:${editorWordWrap}:${editorFontSize}:${languageOverride ?? ''}`

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
    if (editorViewRef) editorViewRef.current = view
    activeFileIdRef.current = stateKey

    // Fire initial cursor position
    const pos = view.state.selection.main.head
    const line = view.state.doc.lineAt(pos)
    cursorCbRef.current?.({ line: line.number, col: pos - line.from + 1 })

    return () => {
      // Only destroy if switching away or unmounting
      // The next effect run will handle re-creation
    }
  }, [activeFile.id, activeFile.isReadOnly, buildExtensions, editorWordWrap, editorFontSize, languageOverride])

  // Sync external content changes into the editor (e.g., after file load)
  useEffect(() => {
    if (!viewRef.current) return
    const stateKey = `${activeFile.id}:${activeFile.isReadOnly}:${editorWordWrap}:${editorFontSize}:${languageOverride ?? ''}`
    if (activeFileIdRef.current !== stateKey) return

    const currentDoc = viewRef.current.state.doc.toString()
    if (currentDoc !== activeFile.content) {
      viewRef.current.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: activeFile.content },
      })
    }
  }, [activeFile.content, activeFile.id, activeFile.isReadOnly, editorWordWrap, editorFontSize, languageOverride])

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
        onContextMenu={(e) => {
          e.preventDefault()
          setCtxMenu({ x: e.clientX, y: e.clientY })
        }}
      />
      {ctxMenu && (
        <FileEditorContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          isReadOnly={activeFile.isReadOnly}
          viewRef={viewRef}
          onClose={() => setCtxMenu(null)}
        />
      )}
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
      <button
        onClick={handleToggleBlame}
        style={{
          position: 'absolute',
          top: 6,
          right: activeFile.isReadOnly ? 80 : 12,
          fontSize: 9,
          fontFamily: 'monospace',
          color: blameActive ? colors.accent : colors.textTertiary,
          background: colors.surfacePrimary,
          padding: '1px 6px',
          borderRadius: 3,
          cursor: 'pointer',
          border: 'none',
          opacity: 0.8,
        }}
        title={blameActive ? 'Hide blame' : 'Show blame'}
      >
        BLAME
      </button>
    </div>
  )
}
