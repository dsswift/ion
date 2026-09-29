/**
 * broadcast — terminalOutputFlushTimer self-stop (moved from the desktop with
 * the terminal fan-out; the server owns the client wire, ADR-033)
 *
 * The 16ms (~62.5Hz) terminal-output flush timer was started on client
 * connect and stopped only on disconnect, so it woke the event loop 62.5
 * times/sec for the whole connected lifetime — even with a terminal open but
 * silent, flushing an empty accumulator.
 *
 * Fix: the interval clears itself when the accumulator is empty, and broadcast()
 * re-arms it (idempotently) the next time terminal output arrives. This test
 * drives an idle tick and asserts the timer handle is nulled, then asserts new
 * output re-arms and flushes. On the pre-fix code the timer is never cleared, so
 * the self-stop assertion goes red.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { IPC } from '@ion/shared/types'

const { mockSend, mockState, accumulator, scrollback } = vi.hoisted(() => {
  const mockSend = vi.fn()
  const accumulator = new Map<string, string>()
  const scrollback = new Map<string, string>()
  const mockState = {
    mainWindow: null as any,
    studioWindow: null as any,
    terminalOutputFlushTimer: null as ReturnType<typeof setInterval> | null,
  }
  return { mockSend, mockState, accumulator, scrollback }
})

vi.mock('./state', async (importOriginal) => ({ ...(await importOriginal<typeof import('./state')>()), ...{
  state: mockState,
  terminalOutputAccumulator: accumulator,
  terminalScrollback: scrollback,
  MAX_SCROLLBACK_SIZE: 1_000_000,
} }))
vi.mock('./protocol/events', () => ({ publishStudioEvent: vi.fn() }))
vi.mock('./thin-view/remote-out', () => ({ sendRemoteEvent: mockSend, remoteClientsPresent: () => true }))

import { broadcast, startTerminalOutputFlushing } from './broadcast'

function outputCount(): number {
  return mockSend.mock.calls.filter((c) => (c[0] as any)?.type === 'desktop_terminal_output').length
}

describe('broadcast — terminalOutputFlushTimer self-stop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    accumulator.clear()
    scrollback.clear()
    mockState.terminalOutputFlushTimer = null
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('self-stops on an empty tick and re-arms when new terminal output arrives', () => {
    // Start with no buffered output.
    startTerminalOutputFlushing()
    expect(mockState.terminalOutputFlushTimer).not.toBeNull()

    // Idle tick: the timer clears itself.
    vi.advanceTimersByTime(16)
    expect(mockState.terminalOutputFlushTimer).toBeNull()

    // New terminal output re-arms the timer via broadcast().
    broadcast(IPC.TERMINAL_INCOMING, 'tab1:i1', 'ls -la\n')
    expect(mockState.terminalOutputFlushTimer).not.toBeNull()

    // Tick flushes the buffered output to iOS and drains the accumulator.
    vi.advanceTimersByTime(16)
    expect(outputCount()).toBe(1)
    expect(accumulator.size).toBe(0)

    // Next idle tick self-stops again.
    vi.advanceTimersByTime(16)
    expect(mockState.terminalOutputFlushTimer).toBeNull()
  })
})
