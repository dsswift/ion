/**
 * AtvCampus — the zoomed-out campus: one building per conversation, glowing
 * by live status (attention yellow / error red / working orange pulse /
 * idle dim), lit windows = working agents. Procedural pixel rendering on
 * its own canvas; clicking a building dives into that conversation.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { darkColors } from '../theme-tokens'
import { layoutCampus, campusSize, buildingGlow, buildingAt, type Building, type CampusEntry } from './engine/campus'
import { rInfo } from '../rendererLogger'

const TILE = 16
const REFRESH_MS = 2000

export interface AtvCampusProps {
  seed: string
  onSelect(tabId: string): void
  onExit(): void
}

export function AtvCampus(props: AtvCampusProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [entries, setEntries] = useState<CampusEntry[]>([])
  const buildingsRef = useRef<Building[]>([])
  const cameraRef = useRef({ zoom: 1, ox: 0, oy: 0 })

  const refresh = useCallback(async () => {
    const [tabs, summaries] = await Promise.all([window.ion.atvListTabs(), window.ion.atvGetAllStatus()])
    const byId = new Map(summaries.map((s) => [s.tabId, s]))
    setEntries(
      tabs.map((t) => {
        const s = byId.get(t.tabId)
        return {
          tabId: t.tabId,
          title: t.title,
          state: s?.state ?? t.status,
          working: s?.working ?? 0,
          error: s?.error ?? 0,
          total: s?.total ?? 0,
          pendingPermissions: s?.pendingPermissions ?? 0,
        }
      }),
    )
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), REFRESH_MS)
    return () => clearInterval(timer)
  }, [refresh])

  // Render loop: cheap enough to redraw on a short interval (pulse anim).
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let raf = 0
    const draw = (): void => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      canvas.width = canvas.clientWidth
      canvas.height = canvas.clientHeight
      const buildings = layoutCampus(entries.map((e) => e.tabId), props.seed)
      buildingsRef.current = buildings
      const size = campusSize(entries.length)
      const zoom = Math.max(0.5, Math.min(canvas.width / (size.w * TILE), canvas.height / (size.h * TILE)) * 0.9)
      const ox = (canvas.width - size.w * TILE * zoom) / 2
      const oy = (canvas.height - size.h * TILE * zoom) / 2
      cameraRef.current = { zoom, ox, oy }
      ctx.imageSmoothingEnabled = false
      ctx.fillStyle = '#101408'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.save()
      ctx.translate(ox, oy)
      ctx.scale(zoom, zoom)
      // Lawn.
      ctx.fillStyle = '#1c2a14'
      ctx.fillRect(0, 0, size.w * TILE, size.h * TILE)
      const byId = new Map(entries.map((e) => [e.tabId, e]))
      const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 300)
      for (const b of buildings) {
        const entry = byId.get(b.tabId)
        if (!entry) continue
        const glow = buildingGlow(entry)
        const px = b.x * TILE
        const py = b.y * TILE
        const pw = b.w * TILE
        const ph = b.h * TILE
        // Glow halo.
        ctx.save()
        ctx.globalAlpha = glow.pulse ? pulse * 0.5 : 0.3
        ctx.fillStyle = glow.color
        ctx.fillRect(px - 4, py - 4, pw + 8, ph + 8)
        ctx.restore()
        // Body + roof.
        ctx.fillStyle = '#2c2f3a'
        ctx.fillRect(px, py, pw, ph)
        ctx.fillStyle = '#3a3e4c'
        ctx.fillRect(px - 2, py - 6, pw + 4, 8)
        // Lit windows = working agents (capped by facade space).
        const lit = Math.min(entry.working, 8)
        for (let w = 0; w < 8; w++) {
          ctx.fillStyle = w < lit ? '#ffd76a' : '#191c24'
          ctx.fillRect(px + 6 + (w % 4) * 14, py + 8 + Math.floor(w / 4) * 16, 8, 10)
        }
        // Label.
        ctx.fillStyle = '#c8ccd8'
        ctx.font = '9px system-ui, sans-serif'
        const label = entry.title.length > 18 ? `${entry.title.slice(0, 18)}…` : entry.title
        ctx.fillText(label, px, py + ph + 12)
      }
      ctx.restore()
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [entries, props.seed])

  return (
    <div style={{ position: 'absolute', inset: 0, background: '#101408' }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block', cursor: 'pointer' }}
        onClick={(e) => {
          const { zoom, ox, oy } = cameraRef.current
          const tx = (e.nativeEvent.offsetX - ox) / (zoom * TILE)
          const ty = (e.nativeEvent.offsetY - oy) / (zoom * TILE)
          const hit = buildingAt(buildingsRef.current, Math.floor(tx), Math.floor(ty))
          if (hit) {
            rInfo('atv', 'campus building selected', { tab_id: hit.tabId })
            props.onSelect(hit.tabId)
          }
        }}
      />
      <button
        onClick={props.onExit}
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          border: `1px solid ${darkColors.containerBorder}`,
          borderRadius: 6,
          background: darkColors.containerBgCollapsed,
          color: darkColors.textPrimary,
          fontSize: 11,
          padding: '2px 8px',
          cursor: 'pointer',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        back to office
      </button>
    </div>
  )
}
