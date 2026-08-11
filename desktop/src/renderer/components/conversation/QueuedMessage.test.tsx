// @vitest-environment jsdom
/**
 * A queued message must look like the message it is about to become.
 *
 * It previously rendered raw `content` in a plain div with no `white-space`
 * rule, so a multi-line paste displayed as one reflowed line while queued and
 * then visibly re-flowed the moment the turn flushed and the identical string
 * came back through markdown. Both bubbles now render through UserMarkdown.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueuedMessage } from './QueuedMessage'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
  ;(globalThis as any).window = globalThis
  ;(globalThis as any).window.ion = {
    readImageDataUrl: () => Promise.resolve({ dataUrl: null }),
    openExternal: () => {},
  }
  ;(globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

let container: HTMLDivElement | null = null
let root: Root | null = null

function render(content: string): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(React.createElement(QueuedMessage, { content }))
  })
  return container
}

afterEach(() => {
  act(() => { root?.unmount() })
  root = null
  container?.remove()
  container = null
})

describe('QueuedMessage — verbatim whitespace', () => {
  // NOTE on what these assert: `textContent` keeps newlines even for raw text in
  // a plain div, because it is not sensitive to CSS collapsing. So asserting the
  // text alone would pass on the unfixed code — false coverage. Each case
  // therefore asserts the text is inside an element that OWNS `pre-wrap`, which
  // is what actually makes it render as typed.
  function verbatimParagraph(el: HTMLElement): HTMLElement {
    const p = [...el.querySelectorAll('p')].find(
      (n) => (n as HTMLElement).style.whiteSpace === 'pre-wrap',
    ) as HTMLElement | undefined
    expect(p, 'no paragraph carrying white-space: pre-wrap').toBeTruthy()
    return p!
  }

  it('keeps the newlines of a multi-line queued message, in a pre-wrap element', () => {
    const el = render('line one\nline two')
    expect(verbatimParagraph(el).textContent).toContain('line one\nline two')
  })

  it('keeps continuation-line indentation, in a pre-wrap element', () => {
    const el = render('trace:\n      at frame one')
    expect(verbatimParagraph(el).textContent).toContain('trace:\n      at frame one')
  })

  it('renders markdown, so a fenced block is a code block', () => {
    const el = render('```sh\necho hi\n```\n')
    expect(el.querySelector('pre')).not.toBeNull()
  })
})

describe('QueuedMessage — slash pill', () => {
  it('still renders a slash invocation as a pill, not markdown', () => {
    const el = render('/align some args')
    // The pill branch is unchanged: the command renders in its own monospace
    // chip, so there is no markdown paragraph for the body.
    expect(el.textContent).toContain('/align')
    expect(el.textContent).toContain('some args')
    expect(el.querySelector('p')).toBeNull()
  })
})
