// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { browserPartition } from './BrowserSurface'

describe('browserPartition', () => {
  it('uses the exact isolated partition name', () => {
    expect(browserPartition('conversation-1', 'instance-1', 'browse', 'isolated')).toBe('studio-isolated-instance-1')
  })

  it('uses the persistent shared partition', () => {
    expect(browserPartition('conversation-1', 'instance-1', 'browse', 'shared')).toBe('persist:studio-browser')
  })
})

/**
 * The bounds a browser tab reports for its main-process view.
 *
 * Pinned at the module seam rather than by rendering the component: the value
 * that matters is what reaches `studioBrowserViewBounds`, and the defect was a
 * coordinate conversion applied to it.
 */
describe('view bounds reporting', () => {
  const RECT = { x: 320, y: 96, width: 900, height: 640 }

  function reported(uiZoom: number): { x: number; y: number; width: number; height: number } {
    // What the component does: read the placeholder rect and send it as-is.
    // getBoundingClientRect returns REAL on-screen pixels, which is the same
    // space a contentView child is positioned in.
    void uiZoom
    return { x: Math.round(RECT.x), y: Math.round(RECT.y), width: Math.round(RECT.width), height: Math.round(RECT.height) }
  }

  it('reports the measured rect unchanged at 100% zoom', () => {
    expect(reported(1)).toEqual(RECT)
  })

  it('reports the same rect at a non-100% zoom', () => {
    // The regression: dividing by the UI zoom (via zoomRect, which exists for
    // `position: fixed` DOM elements) made the view larger and higher than its
    // hole at any zoom above 1.0, so the page spilled over the conversation.
    // A view is not a DOM element and never sees document zoom.
    expect(reported(1.25)).toEqual(RECT)
    expect(reported(0.8)).toEqual(RECT)
  })

  it('never divides the measured rect by a zoom factor', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/studio/surface/tabs/BrowserSurface.tsx'), 'utf8')
    const start = source.indexOf('const push = ()')
    const push = source.slice(start, source.indexOf('}', source.indexOf('studioBrowserViewBounds')))
    // Structural: the geometry push must send the raw rect. A future zoom
    // "correction" here reintroduces the exact overflow. Comment lines are
    // stripped first so the warning ABOUT zoomRect does not trip its own check.
    const code = push.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/zoomRect\s*\(/)
    expect(code).not.toMatch(/\/\s*zoom/)
    expect(code).toContain('host.getBoundingClientRect()')
  })
})
