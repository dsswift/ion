import { describe, expect, it } from 'vitest'
import type { TranscriptRow } from '../transcript-row'
import { clampTranscriptPageRows, pageTranscript } from '../transcript-page'

/** `turns` user+assistant pairs: u0 a0 u1 a1 ... */
function turns(n: number, content = 'x'): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  for (let i = 0; i < n; i++) {
    rows.push({ id: `u${i}`, role: 'user', content, timestamp: i })
    rows.push({ id: `a${i}`, role: 'assistant', content, timestamp: i })
  }
  return rows
}

describe('pageTranscript', () => {
  it('trims a partial turn off the front of the page', () => {
    const page = pageTranscript(turns(10), undefined, 3)
    expect(page.rows.map((r) => r.id)).toEqual(['u9', 'a9'])
    expect(page.cursor).toBe('u9')
  })

  it('keeps a turn whole, tool rows included', () => {
    const all = turns(10)
    all.splice(19, 0, { id: 't9', role: 'tool', content: 'x', timestamp: 9 })
    const page = pageTranscript(all, undefined, 4)
    expect(page.rows.map((r) => r.id)).toEqual(['u9', 't9', 'a9'])
  })

  it('keeps a turn longer than the page rather than send nothing', () => {
    const all: TranscriptRow[] = [{ id: 'u', role: 'user', content: 'x', timestamp: 0 }]
    for (let i = 0; i < 6; i++) all.push({ id: `t${i}`, role: 'tool', content: 'x', timestamp: 0 })
    const page = pageTranscript(all, undefined, 3)
    expect(page.rows.map((r) => r.id)).toEqual(['t3', 't4', 't5'])
  })

  it('walks back by cursor and reports the next cursor', () => {
    const all = turns(10)
    const first = pageTranscript(all, undefined, 4)
    expect(first.rows.map((r) => r.id)).toEqual(['u8', 'a8', 'u9', 'a9'])
    expect(first.startIndex).toBe(16)
    expect(first.cursor).toBe('u8')
    const second = pageTranscript(all, first.cursor, 4)
    expect(second.rows.map((r) => r.id)).toEqual(['u6', 'a6', 'u7', 'a7'])
    expect(second.startIndex).toBe(12)
  })

  it('stops at the byte budget before the row limit', () => {
    const all = turns(10, 'y'.repeat(100))
    const page = pageTranscript(all, undefined, 20, 500)
    expect(page.rows.length).toBeLessThan(20)
    expect(page.rows.length).toBeGreaterThan(0)
    expect(page.hasOlder).toBe(true)
  })

  it('still sends one row that is larger than the budget', () => {
    const page = pageTranscript(turns(2, 'z'.repeat(1000)), undefined, 10, 10)
    expect(page.rows).toHaveLength(1)
  })

  it('answers the whole transcript when it fits', () => {
    const page = pageTranscript(turns(3), undefined, 100)
    expect(page.rows).toHaveLength(6)
    expect(page.hasOlder).toBe(false)
    expect(page.cursor).toBeUndefined()
  })
})

describe('clampTranscriptPageRows', () => {
  it('defaults to the largest page and clamps both ends', () => {
    expect(clampTranscriptPageRows(undefined)).toBe(2000)
    expect(clampTranscriptPageRows(1)).toBe(10)
    expect(clampTranscriptPageRows(99999)).toBe(2000)
  })
})
