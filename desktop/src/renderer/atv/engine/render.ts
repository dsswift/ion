/**
 * Canvas renderer: layout + entities → pixels. Draw-order logic only — every
 * behavioral decision lives in OfficeState/mapping. Untestable in jsdom by
 * design (no canvas there), so this file stays free of simulation logic.
 *
 * Draw order: floors → background furniture → walls → z-sorted (furniture +
 * characters by tile row) → surface items → bubbles.
 */
import { Cell, cellAt, type OfficeLayout } from '../generation/types'
import type { LoadedTheme, LoadedStrip } from '../theme/loader'
import { animationFor, mirroredFor } from './character'
import type { OfficeState } from './office-state'
import { drawBadges, drawDashboards, drawFxSprites, drawHeat, drawLighting } from './render-overlays'

/** Per-character tinted-sheet cache (characterId + tint → canvas per anim). */
const tintCache = new Map<string, HTMLCanvasElement>()

/** Palette tones reserved for the runtime tint layer (see asset-design.md). */
const TINT_TONES = ['#566073', '#6f7a90']

function tintedBitmap(strip: LoadedStrip, key: string, tint: string | null): CanvasImageSource | null {
  if (!strip.bitmap) return null
  if (!tint) return strip.bitmap
  const cacheKey = `${key}:${tint}`
  const cached = tintCache.get(cacheKey)
  if (cached) return cached
  const canvas = document.createElement('canvas')
  canvas.width = strip.frames * strip.frameW
  canvas.height = strip.frameH
  const ctx = canvas.getContext('2d')
  if (!ctx) return strip.bitmap
  ctx.drawImage(strip.bitmap, 0, 0)
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const tintRgb = [parseInt(tint.slice(1, 3), 16), parseInt(tint.slice(3, 5), 16), parseInt(tint.slice(5, 7), 16)]
  const tones = TINT_TONES.map((t) => [parseInt(t.slice(1, 3), 16), parseInt(t.slice(3, 5), 16), parseInt(t.slice(5, 7), 16)])
  for (let i = 0; i < img.data.length; i += 4) {
    for (const [ti, tone] of tones.entries()) {
      if (img.data[i] === tone[0] && img.data[i + 1] === tone[1] && img.data[i + 2] === tone[2]) {
        // Base tone gets the accent; the lighter tone gets a lightened accent.
        const lighten = ti === 1 ? 40 : 0
        img.data[i] = Math.min(255, tintRgb[0] + lighten)
        img.data[i + 1] = Math.min(255, tintRgb[1] + lighten)
        img.data[i + 2] = Math.min(255, tintRgb[2] + lighten)
      }
    }
  }
  ctx.putImageData(img, 0, 0)
  tintCache.set(cacheKey, canvas)
  return canvas
}

function drawStrip(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  strip: LoadedStrip,
  frame: number,
  px: number,
  py: number,
  mirrored: boolean,
): void {
  const sx = (frame % strip.frames) * strip.frameW
  if (mirrored) {
    ctx.save()
    ctx.translate(px + strip.frameW, py)
    ctx.scale(-1, 1)
    ctx.drawImage(source, sx, 0, strip.frameW, strip.frameH, 0, 0, strip.frameW, strip.frameH)
    ctx.restore()
  } else {
    ctx.drawImage(source, sx, 0, strip.frameW, strip.frameH, px, py, strip.frameW, strip.frameH)
  }
}

/** NESW wall-adjacency bitmask for the autotile strip. */
function wallMask(layout: OfficeLayout, x: number, y: number): number {
  let mask = 0
  if (cellAt(layout, x, y - 1) === Cell.Wall) mask |= 1
  if (cellAt(layout, x + 1, y) === Cell.Wall) mask |= 2
  if (cellAt(layout, x, y + 1) === Cell.Wall) mask |= 4
  if (cellAt(layout, x - 1, y) === Cell.Wall) mask |= 8
  return mask
}

export interface Camera {
  zoom: number
  offsetX: number
  offsetY: number
}

/**
 * Fit the whole office inside the viewport, centered, without stretching or
 * skewing: uniform scale only. Integer zoom whenever the office fits at 1x or
 * better (pixel-crisp); below 1x a fractional uniform scale keeps the entire
 * office visible rather than cropping it.
 */
export function fitCamera(layout: OfficeLayout, tile: number, viewW: number, viewH: number): Camera {
  const w = layout.width * tile
  const h = layout.height * tile
  // Continuous uniform scale (no integer stepping): resizing the window
  // smoothly rescales the office so it always fills the viewport, whole and
  // centered, without stretching or skew. A small margin keeps the outer
  // walls off the window edge.
  const zoom = Math.max(0.1, Math.min(viewW / w, viewH / h) * 0.97)
  return centeredCamera(layout, tile, viewW, viewH, zoom)
}

/** Center the office at a given zoom (manual-zoom starting position). */
export function centeredCamera(layout: OfficeLayout, tile: number, viewW: number, viewH: number, zoom: number): Camera {
  const w = layout.width * tile * zoom
  const h = layout.height * tile * zoom
  return { zoom, offsetX: Math.floor((viewW - w) / 2), offsetY: Math.floor((viewH - h) / 2) }
}

/**
 * Clamp a panned camera so the office never leaves the viewport entirely —
 * at least one office tile stays visible on each axis.
 */
export function clampCamera(camera: Camera, layout: OfficeLayout, tile: number, viewW: number, viewH: number): Camera {
  const w = layout.width * tile * camera.zoom
  const h = layout.height * tile * camera.zoom
  const margin = tile * camera.zoom
  return {
    zoom: camera.zoom,
    offsetX: Math.min(viewW - margin, Math.max(margin - w, camera.offsetX)),
    offsetY: Math.min(viewH - margin, Math.max(margin - h, camera.offsetY)),
  }
}

export function renderOffice(
  ctx: CanvasRenderingContext2D,
  office: OfficeState,
  theme: LoadedTheme,
  camera: Camera,
  animClock: number,
  fx?: import('./scene-fx').SceneFx | null,
): void {
  const layout = office.layout
  const tile = theme.tileSize
  ctx.imageSmoothingEnabled = false
  ctx.fillStyle = '#14161c'
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  ctx.save()
  ctx.translate(camera.offsetX, camera.offsetY)
  ctx.scale(camera.zoom, camera.zoom)

  // Floors: per-room floor tile inside rooms; corridor tiles draw the
  // layout's corridor floor so hallways never look like a room.
  const fallbackFloor = [...theme.floors.values()][0]?.bitmap ?? null
  const corridorFloor = layout.corridorFloorId
    ? theme.floors.get(layout.corridorFloorId)?.bitmap ?? fallbackFloor
    : fallbackFloor
  for (let y = 0; y < layout.height; y++) {
    for (let x = 0; x < layout.width; x++) {
      const cell = cellAt(layout, x, y)
      if (cell !== Cell.Floor && cell !== Cell.Door) continue
      const room = layout.rooms.find(
        (r) => x >= r.rect.x && x < r.rect.x + r.rect.w && y >= r.rect.y && y < r.rect.y + r.rect.h,
      )
      const floor = room?.floorId ? theme.floors.get(room.floorId)?.bitmap ?? fallbackFloor : corridorFloor
      if (floor) ctx.drawImage(floor, x * tile, y * tile)
    }
  }

  // Footstep-heat overlay (toggled): above floors, below everything else.
  if (fx?.heatEnabled) drawHeat(ctx, layout, fx, tile)

  // Background furniture (rugs and similar draw under everything).
  for (const placed of layout.furniture) {
    const item = theme.furniture.get(placed.itemId)
    if (!item?.manifest.backgroundTiles) continue
    drawFurniture(ctx, theme, placed.itemId, placed.variant, placed.x * tile, placed.y * tile, animClock)
  }

  // Walls (autotile by adjacency), with wall-mounted furniture on top.
  const wall = layout.wallId ? theme.walls.get(layout.wallId)?.bitmap : null
  for (let y = 0; y < layout.height; y++) {
    for (let x = 0; x < layout.width; x++) {
      if (cellAt(layout, x, y) !== Cell.Wall) continue
      if (wall) {
        ctx.drawImage(wall, wallMask(layout, x, y) * tile, 0, tile, tile, x * tile, y * tile, tile, tile)
      }
    }
  }
  for (const placed of layout.furniture) {
    const item = theme.furniture.get(placed.itemId)
    if (!item?.manifest.canPlaceOnWalls) continue
    drawFurniture(ctx, theme, placed.itemId, placed.variant, placed.x * tile, placed.y * tile, animClock)
  }

  // Z-sorted pass: floor furniture and characters interleaved by tile row.
  type Drawable = { row: number; draw: () => void }
  const drawables: Drawable[] = []
  for (const placed of layout.furniture) {
    const item = theme.furniture.get(placed.itemId)
    if (!item || item.manifest.canPlaceOnWalls || item.manifest.backgroundTiles) continue
    const row = placed.y + item.manifest.footprintH - 1 + (placed.onSurface ? 0.5 : 0)
    drawables.push({
      row,
      draw: () => drawFurniture(ctx, theme, placed.itemId, resolveState(office, theme, placed.itemId, placed.variant, placed.x, placed.y), placed.x * tile, placed.y * tile, animClock),
    })
  }
  for (const entity of office.entities.values()) {
    const sheet = entity.role === 'pet' ? theme.pets.get(entity.characterId) : theme.characters.get(entity.characterId)
    if (!sheet) continue
    const anim = animationFor(entity.sim)
    const strip = sheet.animations[anim] ?? sheet.animations.idle
    if (!strip) continue
    drawables.push({
      row: entity.sim.y + 0.75,
      draw: () => {
        const source = tintedBitmap(strip, `${entity.characterId}:${anim}`, entity.tint)
        if (!source) return
        const frame = Math.floor(entity.sim.animTime * 6) % strip.frames
        // Focus mode: entities outside the highlighted dispatch chain dim.
        const dimmed = fx?.focusChain != null && !fx.focusChain.has(entity.name) && entity.name !== '__manager__'
        if (dimmed) ctx.globalAlpha = 0.35
        drawStrip(ctx, source, strip, frame, Math.round(entity.sim.x * tile), Math.round(entity.sim.y * tile) - (strip.frameH - tile), mirroredFor(entity.sim))
        if (dimmed) ctx.globalAlpha = 1
      },
    })
  }
  drawables.sort((a, b) => a.row - b.row)
  for (const d of drawables) d.draw()

  // Activity lighting: dim rooms with nobody working; whole-office night
  // tint after sustained inactivity. Drawn BEFORE bubbles/dots/badges so
  // attention signals stay full-bright.
  if (fx) drawLighting(ctx, layout, fx, tile)

  // Bubbles float above everything.
  for (const entity of office.entities.values()) {
    if (!entity.bubble) continue
    // Packs without the optional attention artwork degrade to the permission
    // bubble rather than dropping the signal.
    const bitmap = theme.bubbles[entity.bubble.kind] ?? theme.bubbles.permission
    if (!bitmap) continue
    ctx.drawImage(bitmap, Math.round(entity.sim.x * tile), Math.round(entity.sim.y * tile) - tile - 2)
  }

  // Status dots: at-a-glance signal for which of the many characters carry
  // information worth hovering. Orange pulse = actively working; yellow
  // pulse = idle but waiting on dispatched children; green steady = has
  // completed work. Never-activated characters get no dot. Suppressed while
  // a speech bubble occupies the same spot.
  const pulse = 0.55 + 0.45 * Math.sin(animClock * 5)
  for (const entity of office.entities.values()) {
    if (entity.role === 'pet' || entity.bubble) continue
    let color: string | null = null
    let alpha = 1
    if (entity.working) {
      color = '#ff8c3c'
      alpha = pulse
    } else if (entity.waiting) {
      color = '#ffd23c'
      alpha = pulse
    } else if (entity.completed) {
      color = '#3ecf6e'
    }
    if (!color) continue
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.fillStyle = color
    const cx = Math.round(entity.sim.x * tile) + tile / 2
    const cy = Math.round(entity.sim.y * tile) - 3
    ctx.beginPath()
    ctx.arc(cx, cy, 1.8, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  // Live wall dashboards (kanban cards, cost sparkline) on flagged furniture.
  if (fx) drawDashboards(ctx, office, theme, tile, fx.dashboardData)

  // Tool badges: which tool each working character is using right now.
  drawBadges(ctx, office, tile)
  // Celebration confetti + error storm clouds float above everything.
  if (fx) drawFxSprites(ctx, office, fx, tile, animClock)
  ctx.restore()
}

/** Stateful items (pc screens) turn on when someone works right below them. */
function resolveState(
  office: OfficeState,
  theme: LoadedTheme,
  itemId: string,
  variant: string,
  x: number,
  y: number,
): string {
  const item = theme.furniture.get(itemId)
  if (!item?.manifest.states) return variant
  const stateKeys = Object.keys(item.images)
  if (!stateKeys.includes('on') || !stateKeys.includes('off')) return variant
  for (const entity of office.entities.values()) {
    const ex = Math.round(entity.sim.x)
    const ey = Math.round(entity.sim.y)
    const working = entity.sim.state === 'typing' || entity.sim.state === 'reading'
    if (working && Math.abs(ex - x) <= 1 && ey - y >= 0 && ey - y <= 2) return 'on'
  }
  return 'off'
}

function drawFurniture(
  ctx: CanvasRenderingContext2D,
  theme: LoadedTheme,
  itemId: string,
  variant: string,
  px: number,
  py: number,
  animClock: number,
): void {
  const item = theme.furniture.get(itemId)
  if (!item) return
  const mirrored = variant === 'left'
  const key = mirrored ? 'right' : variant
  const strip = item.images[key] ?? item.images[Object.keys(item.images).sort()[0]]
  if (!strip?.bitmap) return
  const frame = strip.frames > 1 ? Math.floor(animClock * 3) % strip.frames : 0
  // Tall items anchor bottom-left: overdraw rises above the footprint tile.
  const yOffset = strip.frameH - item.manifest.footprintH * theme.tileSize
  drawStrip(ctx, strip.bitmap, strip, frame, px, py - yOffset, mirrored)
}
