/**
 * body-sync — every Studio client's conversation-body channel
 * (`studio_body_request` -> `studio_body`, manifest contract C3).
 *
 * Conversation bodies deliberately never ride the snapshot: `snapshot.ts`
 * strips `conversationPane`, so a client learns which tabs exist from
 * `studio:tabs-sync` but gets no message rows with them. This module is the
 * only return path, and `bootMirror` starts it unconditionally for the
 * Electron window and the browser alike; there is no Electron-only IPC pull.
 * Before this module existed the server implemented and documented the body
 * channel, but nothing on the client ever sent the request, so every
 * conversation rendered empty while the inbox looked fully populated.
 *
 * Forwarding `loadSkeletonMessages` is not a substitute. That action is in
 * FORWARDED_ACTIONS, so it runs in the SERVER's store and hydrates the
 * SERVER's pane; its return value is `void`. The rows never cross back. This
 * module is the return path.
 */
import { useSessionStore } from '@ion/server/store/sessionStore'
import { activeInstanceOfPane } from '@ion/server/store/conversation-instance'
import { environmentOfTab } from '../connection/tab-environment'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import type { Message } from '@ion/shared/types'
import { host } from '../../host/host-instance'
import { rDebug, rWarn } from '../../rendererLogger'

/** Tabs with a body request in flight, so a re-render cannot re-ask. */
const inFlight = new Set<string>()

/**
 * Tabs the server has already answered with a body on this connection.
 *
 * This is what decides whether a conversation still needs its rows, rather
 * than `needsHistoryHydration`. That helper answers a different question --
 * the OWNER's "has this pane loaded its history" -- and its last clause
 * ("no messages, but the persisted count says there are some") cannot hold
 * on a mirror: the welcome strips `conversationPane`, so a mirror pane's
 * `messageCount` starts at 0, and a live event that lands before the tab
 * sync leaves the pane holding a row or two with no hydration marker at all.
 * Read through that helper, such a pane says "nothing to load" forever, and
 * the conversation renders as just the turns that arrived after the reload
 * while the phone -- which asks the server directly -- shows all of it.
 *
 * "Have I fetched this conversation's rows yet" is a fact this module owns,
 * so it is the one it asks. An empty conversation answers with zero rows and
 * is recorded the same way, so nothing re-asks in a loop.
 *
 * The memory lives exactly as long as the pane it describes. An Environment
 * that goes offline has its panes deleted (`secondary-store-purge.ts`), and
 * the panes it gets back when it returns are skeletons. Those skeletons do
 * not stay empty: a live event can land a row in one before the operator
 * opens it. A memory that outlived the deleted pane, read against the new
 * one, said "already answered" about rows that were gone, and the
 * conversation rendered blank with no request in flight. So every store
 * change sweeps both sets against the pane map (`forgetGonePanes`), and a
 * tab whose pane is gone is forgotten whether or not it is the active one.
 */
const answered = new Set<string>()

/**
 * Replace one pane instance's rows with the server's authoritative body.
 *
 * Mirrors `applyHistoryReplace`'s commit shape (targets the named instance,
 * falls back to the pane's active one) rather than `commitInstance`, which
 * only ever reaches the active instance — a body can arrive for a background
 * instance the mirror is not currently viewing.
 */
export function applyStudioBody(tabId: string, instanceId: string | undefined, rows: unknown[], prepend = false): boolean {
  const state = useSessionStore.getState()
  const pane = state.conversationPanes.get(tabId)
  if (!pane) return false
  const targetId = instanceId ?? pane.activeInstanceId ?? pane.instances[0]?.id
  if (!targetId) return false
  const idx = pane.instances.findIndex((i) => i.id === targetId)
  if (idx === -1) return false

  const messages = rows.filter((row): row is Message => {
    const m = row as Partial<Message> | null
    return !!m && typeof m === 'object' && typeof m.id === 'string' && typeof m.role === 'string'
  })
  if (messages.length !== rows.length) {
    rWarn('studio.body-sync', 'dropped malformed body rows', {
      tab_id: tabId, received: rows.length, kept: messages.length,
    })
  }

  useSessionStore.setState((current) => {
    const livePane = current.conversationPanes.get(tabId)
    if (!livePane) return {}
    const liveIdx = livePane.instances.findIndex((i) => i.id === targetId)
    if (liveIdx === -1) return {}
    const instances = livePane.instances.slice()
    // An older page goes in front of what is already held; the newest page
    // replaces, because it is the authoritative tail.
    const next = prepend ? [...messages, ...instances[liveIdx].messages] : messages
    instances[liveIdx] = {
      ...instances[liveIdx],
      messages: next,
      messageCount: next.length,
      historyHydrated: true,
      historyHydrationFailed: false,
      externalContentStatus: 'loaded',
    }
    const conversationPanes = new Map(current.conversationPanes)
    conversationPanes.set(tabId, { ...livePane, instances })
    return { conversationPanes }
  })
  return true
}

/**
 * Rows per page.
 *
 * An unpaged request answers with the whole transcript in ONE frame, and a
 * long conversation does not fit: 2679 rows serialised to 8,390,207 bytes,
 * 1,599 over the connection's 8 MiB send cap, so the server closed the
 * socket mid-write. Studio reconnected, asked again, and blew it again --
 * the conversation flashed into view and vanished, repeatedly, while the
 * phone showed it fine because a thin client has always asked for pages.
 *
 * 400 rows keeps a page comfortably inside the cap at the ~3 KB/row this
 * transcript measured, with room for a conversation whose rows are heavier.
 * The server clamps a request to [PAGE_SIZE, BULK_PAGE_MESSAGES] anyway.
 */
const PAGE_ROWS = 400

/**
 * Ask the server for one page of a tab's rows, unless that ask is already
 * outstanding. `before` walks backwards through older pages.
 */
function requestBody(tabId: string, before?: string): void {
  if (inFlight.has(tabId)) return
  const pane = useSessionStore.getState().conversationPanes.get(tabId)
  const instanceId = pane ? (pane.activeInstanceId ?? pane.instances[0]?.id) : undefined
  inFlight.add(tabId)
  rDebug('studio.body-sync', 'requesting conversation body', {
    tab_id: tabId, instance_id: instanceId ?? '', limit: PAGE_ROWS, before: before ?? '',
  })
  // The body lives on the server that owns the tab (ADR-033 union store).
  host.send(environmentOfTab(tabId) ?? LOCAL_ENVIRONMENT_ID, {
    type: 'studio_body_request',
    tabId,
    limit: PAGE_ROWS,
    ...(before ? { before } : {}),
    ...(instanceId ? { instanceId } : {}),
  })
}

/** Why the active tab does or does not need its rows fetched. */
type BodyDecision = 'request' | 'no_pane' | 'hydrated' | 'answered'

function bodyDecision(tabId: string): BodyDecision {
  const pane = useSessionStore.getState().conversationPanes.get(tabId)
  if (!pane) return 'no_pane'
  // A hydrated instance carries real rows already: either the owner filled
  // it, or an answer from this module did (`applyStudioBody` sets the mark).
  if (activeInstanceOfPane(pane)?.historyHydrated === true) return 'hydrated'
  // Answered for THIS pane: `forgetGonePanes` drops the record the moment
  // the pane it filled is deleted, so a rebuilt pane is never mistaken for
  // the one the answer went into.
  if (answered.has(tabId)) return 'answered'
  return 'request'
}

/**
 * Forget every tab whose pane no longer exists. Runs on every store change,
 * so a pane deleted while another conversation is on screen is forgotten
 * too -- not only the one the operator happens to be looking at.
 */
function forgetGonePanes(): void {
  if (answered.size === 0 && inFlight.size === 0) return
  const panes = useSessionStore.getState().conversationPanes
  for (const tabId of new Set([...answered, ...inFlight])) {
    if (panes.has(tabId)) continue
    rDebug('studio.body-sync', 'pane gone; forgetting what this connection fetched for it', {
      tab_id: tabId, was_answered: answered.has(tabId), was_in_flight: inFlight.has(tabId),
    })
    forget(tabId)
  }
}

/** Drops what this module remembers about one tab. */
function forget(tabId: string): void {
  answered.delete(tabId)
  inFlight.delete(tabId)
}

/**
 * Wire the body channel: request the active conversation's rows whenever it
 * changes to one that has none, and apply whatever the server answers.
 *
 * Only the ACTIVE tab is requested. Every open tab has a pane, and eagerly
 * pulling all of them would fan a full transcript read per tab across the
 * wire at connect time for conversations the operator may never open.
 */
export function initBodySyncFromWire(): () => void {
  const offFrame = host.onFrame((_environmentId, frame) => {
    if (frame.type !== 'studio_body') return
    inFlight.delete(frame.tabId)
    answered.add(frame.tabId)
    // `before` echoes the request's own cursor: null on the newest page, so
    // that page replaces and every older one goes in front of it.
    const older = frame.before != null
    const applied = applyStudioBody(frame.tabId, frame.instanceId, frame.rows, older)
    rDebug('studio.body-sync', 'conversation body applied', {
      tab_id: frame.tabId, row_count: frame.rows.length, applied,
      older, has_more: frame.hasMore === true,
    })
    // Keep walking back until the transcript is whole. Each page is its own
    // frame, so a conversation of any length arrives inside the send cap.
    if (applied && frame.hasMore === true && frame.cursor) {
      requestBody(frame.tabId, frame.cursor)
    }
  })

  let lastLogged: string | null = null
  const pump = (): void => {
    forgetGonePanes()
    const tabId = useSessionStore.getState().activeTabId
    if (!tabId) return
    const decision = bodyDecision(tabId)
    // One line per activation: the store changes far too often to log each
    // pump, but a conversation that opens blank must say why it was skipped.
    const key = `${tabId}:${decision}`
    if (key !== lastLogged) {
      lastLogged = key
      rDebug('studio.body-sync', 'body decision for the active tab', { tab_id: tabId, decision })
    }
    if (decision === 'request') requestBody(tabId)
  }
  pump()
  const unsubscribe = useSessionStore.subscribe(pump)

  return () => {
    offFrame()
    unsubscribe()
    inFlight.clear()
    answered.clear()
  }
}

