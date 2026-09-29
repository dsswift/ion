/**
 * ComposerEditor — the prompt text surface, a CodeMirror 6 view dressed as a
 * plain text field (no gutters, UI font, wrapping lines).
 *
 * It is a controlled component over a plain string: the owner holds `value`,
 * every edit reports the new string through `onChange`, and an outside change
 * to `value` (draft restore, rewind, voice transcript, clear-after-send) is
 * written back into the view. Key and paste handling stay with the owner —
 * this component only forwards the DOM events — so the send, slash-menu, and
 * bash-mode rules live in one place.
 */
import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { EditorView, keymap, placeholder as placeholderExtension } from '@codemirror/view'
import { Compartment, EditorState } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { useColors } from '../../theme'
import { composerChips } from './composer-chips'

export interface ComposerEditorHandle {
  focus: () => void
  getValue: () => string
  setValue: (text: string) => void
  /** Replaces the selection (or inserts at the cursor) and moves past it. */
  insertAtCursor: (text: string) => void
  /** Replaces `[from, to)` with `text` and puts the cursor after it. */
  replaceRange: (from: number, to: number, text: string) => void
  /** Cursor offset, and whether it sits on the first / last line. */
  cursor: () => { offset: number; onFirstLine: boolean; onLastLine: boolean }
}

export interface ComposerEditorProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
  minHeight: number
  maxHeight: number
  /** Return true to mark the key handled (CodeMirror then does nothing). */
  onKeyDown?: (event: KeyboardEvent) => boolean
  /** Return true to mark the paste handled. */
  onPaste?: (event: ClipboardEvent) => boolean
  /** Fires after the cursor or text moves; reports the cursor offset. */
  onCursorActivity?: (offset: number) => void
}

export const ComposerEditor = forwardRef<ComposerEditorHandle, ComposerEditorProps>(function ComposerEditor(
  { value, onChange, placeholder, minHeight, maxHeight, onKeyDown, onPaste, onCursorActivity },
  ref,
) {
  const colors = useColors()
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Latest callbacks, read by extensions created once at mount.
  const callbacks = useRef({ onChange, onKeyDown, onPaste, onCursorActivity })
  callbacks.current = { onChange, onKeyDown, onPaste, onCursorActivity }
  const themeCompartment = useMemo(() => new Compartment(), [])
  const placeholderCompartment = useMemo(() => new Compartment(), [])

  const theme = useMemo(() => EditorView.theme({
    '&': { backgroundColor: 'transparent', color: colors.textPrimary, fontSize: '14px' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: 'inherit',
      lineHeight: '20px',
      maxHeight: `${maxHeight}px`,
      overflowY: 'auto',
      scrollbarWidth: 'thin',
    },
    '.cm-content': { padding: '12px 0 4px', minHeight: `${minHeight}px`, caretColor: colors.textPrimary },
    '.cm-line': { padding: '0' },
    '.cm-cursor': { borderLeftColor: colors.textPrimary },
    '.cm-placeholder': { color: colors.textTertiary },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: colors.accentLight },
    '.ion-composer-chip': {
      display: 'inline-block',
      padding: '0 6px',
      margin: '0 1px',
      borderRadius: '6px',
      fontSize: '12px',
      lineHeight: '18px',
      color: colors.accent,
      backgroundColor: colors.accentLight,
      border: `1px solid ${colors.containerBorder}`,
      cursor: 'default',
    },
  }), [colors, minHeight, maxHeight])

  // Mount once. Everything that changes later goes through a compartment or
  // the `callbacks` ref, so the view (and its undo history) survives renders.
  useEffect(() => {
    if (!hostRef.current) return
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        // A restored draft is continued, so the cursor starts at its end.
        selection: { anchor: value.length },
        extensions: [
          history(),
          EditorView.lineWrapping,
          composerChips(),
          themeCompartment.of(theme),
          placeholderCompartment.of(placeholderExtension(placeholder)),
          EditorView.contentAttributes.of({ 'aria-label': 'Prompt', 'data-testid': 'composer-editor-content' }),
          // Owner handlers run first; an unhandled key falls to the keymaps.
          EditorView.domEventHandlers({
            keydown: (event) => callbacks.current.onKeyDown?.(event) ?? false,
            paste: (event) => callbacks.current.onPaste?.(event) ?? false,
          }),
          keymap.of([...historyKeymap, ...defaultKeymap]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString())
            if (update.docChanged || update.selectionSet) {
              callbacks.current.onCursorActivity?.(update.state.selection.main.head)
            }
          }),
        ],
      }),
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once: later changes flow through compartments and the callbacks ref
  }, [])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeCompartment.reconfigure(theme) })
  }, [theme, themeCompartment])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: placeholderCompartment.reconfigure(placeholderExtension(placeholder)) })
  }, [placeholder, placeholderCompartment])

  // The owner's `value` is the truth. This runs after every render, not only
  // when `value` changes: the owner may answer an edit by keeping its value
  // the same (typing `!` enters bash mode and leaves the text empty), and the
  // document must still be brought back in line. An edit the view itself
  // reported arrives here already equal, so the common case is one compare.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: { anchor: value.length },
    })
  })

  useImperativeHandle(ref, () => ({
    focus: () => viewRef.current?.focus(),
    getValue: () => viewRef.current?.state.doc.toString() ?? '',
    setValue: (text) => {
      const view = viewRef.current
      if (!view) return
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: text.length } })
    },
    insertAtCursor: (text) => {
      const view = viewRef.current
      if (!view) return
      view.dispatch(view.state.replaceSelection(text))
    },
    replaceRange: (from, to, text) => {
      const view = viewRef.current
      if (!view) return
      view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } })
    },
    cursor: () => {
      const state = viewRef.current?.state
      if (!state) return { offset: 0, onFirstLine: true, onLastLine: true }
      const offset = state.selection.main.head
      const line = state.doc.lineAt(offset).number
      return { offset, onFirstLine: line === 1, onLastLine: line === state.doc.lines }
    },
  }), [])

  return <div ref={hostRef} data-testid="composer-editor" className="w-full" style={{ minWidth: 0 }} />
})
