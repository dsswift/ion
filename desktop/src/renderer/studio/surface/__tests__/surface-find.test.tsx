// @vitest-environment jsdom
/**
 * Canvas find routing: Mod+F addressed to the canvas drives a code editor's
 * own search while one is editing, and the page-text find bar otherwise.
 */
import React, { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { search, searchPanelOpen } from '@codemirror/search'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../rendererLogger', () => ({ rDebug: vi.fn(), rWarn: vi.fn() }))
vi.mock('../../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000' }) }))
vi.mock('../../../components/git/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }))

const { SurfaceFindHost, useCodeMirrorFind } = await import('../surface-find')
const { dispatchPaneFind, paneFindTarget } = await import('../../find/pane-find')

let root: Root | null = null
let container: HTMLDivElement | null = null
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
})

function Editor({ view, editing }: { view: EditorView; editing: boolean }): React.JSX.Element {
  const ref = useRef<EditorView | null>(view)
  useCodeMirrorFind(ref, editing)
  return <p>page text needle</p>
}

function Harness({ view, editing }: { view: EditorView; editing: boolean }): React.JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null)
  return (
    <SurfaceFindHost bodyRef={bodyRef} activeTabId="tab-1">
      <div ref={bodyRef}><Editor view={view} editing={editing} /></div>
    </SurfaceFindHost>
  )
}

function render(editing: boolean): EditorView {
  const view = new EditorView({ state: EditorState.create({ doc: 'needle', extensions: [search()] }), parent: document.body })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<Harness view={view} editing={editing} />))
  return view
}

describe('canvas find', () => {
  it('opens the code editor search panel while a file is being edited', () => {
    const view = render(true)
    act(() => dispatchPaneFind('surface', 'open'))
    expect(searchPanelOpen(view.state)).toBe(true)
    expect(container!.querySelector('input[placeholder="Find…"]')).toBeNull()
    view.destroy()
  })

  it('opens the page-text find bar for a rendered view', () => {
    const view = render(false)
    act(() => dispatchPaneFind('surface', 'open'))
    expect(searchPanelOpen(view.state)).toBe(false)
    expect(container!.querySelector('input[placeholder="Find…"]')).not.toBeNull()
    view.destroy()
  })

  it('ignores requests addressed to the conversation', () => {
    const view = render(false)
    act(() => dispatchPaneFind('conversation', 'open'))
    expect(container!.querySelector('input[placeholder="Find…"]')).toBeNull()
    view.destroy()
  })
})

describe('paneFindTarget', () => {
  it('follows focus to the canvas only while the canvas is on screen', () => {
    expect(paneFindTarget('surface', true)).toBe('surface')
    expect(paneFindTarget('surface', false)).toBe('conversation')
    expect(paneFindTarget('conversation', true)).toBe('conversation')
  })
})
