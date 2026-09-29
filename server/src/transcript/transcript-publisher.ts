/**
 * transcript-publisher — sends thin clients the server store's own transcript.
 *
 * A thin client (iOS) renders exactly the rows Studio renders: a conversation
 * instance's `messages` in `useSessionStore`. It gets them as a snapshot (a
 * `studio_body` reply, built by `openTabTranscript`) and then as one
 * `desktop_transcript_patch` per revision, which this module computes by
 * diffing the projected rows it last published against the projected rows
 * now. The client does not assemble anything from engine events; it applies
 * what it is sent, and a revision it did not expect makes it take a fresh
 * snapshot. See `@ion/shared/transcript/transcript-patch`.
 *
 * One CHANNEL per conversation instance with at least one subscriber. A
 * channel holds the rows it last published, their revision, and a random
 * epoch minted when it opened. It closes when its last subscriber leaves or
 * its conversation instance is gone, and a channel opened again gets a new
 * epoch, so a client can never apply a revision from a channel that no longer
 * exists.
 *
 * ORDERING. Patches are sent with `Connection.send` and snapshot replies with
 * `Connection.sendAnswer`; both write to the socket synchronously and the
 * socket delivers in order. `openTabTranscript` flushes, subscribes, and
 * returns the snapshot without awaiting, and its caller sends the reply
 * without awaiting, so every patch a subscriber receives after a reply at
 * revision R has `baseRev` R.
 */
import { randomUUID } from 'node:crypto'
import type { Message } from '@ion/shared/types'
import { projectTranscript, type TranscriptRow } from '@ion/shared/transcript/transcript-row'
import { transcriptStreamId } from '@ion/shared/transcript/transcript-patch'
import { useSessionStore } from '../store/sessionStore'
import { activeInstanceOfPane } from '../store/conversation-instance'
import { publishTranscriptRows, rowsForThinClients, type TranscriptChannelCore } from './transcript-channel'
import { onStreamThinkingToRemoteChange } from '../persistence/settings-store'
import type { Connection } from '../protocol/connection'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('transcript', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('transcript', msg, fields)
}

/**
 * How long a burst of store changes is collected into one patch. A streaming
 * reply changes the store on every token; one patch per ~frame keeps the phone
 * smooth without shipping a frame per token.
 */
export const TRANSCRIPT_FLUSH_MS = 33

interface TabChannel extends TranscriptChannelCore {
  tabId: string
  instanceId: string
  /**
   * The `messages` array `rows` was last computed from. The store never
   * edits a messages array in place -- every change, including one that
   * mutates a shared row object, commits a new array -- so an unchanged
   * array is an unchanged transcript, and a channel whose array did not
   * change is not re-projected. Rows themselves are still compared by
   * value: a row OBJECT can be edited in place.
   */
  source: readonly Message[]
}

/** What a snapshot reply needs about the stream it opens. */
export interface TranscriptSnapshot {
  tabId: string
  instanceId: string
  streamId: string
  epoch: string
  rev: number
  rows: TranscriptRow[]
}

const channels = new Map<string, TabChannel>()
const dirty = new Set<string>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let unsubscribeStore: (() => void) | null = null

function instanceMessages(tabId: string, instanceId: string): readonly Message[] | null {
  const pane = useSessionStore.getState().conversationPanes.get(tabId)
  const instance = pane?.instances.find((i) => i.id === instanceId)
  return instance ? instance.messages : null
}

function closeChannel(channel: TabChannel, reason: string): void {
  channels.delete(channel.streamId)
  dirty.delete(channel.streamId)
  log('transcript channel closed', {
    stream_id: channel.streamId, tab_id: channel.tabId, reason, rev: channel.rev, subscribers: channel.subscribers.size,
  })
  if (channels.size === 0 && unsubscribeStore) {
    unsubscribeStore()
    unsubscribeStore = null
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
  }
}

/** Publish whatever changed in one channel since its last revision. */
function flushChannel(channel: TabChannel): void {
  dirty.delete(channel.streamId)
  const messages = instanceMessages(channel.tabId, channel.instanceId)
  if (!messages) {
    closeChannel(channel, 'instance_gone')
    return
  }
  if (messages === channel.source) return
  // Rows are compared by value, never by identity (publishTranscriptRows).
  const rows = rowsForThinClients(projectTranscript(messages))
  channel.source = messages
  if (!publishTranscriptRows(channel, rows, { tabId: channel.tabId, instanceId: channel.instanceId })) {
    closeChannel(channel, 'no_subscribers')
  }
}

function flushDirty(): void {
  flushTimer = null
  for (const streamId of [...dirty]) {
    const channel = channels.get(streamId)
    if (channel) flushChannel(channel)
    else dirty.delete(streamId)
  }
}

/**
 * Marks only the channels whose conversation's messages array changed. A
 * client typically holds a stream for every conversation it has open, and
 * re-projecting all of them on every store change would cost a full
 * projection per conversation per token while anything streams.
 */
function onStoreChange(): void {
  for (const channel of channels.values()) {
    if (instanceMessages(channel.tabId, channel.instanceId) !== channel.source) dirty.add(channel.streamId)
  }
  if (dirty.size > 0 && !flushTimer) flushTimer = setTimeout(flushDirty, TRANSCRIPT_FLUSH_MS)
}

/**
 * Publish every pending change for `tabId` now, rather than at the end of the
 * flush window. Called before anything a client reads next must already
 * reflect: a snapshot reply, and a prompt's result (so the row the prompt
 * made reaches the client before the result that says it was accepted).
 */
export function flushTranscript(tabId: string): void {
  for (const channel of [...channels.values()]) {
    if (channel.tabId === tabId) flushChannel(channel)
  }
}

/**
 * Open (or join) the transcript stream for a tab's conversation instance and
 * return its current rows. `instanceId` absent means the tab's active
 * instance. Returns null when the tab has no such instance.
 *
 * `subscriber` is added when given: a newest-page snapshot subscribes, an
 * older page only reads. Synchronous by design; see the module's ORDERING.
 */
export function openTabTranscript(tabId: string, instanceId: string | undefined, subscriber: Connection | null): TranscriptSnapshot | null {
  const pane = useSessionStore.getState().conversationPanes.get(tabId)
  const instance = instanceId ? pane?.instances.find((i) => i.id === instanceId) : activeInstanceOfPane(pane)
  if (!instance) {
    log('transcript not opened: no such conversation instance', { tab_id: tabId, instance_id: instanceId ?? '' })
    return null
  }
  const streamId = transcriptStreamId({ kind: 'tab', tabId, instanceId: instance.id })
  let channel = channels.get(streamId)
  if (channel) {
    flushChannel(channel)
    channel = channels.get(streamId)
  }
  if (!channel) {
    channel = {
      tabId,
      instanceId: instance.id,
      streamId,
      epoch: randomUUID(),
      rev: 0,
      source: instance.messages,
      rows: rowsForThinClients(projectTranscript(instance.messages)),
      subscribers: new Set(),
    }
    const snapshot: TranscriptSnapshot = { tabId, instanceId: instance.id, streamId, epoch: channel.epoch, rev: 0, rows: channel.rows }
    if (!subscriber) {
      // A read with nobody listening: answer from a projection and keep no
      // channel. Its epoch is fresh, so a client holding another one resyncs.
      return snapshot
    }
    channels.set(streamId, channel)
    if (!unsubscribeStore) unsubscribeStore = useSessionStore.subscribe(onStoreChange)
    log('transcript channel opened', { stream_id: streamId, tab_id: tabId, rows: channel.rows.length })
  }
  if (subscriber && !channel.subscribers.has(subscriber)) {
    channel.subscribers.add(subscriber)
    log('transcript subscriber added', { stream_id: streamId, connection_id: subscriber.id, rev: channel.rev, subscribers: channel.subscribers.size })
  }
  return { tabId, instanceId: channel.instanceId, streamId, epoch: channel.epoch, rev: channel.rev, rows: channel.rows }
}

/**
 * Re-project every open stream even though its messages did not change: a
 * setting that shapes the wire rows (`streamThinkingToRemote`) did.
 */
function republishAll(reason: string): void {
  log('transcript streams re-published', { reason, streams: channels.size })
  for (const channel of [...channels.values()]) {
    channel.source = []
    flushChannel(channel)
  }
}
onStreamThinkingToRemoteChange(() => republishAll('stream_thinking_setting_changed'))

/** A connection closed: it leaves every stream it was on. */
export function forgetTranscriptSubscriber(conn: Connection): void {
  for (const channel of [...channels.values()]) {
    if (!channel.subscribers.delete(conn)) continue
    log('transcript subscriber removed: connection closed', { stream_id: channel.streamId, connection_id: conn.id })
    if (channel.subscribers.size === 0) closeChannel(channel, 'no_subscribers')
  }
}

/** Streams currently open, for diagnostics and tests. */
export function openTranscriptStreams(): string[] {
  return [...channels.keys()]
}

/** TEST ONLY: close every channel and stop listening to the store. */
export function _resetTranscriptPublisherForTest(): void {
  for (const channel of [...channels.values()]) closeChannel(channel, 'test_reset')
  if (channels.size !== 0) warn('transcript publisher reset left channels open', { count: channels.size })
}
