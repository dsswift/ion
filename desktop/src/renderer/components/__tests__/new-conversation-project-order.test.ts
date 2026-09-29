/**
 * Ordering and grouping of the new-conversation picker's project list.
 *
 * The counts here are the real recorded shape: one number per machine that
 * holds the checkout, so "most used" means something different inside a
 * per-machine section than it does in a mixed list.
 */
import { describe, expect, it } from 'vitest'
import type { MergedProjectRow, ProjectHolder } from '../../studio/connection/environment-projects'
import {
  flattenProjectGroups,
  groupProjectRows,
  isProjectGrouping,
  isProjectSortOrder,
  sortProjectRows,
  totalUsage,
  usageOn,
} from '../new-conversation-project-order'

const catalog = [
  { id: 'local', label: 'This Mac' },
  { id: 'grover', label: 'grover' },
  { id: 'work', label: 'dcitag8331' },
]

function holder(environmentId: string, dir: string, usageCount: number): ProjectHolder {
  return {
    environmentId,
    label: catalog.find((entry) => entry.id === environmentId)?.label ?? environmentId,
    entry: { dir, displayName: dir.split('/').pop()!, entry: { addedManually: true, lastUsedAt: 0 }, managed: false, profileAction: 'ask' },
    usageCount,
  }
}

function row(displayName: string, holders: ProjectHolder[]): MergedProjectRow {
  return { key: `remote:${displayName}`, displayName, dir: holders[0].entry.dir, repoRemote: `github.com/o/${displayName}`, holders }
}

const ion = row('ion', [holder('local', '/Users/me/src/ion', 1383), holder('grover', '/home/g/src/ion', 7)])
const notes = row('notes', [holder('local', '/Users/me/notes', 42)])
const billing = row('billing', [holder('work', '/Users/w/src/billing', 300)])
const zebra = row('zebra', [holder('grover', '/home/g/src/zebra', 0)])
const apple = row('apple', [holder('grover', '/home/g/src/apple', 0)])
const rows = [ion, notes, billing, zebra, apple]

describe('usage', () => {
  it('reads a machine\'s own count, and the total across every machine', () => {
    expect(usageOn(ion, 'local')).toBe(1383)
    expect(usageOn(ion, 'grover')).toBe(7)
    expect(usageOn(ion, 'work')).toBe(0)
    expect(totalUsage(ion)).toBe(1390)
  })
})

describe('sortProjectRows', () => {
  it('ranks by total use across machines, most used first', () => {
    expect(sortProjectRows(rows, 'most-used').map((r) => r.displayName)).toEqual(['ion', 'billing', 'notes', 'apple', 'zebra'])
  })

  // Every project starts at zero. Falling through to the name keeps a fresh
  // install readable instead of arbitrary.
  it('falls through to the name when use is equal', () => {
    expect(sortProjectRows([zebra, apple], 'most-used').map((r) => r.displayName)).toEqual(['apple', 'zebra'])
  })

  it('ignores use entirely when sorting by name', () => {
    expect(sortProjectRows(rows, 'alphabetical').map((r) => r.displayName)).toEqual(['apple', 'billing', 'ion', 'notes', 'zebra'])
  })

  it('ranks by one machine\'s count when given one', () => {
    const onGrover = sortProjectRows([ion, zebra], 'most-used', (r) => usageOn(r, 'grover'))
    expect(onGrover.map((r) => r.displayName)).toEqual(['ion', 'zebra'])
  })

  it('does not mutate its input', () => {
    const input = [zebra, apple]
    sortProjectRows(input, 'alphabetical')
    expect(input.map((r) => r.displayName)).toEqual(['zebra', 'apple'])
  })
})

describe('groupProjectRows', () => {
  it('puts this machine first, then the machines it is not on', () => {
    const groups = groupProjectRows({ rows, grouping: 'local-first', order: 'most-used', catalog })
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.displayName)])).toEqual([
      ['This Mac', ['ion', 'notes']],
      ['Other machines', ['billing', 'apple', 'zebra']],
    ])
    // A mixed section names no machine, so each row keeps its own default.
    expect(groups.every((g) => g.environmentId === null)).toBe(true)
  })

  // A header over the only thing on screen is noise.
  it('drops the headers when one half is empty', () => {
    const groups = groupProjectRows({ rows: [notes], grouping: 'local-first', order: 'most-used', catalog })
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBeNull()
  })

  it('makes one flat unlabelled section when grouping is off', () => {
    const groups = groupProjectRows({ rows, grouping: 'none', order: 'alphabetical', catalog })
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBeNull()
    expect(groups[0].rows.map((r) => r.displayName)).toEqual(['apple', 'billing', 'ion', 'notes', 'zebra'])
  })

  // The point of the mode is seeing what each machine has, so a project on
  // two machines belongs to both sections rather than only its default.
  it('repeats a shared project under every machine that has it, ranked by that machine', () => {
    const groups = groupProjectRows({ rows, grouping: 'by-host', order: 'most-used', catalog })
    expect(groups.map((g) => [g.label, g.environmentId, g.rows.map((r) => r.displayName)])).toEqual([
      ['This Mac', 'local', ['ion', 'notes']],
      ['grover', 'grover', ['ion', 'apple', 'zebra']],
      ['dcitag8331', 'work', ['billing']],
    ])
  })

  it('omits a machine with nothing on it', () => {
    const groups = groupProjectRows({ rows: [notes], grouping: 'by-host', order: 'most-used', catalog })
    expect(groups.map((g) => g.label)).toEqual(['This Mac'])
  })

  it('returns nothing when the search matched nothing', () => {
    for (const grouping of ['local-first', 'by-host', 'none'] as const) {
      expect(groupProjectRows({ rows: [], grouping, order: 'most-used', catalog })).toEqual([])
    }
  })
})

describe('flattenProjectGroups', () => {
  it('walks the drawn order and tags each row with its section\'s machine', () => {
    const groups = groupProjectRows({ rows, grouping: 'by-host', order: 'most-used', catalog })
    expect(flattenProjectGroups(groups).map((f) => [f.row.displayName, f.environmentId])).toEqual([
      ['ion', 'local'], ['notes', 'local'],
      ['ion', 'grover'], ['apple', 'grover'], ['zebra', 'grover'],
      ['billing', 'work'],
    ])
  })

  // The keyboard must not be able to land on a row nobody can see.
  it('skips a collapsed section', () => {
    const groups = groupProjectRows({ rows, grouping: 'by-host', order: 'most-used', catalog })
    const flat = flattenProjectGroups(groups, new Set(['host:grover']))
    expect(flat.map((f) => [f.row.displayName, f.environmentId])).toEqual([
      ['ion', 'local'], ['notes', 'local'], ['billing', 'work'],
    ])
  })

  it('never collapses the unlabelled section', () => {
    const groups = groupProjectRows({ rows, grouping: 'none', order: 'alphabetical', catalog })
    expect(flattenProjectGroups(groups, new Set(['all']))).toHaveLength(5)
  })
})

describe('persisted value guards', () => {
  it('accepts only the known values', () => {
    expect(isProjectSortOrder('most-used')).toBe(true)
    expect(isProjectSortOrder('alphabetical')).toBe(true)
    expect(isProjectSortOrder('recency')).toBe(false)
    expect(isProjectSortOrder(null)).toBe(false)
    expect(isProjectGrouping('by-host')).toBe(true)
    expect(isProjectGrouping('local-first')).toBe(true)
    expect(isProjectGrouping('none')).toBe(true)
    expect(isProjectGrouping('by-repo')).toBe(false)
  })
})
