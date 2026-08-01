import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useColors } from '../../theme'
import { rWarn } from '../../rendererLogger'
import {
  TIMELINE_MINIMAP_EXPANDED_STRIP_WIDTH,
  TIMELINE_MINIMAP_GUTTER_WIDTH,
  TIMELINE_MINIMAP_JUMP_OFFSET,
  TIMELINE_MINIMAP_MIN_ITEMS,
  TIMELINE_MINIMAP_RAIL_INSET,
  resolveTimelineMinimapHeightStyle,
  resolveTimelineMinimapIndexFromPointer,
  resolveTimelineMinimapTopPercent,
  resolveTooltipTranslate,
  type TimelineMinimapItem,
} from './TimelineMinimap.logic'

/**
 * Conversation timeline minimap in a dedicated left gutter. One tick per
 * user message ("chapter"); hover animates tick widths by distance from the
 * pointer, a glass tooltip previews the chapter, click jumps the transcript
 * to that message. Ported from T3 code's TimelineMinimap (pingdotgg/t3code,
 * MessagesTimeline.tsx) and adapted to Ion's plain scrollable transcript:
 * jumps and in-view tracking are DOM operations against [data-message-id]
 * anchors instead of virtual-list index math, and the rail lives in reserved
 * layout space (a flex sibling of the scroll container) rather than a
 * hover-revealed overlay — the transcript can never render under it.
 */

interface TimelineMinimapProps {
  items: ReadonlyArray<TimelineMinimapItem>
  scrollRef: React.RefObject<HTMLDivElement | null>
}

/** Events originating inside the preview tooltip must not retarget or jump. */
function eventTargetsPreview(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-minimap-preview]') !== null
}

/**
 * Escape a message id for use inside a quoted attribute selector. Only
 * backslash and double-quote are meaningful there. (CSS.escape is absent in
 * jsdom, and ids are nanoids anyway — this covers the general case.)
 */
function escapeAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function findMessageAnchor(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    `[data-message-id="${escapeAttributeValue(id)}"]`,
  )
}

/** Tick width by distance from the active (hovered/focused) index. */
function tickWidth(activeDistance: number | null): number {
  if (activeDistance === 0) return 24
  if (activeDistance === 1) return 16
  if (activeDistance === 2) return 10
  return 8
}

export function TimelineMinimap({ items, scrollRef }: TimelineMinimapProps) {
  const colors = useColors()
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  // Ids of chapters currently visible in the scroll viewport. React state
  // (not imperative style writes) so tick styling has exactly one owner —
  // an imperative backgroundColor reset used to erase the React-set dim
  // color and hide every off-screen tick. Fed by the IntersectionObserver
  // below and updated only on actual membership change, so scrolling within
  // one chapter never re-renders.
  const [inViewIds, setInViewIds] = useState<ReadonlySet<string>>(() => new Set())
  // Fine-pointer gate: the minimap is a hover interaction. Static check —
  // this is a desktop app and the pointer class doesn't change at runtime.
  const [finePointer] = useState(
    () => typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches,
  )

  const resolvedActiveIndex = activeIndex !== null && activeIndex < items.length ? activeIndex : null
  const activeItem = resolvedActiveIndex === null ? null : (items[resolvedActiveIndex] ?? null)
  const activeTopPercent =
    resolvedActiveIndex === null
      ? 0
      : resolveTimelineMinimapTopPercent(resolvedActiveIndex, items.length)
  const activeTooltipTranslate =
    resolvedActiveIndex === null ? '-50%' : resolveTooltipTranslate(resolvedActiveIndex, items.length)

  const resolveActiveIndexFromPointer = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const rect = event.currentTarget.getBoundingClientRect()
      return resolveTimelineMinimapIndexFromPointer({
        itemCount: items.length,
        railTop: rect.top,
        railHeight: rect.height,
        pointerY: event.clientY,
      })
    },
    [items.length],
  )

  const moveActiveIndex = useCallback(
    (delta: number) => {
      setActiveIndex((current) => {
        const base = current ?? 0
        return Math.max(0, Math.min(items.length - 1, base + delta))
      })
    },
    [items.length],
  )

  const jumpToItem = useCallback(
    (item: TimelineMinimapItem) => {
      const container = scrollRef.current
      if (!container) return // silent-ok: scroll container unmounted (tab teardown race) — nothing to scroll
      const anchor = findMessageAnchor(container, item.id)
      if (!anchor) {
        // Invariant violation: items derive from the same messages whose
        // bubbles stamp data-message-id, and the full history is mounted —
        // a miss means the anchor contract broke.
        rWarn('conversation', 'minimap jump anchor missing', { message_id: item.id.slice(0, 8) })
        return
      }
      container.scrollTo({
        top: Math.max(0, anchor.offsetTop - TIMELINE_MINIMAP_JUMP_OFFSET),
        behavior: 'smooth',
      })
    },
    [scrollRef],
  )

  // Stable key for the chapter id set. Streaming chunks rebuild `items`
  // (the last item's assistantText changes per chunk) without changing the
  // ids — the in-view subscription must not resubscribe for those.
  const itemIdsKey = useMemo(() => items.map((item) => item.id).join('\n'), [items])

  // In-view tracking: an IntersectionObserver rooted at the scroll container
  // observes each chapter's anchor and feeds membership into inViewIds.
  // The precise platform mechanism — no per-frame DOM scans, no scroll
  // listener; the observer fires only on actual visibility transitions.
  // Keyed on the chapter id SET, so it re-wires only when a chapter is
  // added or removed.
  useEffect(() => {
    const container = scrollRef.current
    if (!container || itemIdsKey.length === 0 || !finePointer) return

    const ids = itemIdsKey.split('\n')
    const visible = new Set<string>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.messageId
          if (!id) continue
          if (entry.isIntersecting) {
            visible.add(id)
          } else {
            visible.delete(id)
          }
        }
        setInViewIds((current) => {
          if (current.size === visible.size) {
            let same = true
            for (const id of visible) {
              if (!current.has(id)) { same = false; break }
            }
            if (same) return current
          }
          return new Set(visible)
        })
      },
      { root: container },
    )

    // Anchors render in the same React commit as the minimap (both derive
    // from the same messages state), but defer one frame so a brand-new
    // chapter's bubble is guaranteed mounted before we query it.
    let frame = 0
    frame = requestAnimationFrame(() => {
      frame = 0
      for (const id of ids) {
        const anchor = findMessageAnchor(container, id)
        if (anchor) observer.observe(anchor)
      }
    })

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [scrollRef, itemIdsKey, finePointer])

  const railHeight = useMemo(() => resolveTimelineMinimapHeightStyle(items.length), [items.length])

  // The gutter always renders (reserved layout space — the transcript never
  // shifts when chapters appear); the interactive rail renders only when
  // there is at least one chapter on a fine-pointer device.
  const railVisible = finePointer && items.length >= TIMELINE_MINIMAP_MIN_ITEMS

  const expanded = activeItem !== null

  return (
    <div
      data-testid="timeline-minimap"
      className="group/minimap"
      style={{
        position: 'relative',
        flexShrink: 0,
        width: TIMELINE_MINIMAP_GUTTER_WIDTH,
        height: '100%',
        userSelect: 'none',
        // The expanded hit strip and the preview tooltip extend past the
        // gutter over the transcript while open (transient hover state).
        overflow: 'visible',
        zIndex: 4,
      }}
    >
      {railVisible && (
        <button
          type="button"
          aria-label={`Jump to message: ${activeItem?.userText ?? 'User message'}`}
          style={{
            position: 'absolute',
            top: '50%',
            left: 0,
            transform: 'translateY(-50%)',
            height: railHeight,
            width: expanded ? TIMELINE_MINIMAP_EXPANDED_STRIP_WIDTH : '100%',
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            outline: 'none',
          }}
          onBlur={() => setActiveIndex(null)}
          onFocus={() => setActiveIndex((current) => current ?? 0)}
          onMouseLeave={() => setActiveIndex(null)}
          onMouseMove={(event) => {
            if (eventTargetsPreview(event.target)) return
            setActiveIndex(resolveActiveIndexFromPointer(event))
          }}
          onMouseDown={(event) => {
            if (eventTargetsPreview(event.target)) return
            event.preventDefault()
          }}
          onClick={(event) => {
            if (eventTargetsPreview(event.target)) return
            const nextIndex = resolveActiveIndexFromPointer(event)
            const nextItem = nextIndex === null ? null : (items[nextIndex] ?? null)
            if (nextItem) {
              jumpToItem(nextItem)
            }
            event.currentTarget.blur()
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              moveActiveIndex(1)
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              moveActiveIndex(-1)
            } else if (event.key === 'Home') {
              event.preventDefault()
              setActiveIndex(0)
            } else if (event.key === 'End') {
              event.preventDefault()
              setActiveIndex(items.length - 1)
            } else if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              if (activeItem) {
                jumpToItem(activeItem)
              }
            }
          }}
        >
          {items.map((item, index) => {
            const top = `${resolveTimelineMinimapTopPercent(index, items.length)}%`
            const activeDistance =
              resolvedActiveIndex === null ? null : Math.abs(index - resolvedActiveIndex)
            const inView = inViewIds.has(item.id)
            // Every chapter always shows a tick: in-view chapters bright,
            // hovered tick emphasized, everything else dimmed — never hidden.
            const backgroundColor =
              activeDistance === 0
                ? colors.textSecondary
                : inView
                  ? colors.textPrimary
                  : colors.textTertiary
            return (
              <span
                aria-hidden="true"
                data-minimap-strip
                data-in-view={inView ? 'true' : 'false'}
                key={item.id}
                style={{
                  position: 'absolute',
                  left: TIMELINE_MINIMAP_RAIL_INSET,
                  top,
                  height: 2,
                  width: tickWidth(activeDistance),
                  transform: 'translateY(-50%)',
                  borderRadius: 999,
                  pointerEvents: 'none',
                  backgroundColor,
                  opacity: activeDistance === 0 || inView ? 1 : 0.45,
                  transition: 'background-color 150ms, width 150ms, opacity 150ms',
                }}
              />
            )
          })}
          {activeItem ? (
            <span
              data-minimap-preview
              onMouseMove={(event) => event.stopPropagation()}
              style={{
                position: 'absolute',
                left: TIMELINE_MINIMAP_RAIL_INSET + 32,
                width: 320,
                top: `${activeTopPercent}%`,
                transform: `translateY(${activeTooltipTranslate})`,
                pointerEvents: 'auto',
                cursor: 'text',
                userSelect: 'text',
                display: 'block',
              }}
            >
              <span
                style={{
                  display: 'block',
                  borderRadius: 12,
                  padding: 12,
                  textAlign: 'left',
                  background: colors.popoverBg,
                  border: `1px solid ${colors.popoverBorder}`,
                  boxShadow: colors.popoverShadow,
                  backdropFilter: 'blur(12px)',
                }}
              >
                <span
                  style={{
                    display: 'block',
                    maxWidth: '100%',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontSize: 13,
                    fontWeight: 600,
                    lineHeight: '20px',
                    color: colors.textPrimary,
                  }}
                >
                  {activeItem.userText}
                </span>
                {activeItem.assistantText ? (
                  <span
                    style={{
                      marginTop: 4,
                      maxHeight: 60,
                      overflow: 'hidden',
                      fontSize: 13,
                      lineHeight: '20px',
                      color: colors.textSecondary,
                      display: '-webkit-box',
                      WebkitBoxOrient: 'vertical',
                      WebkitLineClamp: 3,
                    }}
                  >
                    {activeItem.assistantText}
                  </span>
                ) : null}
              </span>
            </span>
          ) : null}
        </button>
      )}
    </div>
  )
}
