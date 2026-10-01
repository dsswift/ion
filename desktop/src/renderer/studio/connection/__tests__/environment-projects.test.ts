/** buildMergedProjects — one row per repository across machines, with the local copy's identity backfilled from the server listing, and a row offered only on the machines that have it. */
import { describe, expect, it, vi } from 'vitest'
import type { EnvironmentProject } from '@ion/shared/types-environment-admin'
import type { EffectiveProjectEntry } from '@ion/shared/project-registry'

vi.mock('../../../components/settings/environment/environment-client', () => ({ environmentClient: {}, onEnvironmentEvent: () => () => {} }))

import { buildMergedProjects, defaultRowEnvironment, rowEnvironments } from '../environment-projects'

const p = (dir: string, extra: Partial<EnvironmentProject['entry']> = {}, originUrl?: string): EnvironmentProject => ({ dir, entry: { addedManually: true, lastUsedAt: 0, ...extra }, displayName: dir.split('/').pop()!, exists: true, isGitRepo: true, ...(originUrl ? { originUrl } : {}) })
const local = (dir: string, extra: Partial<EffectiveProjectEntry['entry']> = {}): EffectiveProjectEntry => ({ dir, displayName: dir.split('/').pop()!, entry: { addedManually: true, lastUsedAt: 0, ...extra }, managed: false, profileAction: 'ask' })

const catalog = [{ id: 'local', label: 'This Mac' }, { id: 'devbox', label: 'devbox' }]
const byEnvironment = {
  local: [p('/Users/u/src/ion', { repoRemote: 'github.com/o/ion' }, 'git@github.com:o/ion.git'), p('/Users/u/notes')],
  devbox: [p('/home/g/src/ion', { repoRemote: 'github.com/o/ion', clonedByIon: true, cloneUrl: 'git@github.com:o/ion.git' }), p('/home/g/src/tools', { repoRemote: 'github.com/o/tools' }, 'https://github.com/o/tools.git')],
}

describe('buildMergedProjects', () => {
  // The preference copy of the local registry has no identity for ion; the
  // server listing does. Without the backfill the same repository grouped
  // under two keys and showed twice.
  it('merges the same repository on two machines into one row, backfilling the local identity', () => {
    const rows = buildMergedProjects({ local: [local('/Users/u/src/ion'), local('/Users/u/notes')], byEnvironment, catalog })
    expect(rows.map((r) => [r.displayName, r.holders.map((h) => h.environmentId)])).toEqual([
      ['ion', ['local', 'devbox']],
      ['notes', ['local']],
      ['tools', ['devbox']],
    ])
    expect(rows[0].repoRemote).toBe('github.com/o/ion')
  })

  // Ordering the picker by real use needs a count per machine: this machine
  // reads its own settings, a remote machine's rides in on its listing.
  it('carries each machine\'s own usage count onto its holder', () => {
    const rows = buildMergedProjects({
      local: [local('/Users/u/src/ion'), local('/Users/u/notes')],
      byEnvironment: { ...byEnvironment, devbox: [p('/home/g/src/ion', { repoRemote: 'github.com/o/ion' }), { ...p('/home/g/src/tools', { repoRemote: 'github.com/o/tools' }), usageCount: 9 }] },
      catalog,
      localUsage: { '/Users/u/src/ion': 1383 },
    })
    const [ion, notes, tools] = rows
    expect(ion.holders.map((h) => [h.environmentId, h.usageCount])).toEqual([['local', 1383], ['devbox', 0]])
    expect(notes.holders[0].usageCount).toBe(0)
    expect(tools.holders[0].usageCount).toBe(9)
  })

  it('keeps the local rows in their own order', () => {
    const rows = buildMergedProjects({ local: [local('/Users/u/notes'), local('/Users/u/src/ion')], byEnvironment, catalog })
    expect(rows.map((r) => r.displayName)).toEqual(['notes', 'ion', 'tools'])
  })

  // A row opens on this machine whenever this machine has the repository,
  // and on the first machine that has it otherwise. A machine that lacks the
  // repository is never an option, clone URL or not.
  it('a row defaults to this machine, else its first holder, and offers only holders', () => {
    const rows = buildMergedProjects({ local: [local('/Users/u/src/ion'), local('/Users/u/notes')], byEnvironment, catalog })
    const [ion, notes, tools] = rows
    expect(defaultRowEnvironment(ion)).toBe('local')
    expect(defaultRowEnvironment(notes)).toBe('local')
    expect(defaultRowEnvironment(tools)).toBe('devbox')
    expect(rowEnvironments(ion)).toEqual(['local', 'devbox'])
    expect(rowEnvironments(tools)).toEqual(['devbox'])
  })
})
