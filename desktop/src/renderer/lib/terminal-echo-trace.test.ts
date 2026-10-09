/**
 * `terminal.echo` is sampled: one keystroke in ECHO_SAMPLE_EVERY opens a
 * span, the next output for that terminal ends it, output with no span open
 * is ignored, and an echo later than ECHO_STALE_MS is dropped as a program's
 * own output.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const logged = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }))
vi.mock('../rendererLogger', () => ({ rInfo: logged.info, rWarn: logged.warn }))

import { ECHO_SAMPLE_EVERY, ECHO_STALE_MS, forgetTerminalEcho, noteTerminalKeystroke, noteTerminalOutput, _resetTerminalEchoForTest } from './terminal-echo-trace'
import { _resetSpanWriterForTest } from './span-writer'

beforeEach(() => { vi.clearAllMocks(); _resetTerminalEchoForTest(); _resetSpanWriterForTest() })

describe('terminal.echo', () => {
  it('samples the first keystroke and then one in every ECHO_SAMPLE_EVERY', () => {
    let t = 1_000
    const now = (): number => t
    const sampled: number[] = []
    for (let i = 1; i <= ECHO_SAMPLE_EVERY * 2; i++) {
      if (noteTerminalKeystroke('k', now)) sampled.push(i)
      t += 1
      noteTerminalOutput('k', 1, now)
    }
    expect(sampled).toEqual([1, ECHO_SAMPLE_EVERY + 1])
    expect(logged.info.mock.calls.filter((c) => c[1] === 'terminal.echo')).toHaveLength(2)
    expect(logged.info.mock.calls[0][2]).toMatchObject({ terminal_key: 'k', bytes: 1, duration_ms: 1 })
  })

  it('ignores output with no span open and drops a stale echo', () => {
    let t = 5_000
    const now = (): number => t
    expect(noteTerminalOutput('k', 3, now)).toBe(false)
    expect(noteTerminalKeystroke('k', now)).toBe(true)
    t += ECHO_STALE_MS + 1
    expect(noteTerminalOutput('k', 3, now)).toBe(false)
    expect(logged.info).not.toHaveBeenCalled()
  })

  it('keeps one span open per terminal and forgets a terminal that went away', () => {
    expect(noteTerminalKeystroke('a')).toBe(true)
    forgetTerminalEcho('a')
    expect(noteTerminalOutput('a', 1)).toBe(false)
    expect(noteTerminalKeystroke('a')).toBe(true)
  })
})
