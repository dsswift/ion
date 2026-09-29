/**
 * Tests for the shared fuzzy-match helpers.
 *
 * `fuzzyMatchCommand` scores a single query→command pair.
 * `fuzzyFilterAndSort` filters a command list and returns matches ranked by
 * score (desc), then group priority (builtin < project < extension < user),
 * then alphabetical name.
 *
 * The algorithm strips the leading `/` from both query and candidate, then
 * treats `--` as a segment separator, rewarding matches that land on segment
 * boundaries over interior subsequences.
 */

import { describe, it, expect } from 'vitest'
import { fuzzyMatchCommand, fuzzyFilterAndSort } from '../fuzzy-match'

// ─── fuzzyMatchCommand ───

describe('fuzzyMatchCommand', () => {
  it('matches a subsequence at a segment boundary (/review → /ion--review--changes)', () => {
    const result = fuzzyMatchCommand('/review', '/ion--review--changes')
    expect(result).not.toBeNull()
    expect(result!.match).toBe(true)
    expect(result!.score).toBeGreaterThan(0)
  })

  it('matches an exact prefix (/compact → /compact)', () => {
    const result = fuzzyMatchCommand('/compact', '/compact')
    expect(result).not.toBeNull()
    expect(result!.match).toBe(true)
    expect(result!.score).toBeGreaterThan(0)
  })

  it('returns null for a non-matching query (/xyz → /compact)', () => {
    const result = fuzzyMatchCommand('/xyz', '/compact')
    expect(result).toBeNull()
  })

  it('is case-insensitive (/Review → /ion--review--changes)', () => {
    const result = fuzzyMatchCommand('/Review', '/ion--review--changes')
    expect(result).not.toBeNull()
    expect(result!.match).toBe(true)
  })

  it('strips the leading `/` from both query and candidate before matching', () => {
    const withSlashes = fuzzyMatchCommand('/compact', '/compact')
    const withoutSlashes = fuzzyMatchCommand('compact', 'compact')

    expect(withSlashes).not.toBeNull()
    expect(withoutSlashes).not.toBeNull()
    expect(withSlashes!.score).toBe(withoutSlashes!.score)
  })

  it('empty query `/` matches everything with score 0', () => {
    const result = fuzzyMatchCommand('/', '/anything')
    expect(result).not.toBeNull()
    expect(result!.match).toBe(true)
    expect(result!.score).toBe(0)
  })
})

// ─── Score ordering ───

describe('fuzzyMatchCommand score ordering', () => {
  it('ranks exact prefix > boundary match > interior subsequence', () => {
    const query = '/cl'

    // Exact prefix: the query `cl` is a prefix of `clear`.
    const exactPrefix = fuzzyMatchCommand(query, '/clear')
    // Boundary match: `cl` matches at the start of the `cli` segment.
    const boundaryMatch = fuzzyMatchCommand(query, '/ion--cli--tools')
    // Interior subsequence: `c…l` found inside `declare` (non-boundary).
    const interiorSubsequence = fuzzyMatchCommand(query, '/declare')

    expect(exactPrefix).not.toBeNull()
    expect(boundaryMatch).not.toBeNull()
    expect(interiorSubsequence).not.toBeNull()

    // Exact prefix beats boundary match.
    expect(exactPrefix!.score).toBeGreaterThan(boundaryMatch!.score)
    // Boundary match beats interior subsequence.
    expect(boundaryMatch!.score).toBeGreaterThan(interiorSubsequence!.score)
  })
})

// ─── fuzzyFilterAndSort ───

describe('fuzzyFilterAndSort', () => {
  it('empty query `/` matches everything', () => {
    const commands = [
      { command: '/alpha' },
      { command: '/beta' },
      { command: '/gamma' },
    ]
    const result = fuzzyFilterAndSort('/', commands)
    expect(result).toHaveLength(3)
  })

  it('filters out non-matching commands', () => {
    const commands = [
      { command: '/compact' },
      { command: '/review' },
      { command: '/deploy' },
    ]
    const result = fuzzyFilterAndSort('/rev', commands)

    expect(result.some((c) => c.command === '/review')).toBe(true)
    expect(result.some((c) => c.command === '/compact')).toBe(false)
  })

  it('sorts by score descending for the `/cl` example', () => {
    const commands = [
      { command: '/declare' },
      { command: '/ion--cli--tools' },
      { command: '/clear' },
    ]
    const result = fuzzyFilterAndSort('/cl', commands)

    expect(result).toHaveLength(3)
    expect(result[0].command).toBe('/clear')
    expect(result[1].command).toBe('/ion--cli--tools')
    expect(result[2].command).toBe('/declare')
  })

  it('breaks score ties by group priority (builtin < project < extension < user)', () => {
    const commands = [
      { command: '/foo', group: 'user' },
      { command: '/foo', group: 'builtin' },
      { command: '/foo', group: 'extension' },
      { command: '/foo', group: 'project' },
    ]
    const result = fuzzyFilterAndSort('/foo', commands)

    expect(result).toHaveLength(4)
    expect(result[0].group).toBe('builtin')
    expect(result[1].group).toBe('project')
    expect(result[2].group).toBe('extension')
    expect(result[3].group).toBe('user')
  })

  it('breaks score + group ties alphabetically by command name', () => {
    const commands = [
      { command: '/zebra', group: 'builtin' },
      { command: '/alpha', group: 'builtin' },
      { command: '/mango', group: 'builtin' },
    ]
    const result = fuzzyFilterAndSort('/', commands)

    expect(result).toHaveLength(3)
    expect(result[0].command).toBe('/alpha')
    expect(result[1].command).toBe('/mango')
    expect(result[2].command).toBe('/zebra')
  })

  it('applies all three tiebreakers together: score → group → alpha', () => {
    const commands = [
      { command: '/clear', group: 'project' },
      { command: '/clear', group: 'builtin' },
      { command: '/ion--cli--tools', group: 'builtin' },
      { command: '/declare', group: 'builtin' },
    ]
    const result = fuzzyFilterAndSort('/cl', commands)

    expect(result).toHaveLength(4)
    // Highest score first, then builtin before project for the tie.
    expect(result[0]).toMatchObject({ command: '/clear', group: 'builtin' })
    expect(result[1]).toMatchObject({ command: '/clear', group: 'project' })
    // Lower-scoring matches follow in their own order.
    expect(result[2].command).toBe('/ion--cli--tools')
    expect(result[3].command).toBe('/declare')
  })
})
