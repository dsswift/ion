import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'
import { usePreferencesStore } from '../preferences'

/**
 * Track window inner height. Used by tall-view layout math so the body grows
 * to fill remaining vertical space when the OS window is resized.
 */
export function useWindowHeight(): number {
  const uiZoom = usePreferencesStore((s) => s.uiZoom)
  const [winHeight, setWinHeight] = useState(() => window.innerHeight / uiZoom)
  useEffect(() => {
    const onResize = () => setWinHeight(window.innerHeight / uiZoom)
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [uiZoom])
  return winHeight
}

/**
 * Track an element's rendered height, falling back until layout has a usable
 * `getBoundingClientRect()` reports physical viewport pixels while the panel
 * writes CSS lengths inside a zoomed root. Convert here so docked pane layouts
 * consume the same coordinate space as their containers.
 */
export function useElementHeight(
  ref: RefObject<HTMLElement | null>,
  fallback: number,
): number {
  const uiZoom = usePreferencesStore((s) => s.uiZoom)
  const [height, setHeight] = useState(fallback)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return

    const update = (): void => {
      const next = element.getBoundingClientRect().height / uiZoom
      // A hidden host briefly measures zero during Studio surface switches.
      // Keep prior usable height until its next visible measurement arrives.
      if (next > 0) setHeight(next)
    }

    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, uiZoom])

  return height
}

/**
 * Observe the input row's actual rendered height (offsetHeight + marginBottom)
 * via ResizeObserver. Returned value is used to subtract from winHeight when
 * computing the chat body height in tall view, so changes to attachments,
 * queued prompts, or expanded textarea sizing reflow correctly.
 */
export function useInputRowHeight(inputRowRef: RefObject<HTMLDivElement | null>): number {
  // default: ~50px pill + 60px marginBottom
  const [inputRowHeight, setInputRowHeight] = useState(110)
  useEffect(() => {
    const el = inputRowRef.current
    if (!el) return
    let rafId = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        // offsetHeight excludes margin; add marginBottom (60px normal, 20px terminal-only)
        const margin = el.style.marginBottom ? parseInt(el.style.marginBottom, 10) : 60
        setInputRowHeight(el.offsetHeight + margin)
      })
    })
    ro.observe(el)
    return () => { cancelAnimationFrame(rafId); ro.disconnect() }
  }, [inputRowRef])
  return inputRowHeight
}
