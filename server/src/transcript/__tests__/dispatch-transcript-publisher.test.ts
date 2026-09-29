/**
 * A dispatched agent's transcript stream: the rows Studio computes for a
 * dispatch (its conversation file plus its in-flight activity), published as
 * a snapshot and revisioned patches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyTranscriptChange, type TranscriptPatchEvent } from '@ion/shared/transcript/transcript-patch'
import { projectTranscript, type TranscriptRow } from '@ion/shared/transcript/transcript-row'
import { mapConversationMessages, type RawSessionMessage } from '@ion/shared/transcript/agent-conversation-mapper'
import type { Message } from '@ion/shared/types'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { mergeDispatchTranscript } from '../../components/agent-dispatch-activity'

const store = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const state = {
    conversationPanes: new Map<string, { activeInstanceId: string; instances: Array<{ id: string; messages: unknown[]; agentStates: unknown[] }> }>(),
    dispatchActivity: {} as Record<string, unknown[]>,
  }
  return {
    state,
    listeners,
    api: {
      getState: () => state,
      subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) },
    },
    emit: () => { for (const fn of [...listeners]) fn() },
  }
})
const engine = vi.hoisted(() => ({ files: new Map<string, unknown[]>(), reads: [] as string[] }))
vi.mock('../../store/sessionStore', () => ({ useSessionStore: store.api }))
vi.mock('../../state', () => ({
  engineBridge: {
    getConversation: vi.fn(async (id: string) => {
      engine.reads.push(id)
      return { messages: engine.files.get(id) ?? [], total: 0, hasMore: false }
    }),
  },
}))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
const thinkingSetting = vi.hoisted(() => ({ enabled: true, listeners: new Set<() => void>() }))
vi.mock('../../persistence/settings-store', () => ({
  shouldStreamThinkingToRemote: () => thinkingSetting.enabled,
  onStreamThinkingToRemoteChange: (fn: () => void) => { thinkingSetting.listeners.add(fn); return () => thinkingSetting.listeners.delete(fn) },
}))

import {
  DISPATCH_FILE_BACKSTOP_MS,
  _resetDispatchTranscriptPublisherForTest,
  forgetDispatchSubscriber,
  openDispatchStreams,
  openDispatchTranscript,
  type DispatchTranscriptSnapshot,
} from '../dispatch-transcript-publisher'
import { TRANSCRIPT_FLUSH_MS } from '../transcript-publisher'
import { recordingConnection } from '../../protocol/__tests__/recording-connection'

function roster(status: string): void {
  store.state.conversationPanes.set('tab-1', {
    activeInstanceId: 'main',
    instances: [{
      id: 'main', messages: [],
      agentStates: [{ name: 'worker', status, metadata: { dispatches: [{ id: 'd1', conversationId: 'c1', status }] } }],
    }],
  })
  store.emit()
}

function activity(messages: Message[]): void {
  store.state.dispatchActivity = { ...store.state.dispatchActivity, d1: messages }
  store.emit()
}

const file: RawSessionMessage[] = [
  { role: 'user', content: 'find the bug', timestamp: 1000 },
  { role: 'assistant', content: 'Looking.', timestamp: 2000 },
  { role: 'tool', content: 'a.ts\nb.ts', toolName: 'Bash', toolId: 't1', toolInput: '{"command":"ls"}', timestamp: 3000 },
]

async function open(conn: ReturnType<typeof recordingConnection>['conn'] | null, dispatchId = 'd1', tabId = 'tab-1'): Promise<DispatchTranscriptSnapshot | null> {
  let answer: DispatchTranscriptSnapshot | null = null
  const owned = await openDispatchTranscript(tabId, 'c1', dispatchId, conn, (s) => { answer = s })
  return owned ? answer : null
}

function patches(sent: StudioFrame[]): TranscriptPatchEvent[] {
  return sent
    .filter((f): f is Extract<StudioFrame, { type: 'studio_event' }> => f.type === 'studio_event')
    .map((f) => f.payload as TranscriptPatchEvent)
    .filter((p) => p.type === 'desktop_transcript_patch')
}

/** What Studio shows for the dispatch, projected for the wire. */
function studioRows(fileRows: RawSessionMessage[], push: Message[] | undefined): TranscriptRow[] {
  return projectTranscript(mergeDispatchTranscript(mapConversationMessages(fileRows), push) ?? [])
}

const running = (id: string, ts: number): Message => ({ id, role: 'tool', content: '', toolName: 'Read', toolId: id, toolStatus: 'running', timestamp: ts })

beforeEach(() => {
  vi.useFakeTimers()
  _resetDispatchTranscriptPublisherForTest()
  store.state.conversationPanes.clear()
  store.state.dispatchActivity = {}
  engine.files.clear()
  engine.reads.length = 0
  engine.files.set('c1', file)
})
afterEach(() => {
  _resetDispatchTranscriptPublisherForTest()
  vi.useRealTimers()
})

describe('dispatch transcript publisher', () => {
  it('refuses a dispatch the tab does not own', async () => {
    roster('running')
    const { conn } = recordingConnection({ view: 'thin' })
    expect(await open(conn, 'd1', 'another-tab')).toBeNull()
    expect(await open(conn, 'd-unknown')).toBeNull()
    expect(openDispatchStreams()).toEqual([])
  })

  it('answers with exactly the rows Studio shows: the file with the activity on top', async () => {
    roster('running')
    const push = [running('t2', 4000)]
    store.state.dispatchActivity = { d1: push }
    const { conn } = recordingConnection({ view: 'thin' })
    const snap = (await open(conn))!
    expect(snap.rev).toBe(0)
    expect(snap.rows).toEqual(studioRows(file, push))
    expect(snap.rows.map((r) => r.id)).toEqual(['user-1000', 'assistant-2000', 'tool-t1', 't2'])
    expect(snap.streamId).toBe('dispatch:c1:d1')
  })

  it('publishes new activity as a patch that continues from the snapshot', async () => {
    roster('running')
    const { conn, sent } = recordingConnection({ view: 'thin' })
    let rows = (await open(conn))!.rows
    activity([running('t2', 4000)])
    vi.advanceTimersByTime(TRANSCRIPT_FLUSH_MS)
    const got = patches(sent)
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ baseRev: 0, rev: 1, streamId: 'dispatch:c1:d1', tabId: 'tab-1', conversationId: 'c1', dispatchId: 'd1' })
    rows = applyTranscriptChange(rows, got[0].change)!
    expect(rows).toEqual(studioRows(file, [running('t2', 4000)]))
  })

  it('reads the file again when a tool finishes, so its result appears', async () => {
    roster('running')
    const { conn, sent } = recordingConnection({ view: 'thin' })
    let rows = (await open(conn))!.rows
    activity([running('t2', 4000)])
    vi.advanceTimersByTime(TRANSCRIPT_FLUSH_MS)

    const withResult = [...file, { role: 'tool', content: 'contents of a.ts', toolName: 'Read', toolId: 't2', timestamp: 4000 }]
    engine.files.set('c1', withResult)
    activity([{ ...running('t2', 4000), toolStatus: 'completed' }])
    // One flush window, well inside the backstop: only the finished tool
    // can have prompted this read.
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_FLUSH_MS)

    for (const p of patches(sent)) rows = applyTranscriptChange(rows, p.change)!
    expect(rows).toEqual(studioRows(withResult, [{ ...running('t2', 4000), toolStatus: 'completed' }]))
    expect(rows.find((r) => r.toolId === 't2')?.content).toBe('contents of a.ts')
  })

  it('reads the file once more when the dispatch stops running', async () => {
    roster('running')
    const { conn } = recordingConnection({ view: 'thin' })
    await open(conn)
    const readsBefore = engine.reads.length
    roster('done')
    await vi.advanceTimersByTimeAsync(0)
    expect(engine.reads.length).toBe(readsBefore + 1)
  })

  it('re-reads a running dispatch on the backstop, and stops once it is done', async () => {
    roster('running')
    const { conn } = recordingConnection({ view: 'thin' })
    await open(conn)
    const readsBefore = engine.reads.length
    await vi.advanceTimersByTimeAsync(DISPATCH_FILE_BACKSTOP_MS)
    expect(engine.reads.length).toBe(readsBefore + 1)

    roster('done')
    await vi.advanceTimersByTimeAsync(0)
    const readsAfterStop = engine.reads.length
    await vi.advanceTimersByTimeAsync(DISPATCH_FILE_BACKSTOP_MS * 3)
    expect(engine.reads.length).toBe(readsAfterStop)
  })

  it('an older-page read keeps no stream open', async () => {
    roster('done')
    expect(await open(null)).not.toBeNull()
    expect(openDispatchStreams()).toEqual([])
  })

  it('closes the stream when its last subscriber leaves', async () => {
    roster('running')
    const { conn } = recordingConnection({ view: 'thin' })
    await open(conn)
    expect(openDispatchStreams()).toEqual(['dispatch:c1:d1'])
    forgetDispatchSubscriber(conn)
    expect(openDispatchStreams()).toEqual([])
  })

  it('keeps two dispatches of one conversation apart', async () => {
    store.state.conversationPanes.set('tab-1', {
      activeInstanceId: 'main',
      instances: [{
        id: 'main', messages: [],
        agentStates: [{ name: 'worker', status: 'running', metadata: { dispatches: [
          { id: 'd1', conversationId: 'c1', status: 'done' },
          { id: 'd2', conversationId: 'c1', status: 'running' },
        ] } }],
      }],
    })
    store.state.dispatchActivity = { d1: [running('old', 100)], d2: [running('new', 5000)] }
    const { conn } = recordingConnection({ view: 'thin' })
    const first = (await open(conn, 'd1'))!
    const second = (await open(conn, 'd2'))!
    expect(first.rows.map((r) => r.id)).toContain('old')
    expect(first.rows.map((r) => r.id)).not.toContain('new')
    expect(second.rows.map((r) => r.id)).toContain('new')
    expect(second.rows.map((r) => r.id)).not.toContain('old')
  })
})
