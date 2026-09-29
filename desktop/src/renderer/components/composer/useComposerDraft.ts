/**
 * useComposerDraft — keep the composer's unsent text and the conversation's
 * durable draft in agreement.
 *
 * The draft lives on the conversation pane in the server's store, which
 * serializes it into the tabs file and reads it back at boot. This hook is the
 * client end of that: it commits what is typed, and it loads what was stored.
 *
 * Two rules, and they are the whole design:
 *
 *   1. COMMIT while typing, debounced. The composer's own React state is the
 *      live value; the store copy trails it by at most DRAFT_COMMIT_DELAY_MS.
 *      Committing only on tab switch — which is what this replaced — meant the
 *      conversation you were actually looking at when the app quit was the one
 *      conversation whose text was never written down.
 *   2. ADOPT on open. The stored draft is read into the composer when a
 *      conversation becomes active, and at no other time. A push that arrived
 *      mid-sentence would overwrite the cursor, so the composer that has the
 *      conversation open owns the text and everyone else adopts on open. The
 *      visible consequence: text typed on another device while you are sitting
 *      on the same conversation appears when you leave and come back, not as
 *      you watch. Live co-editing of an unsent prompt is not a thing this
 *      feature promises.
 *
 * Flushing is what makes rule 1 survive an abrupt exit: the pending timer is
 * fired on tab switch, on unmount, and on the window's own teardown, so the
 * unwritten tail is at most one debounce old and normally zero.
 */
import { useCallback, useEffect, useRef } from 'react'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { rDebug } from '../../rendererLogger'

/**
 * How long the composer may hold a keystroke before the store hears about it.
 *
 * Every commit is a `studio_action` round trip to the owning server, so this
 * is a rate limit, not a cosmetic delay: per-keystroke forwarding would put a
 * frame on the wire for every character. 400 ms coalesces normal typing into
 * roughly one write per pause while keeping the unflushed tail small enough
 * that a hard kill loses at most a word.
 */
export const DRAFT_COMMIT_DELAY_MS = 400

export interface ComposerDraftApi {
  /**
   * Write the pending draft through now, cancelling the debounce. Call before
   * anything that ends this composer's ownership of the text.
   */
  flush: () => void
}

export function useComposerDraft(
  activeTabId: string | null,
  /** True once tab restoration has finished; before it, panes hold no drafts. */
  tabsReady: boolean,
  text: string,
  setText: (text: string) => void,
  /** Runs when a different conversation's draft is adopted, before the text is replaced. */
  onAdopt?: () => void,
): ComposerDraftApi {
  const setDraftInput = useSessionStore((s) => s.setDraftInput)
  // Subscribe to the pane MAP, and resolve which conversation's draft to read
  // inside the effect. Never derive the draft in a selector that closes over
  // `activeTabId`: a selector re-runs against new store state while still
  // holding the tab id from the render that created it, so the store update
  // that switches conversations resolves the DEPARTING conversation's draft
  // and hands it to an effect that has already moved on — which is exactly how
  // one conversation's half-written prompt ended up adopted into the next one.
  // Subscribing to the map keeps the "a pane arrived" wake-up (its identity
  // changes when panes are added or updated) with no tab id baked in.
  const panes = useSessionStore((s) => s.conversationPanes)

  // The timer callback reads these refs rather than closing over values, so a
  // commit that fires late still writes the text that belongs to the tab it
  // was scheduled for — and writes the CURRENT text, which is what makes a
  // post-submit fire harmlessly write the cleared value.
  const textRef = useRef(text)
  textRef.current = text
  const tabIdRef = useRef(activeTabId)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The last value this composer sent for the current tab, so an idle
  // re-render does not forward a write the store already has.
  const committedRef = useRef<string>('')

  const commitNow = useCallback((tabId: string | null, value: string) => {
    if (!tabId) return
    if (committedRef.current === value) return
    committedRef.current = value
    setDraftInput(tabId, value)
  }, [setDraftInput])

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    commitNow(tabIdRef.current, textRef.current)
  }, [commitNow])

  // ─── Rule 1: commit while typing ───
  useEffect(() => {
    if (!activeTabId) return
    if (text === committedRef.current) return
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      commitNow(tabIdRef.current, textRef.current)
    }, DRAFT_COMMIT_DELAY_MS)
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [text, activeTabId, commitNow])

  // ─── Rule 2: flush the departing conversation, adopt the arriving one ───
  //
  // Boot is not a special case. The first conversation to become active with
  // its panes loaded is an arrival like any other, so the draft restored from
  // disk is adopted by the same branch that handles a tab switch. `tabsReady`
  // is in the dependency list precisely so a tab that was already active
  // before restoration finished gets its adoption once the panes exist.
  const adoptedTabRef = useRef<string | null>(null)
  useEffect(() => {
    const previousTabId = tabIdRef.current
    if (previousTabId && previousTabId !== activeTabId) {
      flush()
    }
    const switched = previousTabId !== activeTabId
    tabIdRef.current = activeTabId
    if (!activeTabId || !tabsReady) return
    if (!switched && adoptedTabRef.current === activeTabId) return
    // Not a switch, so this is a late pane arriving for the conversation
    // already open. Take it only if the composer still holds exactly what this
    // hook last put there — anything else is the operator's own typing, and a
    // draft arriving from the store never overwrites that.
    if (!switched && text !== committedRef.current) return

    // Resolved here, from this render's map and this render's tab id, so the
    // draft can only ever belong to the conversation being adopted.
    const pane = panes.get(activeTabId)
    const draft = pane
      ? pane.instances.find((i) => i.id === pane.activeInstanceId)?.draftInput ?? ''
      : ''

    // A switch ALWAYS replaces the text, even when the arriving conversation's
    // pane has not synced yet. Returning early here instead — which is what
    // this did — left the previous conversation's half-written prompt sitting
    // in the composer under a different conversation's name, and the commit
    // timer then wrote those words into it. One conversation's draft must
    // never be able to reach another, so an unsynced pane clears rather than
    // keeps. Only a resolved pane counts as adopted, so the real draft is
    // still taken when it lands a beat later.
    if (pane) adoptedTabRef.current = activeTabId
    else adoptedTabRef.current = null
    committedRef.current = draft
    onAdopt?.()
    setText(draft)
    if (draft.length > 0) {
      rDebug('drafts', 'composer adopted stored draft', { tab_id: activeTabId, count: draft.length })
    }
    // `onAdopt`/`setText` are stable callers in practice; listing them would
    // re-run adoption on every parent render and re-clobber the composer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, tabsReady, panes, flush])

  // ─── Flush on teardown ───
  //
  // Unmount covers a normal window close and a React remount. `pagehide` is
  // the one the abrupt paths need: a browser Studio tab being closed and an
  // Electron window being destroyed both fire it, and neither is guaranteed to
  // run an unmount first. `beforeunload` is deliberately not used — it is
  // unreliable on mobile Safari and adds nothing `pagehide` does not cover.
  useEffect(() => {
    const onPageHide = () => flush()
    window.addEventListener('pagehide', onPageHide)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      flush()
    }
  }, [flush])

  return { flush }
}
