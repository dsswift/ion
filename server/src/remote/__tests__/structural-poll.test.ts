/**
 * A STRUCTURAL store change must kick a snapshot evaluation immediately
 * instead of waiting out the 5 s poll tick, and volatile per-delta churn
 * (cost, message count) must NOT, or an active run would rebuild
 * and ship the whole multi-tab snapshot on every streamed token.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ pollSnapshotOnce: vi.fn(async () => undefined) }))
vi.mock('../snapshot-polling', () => ({ pollSnapshotOnce: mocks.pollSnapshotOnce }))
vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../state', () => ({ state: { rendererSnapshotCache: null } }))

import { scheduleStructuralSnapshotPoll, structuralSignature, _resetStructuralSnapshotGate } from '../structural-poll'

type Tab = Parameters<typeof scheduleStructuralSnapshotPoll>[0][number]
function tab(id: string, over: Partial<Tab> = {}): Tab {
  return { id, status: 'idle', isTerminalOnly: false, runCostUsd: 0, lastActivityTs: 0, messageCount: 0, ...over } as unknown as Tab
}

beforeEach(() => {
  mocks.pollSnapshotOnce.mockClear()
  _resetStructuralSnapshotGate()
  vi.useFakeTimers()
})
afterEach(() => {
  _resetStructuralSnapshotGate()
  vi.useRealTimers()
})

async function seed(tabs: Tab[]): Promise<void> {
  scheduleStructuralSnapshotPoll(tabs)
  await vi.advanceTimersByTimeAsync(300)
  mocks.pollSnapshotOnce.mockClear()
}

describe('structural snapshot kick', () => {
  it('polls when a tab is added, its status changes, or it is closed', async () => {
    await seed([tab('t1')])
    scheduleStructuralSnapshotPoll([tab('t1'), tab('t2')])
    await vi.advanceTimersByTimeAsync(300)
    expect(mocks.pollSnapshotOnce).toHaveBeenCalledTimes(1)

    scheduleStructuralSnapshotPoll([tab('t1', { status: 'running' } as Partial<Tab>), tab('t2')])
    await vi.advanceTimersByTimeAsync(300)
    expect(mocks.pollSnapshotOnce).toHaveBeenCalledTimes(2)

    scheduleStructuralSnapshotPoll([tab('t1', { status: 'running' } as Partial<Tab>)])
    await vi.advanceTimersByTimeAsync(300)
    expect(mocks.pollSnapshotOnce).toHaveBeenCalledTimes(3)
  })

  it('does NOT poll for volatile churn', async () => {
    await seed([tab('t1')])
    scheduleStructuralSnapshotPoll([tab('t1', { runCostUsd: 0.42, lastActivityTs: 999, messageCount: 7 } as Partial<Tab>)])
    await vi.advanceTimersByTimeAsync(300)
    expect(mocks.pollSnapshotOnce).not.toHaveBeenCalled()
  })

  it('collapses a burst of structural changes into one poll', async () => {
    await seed([tab('t1')])
    scheduleStructuralSnapshotPoll([tab('t1'), tab('t2')])
    scheduleStructuralSnapshotPoll([tab('t1'), tab('t2'), tab('t3')])
    scheduleStructuralSnapshotPoll([tab('t1'), tab('t2'), tab('t3'), tab('t4')])
    await vi.advanceTimersByTimeAsync(300)
    expect(mocks.pollSnapshotOnce).toHaveBeenCalledTimes(1)
  })

  it('signature covers exactly id, status and terminal-ness', () => {
    expect(structuralSignature([tab('a', { isTerminalOnly: true } as Partial<Tab>), tab('b')])).toBe('a|idle|1,b|idle|0')
  })
})
