import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type TouchEvent,
  type WheelEvent,
} from 'react'
import { rDebug, rTrace } from '../../rendererLogger'

/**
 * Scroll-follow hook: auto-tails a scrollable container and exposes a
 * "scroll to bottom" button state. Extracted from ConversationView.tsx
 * so both the main view and nested transcript panels share one behavior.
 *
 * The content ref gives ResizeObserver a precise layout boundary. This keeps
 * the tail attached when a streaming row grows without changing the message
 * count. User scroll position still wins as soon as they leave the tail.
 *
 * @param deps - Caller-supplied dependency array. When any dep changes
 *   and the user is near the bottom, the container scrolls to the end.
 */
export function useScrollFollow(deps: unknown[]) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const isNearBottomRef = useRef(true)
  const touchYRef = useRef<number | null>(null)
  /**
   * Set while a deliberate navigation (a chart jump, a search hit) owns the
   * viewport. Tail-following is suppressed for its duration.
   *
   * A boolean flag alone is not enough: `pauseFollowing` clears
   * `isNearBottomRef`, but the navigation's own scroll then fires
   * `handleScroll`, which re-marks "near bottom" whenever the target happens
   * to sit within the tail threshold — and charts are usually the newest rows
   * in a conversation. The jump therefore scrolled and was immediately yanked
   * back to the tail, which is exactly what "clicking the row does nothing"
   * looked like. The lock survives those events and is released once the
   * viewport settles.
   */
  const navigationLockRef = useRef(0)
  const [showScrollBtn, setShowScrollBtn] = useState(false)

  const followTail = useCallback(() => {
    if (navigationLockRef.current > 0) return
    if (isNearBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [])

  /**
   * Take the viewport for a deliberate navigation.
   *
   * Returns nothing: the lock clears itself after the scroll settles, so a
   * caller cannot leak it. Repeated calls extend the window rather than
   * nesting, which matches a user clicking two chart rows in quick
   * succession.
   */
  const beginNavigation = useCallback(() => {
    navigationLockRef.current += 1
    isNearBottomRef.current = false
    setShowScrollBtn(true)
    // Two frames: one for the virtualizer to apply its scroll, one for the
    // measurement pass that follows it. A timer rather than a single frame
    // because `scrollToIndex` on a dynamically-measured list can re-scroll
    // after its first correction.
    window.setTimeout(() => {
      navigationLockRef.current = Math.max(0, navigationLockRef.current - 1)
      rTrace('conversation.scroll', 'navigation lock released')
    }, 250)
  }, [])

  const pauseFollowing = useCallback(() => {
    if (isNearBottomRef.current) {
      rDebug('conversation.scroll', 'conversation tailing paused')
    }
    isNearBottomRef.current = false
    setShowScrollBtn(true)
  }, [])

  const handleWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) pauseFollowing()
  }, [pauseFollowing])

  const handleTouchStart = useCallback((event: TouchEvent<HTMLDivElement>) => {
    touchYRef.current = event.touches[0]?.clientY ?? null
  }, [])

  const handleTouchMove = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const touchY = event.touches[0]?.clientY
    const previousY = touchYRef.current
    touchYRef.current = touchY ?? null
    if (touchY !== undefined && previousY !== null && touchY > previousY) {
      pauseFollowing()
    }
  }, [pauseFollowing])

  const handlePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.buttons !== 0 && event.target === event.currentTarget) {
      pauseFollowing()
    }
  }, [pauseFollowing])

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home') {
      pauseFollowing()
    }
  }, [pauseFollowing])

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    // A navigation owns the viewport: neither resume tailing nor correct back
    // to the tail, whatever position the scroll landed on.
    if (navigationLockRef.current > 0) return
    const el = scrollRef.current
    const threshold = 80
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const nearBottom = distanceFromBottom < threshold

    if (nearBottom) {
      if (!isNearBottomRef.current) {
        rDebug('conversation.scroll', 'conversation tailing resumed', {
          distance_from_bottom: distanceFromBottom,
        })
      }
      isNearBottomRef.current = true
      setShowScrollBtn(false)
      return
    }

    if (!isNearBottomRef.current) {
      setShowScrollBtn(true)
      return
    }

    // Virtual-row measurement and browser layout correction can move the
    // viewport during initial render. Keep following until the user acts.
    rTrace('conversation.scroll', 'corrected automatic scroll away from tail', {
      distance_from_bottom: distanceFromBottom,
    })
    followTail()
  }, [followTail])

  // Layout timing puts an opened conversation at its tail before paint. It also
  // handles dependency changes that do not resize the transcript.
  useLayoutEffect(() => {
    followTail()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  // Streaming updates commonly grow the current row without adding a message.
  // Observe the rendered content so each real size change follows the tail.
  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(followTail)
    observer.observe(content)
    return () => observer.disconnect()
  }, [followTail])

  // Search scrolls with scrollIntoView. Treat it as an explicit user navigation
  // so tail correction does not undo the selected match.
  useLayoutEffect(() => {
    window.addEventListener('ion:search-scrolled', pauseFollowing)
    return () => window.removeEventListener('ion:search-scrolled', pauseFollowing)
  }, [pauseFollowing])

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      isNearBottomRef.current = true
      setShowScrollBtn(false)
      rTrace('conversation.scroll', 'conversation scrolled to tail')
    }
  }, [])

  return {
    scrollRef,
    contentRef,
    isNearBottomRef,
    showScrollBtn,
    handleScroll,
    handleWheel,
    handleTouchStart,
    handleTouchMove,
    handlePointerMove,
    handleKeyDown,
    pauseFollowing,
    beginNavigation,
    scrollToBottom,
  }
}
