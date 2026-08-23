// @vitest-environment jsdom
//
// Tests for navigable (cmd-clickable) file paths and URLs in rendered markdown.
//
// The load-bearing case is `remarkNavigableLinks` end-to-end through
// react-markdown: a `text` entry in react-markdown's `components` map is never
// invoked, so the earlier `text: NavigableText` wiring was dead and cmd-click
// did nothing in any prose. Link detection now runs as a remark plugin that
// emits real `link` nodes, which the `a` override renders.
//
// The remaining cases pin the render-cost fix that came before it: segmentText
// is hoisted into an unconditional useMemo inside NavigableCode (so the
// link-regex does not re-run for unchanged text), and NavigableLink /
// NavigableCode / LinkSegment are wrapped in React.memo so an unrelated
// ancestor re-render does not re-parse a large plan. The NavigableCode case
// re-renders the SAME fiber across its early-return boundary — on a version
// that put the hook below the return, React throws the hook-count error.
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { segmentText, NavigableLink, NavigableCode, LinkSegment, remarkNavigableLinks, useNavigableText } from '../useNavigableLinks'
import { registerSurfaceFileRouter } from '../../lib/file-open-router'
import { useSessionStore } from '../../stores/sessionStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// A real markdown link routes through window.ion.openExternal. Stub it so the
// external-open branch is exercisable and its target is observable.
const externalOpens: string[] = []
const fsExists = vi.fn<(path: string) => Promise<{ exists: boolean }>>()
const fsOpenNative = vi.fn<(path: string) => Promise<{ ok: boolean; error?: string }>>()
const logWrite = vi.fn()
const legacyOpenFile = vi.fn()
let unregisterRouter: (() => void) | null = null

beforeAll(() => {
  ;(globalThis as any).window.ion = {
    openExternal: (url: string) => { externalOpens.push(url); return Promise.resolve() },
    fsExists,
    fsOpenNative,
    logWrite,
  }
})

beforeEach(() => {
  fsExists.mockReset().mockResolvedValue({ exists: true })
  fsOpenNative.mockReset().mockResolvedValue({ ok: true })
  logWrite.mockClear()
  legacyOpenFile.mockClear()
  useSessionStore.setState({
    activeTabId: 'tab-1',
    tabs: [{ id: 'tab-1', workingDirectory: '/active/repository' }] as never,
    staticInfo: { homePath: '/home/operator' } as never,
    openFileInEditor: legacyOpenFile,
  })
})

afterEach(() => {
  unregisterRouter?.()
  unregisterRouter = null
})

const noop = () => {}

function mount() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  return { container, root }
}

async function commandClickFilePath(path: string): Promise<void> {
  const { container, root } = mount()

  function FilePathHarness() {
    const { onOpenFile, onOpenUrl } = useNavigableText()
    return <LinkSegment segment={{ type: 'file', value: path }} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} asChip />
  }

  act(() => root.render(<FilePathHarness />))
  const chip = container.querySelector('[role="link"]')
  expect(chip).not.toBeNull()
  await act(async () => {
    chip!.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }))
    await Promise.resolve()
  })
  act(() => root.unmount())
  container.remove()
}

describe('useNavigableText file routing', () => {
  it('routes an existing absolute Markdown path outside the workspace to the Studio surface', async () => {
    const openTextFile = vi.fn()
    unregisterRouter = registerSurfaceFileRouter({
      openTextFile,
      openImage: vi.fn(),
      openHtml: vi.fn(),
      openGitDiff: vi.fn(() => false),
    })
    const absolutePath = '/outside/knowledge/standard.md'

    await commandClickFilePath(absolutePath)

    expect(fsExists).toHaveBeenCalledWith(absolutePath)
    expect(openTextFile).toHaveBeenCalledWith('/active/repository', 'tab-1', absolutePath)
    expect(legacyOpenFile).not.toHaveBeenCalled()
  })

  it('keeps the overlay editor fallback when no Studio router is registered', async () => {
    const absolutePath = '/outside/knowledge/standard.md'

    await commandClickFilePath(absolutePath)

    expect(legacyOpenFile).toHaveBeenCalledWith('/active/repository', 'tab-1', absolutePath)
  })

  it('logs a Studio router failure without falling through to the overlay editor', async () => {
    const openTextFile = vi.fn(() => { throw new Error('surface unavailable') })
    unregisterRouter = registerSurfaceFileRouter({
      openTextFile,
      openImage: vi.fn(),
      openHtml: vi.fn(),
      openGitDiff: vi.fn(() => false),
    })

    await commandClickFilePath('/outside/knowledge/standard.md')

    expect(legacyOpenFile).not.toHaveBeenCalled()
    expect(logWrite).toHaveBeenCalledWith(
      'WARN',
      'navigable-links',
      'Studio surface file open failed',
      expect.objectContaining({ error: 'Error: surface unavailable' }),
    )
  })

  it('logs an existence-check failure without trying either file route', async () => {
    fsExists.mockRejectedValueOnce(new Error('filesystem unavailable'))

    await commandClickFilePath('/outside/knowledge/standard.md')

    expect(legacyOpenFile).not.toHaveBeenCalled()
    expect(fsOpenNative).not.toHaveBeenCalled()
    expect(logWrite).toHaveBeenCalledWith(
      'WARN',
      'navigable-links',
      'file existence check failed',
      expect.objectContaining({ error: 'Error: filesystem unavailable' }),
    )
  })

  it('logs a native-open refusal returned by the filesystem bridge', async () => {
    fsOpenNative.mockResolvedValueOnce({ ok: false, error: 'no application' })

    await commandClickFilePath('/outside/document.pdf')

    expect(fsOpenNative).toHaveBeenCalledWith('/outside/document.pdf')
    expect(logWrite).toHaveBeenCalledWith(
      'WARN',
      'navigable-links',
      'native file open rejected',
      expect.objectContaining({ error: 'no application' }),
    )
  })
})

describe('segmentText', () => {
  it('splits plain text, file paths, and URLs', () => {
    const segs = segmentText('open src/a/b.ts then visit https://example.com now')
    const files = segs.filter((s) => s.type === 'file').map((s) => s.value)
    const urls = segs.filter((s) => s.type === 'url').map((s) => s.value)
    expect(files).toContain('src/a/b.ts')
    expect(urls).toContain('https://example.com')
  })

  it('returns a single plain segment for text with no links', () => {
    const segs = segmentText('just some words here')
    expect(segs).toHaveLength(1)
    expect(segs[0]).toEqual({ type: 'plain', value: 'just some words here' })
  })
})

describe('remarkNavigableLinks — end-to-end through react-markdown', () => {
  // This is the regression guard for the dead-`text`-component bug. A `text`
  // entry in react-markdown's `components` map is NEVER invoked (only tag-named
  // components are mapped), so the previous `text: NavigableText` wiring meant
  // cmd-click links silently did not work in any rendered prose. Rendering real
  // markdown and asserting the click fires is the only seam that catches it —
  // a unit test of NavigableText passed the whole time the feature was broken.
  function renderMarkdown(source: string, handlers: { onOpenFile: (p: string) => void; onOpenUrl: (u: string) => void }) {
    const { container, root } = mount()
    const components = {
      a: ({ node, href, children }: any) => (
        <NavigableLink node={node} href={href} color="#fff" onOpenFile={handlers.onOpenFile} onOpenUrl={handlers.onOpenUrl}>
          {children}
        </NavigableLink>
      ),
    }
    act(() => {
      root.render(
        <Markdown remarkPlugins={[remarkGfm, remarkNavigableLinks]} components={components}>
          {source}
        </Markdown>,
      )
    })
    return { container, root }
  }

  /** Click an element whose text matches, with the CMD modifier set. */
  function cmdClick(container: HTMLElement, text: string) {
    const el = [...container.querySelectorAll('span, a, button')].find((n) => n.textContent === text)
    expect(el, `no element with text ${JSON.stringify(text)}`).toBeTruthy()
    act(() => {
      el!.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }))
    })
  }

  it('fires onOpenFile for a bare relative path in prose', () => {
    const opened: string[] = []
    const { container, root } = renderMarkdown('please read src/a/b.ts today', {
      onOpenFile: (p) => opened.push(p),
      onOpenUrl: noop,
    })
    cmdClick(container, 'src/a/b.ts')
    expect(opened).toEqual(['src/a/b.ts'])
    act(() => root.unmount())
  })

  it('opens a bare URL externally (remark-gfm autolinks it before the plugin runs)', () => {
    // A bare URL is NOT the regressed case: remark-gfm's autolink-literal
    // extension already converts it to a real `link` node, so it reached the
    // `a` override even while the dead `text` component was in place. Pinned
    // here so a future plugin change cannot silently swallow it.
    const opened: string[] = []
    externalOpens.length = 0
    const { container, root } = renderMarkdown('see https://example.com for details', {
      onOpenFile: (p) => opened.push(p),
      onOpenUrl: noop,
    })
    cmdClick(container, 'https://example.com')
    expect(opened).toEqual([])
    expect(externalOpens).toEqual(['https://example.com'])
    act(() => root.unmount())
  })

  it('leaves a real markdown link on the external-open path, not the file opener', () => {
    const opened: string[] = []
    externalOpens.length = 0
    const { container, root } = renderMarkdown('[label](https://example.com/page)', {
      onOpenFile: (p) => opened.push(p),
      onOpenUrl: noop,
    })
    // A real link renders as the button branch; cmd-clicking it must not be
    // treated as a navigable file — it opens externally instead.
    cmdClick(container, 'label')
    expect(opened).toEqual([])
    expect(externalOpens).toEqual(['https://example.com/page'])
    act(() => root.unmount())
  })

  it('does not linkify a path inside a fenced code block', () => {
    const opened: string[] = []
    const { container, root } = renderMarkdown('```\nsrc/a/b.ts\n```\n', {
      onOpenFile: (p) => opened.push(p),
      onOpenUrl: noop,
    })
    expect(container.querySelector('code')).toBeTruthy()
    expect(container.querySelectorAll('span').length).toBe(0)
    expect(opened).toEqual([])
    act(() => root.unmount())
  })

  it('does not re-linkify the label text of a markdown link', () => {
    const { container, root } = renderMarkdown('[src/a/b.ts](https://example.com)', {
      onOpenFile: noop,
      onOpenUrl: noop,
    })
    // Exactly one clickable element for the link — the plugin must skip text
    // nodes whose parent is already a link.
    expect(container.querySelectorAll('button').length).toBe(1)
    expect(container.querySelectorAll('span').length).toBe(0)
    act(() => root.unmount())
  })
})

describe('NavigableCode hook-order stability', () => {
  it('re-renders across the code-block (className) boundary without a hook error', () => {
    const { root } = mount()
    // inline code -> segmentation path
    act(() => root.render(<NavigableCode onOpenFile={noop} onOpenUrl={noop}>{'src/a/b.ts'}</NavigableCode>))
    // fenced code block (has className) -> early passthrough; hook slot preserved
    act(() => root.render(<NavigableCode className="language-ts" onOpenFile={noop} onOpenUrl={noop}>{'const x = 1'}</NavigableCode>))
    // back to inline
    act(() => root.render(<NavigableCode onOpenFile={noop} onOpenUrl={noop}>{'lib/c.ts'}</NavigableCode>))
    act(() => root.unmount())
  })
})

describe('memoization wrappers', () => {
  const MEMO = Symbol.for('react.memo')
  it('wraps the link components in React.memo', () => {
    expect((NavigableLink as any).$$typeof).toBe(MEMO)
    expect((NavigableCode as any).$$typeof).toBe(MEMO)
    expect((LinkSegment as any).$$typeof).toBe(MEMO)
  })
})
