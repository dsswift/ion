// @vitest-environment jsdom
/**
 * ComposerEditor contract: a controlled plain-string editor whose reference
 * tokens draw as atomic chips, with key handling left to the owner.
 */
import React, { act, createRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { deleteCharBackward } from '@codemirror/commands'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))

import { ComposerEditor, type ComposerEditorHandle } from './ComposerEditor'
import { composerChipLabel, findComposerChipTokens } from './composer-chips'

describe('findComposerChipTokens', () => {
  it('finds file mentions and context tokens with their offsets', () => {
    const text = 'look at @desktop/src/foo.ts and @@terminal:2 then @@diff:server/a.ts.'
    const tokens = findComposerChipTokens(text)
    expect(tokens.map((t) => [t.kind, t.ref])).toEqual([
      ['file', 'desktop/src/foo.ts'],
      ['terminal', '2'],
      ['diff', 'server/a.ts.'],
    ])
    expect(text.slice(tokens[0].from, tokens[0].to)).toBe('@desktop/src/foo.ts')
  })

  it('leaves a person mention, an email, and a trailing sentence dot alone', () => {
    expect(findComposerChipTokens('ask @sam or mail me@example.com')).toEqual([])
    expect(findComposerChipTokens('see @README.md.')[0].raw).toBe('@README.md')
  })

  it('labels a chip by its file name', () => {
    expect(composerChipLabel({ kind: 'file', ref: 'desktop/src/foo.ts' })).toBe('foo.ts')
    expect(composerChipLabel({ kind: 'diff', ref: 'server/a.ts' })).toBe('Diff a.ts')
    expect(composerChipLabel({ kind: 'terminal', ref: '2' })).toBe('Terminal 2')
  })
})

describe('ComposerEditor', () => {
  let container: HTMLDivElement
  let root: Root
  const handle = createRef<ComposerEditorHandle>()
  const onKeyDown = vi.fn((_event: KeyboardEvent) => false)
  let lastValue = ''
  let setOuter: (v: string) => void = () => undefined
  /** When set, the owner answers every edit with this value instead. */
  let forceValue: string | null = null

  function Harness({ initial }: { initial: string }): React.JSX.Element {
    const [value, setValue] = useState(initial)
    const [, bump] = useState(0)
    lastValue = value
    setOuter = setValue
    return (
      <ComposerEditor
        ref={handle}
        value={value}
        onChange={(v) => { setValue(forceValue ?? v); bump((n) => n + 1) }}
        onKeyDown={onKeyDown}
        placeholder="Ask"
        minHeight={20}
        maxHeight={140}
      />
    )
  }

  function mount(initial = ''): EditorView {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root.render(<Harness initial={initial} />))
    return EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
  }

  afterEach(() => { act(() => root.unmount()); container.remove(); onKeyDown.mockClear(); forceValue = null })

  it('draws a file mention as one chip and deletes it as one unit', () => {
    const view = mount('see @desktop/src/foo.ts')
    const chip = container.querySelector('[data-composer-chip="file"]') as HTMLElement
    expect(chip.textContent).toBe('foo.ts')
    expect(chip.getAttribute('data-composer-chip-ref')).toBe('desktop/src/foo.ts')

    act(() => { view.dispatch({ selection: { anchor: view.state.doc.length } }); deleteCharBackward(view) })
    expect(lastValue).toBe('see ')
  })

  it('reports edits and accepts an outside value', () => {
    const view = mount('')
    act(() => handle.current!.insertAtCursor('hello'))
    expect(lastValue).toBe('hello')
    act(() => setOuter('restored draft'))
    expect(view.state.doc.toString()).toBe('restored draft')
  })

  it('returns to the owner value when the owner refuses an edit', () => {
    const view = mount('')
    forceValue = ''
    act(() => handle.current!.insertAtCursor('!'))
    expect(view.state.doc.toString()).toBe('')
  })

  it('hands keys to the owner first; an owner-handled Enter inserts nothing', () => {
    const view = mount('hi')
    onKeyDown.mockImplementation((e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); return true } return false })
    act(() => { view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    expect(onKeyDown).toHaveBeenCalledTimes(1)
    expect(view.state.doc.toString()).toBe('hi')
    act(() => { view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })) })
    expect(view.state.doc.lines).toBe(2)
  })

  it('reports whether the cursor is on the first line', () => {
    mount('one\ntwo')
    expect(handle.current!.cursor()).toMatchObject({ onFirstLine: false, onLastLine: true })
  })
})
