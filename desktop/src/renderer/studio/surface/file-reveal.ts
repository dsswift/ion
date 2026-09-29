/**
 * File reveal — "open this file with this text selected", as asked by a
 * Workspace Search result. The surface store holds the pending request; the
 * file tab applies it once its buffer has loaded and its editor exists.
 */
import { EditorView } from '@codemirror/view'

export interface FileRevealTarget {
  /** 1-based line. */
  line: number
  /** 1-based column of the first character to select. */
  column: number
  /** Characters to select; 0 places a caret. */
  length: number
}

export interface FileReveal extends FileRevealTarget {
  filePath: string
  nonce: number
}

/**
 * Select `target` in `view`, centre it, and focus the editor. A target past
 * the end of a file that changed since the search is clamped to the document.
 */
export function applyFileReveal(view: EditorView, target: FileRevealTarget): void {
  const doc = view.state.doc
  const line = doc.line(Math.max(1, Math.min(target.line, doc.lines)))
  const from = Math.min(line.from + Math.max(0, target.column - 1), line.to)
  const to = Math.min(from + Math.max(0, target.length), line.to)
  view.dispatch({
    selection: { anchor: from, head: to },
    effects: EditorView.scrollIntoView(from, { y: 'center' }),
  })
  view.focus()
}
