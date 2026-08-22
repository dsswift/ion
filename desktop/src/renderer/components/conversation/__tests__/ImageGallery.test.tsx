// @vitest-environment jsdom
/**
 * ImageGallery — pins the paged-rail behaviour that replaced the vertical
 * thumbnail stack.
 *
 * The defect: a turn that read dozens of images rendered every one of them as
 * a ~260px-tall tile in a continuous vertical list, so a fifty-image turn was
 * thousands of pixels of transcript. The gallery bounds that: 2+ images become
 * a horizontal rail capped at GALLERY_RAIL_CAP tiles, with the remainder behind
 * a `+N more` affordance.
 *
 * Revert contract:
 *   - Rendering every item unconditionally fails "caps the collapsed rail".
 *   - Dropping the expand affordance fails "expanding renders every image".
 *   - Restoring the rail chrome for a single image fails "one image renders
 *     the solo tile with no rail chrome".
 */
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, it, expect, vi, beforeEach } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../theme', () => ({
  useColors: () => new Proxy({}, { get: () => '#000' }),
}))
vi.mock('../../../rendererLogger', () => ({
  rInfo: vi.fn(),
  rWarn: vi.fn(),
  rError: vi.fn(),
}))
// The viewer pulls in FloatingPanel + the zustand store; the gallery contract
// under test is "which image did it open", so a marker stands in for it.
vi.mock('../../ImageViewer', async () => {
  const actual = await vi.importActual<typeof import('../../ImageViewer')>('../../ImageViewer')
  return {
    useImageDataUrl: actual.useImageDataUrl,
    ImageViewer: ({ filePath, index, siblings }: { filePath: string; index?: number; siblings?: unknown[] }) =>
      React.createElement('div', {
        'data-testid': 'viewer',
        'data-path': filePath,
        'data-index': String(index),
        'data-siblings': String(siblings?.length ?? 0),
      }),
  }
})
// Tooltip is deliberately NOT mocked. It wraps every tile in its own
// inline-flex span, and that span is the rail's actual flex item — the thing
// the "non-shrinking flex items" test exists to pin. A passthrough mock erases
// the wrapper and the test then passes against the broken layout, which is the
// exact false coverage that let the defect ship. Tooltip renders fine without a
// PopoverLayer: HoverCard falls back to the native `title` attribute and skips
// the portal, so the wrapper (and its style) is still emitted here.

const readImageDataUrl = vi.fn(async (path: string) => ({ dataUrl: `data:image/png;base64,STUB_${path.split('/').pop()}` }))

beforeEach(() => {
  readImageDataUrl.mockClear()
  ;(globalThis as unknown as { window: { ion: unknown } }).window = globalThis as unknown as { ion: unknown }
  ;(globalThis as unknown as { window: { ion: unknown } }).window.ion = { readImageDataUrl }
})

import { ImageGallery, galleryLayout, GALLERY_RAIL_CAP, type GalleryImage } from '../ImageGallery'

// Cross-platform parity: GALLERY_RAIL_CAP must match the fixture iOS's
// MessageAttachmentGalleryTests.swift asserts against, or the same
// many-image conversation folds at a different point per device. See
// assets/gallery-parity.json and the "Parity is part of the contract"
// discipline in root AGENTS.md.
const parityFixturePath = join(__dirname, '../../../../../../assets/gallery-parity.json')
const galleryParityFixture = JSON.parse(readFileSync(parityFixturePath, 'utf-8')) as { railCap: number }

describe('gallery cap cross-platform parity', () => {
  it('GALLERY_RAIL_CAP matches assets/gallery-parity.json (shared with iOS)', () => {
    expect(GALLERY_RAIL_CAP).toBe(galleryParityFixture.railCap)
  })
})

function items(n: number): GalleryImage[] {
  return Array.from({ length: n }, (_, i) => ({ key: `k${i}`, path: `/c/img${i}.png`, name: `img${i}.png` }))
}

async function render(node: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(node) })
  await act(async () => { await Promise.resolve() })
  return {
    container,
    async click(el: Element) {
      await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      await act(async () => { await Promise.resolve() })
    },
    unmount() { act(() => root.unmount()); document.body.removeChild(container) },
  }
}

function overflowButton(container: HTMLElement): HTMLElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) => /^\+\d+ more$/.test(b.textContent || ''))
}

describe('galleryLayout', () => {
  it('shows everything up to the cap', () => {
    expect(galleryLayout(1, false)).toEqual({ visible: 1, overflow: 0 })
    expect(galleryLayout(GALLERY_RAIL_CAP, false)).toEqual({ visible: GALLERY_RAIL_CAP, overflow: 0 })
  })

  it('spends the last slot on the overflow tile past the cap', () => {
    // 50 images: 11 tiles + "+39 more" — never 12 tiles with 38 unreachable.
    expect(galleryLayout(50, false)).toEqual({ visible: 11, overflow: 39 })
    expect(galleryLayout(13, false)).toEqual({ visible: 11, overflow: 2 })
  })

  it('shows everything when expanded', () => {
    expect(galleryLayout(50, true)).toEqual({ visible: 50, overflow: 0 })
  })
})

describe('ImageGallery', () => {
  it('one image renders the solo tile with no rail chrome', async () => {
    const { container, unmount } = await render(<ImageGallery items={items(1)} />)
    expect(container.querySelectorAll('img')).toHaveLength(1)
    expect(container.querySelector('[data-testid="image-gallery-rail"]')).toBeNull()
    expect(container.textContent).not.toContain('images')
    unmount()
  })

  it('caps the collapsed rail and folds the rest into +N more', async () => {
    const { container, unmount } = await render(<ImageGallery items={items(50)} />)
    expect(container.querySelectorAll('img')).toHaveLength(11)
    expect(overflowButton(container)?.textContent).toBe('+39 more')
    expect(container.textContent).toContain('50 images')
    unmount()
  })

  it('expanding renders every image', async () => {
    const { container, click, unmount } = await render(<ImageGallery items={items(50)} />)
    const more = overflowButton(container)
    expect(more).toBeDefined()
    await click(more!)
    expect(container.querySelectorAll('img')).toHaveLength(50)
    expect(overflowButton(container)).toBeUndefined()
    expect(container.textContent).toContain('Show less')
    unmount()
  })

  it('a set at the cap renders every tile with no overflow affordance', async () => {
    const { container, unmount } = await render(<ImageGallery items={items(GALLERY_RAIL_CAP)} />)
    expect(container.querySelectorAll('img')).toHaveLength(GALLERY_RAIL_CAP)
    expect(overflowButton(container)).toBeUndefined()
    unmount()
  })

  it('rail children are non-shrinking, snap-aligned flex items', async () => {
    // The rail's scrolling depends on its DIRECT children refusing to shrink.
    // Tiles are Tooltip-wrapped, and Tooltip renders its own inline-flex span
    // (git/HoverCard.tsx) — so that span, not the tile inside it, is the flex
    // item the rail lays out. Putting flex-shrink-0 and scroll-snap-align on
    // the inner element leaves the wrapper free to compress: the tiles squash,
    // scrollWidth never exceeds clientWidth, and measure() then reports
    // overflowing: false, silently disabling the chevrons and the edge fade
    // too. Assert the emitted inline style on the actual children — jsdom
    // computes no layout, but it does record what we set.
    const { container, unmount } = await render(<ImageGallery items={items(5)} />)
    const rail = container.querySelector('[data-testid="image-gallery-rail"]') as HTMLElement
    const children = Array.from(rail.children) as HTMLElement[]
    expect(children.length).toBeGreaterThan(0)
    for (const child of children) {
      expect(child.style.flexShrink).toBe('0')
      expect(child.style.scrollSnapAlign).toBe('start')
    }
    unmount()
  })

  it('chevrons page the rail by scrolling it', async () => {
    const { container, click, unmount } = await render(<ImageGallery items={items(20)} />)
    const rail = container.querySelector('[data-testid="image-gallery-rail"]') as HTMLElement
    // jsdom reports zero layout, so force the overflow the chevrons depend on.
    Object.defineProperty(rail, 'scrollWidth', { value: 2000, configurable: true })
    Object.defineProperty(rail, 'clientWidth', { value: 400, configurable: true })
    const scrollBy = vi.fn()
    rail.scrollBy = scrollBy as unknown as HTMLElement['scrollBy']
    await act(async () => { rail.dispatchEvent(new Event('scroll')) })

    const next = container.querySelector('[aria-label="Scroll images right"]')
    expect(next).not.toBeNull()
    await click(next!)
    expect(scrollBy).toHaveBeenCalledWith({ left: 360, behavior: 'smooth' })
    unmount()
  })

  it('clicking a tile opens the viewer on that image with the whole set as siblings', async () => {
    const { container, click, unmount } = await render(<ImageGallery items={items(5)} />)
    const tiles = container.querySelectorAll('button[data-gallery-index]')
    await click(tiles[2])
    const viewer = container.querySelector('[data-testid="viewer"]')
    expect(viewer?.getAttribute('data-path')).toBe('/c/img2.png')
    expect(viewer?.getAttribute('data-index')).toBe('2')
    expect(viewer?.getAttribute('data-siblings')).toBe('5')
    unmount()
  })

  it('renders nothing for an empty set', async () => {
    const { container, unmount } = await render(<ImageGallery items={[]} />)
    expect(container.textContent).toBe('')
    unmount()
  })
})
