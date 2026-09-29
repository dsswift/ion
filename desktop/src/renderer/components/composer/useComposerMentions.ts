/**
 * useComposerMentions — the state behind the `@file` mention menu: which
 * mention is being typed, the matching project files, and the highlighted row.
 *
 * Each query is one `searchFiles` call to the Environment. A response is
 * applied only when it answers the latest query, so a slow early answer can
 * never overwrite a newer one.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { host } from '../../host/host-instance'
import { rDebug, rWarn } from '../../rendererLogger'
import { detectActiveMention, mentionInsertion, type ActiveMention } from './composer-mentions'
import type { ComposerEditorHandle } from './ComposerEditor'

const MENTION_RESULT_LIMIT = 30
/** Typing pause (ms) before a query is sent, so a fast typist sends one search. */
const MENTION_SEARCH_DELAY_MS = 60

export interface ComposerMentions {
  active: ActiveMention | null
  results: string[]
  index: number
  /** Feed every text/cursor change. */
  track: (text: string, offset: number) => void
  /** Returns true when the key drove the menu. */
  handleKeyDown: (event: KeyboardEvent) => boolean
  pick: (path: string) => void
  close: () => void
}

export function useComposerMentions(
  editorRef: React.RefObject<ComposerEditorHandle | null>,
  workingDirectory: string,
  enabled: boolean,
): ComposerMentions {
  const [active, setActive] = useState<ActiveMention | null>(null)
  const [results, setResults] = useState<string[]>([])
  const [index, setIndex] = useState(0)
  const latestQuery = useRef(0)
  // Escape dismisses the menu for the mention being typed; it stays dismissed
  // until that `@` is gone, so the next keystroke does not reopen it.
  const dismissedFrom = useRef<number | null>(null)

  const track = useCallback((text: string, offset: number) => {
    const next = enabled ? detectActiveMention(text, offset) : null
    if (next === null) dismissedFrom.current = null
    setActive(next !== null && dismissedFrom.current === next.from ? null : next)
  }, [enabled])

  const query = active?.query ?? null
  useEffect(() => {
    if (query === null) { setResults([]); return }
    const ticket = ++latestQuery.current
    const timer = setTimeout(() => {
      host.shell.searchFiles(workingDirectory, query, MENTION_RESULT_LIMIT)
        .then((result) => {
          if (ticket !== latestQuery.current) return
          if (result.error) rWarn('composer', 'mention search refused', { directory: workingDirectory, error: result.error })
          rDebug('composer', 'mention search answered', { query_length: query.length, results: result.files.length, source: result.source })
          setResults(result.files)
          setIndex(0)
        })
        .catch((err) => {
          if (ticket !== latestQuery.current) return
          rWarn('composer', 'mention search failed', { directory: workingDirectory, error: String(err) })
          setResults([])
        })
    }, MENTION_SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [query, workingDirectory])

  const close = useCallback(() => {
    dismissedFrom.current = active?.from ?? null
    setActive(null)
  }, [active])

  const pick = useCallback((path: string) => {
    if (!active) return
    editorRef.current?.replaceRange(active.from, active.to, mentionInsertion(path))
    setActive(null)
    editorRef.current?.focus()
  }, [active, editorRef])

  const handleKeyDown = useCallback((event: KeyboardEvent): boolean => {
    if (!active) return false
    if (event.key === 'Escape') { event.preventDefault(); close(); return true }
    if (results.length === 0) return false
    if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((i) => (i + 1) % results.length); return true }
    if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((i) => (i - 1 + results.length) % results.length); return true }
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
      event.preventDefault()
      pick(results[index])
      return true
    }
    return false
  }, [active, results, index, pick, close])

  return { active, results, index, track, handleKeyDown, pick, close }
}
