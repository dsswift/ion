import { useEffect } from 'react'

/**
 * OS-level click-through. The Ion window is a transparent shell that should
 * pass mouse events to whatever is beneath it unless the cursor is over an
 * element marked `data-ion-ui`.
 *
 * Throttled by elementFromPoint result equality (only IPC when the
 * shouldIgnore boolean flips), avoiding per-pixel IPC traffic.
 */
export function useClickThrough() {
  useEffect(() => {
    if (!window.ion?.setIgnoreMouseEvents) return
    let lastIgnored: boolean | null = null

    const onMouseMove = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const isUI = !!(el && el.closest('[data-ion-ui]'))
      const shouldIgnore = !isUI
      if (shouldIgnore !== lastIgnored) {
        lastIgnored = shouldIgnore
        if (shouldIgnore) {
          window.ion.setIgnoreMouseEvents(true, { forward: true })
        } else {
          window.ion.setIgnoreMouseEvents(false)
        }
      }
    }

    const onMouseLeave = () => {
      if (lastIgnored !== true) {
        lastIgnored = true
        window.ion.setIgnoreMouseEvents(true, { forward: true })
      }
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseleave', onMouseLeave)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseleave', onMouseLeave)
    }
  }, [])
}
