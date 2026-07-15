import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RetransmitBuffer, replayRange } from '../retransmit-buffer'
import type { WireMessage } from '../protocol'

// Mock the logger so we can assert warn() calls without real file I/O.
const warnMock = vi.fn()
vi.mock('../../logger', () => ({
  warn: (...args: any[]) => warnMock(...args),
  log: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}))

function frame(seq: number, bytes = 10): WireMessage {
  return { seq, ts: seq, deviceId: 'dev', ciphertext: 'x'.repeat(bytes) } as WireMessage
}

beforeEach(() => {
  warnMock.mockReset()
})

describe('RetransmitBuffer', () => {
  it('records frames and replays an exact range in seq order', () => {
    const buf = new RetransmitBuffer()
    for (let s = 1; s <= 5; s++) buf.record('dev', frame(s))
    const { frames, complete } = buf.range('dev', 2, 4)
    expect(complete).toBe(true)
    expect(frames.map((f) => f.seq)).toEqual([2, 3, 4])
  })

  it('reports incomplete when a requested seq was never recorded', () => {
    const buf = new RetransmitBuffer()
    buf.record('dev', frame(1))
    buf.record('dev', frame(3)) // 2 missing
    const { frames, complete } = buf.range('dev', 1, 3)
    expect(complete).toBe(false)
    expect(frames.map((f) => f.seq)).toEqual([1, 3])
  })

  it('evicts oldest frames past the message cap', () => {
    const buf = new RetransmitBuffer(3, 1_000_000) // cap 3 messages
    for (let s = 1; s <= 5; s++) buf.record('dev', frame(s))
    // 1 and 2 evicted; 3,4,5 retained.
    expect(buf.range('dev', 1, 2).complete).toBe(false)
    expect(buf.range('dev', 3, 5).complete).toBe(true)
  })

  it('evicts oldest frames past the byte budget', () => {
    const buf = new RetransmitBuffer(1000, 25) // 25-byte budget, 10 bytes each
    for (let s = 1; s <= 5; s++) buf.record('dev', frame(s, 10))
    // Only the last ~2 frames fit in 25 bytes.
    const r = buf.range('dev', 4, 5)
    expect(r.complete).toBe(true)
    expect(buf.range('dev', 1, 1).complete).toBe(false)
  })

  it('keeps per-device buffers isolated', () => {
    const buf = new RetransmitBuffer()
    buf.record('a', frame(1))
    buf.record('b', frame(1))
    expect(buf.range('a', 1, 1).complete).toBe(true)
    expect(buf.range('b', 1, 1).complete).toBe(true)
    buf.clearDevice('a')
    expect(buf.range('a', 1, 1).complete).toBe(false)
    expect(buf.range('b', 1, 1).complete).toBe(true)
  })

  it('logs a warning and returns empty/incomplete for inverted fromSeq>toSeq', () => {
    const buf = new RetransmitBuffer()
    buf.record('dev', frame(5))
    const result = buf.range('dev', 8, 3) // inverted: fromSeq > toSeq
    expect(result.frames).toEqual([])
    expect(result.complete).toBe(false)
    // The malformed request must be observable via the warn log.
    expect(warnMock).toHaveBeenCalledWith(
      'RetransmitBuffer',
      expect.stringContaining('invalid resend range'),
      expect.objectContaining({ from_seq: 8, to_seq: 3 }),
    )
  })

  it('does not iterate the integer span for an enormous toSeq (main-thread freeze regression)', () => {
    // A peer sending a huge/garbage toSeq must not drive a per-integer loop.
    // Pre-fix this walked billions of buf.get() calls synchronously and pegged
    // a core; post-fix it iterates only the buffered frames. Guard with a wall-
    // clock ceiling: correct code is sub-millisecond, the old code took minutes.
    const buf = new RetransmitBuffer()
    for (let s = 1; s <= 5; s++) buf.record('dev', frame(s))
    const start = Date.now()
    const { frames, complete } = buf.range('dev', 1, 3_000_000_000)
    expect(Date.now() - start).toBeLessThan(100)
    // Only the buffered frames come back; the giant span is reported incomplete.
    expect(frames.map((f) => f.seq)).toEqual([1, 2, 3, 4, 5])
    expect(complete).toBe(false)
  })

  it('rejects non-integer bounds without iterating', () => {
    const buf = new RetransmitBuffer()
    buf.record('dev', frame(1))
    const nan = buf.range('dev', 1, Number.NaN)
    expect(nan.frames).toEqual([])
    expect(nan.complete).toBe(false)
    const inf = buf.range('dev', 1, Number.POSITIVE_INFINITY)
    expect(inf.frames).toEqual([])
    expect(inf.complete).toBe(false)
  })
})

describe('replayRange', () => {
  it('delivers each buffered frame and returns completeness', () => {
    const buf = new RetransmitBuffer()
    for (let s = 1; s <= 4; s++) buf.record('dev', frame(s))
    const delivered: number[] = []
    const complete = replayRange(buf, 'dev', 2, 4, (f) => delivered.push(f.seq))
    expect(delivered).toEqual([2, 3, 4])
    expect(complete).toBe(true)
  })

  it('returns false when the range is partially evicted (caller sends unavailable)', () => {
    const buf = new RetransmitBuffer(2) // only last 2 retained
    for (let s = 1; s <= 4; s++) buf.record('dev', frame(s))
    const delivered: number[] = []
    const complete = replayRange(buf, 'dev', 1, 4, (f) => delivered.push(f.seq))
    expect(complete).toBe(false)
    expect(delivered).toEqual([3, 4]) // only the surviving frames replayed
  })
})
