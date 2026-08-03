import type { Message } from '../../shared/types'
import type { StoreSet, StoreGet } from './session-store-types'
import { nextMsgId } from './session-store-helpers'
import { commitInstance, activeInstance, needsHistoryHydration } from './conversation-instance'
import { mapSessionHistory } from '../../shared/session-message-mapper'
import { mapPersistedMessages, filterRestorablePersistedMessages } from './persisted-message-map'
import { buildRestoredDenied } from './restored-denied'
import { rInfo, rWarn, rDebug } from '../rendererLogger'

/**
 * resume-slice-hydration — lazy history hydration for a skeleton pane.
 *
 * Extracted from resume-slice.ts (600-line cap) so the concurrency guard and
 * both merge branches live together and are independently reviewable. The seam
 * is one-way: this module never imports the slices.
 *
 * ─── Why the in-flight guard exists ─────────────────────────────────────────
 *
 * `loadSkeletonMessages` is fired from several INDEPENDENT places that can all
 * target the same tab within the same tick:
 *
 *   - `tab-slice.ts:selectTab`      — the user opens the tab
 *   - `resume-slice.ts:rehydrateFailedHistory` — the engine reconnected
 *   - `atv/AtvSideDock.tsx`         — the ATV mirror activates the tab
 *   - `main/remote/handlers/attachments.ts` — an iOS `desktop_load_attachments`
 *     drives it through `executeJavaScript` before scanning for attachments
 *
 * The function is `async` and its FIRST write happens only after an awaited
 * IPC round-trip. The `needsHistoryHydration` / `externalContentStatus`
 * gates at the top are therefore read BEFORE any marker is written: two calls
 * that arrive while the first is still awaiting both pass the gate, both load
 * the same history, and both append it. `commitInstance` is a pure functional
 * update, so the second write does not overwrite the first — it appends a
 * second full copy of the scrollback, and the transcript renders every row
 * twice (the reported "message appears several times" bug, seen when a prompt
 * arrives from iOS: the prompt triggers a snapshot push, iOS answers with
 * `desktop_load_conversation` + `desktop_load_attachments`, and the attachments
 * handler's hydration races the one `selectTab` already started).
 *
 * Leaving the tab and returning "fixed" it because the re-entry found
 * `historyHydrated: true` and short-circuited, re-rendering from the single
 * clean copy the LAST write produced.
 *
 * The guard is a per-tab promise registry. A second caller that arrives while
 * a load is in flight awaits the SAME promise instead of starting a second
 * one, so N concurrent callers produce exactly one load and one append. This
 * is the precise mechanism (shared identity of the in-flight operation), not a
 * heuristic debounce that would merely narrow the window.
 */
const inFlight = new Map<string, Promise<void>>()

/** Visible for tests: no load is currently in flight for any tab. */
export function hydrationInFlightCount(): number {
  return inFlight.size
}

export function loadSkeletonMessagesImpl(set: StoreSet, get: StoreGet) {
  return async (tabId: string): Promise<void> => {
    // Coalesce concurrent callers onto one load. See the module doc: the gates
    // below cannot do this themselves because they are read before the first
    // awaited write, so every racing caller passes them.
    const existing = inFlight.get(tabId)
    if (existing) {
      rDebug('session.restore', 'hydration already in flight, joining', { tab_id: tabId.slice(0, 8) })
      return existing
    }
    const run = hydrate(set, get, tabId).finally(() => { inFlight.delete(tabId) })
    inFlight.set(tabId, run)
    return run
  }
}

async function hydrate(set: StoreSet, get: StoreGet, tabId: string): Promise<void> {
  // Externalized scrollback (schema v4): the instance's history lives in
  // a per-tab content file, not the engine store (renderer-only harness/
  // system rows never reach the engine). Load it once on first
  // activation; the engine-chain path below stays for count-only
  // instances whose rows ARE engine-reloadable.
  const pendingInst = activeInstance(get().conversationPanes, tabId)
  if (pendingInst?.externalContentStatus === 'pending') {
    const baseline = pendingInst.messages.length
    try {
      // Load the content file and the engine chain in parallel. The content
      // file holds renderer-only rows (harness/system) that are not in the
      // engine store. The engine chain is the authoritative source for
      // user/assistant/tool rows. Both are needed: a stale content file
      // (written after a session recycle that cleared the pane) misses the
      // real conversation rows, which the engine still has on disk.
      const tab = get().tabs.find((t) => t.id === tabId)
      // Degrading to content-only when the engine chain fails is fine for
      // rendering, but it must not masquerade as a complete load — the
      // flag marks the pane for retry when the engine reconnects.
      let chainLoadFailed = false
      const [content, chainHistory] = await Promise.all([
        window.ion.loadTabContent(tabId),
        tab?.conversationId
          ? window.ion.loadChainHistory([...(tab.historicalSessionIds ?? []), tab.conversationId])
              .catch((err: unknown) => {
                chainLoadFailed = true
                rWarn('session.restore', 'external content: engine chain load failed, using content file only', { tab_id: tabId.slice(0, 8), error: String(err) })
                return [] as unknown[]
              })
          : Promise.resolve([] as unknown[]),
      ])

      const restoredFromFile = content
        ? mapPersistedMessages(filterRestorablePersistedMessages(content.messages))
        : []

      // Engine chain is authoritative for user/assistant/tool rows.
      const engineRows = mapSessionHistory(chainHistory as Parameters<typeof mapSessionHistory>[0], nextMsgId)

      // Renderer-only rows (harness/system) exist only in the content file
      // and cannot be reloaded from the engine store. Supplement the engine
      // rows with these rather than using the full content file, so a stale
      // content file (missing real conversation rows) does not hide history.
      const rendererOnlyRows = restoredFromFile.filter(
        (m) => m.role === 'harness' || m.role === 'system',
      )

      // Merge and sort by timestamp so harness banners slot in
      // chronologically alongside the real conversation rows.
      const allRows = engineRows.length > 0
        ? [...engineRows, ...rendererOnlyRows].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
        : restoredFromFile

      rInfo('session.restore', 'external content hydrated', {
        tab_id: tabId.slice(0, 8),
        content_rows: restoredFromFile.length,
        engine_rows: engineRows.length,
        renderer_only_rows: rendererOnlyRows.length,
        merged_rows: allRows.length,
        baseline,
        missing: !content,
      })

      set((s) => ({
        conversationPanes: commitInstance(s.conversationPanes, tabId, (i) => {
          // Keep live rows that streamed in during the async load (past
          // the baseline); everything before it is covered by the merged set.
          // Drop tail rows the merged set already contains — the same
          // id-based dedup the engine-chain branch below applies. Without it
          // a turn that completed DURING the load appears twice (once from
          // the reloaded history, once from the live row it re-keyed).
          const mergedIds = new Set(allRows.map((m) => m.id))
          const liveTail = i.messages.slice(baseline).filter((m) => !mergedIds.has(m.id))
          return {
            ...i,
            messages: [...allRows, ...liveTail],
            messageCount: allRows.length + liveTail.length,
            historyHydrated: true,
            historyHydrationFailed: chainLoadFailed,
            externalContentStatus: content ? ('loaded' as const) : ('error' as const),
          }
        }),
      }))
    } catch (err) {
      rWarn('session.restore', 'external content load failed', { tab_id: tabId.slice(0, 8), error: String(err) })
      // Mark errored-but-hydrated so the tab is usable (count-only
      // rendering) and selectTab doesn't retry on every switch. The
      // failure marker lets rehydrateFailedHistory retry this pane when
      // the engine reconnects.
      set((s) => ({
        conversationPanes: commitInstance(s.conversationPanes, tabId, (i) => ({
          ...i,
          historyHydrated: true,
          historyHydrationFailed: true,
          externalContentStatus: 'error' as const,
        })),
      }))
    }
    return
  }

  const tab = get().tabs.find((t) => t.id === tabId)
  if (!tab || !tab.conversationId) return
  // Precise hydration gate (needsHistoryHydration): the historyHydrated
  // marker, not message emptiness — live events append to skeleton panes
  // before the user opens them, and an emptiness check would skip the
  // history load, leaving only the live tail in the transcript.
  const inst = activeInstance(get().conversationPanes, tabId)
  if (!needsHistoryHydration(inst)) return
  // Messages already present are live-streamed arrivals on the skeleton.
  // Everything before this baseline is REPLACED by the history load (a
  // completed turn is persisted, so the history covers it); anything
  // appended during the async load is kept as the live tail. Known edge:
  // a turn still streaming at this instant loses its not-yet-persisted
  // partial text — the pre-hydration window is one IPC roundtrip.
  const baseline = inst!.messages.length

  try {
    // Load all historical + current session messages in a single
    // batch IPC roundtrip. The engine's loadChainHistory command
    // loads all session IDs in order and returns a flat array.
    // No retries — the engine is already running and the files
    // are on disk. The old code used 3 retries with exponential
    // backoff (2s, 4s) causing 6+ second waits on tab switch.
    const allSessionIds = [...tab.historicalSessionIds, tab.conversationId]
    const history = await window.ion.loadChainHistory(allSessionIds)

    // Shared mapper: internal rows filtered, marker rows converted to
    // system divider Messages (compaction/plan/steer).
    const allMessages: Message[] = mapSessionHistory(history, nextMsgId)

    // Restore permissionDenied from the last tool message (only if the
    // instance doesn't already have one from the persisted state)
    const currentInst = activeInstance(get().conversationPanes, tabId)
    let restoredDenied = currentInst?.permissionDenied ?? null
    if (!restoredDenied) {
      restoredDenied = buildRestoredDenied(allMessages)
    }

    rInfo('session.restore', 'skeleton messages hydrated', { tab_id: tabId.slice(0, 8), count: allMessages.length, baseline, restored_denied: !!restoredDenied })
    // Canonical ids make the live tail dedupable: a turn that completed
    // DURING the async load appears both in the history (entry-row id)
    // and in the tail (re-keyed at message_end / keyed by toolId), so
    // drop tail rows the history already contains.
    const historyIds = new Set(allMessages.map((m) => m.id))
    set((s) => ({
      conversationPanes: commitInstance(s.conversationPanes, tabId, (i) => {
        const liveTail = i.messages.slice(baseline).filter((m) => !historyIds.has(m.id))
        return {
          ...i,
          // History first, then live messages that streamed in DURING the
          // load (past the baseline) — the pre-baseline live messages are
          // persisted turns the history already contains.
          messages: [...allMessages, ...liveTail],
          messageCount: allMessages.length + liveTail.length,
          historyHydrated: true,
          historyHydrationFailed: false,
          ...(restoredDenied ? { permissionDenied: restoredDenied } : {}),
        }
      }),
    }))
  } catch (err) {
    rWarn('session.restore', 'skeleton load failed', { tab_id: tabId.slice(0, 8), error: String(err) })
    // Mark hydrated with whatever live messages exist so the tab is
    // usable and selectTab doesn't retry the failing load on every switch.
    // The persisted messageCount is intentionally NOT clobbered with the
    // live length — the history still exists on disk, and zeroing the
    // count would lie to blank-tab detection and the iOS wire. The
    // failure marker lets rehydrateFailedHistory retry this pane when the
    // engine reconnects.
    set((s) => ({
      conversationPanes: commitInstance(s.conversationPanes, tabId, (i) => ({
        ...i,
        historyHydrated: true,
        historyHydrationFailed: true,
      })),
    }))
  }
}
