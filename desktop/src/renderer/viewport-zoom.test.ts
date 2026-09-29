// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { usePreferencesStore } from './preferences'
import { zoomAnchorEdges } from './viewport-zoom'

const setZoom = (uiZoom: number): void => usePreferencesStore.setState({ uiZoom })
const setWindow = (width: number, height: number): void => {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true })
}

afterEach(() => setZoom(1))

describe('zoomAnchorEdges', () => {
  // A trigger 40px wide whose top edge is 100px above the window bottom and
  // whose right edge is 60px from the window right, all in viewport pixels.
  const trigger = new DOMRect(900, 700, 40, 20)

  it('passes viewport pixels through at 100% zoom', () => {
    setZoom(1)
    setWindow(1000, 800)
    const edges = zoomAnchorEdges(trigger)
    expect(edges.fromBottom).toBe(100)
    expect(edges.fromRight).toBe(60)
    expect(edges.left).toBe(900)
    expect(edges.centerX).toBe(920)
  })

  it('returns CSS lengths that land on the trigger under zoom', () => {
    setZoom(1.25)
    setWindow(1000, 800)
    const edges = zoomAnchorEdges(trigger)
    // CSS length x zoom must reproduce the viewport distance to the trigger.
    expect(edges.fromBottom * 1.25).toBeCloseTo(100)
    expect(edges.fromRight * 1.25).toBeCloseTo(60)
    expect(edges.left * 1.25).toBeCloseTo(900)
    expect(edges.centerX * 1.25).toBeCloseTo(920)
    // The unconverted value is what the pop-ups used to spend.
    expect(edges.fromBottom).not.toBe(100)
  })

  it('holds below 100% zoom', () => {
    setZoom(0.8)
    setWindow(1000, 800)
    expect(zoomAnchorEdges(trigger).fromBottom * 0.8).toBeCloseTo(100)
  })
})
