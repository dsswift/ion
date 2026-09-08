/**
 * GraphMinimap — a small 2D canvas in the stage's corner showing every
 * visible node as a dot and the current viewport as a rectangle. Clicking it
 * centres the camera on that point. It hides itself while the viewport
 * already shows the whole graph, so it only takes space when it orients.
 *
 * Repaints ride sigma's `afterRender`, throttled the same way as the hull
 * overlay: a running simulation renders every frame, and re-projecting the
 * whole graph per frame is main-thread work the frame budget cannot absorb.
 * The canvas is a sibling of the stage (rendered by `GraphSurface`), so it
 * receives the live sigma instance as a prop rather than reaching into the
 * canvas component.
 */

import React, { useEffect, useRef } from 'react'
import type Sigma from 'sigma'
import { useColors } from '../../../theme'
import { useGraphStore } from '../graph-store'
import { withAlpha } from '../color-alpha'
import { minimapPointToGraph, projectMinimap, viewportCoversGraph, type MinimapProjection } from './minimap-projection'

export const MINIMAP_WIDTH_PX = 160
export const MINIMAP_HEIGHT_PX = 110
const REDRAW_INTERVAL_MS = 80
const DOT_RADIUS_PX = 1.5
/** The inspector is a 300px right-docked panel; the minimap steps left of it when it is open. */
const INSPECTOR_WIDTH_PX = 300

export function GraphMinimap({ sigma }: { sigma: Sigma | null }): React.JSX.Element | null {
  const colors = useColors()
  const colorsRef = useRef(colors)
  colorsRef.current = colors
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const projectionRef = useRef<MinimapProjection | null>(null)
  const requestCamera = useGraphStore((s) => s.requestCamera)
  const inspectorOpen = useGraphStore((s) => s.selectedNodeIds.size > 0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!sigma || !canvas) return

    let lastDraw = 0
    const draw = (): void => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const dpr = window.devicePixelRatio || 1
      if (canvas.width !== MINIMAP_WIDTH_PX * dpr || canvas.height !== MINIMAP_HEIGHT_PX * dpr) {
        canvas.width = MINIMAP_WIDTH_PX * dpr
        canvas.height = MINIMAP_HEIGHT_PX * dpr
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, MINIMAP_WIDTH_PX, MINIMAP_HEIGHT_PX)

      const visible = useGraphStore.getState().visibleNodeIds
      const graph = sigma.getGraph()
      const points: { x: number; y: number }[] = []
      graph.forEachNode((id, attrs) => {
        // A synthetic cluster node stands in for members that are visible; it is not in the set itself.
        if (attrs.kind !== 'cluster' && !visible.has(id)) return
        points.push({ x: attrs.x as number, y: attrs.y as number })
      })
      const { width, height } = sigma.getDimensions()
      const corners = [
        sigma.viewportToGraph({ x: 0, y: 0 }),
        sigma.viewportToGraph({ x: width, y: 0 }),
        sigma.viewportToGraph({ x: width, y: height }),
        sigma.viewportToGraph({ x: 0, y: height }),
      ]
      const projection = projectMinimap(points, corners, { width: MINIMAP_WIDTH_PX, height: MINIMAP_HEIGHT_PX })
      projectionRef.current = projection
      const covered = !projection || viewportCoversGraph(projection)
      canvas.style.display = covered ? 'none' : 'block'
      if (!projection || covered) return

      const palette = colorsRef.current
      ctx.fillStyle = palette.graphNodeDefault
      for (const d of projection.dots) {
        ctx.beginPath()
        ctx.arc(d.x, d.y, DOT_RADIUS_PX, 0, Math.PI * 2)
        ctx.fill()
      }
      const r = projection.viewportRect
      ctx.fillStyle = withAlpha(palette.accent, 0.12)
      ctx.strokeStyle = palette.accent
      ctx.lineWidth = 1
      ctx.fillRect(r.x, r.y, r.width, r.height)
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, Math.max(0, r.width - 1), Math.max(0, r.height - 1))
    }

    const onAfterRender = (): void => {
      const now = Date.now()
      if (now - lastDraw < REDRAW_INTERVAL_MS) return
      lastDraw = now
      draw()
    }
    sigma.on('afterRender', onAfterRender)
    draw()
    return () => {
      sigma.off('afterRender', onAfterRender)
    }
  }, [sigma])

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const projection = projectionRef.current
    const canvas = canvasRef.current
    if (!projection || !canvas) return
    const rect = canvas.getBoundingClientRect()
    // The stage may be counter-zoomed against the app's root zoom; the
    // canvas's CSS size is authoritative for its own pixel space.
    const px = ((e.clientX - rect.left) / rect.width) * MINIMAP_WIDTH_PX
    const py = ((e.clientY - rect.top) / rect.height) * MINIMAP_HEIGHT_PX
    const target = minimapPointToGraph({ x: px, y: py }, projection)
    requestCamera({ kind: 'center', x: target.x, y: target.y })
  }

  if (!sigma) return null
  return (
    <canvas
      ref={canvasRef}
      onClick={onClick}
      aria-label="Graph minimap"
      style={{
        position: 'absolute',
        right: inspectorOpen ? INSPECTOR_WIDTH_PX + 8 : 8,
        bottom: 8,
        width: MINIMAP_WIDTH_PX,
        height: MINIMAP_HEIGHT_PX,
        borderRadius: 6,
        background: colors.surfaceSecondary,
        border: `1px solid ${colors.containerBorder}`,
        cursor: 'crosshair',
        display: 'none',
      }}
    />
  )
}
