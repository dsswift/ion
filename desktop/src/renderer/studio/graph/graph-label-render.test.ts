/**
 * Pins the themed, width-bounded label drawers.
 *
 * Regression coverage for the reported defect: Sigma's stock drawers paint
 * labels in `#000` (invisible on Ion's dark surfaces) at unbounded width
 * (a long document title ran the full width of the stage), and the hover
 * treatment was a `#FFF` slab. Each assertion below fails if any of those
 * stock behaviours comes back.
 */
import { describe, expect, it, vi } from 'vitest'
import { createNodeLabelDrawer, createNodeHoverDrawer, truncateToWidth, labelPlacement, MAX_LABEL_WIDTH_PX, LABEL_GAP_PX } from './graph-label-render'
import { darkColors } from '../../theme/palette-dark'
import type { Settings } from 'sigma/settings'

/** A canvas stub whose text metrics are a fixed width per character. */
function stubContext(pxPerChar = 10): CanvasRenderingContext2D & { fills: string[]; strokes: string[]; filled: [string, number, number][] } {
  const fills: string[] = []
  const strokes: string[] = []
  const filled: [string, number, number][] = []
  const ctx = {
    font: '',
    textAlign: 'start' as CanvasTextAlign,
    textBaseline: 'alphabetic' as CanvasTextBaseline,
    lineWidth: 0,
    lineJoin: 'miter' as CanvasLineJoin,
    fills,
    strokes,
    filled,
    set fillStyle(v: string) {
      fills.push(v)
    },
    get fillStyle(): string {
      return fills[fills.length - 1] ?? ''
    },
    set strokeStyle(v: string) {
      strokes.push(v)
    },
    get strokeStyle(): string {
      return strokes[strokes.length - 1] ?? ''
    },
    measureText: (t: string) => ({ width: t.length * pxPerChar }) as TextMetrics,
    fillText: (t: string, x: number, y: number) => {
      filled.push([t, x, y])
    },
    strokeText: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    arc: vi.fn(),
    roundRect: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
  }
  return ctx as unknown as CanvasRenderingContext2D & { fills: string[]; strokes: string[]; filled: [string, number, number][] }
}

const settings = { labelSize: 11, labelFont: 'system-ui', labelWeight: '500' } as Settings

describe('truncateToWidth', () => {
  it('returns a label that already fits, unchanged', () => {
    expect(truncateToWidth(stubContext(), 'short', 200)).toBe('short')
  })

  it('ellipsizes a label that does not fit, within the budget', () => {
    const ctx = stubContext()
    const out = truncateToWidth(ctx, 'a'.repeat(60), 100)
    expect(out.endsWith('…')).toBe(true)
    expect(ctx.measureText(out).width).toBeLessThanOrEqual(100)
  })
})

describe('createNodeLabelDrawer', () => {
  it('fills the label in the theme label color, never black', () => {
    const ctx = stubContext()
    createNodeLabelDrawer(darkColors)(ctx, { x: 0, y: 0, size: 5, label: 'Doc', color: '#fff' }, settings)
    expect(ctx.fills).toContain(darkColors.graphLabel)
    expect(ctx.fills).not.toContain('#000')
  })

  it('paints a plate in the theme plate colour under the text', () => {
    const ctx = stubContext()
    createNodeLabelDrawer(darkColors)(ctx, { x: 0, y: 0, size: 5, label: 'Doc', color: '#fff' }, settings)
    expect(ctx.fills[0]).toBe(darkColors.graphLabelPlate)
    expect(ctx.roundRect).toHaveBeenCalledTimes(1)
  })

  it('centres the label under the node, never beside it', () => {
    const ctx = stubContext()
    createNodeLabelDrawer(darkColors)(ctx, { x: 100, y: 50, size: 6, label: 'Doc', color: '#fff' }, settings)
    const [, x, y] = ctx.filled[0]
    expect(ctx.textAlign).toBe('center')
    expect(x).toBe(100)
    expect(y).toBeGreaterThan(50 + 6 + LABEL_GAP_PX)
  })

  it('a hub draws heavier, larger and brighter than an ordinary node', () => {
    const ctx = stubContext()
    createNodeLabelDrawer(darkColors)(ctx, { x: 0, y: 0, size: 5, label: 'Hub', color: '#fff', labelTier: 'hub' }, settings)
    expect(ctx.font).toBe('600 12px system-ui')
    expect(ctx.fills).toContain(darkColors.graphLabelHub)
    const plain = stubContext()
    createNodeLabelDrawer(darkColors)(plain, { x: 0, y: 0, size: 5, label: 'Doc', color: '#fff', labelTier: 'normal' }, settings)
    expect(plain.font).toBe('500 11px system-ui')
    expect(plain.fills).toContain(darkColors.graphLabel)
  })

  it('truncates a long label to the stage budget instead of running full width', () => {
    const ctx = stubContext()
    const long = 'ADR-0037: Faceted Tag Vocabulary Projected From ORN Segments, Excluding the Instance Segment'
    createNodeLabelDrawer(darkColors)(ctx, { x: 0, y: 0, size: 5, label: long, color: '#fff' }, settings)
    const [text] = ctx.filled[0]
    expect(text).not.toBe(long)
    expect(ctx.measureText(text).width).toBeLessThanOrEqual(MAX_LABEL_WIDTH_PX)
  })

  it('draws nothing for a node with no label', () => {
    const ctx = stubContext()
    createNodeLabelDrawer(darkColors)(ctx, { x: 0, y: 0, size: 5, label: '', color: '#fff' }, settings)
    expect(ctx.filled).toHaveLength(0)
  })
})

describe('createNodeHoverDrawer', () => {
  it('paints the hover pill on the theme popover surface, not Sigma’s white', () => {
    const ctx = stubContext()
    createNodeHoverDrawer(darkColors)(ctx, { x: 0, y: 0, size: 5, label: 'Doc', color: '#fff' }, settings)
    expect(ctx.fills).toContain(darkColors.popoverBg)
    expect(ctx.fills).not.toContain('#FFF')
    expect(ctx.roundRect).toHaveBeenCalled()
  })

  it('still draws the node ring when the node has no label', () => {
    const ctx = stubContext()
    createNodeHoverDrawer(darkColors)(ctx, { x: 0, y: 0, size: 5, label: '', color: '#fff' }, settings)
    expect(ctx.arc).toHaveBeenCalled()
    expect(ctx.roundRect).not.toHaveBeenCalled()
  })
})

describe('labelPlacement', () => {
  it('puts the plate below the node, horizontally centred on it', () => {
    const place = labelPlacement({ x: 40, y: 20, size: 8 }, 12, 60)
    expect(place.plateY).toBe(20 + 8 + LABEL_GAP_PX)
    expect(place.plateX + place.plateWidth / 2).toBeCloseTo(40)
    expect(place.textX).toBe(40)
    expect(place.baselineY).toBeGreaterThan(place.plateY)
    expect(place.baselineY).toBeLessThan(place.plateY + place.plateHeight)
  })
})
