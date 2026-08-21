import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CaretLeft, CaretRight } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { rInfo } from '../../rendererLogger'
import { ImageViewer, useImageDataUrl } from '../ImageViewer'
import { Tooltip } from '../git/Tooltip'
import { contentRouter } from '../../lib/file-open-router'

/**
 * ImageGallery — the single inline-image surface for the transcript.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Inline images used to render as a vertical `flex-col` of ~260px-tall
 * thumbnails, one stack per message and (via ToolImagesStrip) one stack per
 * tool row. A turn that read dozens of images — an MCP tool returning fifty
 * app screens is the real case that prompted this — produced thousands of
 * pixels of continuous image list, burying the rest of the transcript.
 *
 * So a multi-image set renders as a horizontal snap rail of short tiles: a
 * bounded, fixed-height band no matter how many images are in it. The images
 * stay fully reachable (page the rail, expand to a grid, open the viewer and
 * walk the set) without any of them dictating the transcript's height.
 *
 * ── The one-image case is deliberately unchanged ────────────────────────────
 * A single pasted screenshot is the common case and reads best as one large
 * thumbnail. It keeps the previous treatment exactly (280px wide, up to 260px
 * tall, no rail chrome). The rail only appears once there are 2+ images, which
 * is the point where a stack starts costing vertical space.
 */

/** One image in a gallery. `caption` names the producing tool, when known. */
export interface GalleryImage {
  /** Stable React key. Callers key per owning message/tool, not per path. */
  key: string
  path: string
  name: string
  /** Persisted base64 fallback for images whose on-disk file is gone. */
  dataUrl?: string
  /** Producing tool name, surfaced in the tile hover label. */
  caption?: string
}

/** Tiles shown in the collapsed rail before the `+N more` slot takes over. */
export const GALLERY_RAIL_CAP = 12
/** Rail tile height, px. */
const RAIL_TILE_HEIGHT = 120
/** Expanded-grid tile height, px. */
const GRID_TILE_HEIGHT = 96
/** Width of the largest tile a single-image gallery renders, px. */
const SOLO_MAX_WIDTH = 280
/** Height cap for the single-image tile, px. */
const SOLO_MAX_HEIGHT = 260

/**
 * How many tiles the collapsed rail paints, and how many are folded into the
 * `+N more` slot.
 *
 * Pure so the cap arithmetic is testable without a DOM. When the set exceeds
 * the cap the last visible slot is spent on the overflow tile itself, so the
 * rail shows CAP-1 images plus the affordance rather than CAP images and a
 * hidden remainder the user has no way to reach.
 */
export function galleryLayout(count: number, expanded: boolean): { visible: number; overflow: number } {
  if (expanded || count <= GALLERY_RAIL_CAP) return { visible: count, overflow: 0 }
  return { visible: GALLERY_RAIL_CAP - 1, overflow: count - (GALLERY_RAIL_CAP - 1) }
}

export function ImageGallery({ items, align = 'start' }: { items: GalleryImage[]; align?: 'start' | 'end' }) {
  const colors = useColors()
  const railRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  // Which tile indices have ever entered the rail viewport. A tile only reads
  // its bytes over IPC once it has been seen, so a fifty-image rail costs the
  // handful of reads that are actually on screen.
  const [seen, setSeen] = useState<Set<number>>(() => new Set())
  // Scroll position drives both the chevron disabled states and which edge
  // fades. Recomputed on scroll and on resize.
  const [scrollState, setScrollState] = useState({ atStart: true, atEnd: true, overflowing: false })

  const count = items.length
  const { visible, overflow } = galleryLayout(count, expanded)

  useEffect(() => {
    rInfo('conversation', 'rendering image gallery', { images: count, capped: count > GALLERY_RAIL_CAP, expanded })
  }, [count, expanded])

  const measure = useCallback(() => {
    const el = railRef.current
    if (!el) return
    const overflowing = el.scrollWidth > el.clientWidth + 1
    setScrollState({
      overflowing,
      atStart: el.scrollLeft <= 1,
      atEnd: el.scrollLeft >= el.scrollWidth - el.clientWidth - 1,
    })
  }, [])

  // Re-measure whenever the rail's content or box changes. ResizeObserver
  // covers the pane-resize case; the item-count dependency covers expansion.
  useEffect(() => {
    const el = railRef.current
    if (!el) return
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure, visible, expanded])

  // Lazy-load gating: mark a tile seen the first time it intersects the rail.
  // Same pattern as the git graph's infinite-scroll sentinel. Where the API is
  // unavailable (jsdom, older embedders) every tile is treated as seen, so the
  // gallery degrades to eager loading rather than to blank tiles.
  useEffect(() => {
    const root = railRef.current
    if (!root) return
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(new Set(items.map((_, i) => i)))
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const arrived: number[] = []
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const idx = Number((entry.target as HTMLElement).dataset.galleryIndex)
          if (!Number.isNaN(idx)) arrived.push(idx)
        }
        if (arrived.length === 0) return
        setSeen((prev) => {
          const next = new Set(prev)
          for (const i of arrived) next.add(i)
          return next
        })
      },
      { root, rootMargin: '200px', threshold: 0.01 },
    )
    for (const tile of root.querySelectorAll('[data-gallery-index]')) observer.observe(tile)
    return () => observer.disconnect()
  }, [items, visible, expanded])

  const page = useCallback((direction: -1 | 1) => {
    const el = railRef.current
    if (!el) return
    el.scrollBy({ left: direction * el.clientWidth * 0.9, behavior: 'smooth' })
  }, [])

  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => {
      rInfo('conversation', 'image gallery expand toggled', { images: count, expanded: !prev })
      return !prev
    })
  }, [count])

  const siblings = useMemo(() => items.map((i) => ({ path: i.path, name: i.name })), [items])
  const openItem = useCallback((index: number) => {
    const item = items[index]
    if (!item) return
    const router = contentRouter()
    if (router) router.openImage(item.path, item.dataUrl)
    else setSelected(index)
  }, [items])
  const closeViewer = useCallback(() => setSelected(null), [])

  if (count === 0) return null

  const viewer = selected != null && items[selected] ? (
    <ImageViewer
      filePath={items[selected].path}
      fileName={items[selected].name}
      siblings={siblings}
      index={selected}
      onNavigate={setSelected}
      onClose={closeViewer}
    />
  ) : null

  // Single image: the pre-rail treatment, unchanged.
  if (count === 1) {
    return (
      <>
        <div className={`flex mb-1 ${align === 'end' ? 'justify-end' : 'justify-start'}`}>
          <GalleryTile
            item={items[0]}
            index={0}
            load
            maxWidth={SOLO_MAX_WIDTH}
            maxHeight={SOLO_MAX_HEIGHT}
            snap={false}
            onOpen={() => openItem(0)}
          />
        </div>
        {viewer}
      </>
    )
  }

  const tileHeight = expanded ? GRID_TILE_HEIGHT : RAIL_TILE_HEIGHT
  // Fade the edge the rail can still scroll toward, so a partly-visible tile
  // reads as "there is more this way" instead of being hard-clipped.
  const fadeLeft = !expanded && scrollState.overflowing && !scrollState.atStart
  const fadeRight = !expanded && scrollState.overflowing && !scrollState.atEnd
  const maskImage = fadeLeft || fadeRight
    ? `linear-gradient(to right, transparent 0, black ${fadeLeft ? '32px' : '0'}, black calc(100% - ${fadeRight ? '32px' : '0px'}), transparent 100%)` // hardcoded-ok: mask gradient stops are alpha keyframes, not themed colors
    : undefined

  return (
    <>
      <div className={`flex flex-col gap-1 mb-1 ${align === 'end' ? 'items-end' : 'items-start'}`} style={{ maxWidth: '100%' }}>
        <div className="flex items-center gap-2 px-0.5">
          <span className="text-[10px] tabular-nums" style={{ color: colors.textTertiary }}>
            {count} images
          </span>
          {count > GALLERY_RAIL_CAP && (
            <button
              type="button"
              onClick={toggleExpanded}
              className="text-[10px] rounded px-1 transition-colors"
              style={{ color: colors.textTertiary, cursor: 'pointer' }}
              onMouseEnter={(e) => { e.currentTarget.style.color = colors.accent }}
              onMouseLeave={(e) => { e.currentTarget.style.color = colors.textTertiary }}
            >
              {expanded ? 'Show less' : 'Show all'}
            </button>
          )}
        </div>

        <div className="relative" style={{ maxWidth: '100%' }}>
          <div
            ref={railRef}
            onScroll={measure}
            data-testid="image-gallery-rail"
            className={expanded ? 'flex flex-wrap gap-1' : 'flex gap-1 overflow-x-auto'}
            style={{
              maxWidth: '100%',
              scrollSnapType: expanded ? undefined : 'x mandatory',
              scrollbarWidth: 'none',
              maskImage,
              WebkitMaskImage: maskImage,
            }}
          >
            {items.slice(0, visible).map((item, i) => (
              <GalleryTile
                key={item.key}
                item={item}
                index={i}
                load={seen.has(i)}
                maxHeight={tileHeight}
                snap={!expanded}
                onOpen={() => openItem(i)}
              />
            ))}
            {overflow > 0 && (
              <button
                type="button"
                onClick={toggleExpanded}
                className="flex-shrink-0 flex items-center justify-center rounded-lg border text-[11px] font-medium transition-colors"
                style={{
                  height: tileHeight,
                  minWidth: 72,
                  padding: '0 12px',
                  scrollSnapAlign: 'start',
                  background: colors.surfacePrimary,
                  borderColor: colors.toolBorder,
                  color: colors.textSecondary,
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = colors.surfaceHover }}
                onMouseLeave={(e) => { e.currentTarget.style.background = colors.surfacePrimary }}
              >
                +{overflow} more
              </button>
            )}
          </div>

          {/* Chevrons only exist while the rail can actually scroll. */}
          {!expanded && scrollState.overflowing && (
            <>
              <RailButton side="left" disabled={scrollState.atStart} onClick={() => page(-1)} />
              <RailButton side="right" disabled={scrollState.atEnd} onClick={() => page(1)} />
            </>
          )}
        </div>
      </div>
      {viewer}
    </>
  )
}

/** Overlaid page control pinned to one edge of the rail. */
function RailButton({ side, disabled, onClick }: { side: 'left' | 'right'; disabled: boolean; onClick: () => void }) {
  const colors = useColors()
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={side === 'left' ? 'Scroll images left' : 'Scroll images right'}
      className="absolute top-1/2 flex items-center justify-center rounded-full border transition-opacity"
      style={{
        [side]: 4,
        transform: 'translateY(-50%)',
        width: 22,
        height: 22,
        background: colors.popoverBg,
        borderColor: colors.containerBorder,
        color: colors.textSecondary,
        opacity: disabled ? 0.3 : 0.9,
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {side === 'left' ? <CaretLeft size={12} /> : <CaretRight size={12} />}
    </button>
  )
}

function GalleryTile({
  item,
  index,
  load,
  maxHeight,
  maxWidth,
  snap,
  onOpen,
}: {
  item: GalleryImage
  index: number
  /** False until the tile has entered the rail viewport (gates the IPC read). */
  load: boolean
  maxHeight: number
  maxWidth?: number
  snap?: boolean
  onOpen: () => void
}) {
  const colors = useColors()
  const dataUrl = useImageDataUrl(item.path, item.dataUrl, load)
  const label = item.caption ? `${item.name} · ${item.caption}` : item.name

  // Tooltip wraps its child in its own inline-flex span (git/HoverCard.tsx),
  // and THAT span — not the tile inside it — is the rail's flex item. So the
  // sizing that makes the rail scroll has to live on the wrapper: a
  // flex-shrink-0 on the inner element leaves the wrapper free to compress,
  // the tiles squash instead of overflowing, and measure() then sees
  // scrollWidth <= clientWidth and reports the rail as non-overflowing —
  // silently disabling the chevrons and the edge fade as well. Same reasoning
  // for scroll-snap-align: it applies to the scroll container's item.
  // Tooltip's `style` prop exists for exactly this case.
  const wrapperStyle: React.CSSProperties = {
    flexShrink: 0,
    scrollSnapAlign: snap ? 'start' : undefined,
  }

  // Not yet loaded, or the file is gone with no persisted fallback: the same
  // name placeholder the pre-gallery tile showed, sized to hold the rail's
  // line so scroll geometry doesn't jump when the image lands.
  if (!dataUrl) {
    return (
      <Tooltip text={label} style={wrapperStyle}>
        <div
          data-gallery-index={index}
          className="flex-shrink-0 flex items-center px-2 rounded-lg border text-[11px] truncate"
          style={{
            height: maxHeight,
            minWidth: 96,
            maxWidth: 160,
            background: colors.surfacePrimary,
            borderColor: colors.surfaceSecondary,
            color: colors.textTertiary,
          }}
        >
          {item.name}
        </div>
      </Tooltip>
    )
  }

  return (
    <Tooltip text={label} style={wrapperStyle}>
      <button
        type="button"
        data-gallery-index={index}
        className="flex-shrink-0 block rounded-lg overflow-hidden border cursor-pointer"
        style={{
          borderColor: colors.toolBorder,
          background: colors.surfacePrimary,
          maxWidth,
        }}
        onClick={onOpen}
      >
        <img
          src={dataUrl}
          alt={item.name}
          className="block object-contain"
          style={{ height: maxWidth ? undefined : maxHeight, maxHeight, maxWidth: maxWidth ?? undefined, width: maxWidth ? '100%' : undefined }}
          loading="lazy"
        />
      </button>
    </Tooltip>
  )
}
