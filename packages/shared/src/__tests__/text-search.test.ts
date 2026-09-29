import { describe, expect, it } from 'vitest'
import { buildLineMatch, findMatchRanges, TEXT_SEARCH_PREVIEW_CHARS } from '../text-search'

const loose = { caseSensitive: false, wholeWord: false }

describe('findMatchRanges', () => {
  it('finds every literal occurrence, case-insensitively by default', () => {
    expect(findMatchRanges('Foo foo FOO', 'foo', loose)).toEqual([[0, 3], [4, 7], [8, 11]])
    expect(findMatchRanges('Foo foo FOO', 'foo', { ...loose, caseSensitive: true })).toEqual([[4, 7]])
  })

  it('treats pattern characters literally', () => {
    expect(findMatchRanges('a.b axb', 'a.b', loose)).toEqual([[0, 3]])
  })

  it('skips occurrences inside a longer identifier for whole-word', () => {
    expect(findMatchRanges('id my_id id2 (id)', 'id', { ...loose, wholeWord: true })).toEqual([[0, 2], [14, 16]])
  })
})

describe('buildLineMatch', () => {
  it('returns null for a line without the query', () => {
    expect(buildLineMatch(1, 'nothing here', 'zzz', loose)).toBeNull()
  })

  it('clips a long line around the first match and shifts its ranges', () => {
    const line = `${'x'.repeat(5000)}needle${'y'.repeat(5000)}`
    const match = buildLineMatch(7, line, 'needle', loose)!
    expect(match.column).toBe(5001)
    expect(match.preview.length).toBe(TEXT_SEARCH_PREVIEW_CHARS)
    const [start, end] = match.ranges[0]
    expect(match.preview.slice(start, end)).toBe('needle')
  })
})
