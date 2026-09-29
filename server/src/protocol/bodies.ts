/**
 * bodies — `studio_body_request` -> `studio_body` (manifest contract C3).
 *
 * Conversation bodies never ride the snapshot (`snapshot.ts` strips
 * `conversationPane`/`terminalBuffers`) — a Studio client asks for one tab's
 * rows explicitly. Once answered, further updates to the same conversation
 * stream as ordinary `studio_event`s on `ion:normalized-event`
 * (`events.ts`) — this module only ever answers the one-shot backfill
 * request.
 *
 * The answer is whatever THIS server's own store holds for the tab, after
 * running the store's `loadSkeletonMessages` to make sure it is loaded. That
 * delegation is the whole point: the store's `hydrate()` merges the engine
 * chain (resolved through `tab.conversationId` plus `historicalSessionIds`)
 * with the tab's externalized content file, dedupes the overlap, and maps
 * every row into the `Message` shape a client renders. An earlier version of
 * this module re-derived the rows here instead — engine
 * `loadSessionHistory(tabId)` concatenated with the raw content file — which
 * was wrong twice over: it keyed the engine read on the TAB id rather than
 * the conversation chain (so a restored conversation answered empty), and it
 * was a second mapping of the same data that could drift from the one the
 * owner window renders. There is one hydration path now, and both the
 * server's own store and every remote client read its result.
 *
 * PAGING. A request naming `before` or `limit` gets one page, newest first,
 * snapped to a turn boundary, instead of the whole transcript. The window is
 * cut from the SAME hydrated rows, so a paged client and an unpaged one see
 * one transcript. A request naming neither is answered exactly as before:
 * the reply carries no paging field at all.
 */
import { scopeSatisfies } from '@ion/shared/studio-wire/action-scopes'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { useSessionStore } from '../store/sessionStore'
import { activeInstanceOfPane } from '../store/conversation-instance'
import { clampPageSize, paginateHistory } from '../remote/handlers/tabs-session-chain'
import { openTabTranscript } from '../transcript/transcript-publisher'
import { openDispatchTranscript } from '../transcript/dispatch-transcript-publisher'
import { clampTranscriptPageRows, pageTranscript } from '@ion/shared/transcript/transcript-page'
import { log as _log, warn as _warn } from '../logger'
import type { Connection } from './connection'
import { tabIdVisibleToSubject } from './tabs-index'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('studio-bodies', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('studio-bodies', msg, fields)
}

export type StudioBodyRequestFrame = Extract<StudioFrame, { type: 'studio_body_request' }>

export async function handleBodyRequest(conn: Connection, frame: StudioBodyRequestFrame): Promise<void> {
  // A body is an answer the client asked for, and a client asks for many at
  // once when it connects: each is built and sent only after the previous
  // one left the socket (see Connection.answerInTurn).
  await conn.answerInTurn(() => answerBody(conn, frame))
}

async function answerBody(conn: Connection, frame: StudioBodyRequestFrame): Promise<void> {
  if (!scopeSatisfies(conn.scopes, 'conversations:read')) {
    warn('body request refused: insufficient scope', { connection_id: conn.id, tab_id: frame.tabId })
    await conn.sendAnswer({ type: 'studio_body', tabId: frame.tabId, instanceId: frame.instanceId, rows: [] })
    return
  }

  // A body is the conversation itself, so it follows the same ownership rule
  // as the conversation's live events (`events.ts`'s `visibleTo`). Scope alone
  // says the caller may read conversations, not which ones: without this, any
  // connection could read any tab's rows by naming its id.
  const subject = conn.principal?.subject ?? null
  if (!tabIdVisibleToSubject(frame.tabId, subject)) {
    warn('body request refused: tab not visible to this principal', {
      connection_id: conn.id, tab_id: frame.tabId, view: conn.view, principal_present: subject !== null,
    })
    await conn.sendAnswer({ type: 'studio_body', tabId: frame.tabId, instanceId: frame.instanceId, rows: [] })
    return
  }

  if (frame.conversationId !== undefined) {
    if (conn.view !== 'thin') {
      warn('dispatch body refused: only a thin view reads dispatch transcripts', { connection_id: conn.id, tab_id: frame.tabId })
      await conn.sendAnswer({ type: 'studio_body', tabId: frame.tabId, conversationId: frame.conversationId, dispatchId: frame.dispatchId, rows: [] })
      return
    }
    await answerDispatchBody(conn, frame, frame.conversationId)
    return
  }

  if (conn.view === 'thin') {
    await answerThinBody(conn, frame)
    return
  }

  try {
    await useSessionStore.getState().loadSkeletonMessages(frame.tabId)
  } catch (err) {
    // Hydration failure is not fatal to the request: whatever the pane
    // already holds is still the honest answer, and the client renders it
    // rather than hanging on a reply that never comes.
    warn('body request hydration failed; answering with whatever the pane holds', {
      connection_id: conn.id, tab_id: frame.tabId, error: String(err),
    })
  }

  const pane = useSessionStore.getState().conversationPanes.get(frame.tabId)
  const instance = frame.instanceId
    ? (pane?.instances.find((i) => i.id === frame.instanceId) ?? null)
    : activeInstanceOfPane(pane)
  const all = instance?.messages ?? []
  const paged = frame.before !== undefined || frame.limit !== undefined

  if (!paged) {
    log('body request answered', {
      connection_id: conn.id,
      tab_id: frame.tabId,
      instance_id: frame.instanceId ?? '',
      row_count: all.length,
      pane_present: pane != null,
      paged: false,
    })
    await conn.sendAnswer({ type: 'studio_body', tabId: frame.tabId, instanceId: frame.instanceId, rows: all })
    return
  }

  const { page, hasMore, cursor, total } = paginateHistory(all, frame.before, clampPageSize(frame.limit))
  log('body request answered', {
    connection_id: conn.id,
    tab_id: frame.tabId,
    instance_id: frame.instanceId ?? '',
    row_count: page.length,
    total,
    has_more: hasMore,
    before: frame.before ?? '',
    pane_present: pane != null,
    paged: true,
  })
  await conn.sendAnswer({ type: 'studio_body', tabId: frame.tabId, instanceId: frame.instanceId, rows: page, hasMore, ...(cursor ? { cursor } : {}), before: frame.before ?? null })
}

/**
 * A thin connection's body is the store's own transcript, projected for the
 * wire: the rows Studio renders, not a second mapping of the engine's
 * history. The reply opens (or joins) the conversation's transcript stream
 * and carries its revision, and `desktop_transcript_patch` events follow.
 *
 * Everything from `openTabTranscript` to `sendAnswer` runs without awaiting,
 * so no patch can be written to the socket between the snapshot being taken
 * and the reply that carries it (see transcript-publisher.ts, ORDERING).
 */
async function answerThinBody(conn: Connection, frame: StudioBodyRequestFrame): Promise<void> {
  try {
    await useSessionStore.getState().loadSkeletonMessages(frame.tabId)
  } catch (err) {
    warn('thin body hydration failed; answering with whatever the pane holds', {
      connection_id: conn.id, tab_id: frame.tabId, error: String(err),
    })
  }
  const newest = frame.before === undefined
  const snapshot = openTabTranscript(frame.tabId, frame.instanceId, newest ? conn : null)
  if (!snapshot) {
    log('thin body answered empty: no such conversation', { connection_id: conn.id, tab_id: frame.tabId, instance_id: frame.instanceId ?? '' })
    await conn.sendAnswer({ type: 'studio_body', tabId: frame.tabId, instanceId: frame.instanceId, rows: [], hasMore: false, before: frame.before ?? null })
    return
  }
  const page = pageTranscript(snapshot.rows, frame.before, clampTranscriptPageRows(frame.limit))
  log('thin body request answered', {
    connection_id: conn.id,
    tab_id: frame.tabId,
    stream_id: snapshot.streamId,
    rev: snapshot.rev,
    row_count: page.rows.length,
    start_index: page.startIndex,
    total: page.total,
    has_more: page.hasOlder,
    before: frame.before ?? '',
    subscribed: newest,
  })
  const sent = await conn.sendAnswer({
    type: 'studio_body',
    tabId: frame.tabId,
    instanceId: snapshot.instanceId,
    rows: page.rows,
    hasMore: page.hasOlder,
    ...(page.cursor ? { cursor: page.cursor } : {}),
    before: frame.before ?? null,
    streamId: snapshot.streamId,
    epoch: snapshot.epoch,
    rev: snapshot.rev,
    total: page.total,
    startIndex: page.startIndex,
  })
  if (!sent) log('thin body answer not delivered', { connection_id: conn.id, tab_id: frame.tabId })
}

/**
 * A dispatched agent's transcript for a thin connection: the rows Studio
 * shows for that dispatch, as a transcript stream of its own. The tab named
 * must own the dispatch (dispatch-transcript-publisher.ts).
 *
 * The page is cut and sent inside the publisher's `answer` callback, which
 * runs synchronously after the connection subscribes; see that module's
 * ORDERING.
 */
async function answerDispatchBody(conn: Connection, frame: StudioBodyRequestFrame, conversationId: string): Promise<void> {
  const dispatchId = frame.dispatchId ?? ''
  const newest = frame.before === undefined
  let sent: Promise<boolean> | null = null
  const owned = await openDispatchTranscript(frame.tabId, conversationId, dispatchId, newest ? conn : null, (snapshot) => {
    const page = pageTranscript(snapshot.rows, frame.before, clampTranscriptPageRows(frame.limit))
    log('dispatch body request answered', {
      connection_id: conn.id,
      tab_id: frame.tabId,
      stream_id: snapshot.streamId,
      rev: snapshot.rev,
      row_count: page.rows.length,
      start_index: page.startIndex,
      total: page.total,
      has_more: page.hasOlder,
      before: frame.before ?? '',
      subscribed: newest,
    })
    sent = conn.sendAnswer({
      type: 'studio_body',
      tabId: frame.tabId,
      conversationId,
      dispatchId,
      rows: page.rows,
      hasMore: page.hasOlder,
      ...(page.cursor ? { cursor: page.cursor } : {}),
      before: frame.before ?? null,
      streamId: snapshot.streamId,
      epoch: snapshot.epoch,
      rev: snapshot.rev,
      total: page.total,
      startIndex: page.startIndex,
    })
  })
  if (!owned) {
    await conn.sendAnswer({ type: 'studio_body', tabId: frame.tabId, conversationId, dispatchId, rows: [], hasMore: false, before: frame.before ?? null })
    return
  }
  if (sent && !(await sent)) log('dispatch body answer not delivered', { connection_id: conn.id, tab_id: frame.tabId })
}
