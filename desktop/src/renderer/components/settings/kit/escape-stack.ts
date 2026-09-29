/**
 * escape-stack — Escape closes the top-most Settings layer only.
 *
 * The dialog closes on Escape from a document listener. A row menu or a
 * side panel open on top of it must take that key first, or one press
 * closes everything. Each open layer pushes a handler here; one capturing
 * window listener runs the newest handler and stops the key there.
 */
import { useEffect, useRef } from 'react'

const stack: Array<{ current: () => void }> = []

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || stack.length === 0) return
  event.stopPropagation()
  event.preventDefault()
  stack[stack.length - 1].current()
}

/** While `active`, Escape runs `handler` instead of reaching anything underneath. */
export function useEscapeLayer(active: boolean, handler: () => void): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    if (!active) return
    if (stack.length === 0) window.addEventListener('keydown', onKeyDown, true)
    stack.push(ref)
    return () => {
      const at = stack.lastIndexOf(ref)
      if (at >= 0) stack.splice(at, 1)
      if (stack.length === 0) window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [active])
}
