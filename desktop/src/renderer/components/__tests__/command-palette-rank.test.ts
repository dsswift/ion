import { describe, it, expect } from 'vitest'
import { fuzzyScore, rankEntries, type PaletteEntry } from '../command-palette-rank'

const noop = (): void => {}
function entry(id: string, label: string, keywords?: string): PaletteEntry {
  return { id, label, keywords, section: 'test', run: noop }
}

describe('fuzzyScore', () => {
  it('requires a subsequence match', () => {
    expect(fuzzyScore('xyz', 'graphics lead')).toBe(-1)
    expect(fuzzyScore('gl', 'graphics lead')).toBeGreaterThanOrEqual(0)
  })
  it('prefix beats infix, dense beats sparse', () => {
    expect(fuzzyScore('gra', 'graphics')).toBeGreaterThan(fuzzyScore('gra', 'engram archive'))
    expect(fuzzyScore('', 'anything')).toBe(0)
  })
})

describe('rankEntries', () => {
  const entries = [
    entry('a', 'Open Overlay'),
    entry('b', 'Open Visualizer', 'atv office'),
    entry('c', 'graphics-lead', 'agent'),
    entry('d', 'New Conversation'),
  ]
  it('label matches outrank keyword matches; results capped', () => {
    const r = rankEntries('open', entries)
    expect(r.map((x) => x.entry.id)).toEqual(['a', 'b'])
    expect(rankEntries('', entries, 2)).toHaveLength(2)
  })
  it('keyword-only matches surface too', () => {
    const r = rankEntries('atv', entries)
    expect(r.map((x) => x.entry.id)).toEqual(['b'])
  })
  it('no match yields empty', () => {
    expect(rankEntries('zzz', entries)).toEqual([])
  })
})
