/**
 * dispatch-transcript-publisher — sends thin clients a dispatched agent's
 * transcript, built exactly the way Studio builds it.
 *
 * Studio shows a dispatch as its conversation file (read from the engine and
 * mapped by `mapConversationMessages`) with the dispatch's in-flight activity
 * laid on top (`mergeDispatchTranscript` over the store's
 * `dispatchActivity[dispatchId]`). This module computes the same rows on the
 * server and publishes them as a transcript stream: a snapshot answers the
 * `studio_body_request` that names the dispatch, and `desktop_transcript_patch`
 * events follow, exactly as for a tab (transcript-publisher.ts). A client
 * rebuilds nothing.
 *
 * The activity arrives through the store as it happens. The file is read when
 * the stream opens, when a tool finishes (its result lands in the file, not
 * in the activity), when the dispatch stops running, and every
 * `DISPATCH_FILE_BACKSTOP_MS` while it runs -- the same backstop interval
 * Studio's own dispatch views poll at.
 *
 * A channel whose last subscriber left is KEPT for a while, publishing and
 * reading nothing, so a client that reconnects holding its revision resumes
 * it (`openDispatchTranscript`, `held`); see transcript-publisher.ts.
 *
 * ORDERING. `openDispatchTranscript` hands the snapshot to its `answer`
 * callback synchronously, after publishing any change pending for existing
 * subscribers and adding the new one, so the first patch the new subscriber
 * receives names the snapshot's revision as its `baseRev`.
 */
import { randomUUID } from 'node:crypto'
import type { Message } from '@ion/shared/types'
import { projectTranscript, type TranscriptRow } from '@ion/shared/transcript/transcript-row'
import { transcriptStreamId } from '@ion/shared/transcript/transcript-patch'
import { mapConversationMessages, type RawSessionMessage } from '@ion/shared/transcript/agent-conversation-mapper'
import { mergeDispatchTranscript } from '../components/agent-dispatch-activity'
import { useSessionStore } from '../store/sessionStore'
import { engineBridge } from '../state'
import {
  endLinger, holdsCurrent, publishTranscriptRows, rowsForThinClients, startLinger,
  type HeldRevision, type TranscriptChannelCore,
} from './transcript-channel'
import { currentTrace } from '../tracing/op-span'
import { onStreamThinkingToRemoteChange } from '../persistence/settings-store'
import { TRANSCRIPT_FLUSH_MS } from './transcript-publisher'
import type { Connection } from '../protocol/connection'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('transcript.dispatch', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('transcript.dispatch', msg, fields)
}

/** How often a running dispatch's file is re-read when nothing else prompts it. */
export const DISPATCH_FILE_BACKSTOP_MS = 12_000

/** Where a dispatch stands in its tab's agent roster. */
export interface DispatchStanding {
  running: boolean
}

interface DispatchChannel extends TranscriptChannelCore {
  tabId: string
  conversationId: string
  dispatchId: string
  /** The mapped conversation file; undefined until the first read lands. */
  snapshot: Message[] | undefined
  /** The store's `dispatchActivity[dispatchId]` the rows were built from. */
  push: readonly Message[] | undefined
  running: boolean
  /**
   * The tab's agent-state arrays (one per instance) `running` was read from.
   * The store replaces an array when any agent changes, so the same arrays
   * mean the same standing.
   */
  roster: unknown[] | undefined
  /** Resolves once the first file read has landed (or failed). */
  ready: Promise<void>
  /** True once a file read has finished, whether or not it succeeded. */
  loaded: boolean
  reading: boolean
  readAgain: boolean
  backstop: ReturnType<typeof setInterval> | null
  closed: boolean
}

/** What a snapshot reply needs about the stream it opens. */
export interface DispatchTranscriptSnapshot {
  streamId: string
  epoch: string
  rev: number
  rows: TranscriptRow[]
  /** The caller's `held` revision is this one: it keeps its rows, and `rows` is not for sending. */
  resumed: boolean
}

type AgentMeta = {
  dispatches?: Array<{ id?: string; conversationId?: string; status?: string }>
  conversationId?: string
  conversationIds?: string[]
}

const channels = new Map<string, DispatchChannel>()
const dirty = new Set<string>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
let unsubscribeStore: (() => void) | null = null

/**
 * Whether `tabId`'s agent roster owns this dispatch, and whether it runs.
 * `dispatchId` empty names an agent with no registered dispatch, which owns
 * the conversation through its own metadata. Returns null when nothing in
 * the tab owns it: a client may read a dispatch only through the tab that
 * dispatched it.
 */
export function dispatchStanding(tabId: string, conversationId: string, dispatchId: string): DispatchStanding | null {
  const pane = useSessionStore.getState().conversationPanes.get(tabId)
  for (const inst of pane?.instances ?? []) {
    const agents = inst.agentStates ?? []
    for (const agent of agents) {
      const meta = ((agent as unknown as { metadata?: AgentMeta }).metadata ?? {}) as AgentMeta
      const dispatch = (meta.dispatches ?? []).find((d) =>
        (dispatchId ? d.id === dispatchId : true) && d.conversationId === conversationId)
      if (dispatch) return { running: dispatch.status === 'running' }
      if (!dispatchId && (meta.conversationId === conversationId || (meta.conversationIds ?? []).includes(conversationId))) {
        return { running: agent.status === 'running' }
      }
    }
  }
  return null
}

/** The agent-state arrays a channel's standing is read from. */
function rosterOf(tabId: string): unknown[] | undefined {
  const pane = useSessionStore.getState().conversationPanes.get(tabId)
  return pane?.instances.map((i) => i.agentStates)
}

function closeChannel(channel: DispatchChannel, reason: string): void {
  if (channel.closed) return
  channel.closed = true
  channels.delete(channel.streamId)
  dirty.delete(channel.streamId)
  endLinger(channel)
  if (channel.backstop) clearInterval(channel.backstop)
  channel.backstop = null
  log('dispatch transcript channel closed', {
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

/** The channel's last subscriber left: keep it at its revision, reading nothing, for a client that comes back. */
function keepForResume(channel: DispatchChannel): void {
  dirty.delete(channel.streamId)
  if (channel.backstop) clearInterval(channel.backstop)
  channel.backstop = null
  startLinger(channel, () => closeChannel(channel, 'not_resumed_in_time'))
}

/** Bring a kept channel's inputs up to the store's, now that it has a subscriber again. */
function wake(channel: DispatchChannel): void {
  channel.push = channel.dispatchId ? useSessionStore.getState().dispatchActivity[channel.dispatchId] : undefined
  channel.running = dispatchStanding(channel.tabId, channel.conversationId, channel.dispatchId)?.running ?? false
  channel.roster = rosterOf(channel.tabId)
  syncBackstop(channel)
}

function currentRows(channel: DispatchChannel): TranscriptRow[] {
  return rowsForThinClients(projectTranscript(mergeDispatchTranscript(channel.snapshot, channel.push as Message[] | undefined) ?? []))
}

/** Publish the channel's current rows to its subscribers. */
function publish(channel: DispatchChannel): boolean {
  // A dispatch push arrives on an engine event, so the ambient trace is that event's.
  return publishTranscriptRows(channel, currentRows(channel), {
    tabId: channel.tabId, conversationId: channel.conversationId, dispatchId: channel.dispatchId,
  }, currentTrace())
}

/** Keep the backstop timer running exactly while the dispatch runs. */
function syncBackstop(channel: DispatchChannel): void {
  if (channel.running && !channel.backstop && !channel.closed) {
    channel.backstop = setInterval(() => void readFile(channel, 'backstop'), DISPATCH_FILE_BACKSTOP_MS)
  } else if (!channel.running && channel.backstop) {
    clearInterval(channel.backstop)
    channel.backstop = null
  }
}

/** Read the dispatch's conversation file and publish what changed. */
async function readFile(channel: DispatchChannel, reason: string): Promise<void> {
  if (channel.closed) return
  if (channel.reading) {
    channel.readAgain = true
    return
  }
  channel.reading = true
  try {
    const data = await engineBridge.getConversation(channel.conversationId, 0, 0) as { messages?: RawSessionMessage[] }
    channel.snapshot = mapConversationMessages(data.messages ?? [])
    log('dispatch conversation file read', {
      stream_id: channel.streamId, conversation_id: channel.conversationId, reason, rows: channel.snapshot.length,
    })
  } catch (err) {
    // The previous snapshot, if any, is still the best answer.
    warn('dispatch conversation file read failed', {
      stream_id: channel.streamId, conversation_id: channel.conversationId, reason, error: String(err),
    })
  } finally {
    channel.reading = false
    channel.loaded = true
  }
  if (channel.closed) return
  if (channel.subscribers.size > 0 && !publish(channel)) keepForResume(channel)
  if (channel.readAgain) {
    channel.readAgain = false
    await readFile(channel, 'coalesced')
  }
}

function finishedToolCount(push: readonly Message[] | undefined): number {
  return (push ?? []).filter((m) => m.role === 'tool' && m.toolStatus !== 'running').length
}

function flushDirty(): void {
  flushTimer = null
  for (const streamId of [...dirty]) {
    dirty.delete(streamId)
    const channel = channels.get(streamId)
    // Before the first read lands, the opener publishes; nothing to do yet.
    if (channel && channel.loaded && channel.subscribers.size > 0 && !publish(channel)) keepForResume(channel)
  }
}

function onStoreChange(): void {
  const activity = useSessionStore.getState().dispatchActivity
  for (const channel of [...channels.values()]) {
    // Kept for resume: it stays as its last subscriber saw it until `wake`.
    if (channel.linger) continue
    const push = channel.dispatchId ? activity[channel.dispatchId] : undefined
    if (push !== channel.push) {
      const toolFinished = finishedToolCount(push) > finishedToolCount(channel.push)
      channel.push = push
      dirty.add(channel.streamId)
      if (toolFinished) void readFile(channel, 'tool_finished')
    }
    const roster = rosterOf(channel.tabId)
    if (!rosterMatches(channel, roster)) {
      const wasRunning = channel.running
      channel.running = dispatchStanding(channel.tabId, channel.conversationId, channel.dispatchId)?.running ?? false
      channel.roster = roster
      syncBackstop(channel)
      if (wasRunning && !channel.running) {
        log('dispatch stopped running; reading its file once more', { stream_id: channel.streamId })
        void readFile(channel, 'stopped')
      }
    }
  }
  if (dirty.size > 0 && !flushTimer) flushTimer = setTimeout(flushDirty, TRANSCRIPT_FLUSH_MS)
}

/** Whether the roster the channel's standing came from is still the store's. */
function rosterMatches(channel: DispatchChannel, roster: unknown[] | undefined): boolean {
  const a = channel.roster
  const b = roster
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((v, i) => v === b[i])
}

/**
 * Open (or join) a dispatched agent's transcript stream and hand its current
 * rows to `answer`. Returns false when `tabId` does not own the dispatch.
 *
 * `subscriber` is added when given (a newest-page request); an older-page
 * read only reads. `answer` runs synchronously after the subscriber is added;
 * see the module's ORDERING.
 *
 * `held` is the revision the subscriber says it still holds. When that is
 * the channel's revision the snapshot is `resumed`: the subscriber keeps its
 * rows, and whatever changed since is published as a patch after `answer`.
 */
export async function openDispatchTranscript(
  tabId: string,
  conversationId: string,
  dispatchId: string,
  subscriber: Connection | null,
  answer: (snapshot: DispatchTranscriptSnapshot) => void,
  held?: HeldRevision,
): Promise<boolean> {
  const standing = dispatchStanding(tabId, conversationId, dispatchId)
  if (!standing) {
    warn('dispatch transcript refused: the tab does not own this dispatch', { tab_id: tabId, conversation_id: conversationId, dispatch_id: dispatchId })
    return false
  }
  const streamId = transcriptStreamId({ kind: 'dispatch', tabId, conversationId, dispatchId })
  let channel = channels.get(streamId)
  if (channel?.linger && !(subscriber && holdsCurrent(channel, held))) {
    // Kept for a client that did not come back holding its revision.
    closeChannel(channel, 'not_resumed')
    channel = undefined
  }
  if (!channel) {
    const created: DispatchChannel = {
      streamId, tabId, conversationId, dispatchId,
      epoch: randomUUID(), rev: 0, rows: [], subscribers: new Set(), linger: null,
      snapshot: undefined,
      push: dispatchId ? useSessionStore.getState().dispatchActivity[dispatchId] : undefined,
      running: standing.running,
      roster: rosterOf(tabId),
      ready: Promise.resolve(),
      loaded: false,
      reading: false, readAgain: false, backstop: null, closed: false,
    }
    channel = created
    channels.set(streamId, channel)
    if (!unsubscribeStore) unsubscribeStore = useSessionStore.subscribe(onStoreChange)
    created.ready = readFile(created, 'open').then(() => {
      created.rows = currentRows(created)
    })
    syncBackstop(created)
    log('dispatch transcript channel opened', { stream_id: streamId, tab_id: tabId, running: standing.running })
  }
  await channel.ready
  if (channel.closed) {
    // Every subscriber left while the file was read. Answer from what was read.
    answer({ streamId, epoch: channel.epoch, rev: channel.rev, rows: currentRows(channel), resumed: false })
    return true
  }
  const resumed = subscriber !== null && holdsCurrent(channel, held)
  const kept = channel.linger !== null
  if (!resumed) publish(channel)
  if (subscriber && !channel.subscribers.has(subscriber)) {
    channel.subscribers.add(subscriber)
    endLinger(channel)
    log('dispatch transcript subscriber added', { stream_id: streamId, connection_id: subscriber.id, rev: channel.rev, subscribers: channel.subscribers.size, resumed })
  }
  answer({ streamId, epoch: channel.epoch, rev: channel.rev, rows: channel.rows, resumed })
  if (resumed) {
    if (kept) {
      wake(channel)
      void readFile(channel, 'resumed')
    } else if (!publish(channel)) {
      keepForResume(channel)
    }
  }
  if (channel.subscribers.size === 0 && !channel.linger) closeChannel(channel, 'read_only')
  return true
}

onStreamThinkingToRemoteChange(() => {
  log('dispatch transcript streams re-published', { reason: 'stream_thinking_setting_changed', streams: channels.size })
  for (const channel of [...channels.values()]) {
    if (channel.subscribers.size === 0) {
      // Its rows have the old shape, so nobody may resume them.
      closeChannel(channel, 'stream_thinking_setting_changed')
    } else if (channel.loaded && !publish(channel)) {
      keepForResume(channel)
    }
  }
})

/** A connection closed: it leaves every dispatch stream it was on. */
export function forgetDispatchSubscriber(conn: Connection): void {
  for (const channel of [...channels.values()]) {
    if (!channel.subscribers.delete(conn)) continue
    log('dispatch transcript subscriber removed: connection closed', { stream_id: channel.streamId, connection_id: conn.id })
    if (channel.subscribers.size === 0) keepForResume(channel)
  }
}

/** Dispatch streams currently open, for diagnostics and tests. */
export function openDispatchStreams(): string[] {
  return [...channels.keys()]
}

/** TEST ONLY: close every channel and stop listening to the store. */
export function _resetDispatchTranscriptPublisherForTest(): void {
  for (const channel of [...channels.values()]) closeChannel(channel, 'test_reset')
}
