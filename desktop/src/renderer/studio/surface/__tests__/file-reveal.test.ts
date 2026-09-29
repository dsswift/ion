// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { applyFileReveal } from '../file-reveal'

let view: EditorView | null = null
afterEach(() => { view?.destroy(); view = null })

function editor(doc: string): EditorView {
  view = new EditorView({ state: EditorState.create({ doc }), parent: document.body })
  return view
}

describe('applyFileReveal', () => {
  it('selects exactly the match on the requested line', () => {
    const v = editor('first\n  principal_id = var.cloudops_grafana_principal_id\nlast')
    applyFileReveal(v, { line: 2, column: 22, length: 29 })
    const { from, to } = v.state.selection.main
    expect(v.state.sliceDoc(from, to)).toBe('cloudops_grafana_principal_id')
  })

  it('clamps a target past the end of a file that shrank since the search', () => {
    const v = editor('one\ntwo')
    applyFileReveal(v, { line: 40, column: 90, length: 5 })
    expect(v.state.selection.main.head).toBe(v.state.doc.length)
  })
})
