import { useEffect, useState, type RefObject } from 'react'

/**
 * Track window inner height. Used by tall-view layout math so the body grows
 * to fill remaining vertical space when the OS window is resized.
 */
export function useWindowHeight(): number {
  const [winHeight, setWinHeight] = useState(window.innerHeight)
  useEffect(() => {
    const onResize = () => setWinHeight(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return winHeight
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
    const ro = new ResizeObserver(() => {
      // offsetHeight excludes margin; add marginBottom (60px normal, 20px terminal-only)
      const margin = el.style.marginBottom ? parseInt(el.style.marginBottom, 10) : 60
      setInputRowHeight(el.offsetHeight + margin)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [inputRowRef])
  return inputRowHeight
}
