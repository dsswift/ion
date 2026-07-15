/**
 * render-overlays — the ATV's post-scene draw passes (badges today;
 * lighting, heat, particles, dashboards join in their own commits). Pure
 * placement/classification math lives in sibling modules (badges.ts …);
 * this file holds only ctx calls, per the render/logic split render.ts
 * itself follows.
 */
import type { OfficeState } from './office-state'
import type { OfficeLayout } from '../generation/types'
import type { SceneFx } from './scene-fx'
import { badgeKindOf, BADGE_COLORS, type BadgeKind } from './badges'
import { heatColor } from './scene-fx'
import { kanbanCards, sparklinePoints } from './dashboards'

/**
 * Footstep-heat overlay (toggled): tint floor tiles by cumulative visits.
 * Drawn right after the floor pass so furniture/characters stay readable.
 */
export function drawHeat(ctx: CanvasRenderingContext2D, layout: OfficeLayout, fx: SceneFx, tile: number): void {
  ctx.save()
  for (let y = 0; y < layout.height; y++) {
    for (let x = 0; x < layout.width; x++) {
      const color = heatColor(fx.visits[y * layout.width + x], fx.visitP95)
      if (!color) continue
      ctx.fillStyle = color
      ctx.fillRect(x * tile, y * tile, tile, tile)
    }
  }
  ctx.restore()
}

/**
 * Activity lighting: a translucent night-blue wash over rooms scaled by
 * (1 - brightness), plus a whole-office wash for the night tint. Cheap:
 * O(rooms) fillRects per frame.
 */
export function drawLighting(ctx: CanvasRenderingContext2D, layout: OfficeLayout, fx: SceneFx, tile: number): void {
  ctx.save()
  for (const room of layout.rooms) {
    const b = (fx.brightness.get(room.id) ?? 1) * fx.globalBrightness
    if (b >= 0.98) continue
    ctx.fillStyle = `rgba(10, 12, 24, ${(1 - b) * 0.75})`
    ctx.fillRect(room.rect.x * tile, room.rect.y * tile, room.rect.w * tile, room.rect.h * tile)
  }
  // Corridor + everything else under the global (night) tint only.
  if (fx.globalBrightness < 0.98) {
    ctx.fillStyle = `rgba(8, 10, 22, ${(1 - fx.globalBrightness) * 0.5})`
    ctx.fillRect(0, 0, layout.width * tile, layout.height * tile)
  }
  ctx.restore()
}

/** Procedural 5px badge glyphs — ship art-free; crisp at integer zooms. */
function drawGlyph(ctx: CanvasRenderingContext2D, kind: BadgeKind, x: number, y: number): void {
  ctx.strokeStyle = '#e8e8ec'
  ctx.fillStyle = '#e8e8ec'
  ctx.lineWidth = 1
  switch (kind) {
    case 'terminal': // >_
      ctx.beginPath()
      ctx.moveTo(x + 1, y + 1)
      ctx.lineTo(x + 3, y + 3)
      ctx.lineTo(x + 1, y + 5)
      ctx.stroke()
      ctx.fillRect(x + 4, y + 4, 3, 1)
      break
    case 'search': // magnifier
      ctx.beginPath()
      ctx.arc(x + 3, y + 2.5, 2, 0, Math.PI * 2)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(x + 4.5, y + 4)
      ctx.lineTo(x + 6.5, y + 6)
      ctx.stroke()
      break
    case 'edit': // pencil
      ctx.beginPath()
      ctx.moveTo(x + 1, y + 6)
      ctx.lineTo(x + 5.5, y + 1.5)
      ctx.stroke()
      ctx.fillRect(x + 1, y + 5, 2, 2)
      break
    case 'web': // globe
      ctx.beginPath()
      ctx.arc(x + 3.5, y + 3.5, 2.5, 0, Math.PI * 2)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(x + 1, y + 3.5)
      ctx.lineTo(x + 6, y + 3.5)
      ctx.stroke()
      break
    case 'task': // fan-out
      ctx.fillRect(x + 3, y + 1, 1, 2)
      ctx.fillRect(x + 1, y + 4, 1, 2)
      ctx.fillRect(x + 5, y + 4, 1, 2)
      break
    default: // generic gear dot
      ctx.beginPath()
      ctx.arc(x + 3.5, y + 3.5, 1.5, 0, Math.PI * 2)
      ctx.fill()
      break
  }
}

/**
 * Live wall dashboards: furniture whose manifest carries `dashboard` renders
 * real data inside its pixel bounds — kanban → dispatch cards; sparkline →
 * $/min trend; cost-plaque → conversation cost text.
 */
export interface DashboardData {
  dispatchStatuses: string[]
  sparkline: number[]
  conversationCostUsd: number
}

export function drawDashboards(
  ctx: CanvasRenderingContext2D,
  office: OfficeState,
  theme: { furniture: Map<string, { manifest: { dashboard?: string; width: number; height: number } }> },
  tile: number,
  data: DashboardData,
): void {
  for (const placed of office.layout.furniture) {
    const item = theme.furniture.get(placed.itemId)
    const kind = item?.manifest.dashboard
    if (!item || !kind) continue
    const px = placed.x * tile + 2
    const py = placed.y * tile + 2
    const w = item.manifest.width - 4
    const h = item.manifest.height - 4
    ctx.save()
    if (kind === 'kanban') {
      for (const card of kanbanCards(data.dispatchStatuses, w, h)) {
        ctx.fillStyle = card.color
        ctx.fillRect(px + card.x, py + card.y, card.w, card.h)
      }
    } else if (kind === 'sparkline') {
      const pts = sparklinePoints(data.sparkline, w, h)
      if (pts.length > 1) {
        ctx.strokeStyle = '#3ecf6e'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(px + pts[0].x, py + pts[0].y)
        for (const p of pts.slice(1)) ctx.lineTo(px + p.x, py + p.y)
        ctx.stroke()
      }
    } else if (kind === 'cost-plaque' && data.conversationCostUsd > 0) {
      ctx.fillStyle = '#e8e8ec'
      ctx.font = '5px monospace'
      ctx.fillText(`$${data.conversationCostUsd.toFixed(2)}`, px, py + 5)
    }
    ctx.restore()
  }
}

/** Confetti + storm-cloud micro-moods (procedural — no pack assets needed). */
export function drawFxSprites(ctx: CanvasRenderingContext2D, office: OfficeState, fx: SceneFx, tile: number, animClock: number): void {
  // Confetti: 2px rects in tile space.
  for (const p of fx.particles) {
    ctx.fillStyle = p.color
    ctx.globalAlpha = Math.min(1, p.ttl)
    ctx.fillRect(Math.round(p.x * tile), Math.round(p.y * tile), 2, 2)
  }
  ctx.globalAlpha = 1
  // Storm cloud over slumped (errored) characters: three gray puffs + rain.
  for (const entity of office.entities.values()) {
    if (entity.sim.state !== 'slumped') continue
    const cx = Math.round(entity.sim.x * tile) + tile / 2
    const cy = Math.round(entity.sim.y * tile) - tile - 6
    ctx.fillStyle = 'rgba(90, 95, 110, 0.9)'
    for (const [dx, dy, r] of [[-4, 0, 3.4], [0, -2, 4.2], [4, 0, 3.4]] as const) {
      ctx.beginPath()
      ctx.arc(cx + dx, cy + dy, r, 0, Math.PI * 2)
      ctx.fill()
    }
    // Rain pixels animate downward.
    ctx.fillStyle = 'rgba(120, 160, 220, 0.85)'
    const phase = (animClock * 8) % 4
    for (const dx of [-3, 0, 3]) {
      ctx.fillRect(cx + dx, cy + 5 + ((phase + dx) % 4), 1, 2)
    }
  }
}

/**
 * Tool badges above working characters: which tool each agent is using,
 * legible at a glance. Suppressed while a bubble occupies the slot (bubbles
 * are attention signals — they win).
 */
export function drawBadges(ctx: CanvasRenderingContext2D, office: OfficeState, tile: number): void {
  for (const entity of office.entities.values()) {
    if (entity.role === 'pet' || entity.bubble || !entity.working) continue
    const kind = badgeKindOf(entity.activity)
    if (!kind) continue
    const x = Math.round(entity.sim.x * tile) + tile - 4
    const y = Math.round(entity.sim.y * tile) - tile + 2
    ctx.save()
    ctx.fillStyle = BADGE_COLORS[kind]
    ctx.globalAlpha = 0.92
    ctx.beginPath()
    ctx.roundRect(x - 1, y - 1, 9, 9, 2)
    ctx.fill()
    ctx.globalAlpha = 1
    drawGlyph(ctx, kind, x, y)
    ctx.restore()
  }
}
