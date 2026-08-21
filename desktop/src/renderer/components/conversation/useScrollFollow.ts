import { useCallback, useLayoutEffect, useRef, useState } from 'react'

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
  const [showScrollBtn, setShowScrollBtn] = useState(false)

  const followTail = useCallback(() => {
    if (isNearBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [])

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    const el = scrollRef.current
    const threshold = 80
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
    isNearBottomRef.current = nearBottom
    setShowScrollBtn(!nearBottom)
  }, [])

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

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      isNearBottomRef.current = true
      setShowScrollBtn(false)
    }
  }, [])

  return { scrollRef, contentRef, isNearBottomRef, showScrollBtn, handleScroll, scrollToBottom }
}
