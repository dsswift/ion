import { describe, it, expect } from 'vitest'
import { clipReducer, clipRemaining, CLIP_SECONDS, type ClipState } from '../clip'

describe('clipReducer', () => {
  it('idle → recording → saving → idle', () => {
    let s: ClipState = { kind: 'idle' }
    s = clipReducer(s, { type: 'start', atMs: 1000 })
    expect(s.kind).toBe('recording')
    s = clipReducer(s, { type: 'stop' })
    expect(s.kind).toBe('saving')
    s = clipReducer(s, { type: 'saved' })
    expect(s.kind).toBe('idle')
  })
  it('ignores invalid transitions', () => {
    expect(clipReducer({ kind: 'idle' }, { type: 'stop' }).kind).toBe('idle')
    expect(clipReducer({ kind: 'recording', startedAtMs: 0 }, { type: 'start', atMs: 5 }).kind).toBe('recording')
    expect(clipReducer({ kind: 'saving' }, { type: 'failed' }).kind).toBe('idle')
  })
  it('countdown clamps at zero', () => {
    expect(clipRemaining({ kind: 'recording', startedAtMs: 0 }, 2000)).toBe(CLIP_SECONDS - 2)
    expect(clipRemaining({ kind: 'recording', startedAtMs: 0 }, 60_000)).toBe(0)
    expect(clipRemaining({ kind: 'idle' }, 0)).toBe(0)
  })
})
