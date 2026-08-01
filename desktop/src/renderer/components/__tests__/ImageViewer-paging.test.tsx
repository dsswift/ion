// @vitest-environment jsdom
/**
 * ImageViewer paging — pins the gallery-driven navigation added alongside the
 * inline image gallery.
 *
 * A fifty-image turn is only browsable if the viewer can walk the set; opening
 * and closing the panel per image is not a viewer, it is a file picker. Paging
 * is additive: the single-image callers (FileExplorer, StatusBarAttachments)
 * pass no siblings and must get exactly the toolbar they had.
 *
 * Revert contract:
 *   - Dropping the nav props makes "next/prev walk the set" fail.
 *   - Rendering nav chrome unconditionally makes "no nav chrome without
 *     siblings" fail — that is the additive-prop guarantee for existing callers.
 */
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect, vi, beforeEach } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000' }),
}))
vi.mock('../../rendererLogger', () => ({
  rError: vi.fn(),
  rInfo: vi.fn(),
}))
// FloatingPanel portals into PopoverLayer and reads window geometry; the
// contract under test is the toolbar + image, so render children inline.
vi.mock('../FloatingPanel', () => ({
  FloatingPanel: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'panel' }, children),
}))
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: (selector: (s: unknown) => unknown) =>
    selector({
      planGeometry: { x: 0, y: 0, w: 600, h: 500 },
      setPlanGeometry: vi.fn(),
      tabs: [],
      activeTabId: null,
    }),
}))

const readImageDataUrl = vi.fn(async (path: string) => ({ dataUrl: `data:image/png;base64,STUB_${path.split('/').pop()}` }))

beforeEach(() => {
  ;(globalThis as unknown as { window: { ion: unknown } }).window = globalThis as unknown as { ion: unknown }
  ;(globalThis as unknown as { window: { ion: unknown } }).window.ion = { readImageDataUrl, fsRevealInFinder: vi.fn() }
})

import { ImageViewer } from '../ImageViewer'

const SIBLINGS = [
  { path: '/c/a.png', name: 'a.png' },
  { path: '/c/b.png', name: 'b.png' },
  { path: '/c/c.png', name: 'c.png' },
]

/** Host that owns the selected index, mirroring how ImageGallery drives it. */
function PagingHost({ start }: { start: number }) {
  const [index, setIndex] = React.useState(start)
  return (
    <ImageViewer
      filePath={SIBLINGS[index].path}
      fileName={SIBLINGS[index].name}
      siblings={SIBLINGS}
      index={index}
      onNavigate={setIndex}
      onClose={() => undefined}
    />
  )
}

async function render(node: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(node) })
  await act(async () => { await Promise.resolve() })
  return {
    container,
    src: () => container.querySelector('img')?.getAttribute('src'),
    async click(selector: string) {
      const el = container.querySelector(selector)
      if (!el) throw new Error(`no element for ${selector}`)
      await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await Promise.resolve() })
    },
    async press(key: string) {
      await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key })) })
      await act(async () => { await Promise.resolve() })
    },
    unmount() { act(() => root.unmount()); document.body.removeChild(container) },
  }
}

describe('ImageViewer paging', () => {
  it('next and prev buttons walk the set', async () => {
    const view = await render(<PagingHost start={0} />)
    expect(view.src()).toContain('STUB_a.png')
    await view.click('[aria-label="Next image"]')
    expect(view.src()).toContain('STUB_b.png')
    await view.click('[aria-label="Previous image"]')
    expect(view.src()).toContain('STUB_a.png')
    view.unmount()
  })

  it('wraps around at both ends', async () => {
    const view = await render(<PagingHost start={0} />)
    await view.click('[aria-label="Previous image"]')
    expect(view.src()).toContain('STUB_c.png')
    await view.click('[aria-label="Next image"]')
    expect(view.src()).toContain('STUB_a.png')
    view.unmount()
  })

  it('arrow keys page the set', async () => {
    const view = await render(<PagingHost start={0} />)
    await view.press('ArrowRight')
    expect(view.src()).toContain('STUB_b.png')
    await view.press('ArrowLeft')
    expect(view.src()).toContain('STUB_a.png')
    view.unmount()
  })

  it('shows the position counter', async () => {
    const view = await render(<PagingHost start={1} />)
    expect(view.container.textContent).toContain('2 / 3')
    view.unmount()
  })

  it('renders no nav chrome without siblings (existing single-image callers)', async () => {
    const view = await render(
      <ImageViewer filePath="/c/solo.png" fileName="solo.png" onClose={() => undefined} />,
    )
    expect(view.container.querySelector('[aria-label="Next image"]')).toBeNull()
    expect(view.container.querySelector('[aria-label="Previous image"]')).toBeNull()
    expect(view.container.textContent).toContain('Save As')
    view.unmount()
  })

  it('renders no nav chrome for a single-item sibling set', async () => {
    const view = await render(
      <ImageViewer
        filePath="/c/a.png"
        fileName="a.png"
        siblings={[SIBLINGS[0]]}
        index={0}
        onNavigate={vi.fn()}
        onClose={() => undefined}
      />,
    )
    expect(view.container.querySelector('[aria-label="Next image"]')).toBeNull()
    view.unmount()
  })
})
