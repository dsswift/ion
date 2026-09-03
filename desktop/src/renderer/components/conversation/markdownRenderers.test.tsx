// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { darkColors } from '../../theme/palette-dark'
import { remarkNavigableLinks } from '../../hooks/useNavigableLinks'
import { makeMarkdownComponents, parseFenceMeta, extractCodeText } from './markdownRenderers'
import { registerContentRouter } from '../../lib/file-open-router'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const getFavicon = vi.fn((_host: string): Promise<string | null> => Promise.resolve(null))
const openExternal = vi.fn((_url: string) => Promise.resolve(true))

beforeAll(() => {
  ;(window as unknown as { ion: object }).ion = {
    getFavicon: (host: string) => getFavicon(host),
    openExternal: (url: string) => openExternal(url),
  }
})

let container: HTMLDivElement | null = null
let root: Root | null = null
const onOpenFile = vi.fn()
const onOpenUrl = vi.fn()

function renderMarkdown(md: string): HTMLElement {
  const components = makeMarkdownComponents({ colors: darkColors, onOpenFile, onOpenUrl })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <Markdown remarkPlugins={[remarkGfm, remarkNavigableLinks]} components={components}>{md}</Markdown>,
    )
  })
  return container
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

afterEach(() => {
  act(() => { root?.unmount() })
  root = null
  container?.remove()
  container = null
  getFavicon.mockReset()
  getFavicon.mockResolvedValue(null)
  openExternal.mockClear()
  onOpenFile.mockClear()
  onOpenUrl.mockClear()
})

describe('parseFenceMeta', () => {
  it('parses title= and filename= (quoted or bare)', () => {
    expect(parseFenceMeta('title=src/foo.ts')).toEqual({ fileName: 'src/foo.ts' })
    expect(parseFenceMeta('filename="a b.ts"')).toEqual({ fileName: 'a b.ts' })
    expect(parseFenceMeta("title='x.go'")).toEqual({ fileName: 'x.go' })
  })

  it('accepts a bare dotted token and ignores prose', () => {
    expect(parseFenceMeta('src/foo.ts')).toEqual({ fileName: 'src/foo.ts' })
    expect(parseFenceMeta('some words')).toEqual({})
    expect(parseFenceMeta(undefined)).toEqual({})
  })
})

describe('extractCodeText', () => {
  it('flattens strings, arrays, and elements', () => {
    expect(extractCodeText('abc')).toBe('abc')
    expect(extractCodeText(['a', 'b'])).toBe('ab')
    expect(extractCodeText(React.createElement('span', null, 'x'))).toBe('x')
  })
})

describe('makeMarkdownComponents', () => {
  // A GFM table must render inside the horizontal scroll wrapper — a real
  // <table> nested in an `overflow-x: auto` container — so a table wider than a
  // thin panel scrolls instead of crushing its columns. The regression this
  // guards: an override that returned a bare <div>{children}</div> dropped the
  // <table> element entirely, leaving orphan <thead>/<tr> rows, and a table with
  // no scroll ancestor squeezes to fit and stacks cell text one char per line.
  it('wraps a table in a horizontal scroll container that still contains a real <table>', () => {
    const el = renderMarkdown('| A | B |\n| - | - |\n| 1 | 2 |')
    const table = el.querySelector('table')
    expect(table).not.toBeNull()
    expect(table!.textContent).toContain('1')
    const scroller = table!.closest('div') as HTMLDivElement
    expect(scroller).not.toBeNull()
    expect(scroller.style.overflowX).toBe('auto')
  })

  it('routes fenced code through CodeBlock with the fence language badge', () => {
    const el = renderMarkdown('```ts\nconst x = 1\n```')
    expect(el.textContent).toContain('TypeScript')
    expect(el.textContent).toContain('const x = 1')
    expect(el.querySelector('[data-code-lang="ts"]')).not.toBeNull()
  })

  it('passes fence meta filenames into the CodeBlock badge', () => {
    const el = renderMarkdown('```ts title=src/foo.ts\nconst x = 1\n```')
    expect(el.textContent).toContain('src/foo.ts')
  })

  it('keeps inline code on NavigableCode (a plain <code>, no block chrome)', () => {
    const el = renderMarkdown('inline `hello` code')
    const code = el.querySelector('code')!
    expect(code.textContent).toBe('hello')
    expect(el.querySelector('pre')).toBeNull()
  })

  it('renders a file-path inline code span as a chip that cmd-clicks into onOpenFile', () => {
    const el = renderMarkdown('see `src/foo.ts` here')
    const chip = el.querySelector('[role="link"]') as HTMLElement
    expect(chip).not.toBeNull()
    expect(chip.textContent).toContain('src/foo.ts')
    expect(chip.querySelector('svg')).not.toBeNull() // file-type icon
    act(() => {
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }))
    })
    // The click now travels with the path so ⇧ (source) and ⌥ (native) reach
    // the open-intent rules; dropping it is what made the modifiers inert.
    expect(onOpenFile).toHaveBeenCalledWith('src/foo.ts', expect.objectContaining({ metaKey: true }))
  })

  // Regression guard for the dead-`text`-component bug: a `text` entry in
  // react-markdown's `components` map is never invoked (only tag-named
  // components are mapped), so a bare file path in ordinary prose never went
  // through NavigableText and cmd-click silently did nothing. Link detection
  // now runs as the `remarkNavigableLinks` plugin, which rewrites the bare
  // path into a real `link` node before the `a` override sees it — this test
  // exercises that path through the actual factory the conversation
  // components use, not just the underlying NavigableLink unit.
  it('cmd-clicks a bare file path in prose (not inline code) as a chip that opens the file', () => {
    const el = renderMarkdown('please read src/foo.ts today')
    const chip = el.querySelector('[role="link"]') as HTMLElement
    expect(chip).not.toBeNull()
    expect(chip.textContent).toContain('src/foo.ts')
    act(() => {
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }))
    })
    // The click now travels with the path so ⇧ (source) and ⌥ (native) reach
    // the open-intent rules; dropping it is what made the modifiers inert.
    expect(onOpenFile).toHaveBeenCalledWith('src/foo.ts', expect.objectContaining({ metaKey: true }))
  })

  it('renders external links with a favicon when the IPC yields one, and opens via openExternal', async () => {
    getFavicon.mockResolvedValue('data:image/png;base64,AAAA')
    const el = renderMarkdown('[site](https://unique-favicon-host.example)')
    await flush()
    const img = el.querySelector('img[data-favicon]') as HTMLImageElement
    expect(img).not.toBeNull()
    expect(img.src).toBe('data:image/png;base64,AAAA')
    const btn = el.querySelector('button')!
    act(() => { btn.click() })
    expect(openExternal).toHaveBeenCalledWith('https://unique-favicon-host.example')
  })

  it('routes a cmd-clicked external link into the Studio surface browser', async () => {
    // The plain-click case above must keep reaching the OS browser; this is the
    // other half of that rule. Registering a router stands in for Studio, so
    // the assertion covers the real seam rather than a window-role branch.
    const openUrl = vi.fn(() => true)
    const release = registerContentRouter({
      openTextFile: vi.fn(),
      openImage: vi.fn(),
      openHtml: vi.fn(),
      openGitDiff: vi.fn(() => true),
      openUrl,
    })
    try {
      getFavicon.mockResolvedValue(null)
      const el = renderMarkdown('[site](https://cmd-click-host.example)')
      await flush()
      const btn = el.querySelector('button')!
      act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true })) })
      expect(openUrl).toHaveBeenCalledWith('https://cmd-click-host.example')
      expect(openExternal).not.toHaveBeenCalled()
    } finally {
      release()
    }
  })

  it('escapes to the default browser on a cmd-option-click', async () => {
    // The other half of the routed case above, through a real rendered anchor:
    // holding ⌥ must reach the OS even though Studio has a router installed.
    const openUrl = vi.fn(() => true)
    const release = registerContentRouter({
      openTextFile: vi.fn(),
      openImage: vi.fn(),
      openHtml: vi.fn(),
      openGitDiff: vi.fn(() => true),
      openUrl,
    })
    try {
      getFavicon.mockResolvedValue(null)
      const el = renderMarkdown('[site](https://escape-host.example)')
      await flush()
      const btn = el.querySelector('button')!
      act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true, altKey: true })) })
      expect(openUrl).not.toHaveBeenCalled()
      expect(openExternal).toHaveBeenCalledWith('https://escape-host.example')
    } finally {
      release()
    }
  })

  it('falls back to the Globe glyph when the favicon IPC returns null', async () => {
    getFavicon.mockResolvedValue(null)
    const el = renderMarkdown('[site](https://no-favicon-host.example)')
    await flush()
    expect(el.querySelector('img[data-favicon]')).toBeNull()
    expect(el.querySelector('button svg')).not.toBeNull() // Globe
  })
})
