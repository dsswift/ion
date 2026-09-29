/**
 * The golden transcript replay: the cross-language parity pin.
 *
 * Drives the REAL server store reducer through a recorded conversation --
 * streamed text across two messages, a tool call with streamed input and a
 * result, the canonical re-key at message end, a thinking block, a stream
 * reset, a steer, a harness message relocated by its dedup key, and a
 * wholesale history replace -- with the REAL publisher recording what it
 * sends a thin client. The snapshot, every patch, and the final rows are
 * written to `packages/shared/src/transcript/__fixtures__/transcript-replay.json`.
 *
 * The iOS suite replays that file and asserts its rows equal `final` field by
 * field. So the server's rows, the patches, and the phone's rows are pinned
 * to each other: a change on either side that makes them disagree fails CI.
 *
 * Regenerate after an intended change with
 *   UPDATE_TRANSCRIPT_FIXTURE=1 npx vitest run src/transcript/__tests__/transcript-replay-fixture.test.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent, TabState } from '@ion/shared/types'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { applyTranscriptChange, type TranscriptPatchEvent } from '@ion/shared/transcript/transcript-patch'
import type { TranscriptRow } from '@ion/shared/transcript/transcript-row'

let msgSeq = 0
vi.mock('../../store/session-store-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../store/session-store-helpers')>()),
  nextMsgId: () => `msg-${++msgSeq}`,
  playNotificationIfHidden: vi.fn(async () => {}),
  scheduleDoneGroupMove: vi.fn(),
}))
vi.mock('../../store/slices/event-slice-titling', () => ({ maybeGenerateTabTitle: vi.fn() }))
vi.mock('../../logger', () => ({ log: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn() }))
const thinkingSetting = vi.hoisted(() => ({ enabled: true, listeners: new Set<() => void>() }))
vi.mock('../../persistence/settings-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../persistence/settings-store')>()),
  shouldStreamThinkingToRemote: () => thinkingSetting.enabled,
  onStreamThinkingToRemoteChange: (fn: () => void) => { thinkingSetting.listeners.add(fn); return () => thinkingSetting.listeners.delete(fn) },
}))

import { useSessionStore } from '../../store/sessionStore'
import { makeMainPane } from '../../store/conversation-instance'
import { TRANSCRIPT_FLUSH_MS, _resetTranscriptPublisherForTest, openTabTranscript } from '../transcript-publisher'
import { recordingConnection } from '../../protocol/__tests__/recording-connection'

const FIXTURE = join(__dirname, '../../../../packages/shared/src/transcript/__fixtures__/transcript-replay.json')
const TAB = 'tab-replay'

function tab(): TabState {
  return {
    id: TAB, conversationId: 'conv-replay', historicalSessionIds: [], lastKnownSessionId: null, status: 'running',
    activeRequestId: 'req-1', lastEventAt: null, lastActivityAt: null, idleSince: null, lastCompletionAt: null,
    settledOverride: null, settledAt: null, snoozedUntil: null, snoozedAt: null, lastVisitedAt: null, manualUnread: false,
    currentActivity: '', attachments: [], title: 'Replay', customTitle: 'Replay', lastResult: null, sessionTools: [],
    sessionMcpServers: [], sessionSkills: [], sessionVersion: null, queuedPrompts: [], workingDirectory: '/repo',
    hasChosenDirectory: true, additionalDirs: [], bashResults: [], bashExecuting: false, bashExecId: null, pillColor: null,
    forkedFromSessionId: null, worktree: null, pendingWorktreeSetup: false, contextTokens: null, contextWindow: null,
    isCompacting: false, isTerminalOnly: false, inputLocked: false, engineProfileId: null, lastMessagePreview: null,
  } as unknown as TabState
}

function emit(event: NormalizedEvent): void {
  useSessionStore.getState().handleNormalizedEvent(TAB, event)
  vi.advanceTimersByTime(TRANSCRIPT_FLUSH_MS)
}

function mainMessages(): unknown[] {
  return useSessionStore.getState().conversationPanes.get(TAB)!.instances[0].messages
}

function setMainMessages(messages: unknown[]): void {
  const panes = new Map(useSessionStore.getState().conversationPanes)
  const pane = panes.get(TAB)!
  panes.set(TAB, { ...pane, instances: [{ ...pane.instances[0], messages: messages as never }] })
  useSessionStore.setState({ conversationPanes: panes })
  vi.advanceTimersByTime(TRANSCRIPT_FLUSH_MS)
}

beforeEach(() => {
  msgSeq = 0
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-22T12:00:00Z'))
  _resetTranscriptPublisherForTest()
})
afterEach(() => {
  _resetTranscriptPublisherForTest()
  vi.useRealTimers()
})

describe('golden transcript replay', () => {
  it('records the server rows, the patches, and the rows a client ends with', () => {
    useSessionStore.setState({
      tabs: [tab()],
      activeTabId: TAB,
      conversationPanes: new Map([[TAB, makeMainPane({
        messages: [{ id: 'u1', role: 'user', content: 'Is it transferred?', timestamp: Date.now(), clientMsgId: 'phone-1' }],
      })]]),
    } as never)

    const { conn, sent } = recordingConnection({ view: 'thin' })
    const snapshot = openTabTranscript(TAB, undefined, conn)!

    const step = (event: NormalizedEvent): void => { vi.advanceTimersByTime(250); emit(event) }
    step({ type: 'text_chunk', text: 'Checking ground ' } as NormalizedEvent)
    step({ type: 'text_chunk', text: 'truth first.' } as NormalizedEvent)
    step({ type: 'tool_call', toolName: 'Bash', toolId: 'toolu_1', index: 0 } as NormalizedEvent)
    step({ type: 'tool_call_update', toolId: 'toolu_1', partialInput: '{"command":' } as NormalizedEvent)
    step({ type: 'tool_call_update', toolId: 'toolu_1', partialInput: '"ls"}' } as NormalizedEvent)
    step({ type: 'tool_call_complete', index: 0 } as NormalizedEvent)
    step({ type: 'message_end', inputTokens: 10, outputTokens: 5, entryId: 'e1', userEntryId: 'u1' } as NormalizedEvent)
    step({ type: 'tool_result', toolId: 'toolu_1', content: 'repo\nnotes.md', isError: false } as NormalizedEvent)
    step({ type: 'thinking_block_start' } as NormalizedEvent)
    step({ type: 'thinking_delta', text: 'The file is here.' } as NormalizedEvent)
    step({ type: 'thinking_block_end', elapsedSeconds: 2, totalTokens: 12 } as NormalizedEvent)
    step({ type: 'text_chunk', text: 'A partial attempt' } as NormalizedEvent)
    step({ type: 'stream_reset' } as NormalizedEvent)
    step({ type: 'harness_message', message: 'Synced', dedupKey: 'ext:sync', dedupMode: 'relocate' } as NormalizedEvent)

    // A steer: the store inserts a pending bubble when the phone sends into a
    // busy conversation, and the engine confirms it once drained.
    vi.advanceTimersByTime(250)
    setMainMessages([...mainMessages(), { id: 'phone-2', role: 'user', content: 'Also check the bench.', timestamp: Date.now(), steerPending: true, clientMsgId: 'phone-2' }])
    step({ type: 'steer_injected', messageLength: 21, clientMessageId: 'phone-2', entryId: 'e-steer' } as NormalizedEvent)

    step({ type: 'text_chunk', text: 'Yes, it transferred.' } as NormalizedEvent)
    step({ type: 'harness_message', message: 'Synced again', dedupKey: 'ext:sync', dedupMode: 'relocate' } as NormalizedEvent)
    step({ type: 'message_end', inputTokens: 12, outputTokens: 3, entryId: 'e2', userEntryId: 'u1' } as NormalizedEvent)

    // A rewind replaces the transcript wholesale.
    vi.advanceTimersByTime(250)
    setMainMessages(mainMessages().slice(0, 3))

    const patches = sent
      .filter((f): f is Extract<StudioFrame, { type: 'studio_event' }> => f.type === 'studio_event')
      .map((f) => f.payload as TranscriptPatchEvent)
      .filter((p) => p.type === 'desktop_transcript_patch')
    const finalRows = openTabTranscript(TAB, undefined, null)!.rows

    // The server's own consistency: every patch builds on the last, and
    // applying them reproduces its final rows.
    let rows: TranscriptRow[] = snapshot.rows
    let rev = snapshot.rev
    for (const p of patches) {
      expect(p.baseRev).toBe(rev)
      rows = applyTranscriptChange(rows, p.change)!
      rev = p.rev
    }
    expect(rows).toEqual(finalRows)
    expect(patches.some((p) => p.change.kind === 'append')).toBe(true)
    expect(finalRows.length).toBe(3)

    const recorded = {
      comment: 'Generated by server/src/transcript/__tests__/transcript-replay-fixture.test.ts. Replayed by ios/IonRemoteTests/Transcript/TranscriptReplayTests.swift. Do not edit by hand.',
      snapshot: { streamId: snapshot.streamId, rev: snapshot.rev, rows: snapshot.rows },
      patches: patches.map(({ epoch: _epoch, ...rest }) => rest),
      final: finalRows,
    }
    const text = JSON.stringify(recorded, null, 2) + '\n'
    if (process.env.UPDATE_TRANSCRIPT_FIXTURE === '1') writeFileSync(FIXTURE, text)
    expect(text).toBe(readFileSync(FIXTURE, 'utf-8'))
  })
})
