/**
 * Pane Find routing — the find shortcuts (Mod+F, Mod+G, Mod+Shift+G) act on
 * the pane that holds focus. The shell picks the pane; the pane decides how
 * it searches (its rendered text, or its code editor's own search).
 */
import { useEffect, useRef } from 'react'

export type PaneFindTarget = 'conversation' | 'surface'
export type PaneFindAction = 'open' | 'next' | 'prev'

const PANE_FIND_EVENT = 'ion:pane-find'

interface PaneFindDetail {
  target: PaneFindTarget
  action: PaneFindAction
}

/**
 * The pane a find request goes to: the canvas when it was clicked or focused
 * last and is still on screen, the conversation otherwise.
 */
export function paneFindTarget(lastFocusedColumn: 'conversation' | 'surface', surfaceVisible: boolean): PaneFindTarget {
  return lastFocusedColumn === 'surface' && surfaceVisible ? 'surface' : 'conversation'
}

export function dispatchPaneFind(target: PaneFindTarget, action: PaneFindAction): void {
  window.dispatchEvent(new CustomEvent<PaneFindDetail>(PANE_FIND_EVENT, { detail: { target, action } }))
}

export type PaneFindHandlers = Record<PaneFindAction, () => void>

/** Run `handlers` for find requests addressed to `target`. */
export function usePaneFindEvents(target: PaneFindTarget, handlers: PaneFindHandlers): void {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  useEffect(() => {
    const onFind = (event: Event): void => {
      const detail = (event as CustomEvent<PaneFindDetail>).detail
      if (detail?.target === target) handlersRef.current[detail.action]()
    }
    window.addEventListener(PANE_FIND_EVENT, onFind)
    return () => window.removeEventListener(PANE_FIND_EVENT, onFind)
  }, [target])
}
