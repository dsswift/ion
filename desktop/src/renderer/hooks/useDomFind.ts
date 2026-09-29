/**
 * useDomFind — find-in-pane over rendered text: the conversation transcript,
 * and the canvas views that render text as page content (markdown preview,
 * plan, diff).
 *
 * Matches are painted with the CSS Custom Highlight API. The DOM is never
 * rewritten, so React keeps owning its text nodes: a streaming message or a
 * re-rendered diff cannot collide with a highlight, and the pane is rescanned
 * whenever its content changes.
 *
 * Text is matched per block. Inline runs (syntax-highlighted tokens, bold
 * words) join into one searchable string, so a query can span them, while two
 * separate paragraphs never join into a false match.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'

export interface DomFindState {
  active: boolean
  query: string
  matchCount: number
  currentIndex: number
  /** Bumped by every `open`; the find bar focuses its input when it moves. */
  focusRequest: number
}

export interface DomFindActions {
  open(): void
  close(): void
  setQuery(query: string): void
  next(): void
  prev(): void
}

/** Elements carrying this attribute (the find bar itself) are never searched. */
export const FIND_SKIP_ATTR = 'data-ion-search-ui'
const ALL_MATCHES = 'ion-find'
const ACTIVE_MATCH = 'ion-find-active'
/** Quiet period after a content change before the pane is rescanned. */
const RESCAN_DELAY_MS = 150

interface Segment {
  text: string
  nodes: Array<{ node: Text; start: number }>
}

/** Lower-cases without changing length, so offsets map back to the DOM. */
function foldCase(text: string): string {
  let out = ''
  for (const ch of text) {
    const lower = ch.toLowerCase()
    out += lower.length === ch.length ? lower : ch
  }
  return out
}

function collectSegments(root: HTMLElement): Segment[] {
  const styles = new Map<Element, CSSStyleDeclaration>()
  const hidden = new Map<Element, boolean>()
  const blocks = new Map<Element, Element>()
  const style = (el: Element): CSSStyleDeclaration => {
    let s = styles.get(el)
    if (!s) { s = window.getComputedStyle(el); styles.set(el, s) }
    return s
  }
  const isHidden = (el: Element | null): boolean => {
    if (!el || el === root) return false
    const cached = hidden.get(el)
    if (cached !== undefined) return cached
    const s = el.hasAttribute(FIND_SKIP_ATTR) ? null : style(el)
    const result = !s || s.display === 'none' || s.visibility === 'hidden' || isHidden(el.parentElement)
    hidden.set(el, result)
    return result
  }
  const blockOf = (el: Element): Element => {
    if (el === root) return root
    const cached = blocks.get(el)
    if (cached) return cached
    const display = style(el).display
    const result = display.startsWith('inline') || display === 'contents' ? blockOf(el.parentElement ?? root) : el
    blocks.set(el, result)
    return result
  }

  const segments: Segment[] = []
  let current: Segment | null = null
  let currentBlock: Element | null = null
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const parent = node.parentElement
    if (!parent || !node.data || isHidden(parent)) continue
    const block = blockOf(parent)
    if (!current || block !== currentBlock) {
      current = { text: '', nodes: [] }
      currentBlock = block
      segments.push(current)
    }
    current.nodes.push({ node, start: current.text.length })
    current.text += node.data
  }
  return segments
}

/** The text node and offset holding segment position `pos`; `end` prefers the node a range ends in. */
function locate(segment: Segment, pos: number, end: boolean): { node: Text; offset: number } {
  let lo = 0
  let hi = segment.nodes.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    const start = segment.nodes[mid].start
    if (end ? start < pos : start <= pos) lo = mid
    else hi = mid - 1
  }
  const entry = segment.nodes[lo]
  return { node: entry.node, offset: pos - entry.start }
}

/** Every case-insensitive occurrence of `query` under `root`, in document order. */
export function findTextRanges(root: HTMLElement, query: string): Range[] {
  if (!query) return []
  const needle = foldCase(query)
  const ranges: Range[] = []
  for (const segment of collectSegments(root)) {
    const hay = foldCase(segment.text)
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) {
      const start = locate(segment, at, false)
      const end = locate(segment, at + needle.length, true)
      const range = document.createRange()
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset)
      ranges.push(range)
    }
  }
  return ranges
}

function sharedHighlight(name: string): Highlight | null {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return null
  let highlight = CSS.highlights.get(name)
  if (!highlight) {
    highlight = new Highlight()
    CSS.highlights.set(name, highlight)
  }
  return highlight
}

function unpaint(ranges: readonly Range[]): void {
  const all = sharedHighlight(ALL_MATCHES)
  const active = sharedHighlight(ACTIVE_MATCH)
  for (const range of ranges) {
    all?.delete(range)
    active?.delete(range)
  }
}

function paint(ranges: readonly Range[], index: number): void {
  const all = sharedHighlight(ALL_MATCHES)
  const active = sharedHighlight(ACTIVE_MATCH)
  ranges.forEach((range, i) => {
    if (i === index) { all?.delete(range); active?.add(range) }
    else { active?.delete(range); all?.add(range) }
  })
}

function reveal(range: Range): void {
  const target = range.startContainer.parentElement
  target?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
  // A following transcript would otherwise drag the view back to its tail.
  window.dispatchEvent(new CustomEvent('ion:search-scrolled'))
}

export function useDomFind(containerRef: RefObject<HTMLElement | null>): [DomFindState, DomFindActions] {
  const [active, setActive] = useState(false)
  const [query, setQueryState] = useState('')
  const [matchCount, setMatchCount] = useState(0)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [focusRequest, setFocusRequest] = useState(0)
  const rangesRef = useRef<Range[]>([])
  const indexRef = useRef(0)
  const queryRef = useRef(query)
  queryRef.current = query

  const select = useCallback((index: number, scroll: boolean) => {
    const ranges = rangesRef.current
    indexRef.current = ranges.length === 0 ? 0 : Math.max(0, Math.min(index, ranges.length - 1))
    setCurrentIndex(indexRef.current)
    paint(ranges, indexRef.current)
    if (scroll && ranges.length > 0) reveal(ranges[indexRef.current])
  }, [])

  const scan = useCallback((scroll: boolean) => {
    unpaint(rangesRef.current)
    const root = containerRef.current
    rangesRef.current = root ? findTextRanges(root, queryRef.current) : []
    setMatchCount(rangesRef.current.length)
    select(indexRef.current, scroll)
  }, [containerRef, select])

  // A new query starts from the first match and scrolls to it.
  useEffect(() => {
    if (!active) return
    indexRef.current = 0
    const timer = setTimeout(() => scan(true), 0)
    return () => clearTimeout(timer)
  }, [active, query, scan])

  // Content changed under an open search: rescan, keep the position, no jump.
  useEffect(() => {
    const root = containerRef.current
    if (!active || !query || !root) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const observer = new MutationObserver(() => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => scan(false), RESCAN_DELAY_MS)
    })
    observer.observe(root, { childList: true, subtree: true, characterData: true })
    return () => {
      observer.disconnect()
      if (timer) clearTimeout(timer)
    }
  }, [active, query, containerRef, scan])

  useEffect(() => () => unpaint(rangesRef.current), [])

  const open = useCallback(() => {
    setActive(true)
    setFocusRequest((n) => n + 1)
  }, [])

  const close = useCallback(() => {
    unpaint(rangesRef.current)
    rangesRef.current = []
    indexRef.current = 0
    setActive(false)
    setQueryState('')
    setMatchCount(0)
    setCurrentIndex(0)
  }, [])

  const setQuery = useCallback((next: string) => setQueryState(next), [])

  const step = useCallback((delta: number) => {
    const count = rangesRef.current.length
    if (count === 0) return
    select((indexRef.current + delta + count) % count, true)
  }, [select])
  const next = useCallback(() => step(1), [step])
  const prev = useCallback(() => step(-1), [step])

  const actions = useMemo(() => ({ open, close, setQuery, next, prev }), [open, close, setQuery, next, prev])
  return [{ active, query, matchCount, currentIndex, focusRequest }, actions]
}
