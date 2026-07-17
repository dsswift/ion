/**
 * Tests for `command-await.ts` — the promise-wrapper around
 * `engine_command_result` events — with focus on the per-call timeout.
 *
 * Why this file exists
 * ────────────────────
 * `/compact` runs asynchronously in the engine: the engine emits its
 * `engine_command_result` only when the (potentially tens-of-seconds) LLM
 * summarization COMPLETES. The desktop slash pipeline awaits that result via
 * `awaitCommandResult`, whose default crash-safety timeout is 5s. With the
 * default, a legitimately-slow compaction tripped the synthetic timeout and
 * surfaced "timeout waiting for engine_command_result" for a compaction that
 * in fact succeeded. `dispatchExtensionCommand` now passes a 180s timeout for
 * `/compact`; these tests pin both the timeout mechanism and the specific
 * regression (a result arriving after 5s still resolves when the larger
 * timeout is used).
 *
 * Mock pattern
 * ────────────
 * `command-await` imports `engineBridge` from `../state` (an EventEmitter-like
 * object it attaches a single `'event'` listener to) and `log` from
 * `../logger`. We mock both. `emitBridgeEvent` fans a synthetic
 * `engine_command_result` to the registered listener, standing in for the
 * engine bridge. Fake timers make the timeout deterministic.
 *
 * Location note: this lives under `src/main/__tests__/` because the vitest
 * config only discovers test files under an `__tests__` directory — a
 * co-located `command-await.test.ts` next to the source would never be run
 * by the harness.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => {
  const bridgeListeners = new Map<string, Array<(key: string, event: any) => void>>()
  return { bridgeListeners }
})

function emitBridgeEvent(key: string, event: any): void {
  const arr = mocks.bridgeListeners.get('event') ?? []
  for (const fn of arr) fn(key, event)
}

vi.mock('../state', () => {
  const mockEngineBridge = {
    on: (name: string, fn: (key: string, event: any) => void) => {
      const arr = mocks.bridgeListeners.get(name) ?? []
      arr.push(fn)
      mocks.bridgeListeners.set(name, arr)
    },
  }
  return { engineBridge: mockEngineBridge }
})

vi.mock('../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

import { awaitCommandResult, _resetAwaitersForTests } from '../command-await'
import { awaitTimeoutForCommand } from '../slash-classify'

beforeEach(() => {
  vi.useFakeTimers()
  mocks.bridgeListeners.clear()
  _resetAwaitersForTests()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('awaitCommandResult timeout selection', () => {
  it('resolves with the real result when the engine responds within the default timeout', async () => {
    const p = awaitCommandResult('key-1', 'clear')
    emitBridgeEvent('key-1', { type: 'engine_command_result', command: 'clear', message: 'ok', commandError: '' })
    const result = await p
    expect(result.commandError).toBe('')
    expect(result.command).toBe('clear')
  })

  it('fires the synthetic timeout at the default 5s when no result arrives', async () => {
    const p = awaitCommandResult('key-2', 'clear')
    // Just before the 5s default: still pending.
    await vi.advanceTimersByTimeAsync(4_999)
    // Cross the boundary.
    await vi.advanceTimersByTimeAsync(2)
    const result = await p
    expect(result.commandError).toBe('timeout')
  })

  it('does NOT time out a compact at 5s when given the 180s timeout, and still resolves on a late result', async () => {
    // This is the core regression: a compaction result arriving at ~30s (well
    // past the 5s default) must still resolve successfully because the caller
    // passed the extended timeout. On the old 5s default this promise would
    // have resolved with commandError:'timeout' before the result arrived.
    const p = awaitCommandResult('key-3', 'compact', 180_000)

    // Advance past the OLD default. With the extended timeout the promise is
    // still pending (no synthetic timeout yet).
    await vi.advanceTimersByTimeAsync(30_000)

    // Now the engine finally emits the real completion result.
    emitBridgeEvent('key-3', { type: 'engine_command_result', command: 'compact', message: 'command executed: compact', commandError: '' })

    const result = await p
    expect(result.commandError).toBe('')
    expect(result.command).toBe('compact')
  })

  it('still enforces the extended timeout as a crash-safety net if the engine never responds', async () => {
    const p = awaitCommandResult('key-4', 'compact', 180_000)
    // Just before 180s: pending.
    await vi.advanceTimersByTimeAsync(179_999)
    await vi.advanceTimersByTimeAsync(2)
    const result = await p
    expect(result.commandError).toBe('timeout')
  })
})

describe('awaitTimeoutForCommand selection policy (slash-classify)', () => {
  it('selects the extended 180s timeout for /compact', () => {
    // This is what dispatchExtensionCommand passes as the awaiter timeout.
    // On the pre-fix code path (which passed no timeout) this returned the
    // default and /compact tripped the 5s crash-safety timeout.
    expect(awaitTimeoutForCommand('compact')).toBe(180_000)
  })

  it('uses the awaiter default (undefined) for other commands', () => {
    expect(awaitTimeoutForCommand('clear')).toBeUndefined()
    expect(awaitTimeoutForCommand('export')).toBeUndefined()
    expect(awaitTimeoutForCommand('align')).toBeUndefined()
  })
})
