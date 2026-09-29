/**
 * Find in the canvas pane. Requests routed to the canvas (Pane Find) land
 * here and go to one of two searches:
 *
 * - A code editor tab in edit mode registers a delegate, and the request
 *   drives CodeMirror's own search. CodeMirror draws only the lines on
 *   screen, so searching its rendered text would miss the rest of the file.
 * - Everything else (markdown preview, plan, diff) renders its text as page
 *   content, and `useDomFind` searches that under the canvas body.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, type RefObject } from 'react'
import type { EditorView } from '@codemirror/view'
import { findNext, findPrevious, openSearchPanel } from '@codemirror/search'
import { FindBar } from '../../components/FindBar'
import { useDomFind } from '../../hooks/useDomFind'
import { rDebug } from '../../rendererLogger'
import { usePaneFindEvents, type PaneFindHandlers } from '../find/pane-find'

interface SurfaceFindContextValue {
  /** Route find requests to `delegate` until it is released. */
  claim(delegate: PaneFindHandlers): () => void
  /** True while the page-text find bar is open over the canvas. */
  findActive: boolean
}

const SurfaceFindContext = createContext<SurfaceFindContextValue>({
  claim: () => () => undefined,
  findActive: false,
})

export function useSurfaceFindActive(): boolean {
  return useContext(SurfaceFindContext).findActive
}

/**
 * Hosts find for the canvas body `bodyRef` points at. The find bar is drawn
 * over the body; a new active tab closes a search typed in the previous one.
 */
export function SurfaceFindHost({ bodyRef, activeTabId, children }: {
  bodyRef: RefObject<HTMLElement | null>
  activeTabId: string | null
  children: React.ReactNode
}): React.JSX.Element {
  const [state, actions] = useDomFind(bodyRef)
  const delegateRef = useRef<PaneFindHandlers | null>(null)
  const activeRef = useRef(state.active)
  activeRef.current = state.active

  const route = (action: keyof PaneFindHandlers): void => {
    const delegate = delegateRef.current
    rDebug('studio.surface.find', 'find request', { action, via: delegate ? 'editor' : 'page', tab_id: activeTabId ?? '' })
    if (delegate) delegate[action]()
    else if (action === 'open') actions.open()
    else if (activeRef.current) actions[action]()
  }
  usePaneFindEvents('surface', {
    open: () => route('open'),
    next: () => route('next'),
    prev: () => route('prev'),
  })

  const { close } = actions
  useEffect(() => {
    close()
  }, [activeTabId, close])

  const claim = useCallback((delegate: PaneFindHandlers) => {
    delegateRef.current = delegate
    // An editor taking over (a preview switched to source) ends the page search.
    close()
    return () => {
      if (delegateRef.current === delegate) delegateRef.current = null
    }
  }, [close])

  const value = useMemo(() => ({ claim, findActive: state.active }), [claim, state.active])
  return (
    <SurfaceFindContext.Provider value={value}>
      {children}
      <FindBar state={state} actions={actions} />
    </SurfaceFindContext.Provider>
  )
}

/**
 * While `enabled`, find requests to the canvas drive this CodeMirror view's
 * search: open shows its search panel (seeded from the selection), next and
 * previous step through its matches.
 */
export function useCodeMirrorFind(viewRef: RefObject<EditorView | null>, enabled: boolean): void {
  const { claim } = useContext(SurfaceFindContext)
  useEffect(() => {
    if (!enabled) return
    const run = (command: (view: EditorView) => boolean) => () => {
      const view = viewRef.current
      if (view) command(view)
    }
    return claim({ open: run(openSearchPanel), next: run(findNext), prev: run(findPrevious) })
  }, [claim, enabled, viewRef])
}
