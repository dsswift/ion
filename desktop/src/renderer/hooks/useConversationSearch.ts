import { useState, useCallback, useEffect, useRef, type RefObject } from 'react'

// ─── Types ───

export interface SearchMatch {
  /** The text node that was split to create this match span */
  span: HTMLElement
}

export interface ConversationSearchState {
  active: boolean
  query: string
  matches: SearchMatch[]
  currentIndex: number
}

export interface ConversationSearchActions {
  open: () => void
  close: () => void
  setQuery: (q: string) => void
  next: () => void
  prev: () => void
}

// ─── Constants ───

const MATCH_SPAN_ATTR = 'data-ion-search-match'
const SKIP_ATTR = 'data-ion-search-ui'
const ACTIVE_CLASS = 'ion-search-active'

// ─── DOM Helpers ───

/** Walk all text nodes under `root`, skipping nodes inside elements with
 * `data-ion-search-ui` or that are inside a collapsed/hidden element. */
function collectTextNodes(root: HTMLElement): Text[] {
  const results: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // Skip nodes inside search UI
      let el = node.parentElement
      while (el && el !== root) {
        if (el.hasAttribute(SKIP_ATTR)) return NodeFilter.FILTER_REJECT
        // Skip invisible nodes (display:none / visibility:hidden)
        const style = window.getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden') {
          return NodeFilter.FILTER_REJECT
        }
        el = el.parentElement
      }
      // Skip empty text nodes
      if (!node.nodeValue || node.nodeValue.trim() === '') return NodeFilter.FILTER_SKIP
      return NodeFilter.FILTER_ACCEPT
    },
  })

  let node: Node | null
  while ((node = walker.nextNode())) {
    results.push(node as Text)
  }
  return results
}

/** Remove all highlight spans previously inserted by this module,
 * replacing each span with its text content and normalising the parent. */
function removeHighlights(root: HTMLElement) {
  const spans = root.querySelectorAll<HTMLElement>(`[${MATCH_SPAN_ATTR}]`)
  spans.forEach((span) => {
    const parent = span.parentNode
    if (!parent) return
    const text = document.createTextNode(span.textContent ?? '')
    parent.replaceChild(text, span)
    // Merge adjacent text nodes so future TreeWalker passes see clean nodes
    parent.normalize()
  })
}

/** Wrap every case-insensitive occurrence of `query` in `textNode` with a
 * `<mark>` span carrying `data-ion-search-match`. Returns the list of spans
 * created (one per occurrence in this text node). */
function highlightTextNode(textNode: Text, query: string): HTMLElement[] {
  const text = textNode.nodeValue ?? ''
  const lower = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const spans: HTMLElement[] = []
  let offset = 0
  const parent = textNode.parentNode
  if (!parent) return []

  // Find all occurrence positions first
  const positions: number[] = []
  let idx = lower.indexOf(lowerQuery, 0)
  while (idx !== -1) {
    positions.push(idx)
    idx = lower.indexOf(lowerQuery, idx + lowerQuery.length)
  }
  if (positions.length === 0) return []

  // Build replacement fragment
  const fragment = document.createDocumentFragment()
  for (const pos of positions) {
    // Text before match
    if (pos > offset) {
      fragment.appendChild(document.createTextNode(text.slice(offset, pos)))
    }
    // Match span
    const span = document.createElement('mark')
    span.setAttribute(MATCH_SPAN_ATTR, '')
    span.textContent = text.slice(pos, pos + query.length)
    // Inherit inline style — actual colors applied via CSS in index.css
    spans.push(span)
    fragment.appendChild(span)
    offset = pos + query.length
  }
  // Text after last match
  if (offset < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(offset)))
  }

  parent.replaceChild(fragment, textNode)
  return spans
}

// ─── Hook ───

export function useConversationSearch(
  containerRef: RefObject<HTMLElement | null>,
  scrollTrigger: string,
): [ConversationSearchState, ConversationSearchActions] {
  const [active, setActive] = useState(false)
  const [query, setQueryState] = useState('')
  const [matches, setMatches] = useState<SearchMatch[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)

  // Keep latest query in a ref so effects that close over query see fresh value
  const queryRef = useRef(query)
  queryRef.current = query

  // ── Recompute highlights ──────────────────────────────────────────────────

  const recompute = useCallback(() => {
    const root = containerRef.current
    if (!root) return

    // Always start clean
    removeHighlights(root)

    const q = queryRef.current
    if (!q || q.length < 1) {
      setMatches([])
      setCurrentIndex(0)
      return
    }

    const textNodes = collectTextNodes(root)
    const newSpans: HTMLElement[] = []

    for (const tn of textNodes) {
      const found = highlightTextNode(tn, q)
      newSpans.push(...found)
    }

    const newMatches = newSpans.map((span) => ({ span }))
    setMatches(newMatches)
    setCurrentIndex((prev) => {
      const clamped = newMatches.length === 0 ? 0 : Math.min(prev, newMatches.length - 1)
      return clamped
    })
  }, [containerRef])

  // Recompute when query changes (but wait a tick so React has flushed)
  useEffect(() => {
    if (!active) return
    const id = setTimeout(recompute, 0)
    return () => clearTimeout(id)
  }, [active, query, recompute])

  // Recompute when messages stream in (scrollTrigger changes)
  useEffect(() => {
    if (!active || !query) return
    const id = setTimeout(recompute, 50)
    return () => clearTimeout(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTrigger])

  // ── Active match highlight ────────────────────────────────────────────────

  useEffect(() => {
    // Remove active class from all
    const root = containerRef.current
    if (!root) return
    root.querySelectorAll(`.${ACTIVE_CLASS}`).forEach((el) => el.classList.remove(ACTIVE_CLASS))

    if (matches.length === 0) return
    const span = matches[currentIndex]?.span
    if (!span) return
    span.classList.add(ACTIVE_CLASS)
    span.scrollIntoView({ block: 'center', behavior: 'smooth' })
    // Let ConversationView know we've scrolled so it doesn't fight us
    window.dispatchEvent(new CustomEvent('ion:search-scrolled'))
  }, [currentIndex, matches, containerRef])

  // ── Cleanup on close / unmount ────────────────────────────────────────────

  const doClose = useCallback(() => {
    const root = containerRef.current
    if (root) removeHighlights(root)
    setActive(false)
    setQueryState('')
    setMatches([])
    setCurrentIndex(0)
  }, [containerRef])

  // ── Listen for tab switch (ion:search-close-tab) ─────────────────────────
  // ConversationView is remounted per tab, so closing is automatic. But if
  // tabs are not unmounted (they're not — the view switches), we emit
  // ion:search-close on selectTab. Simplest: listen to CustomEvent from
  // keyboard shortcut or tab switch.
  useEffect(() => {
    const handler = () => doClose()
    window.addEventListener('ion:search-close', handler)
    return () => window.removeEventListener('ion:search-close', handler)
  }, [doClose])

  // ── Actions ───────────────────────────────────────────────────────────────

  const open = useCallback(() => {
    setActive(true)
  }, [])

  const close = useCallback(() => {
    doClose()
  }, [doClose])

  const setQuery = useCallback((q: string) => {
    setQueryState(q)
  }, [])

  const next = useCallback(() => {
    setCurrentIndex((i) => {
      if (matches.length === 0) return 0
      return (i + 1) % matches.length
    })
  }, [matches.length])

  const prev = useCallback(() => {
    setCurrentIndex((i) => {
      if (matches.length === 0) return 0
      return (i - 1 + matches.length) % matches.length
    })
  }, [matches.length])

  const state: ConversationSearchState = { active, query, matches, currentIndex }
  const actions: ConversationSearchActions = { open, close, setQuery, next, prev }

  return [state, actions]
}
