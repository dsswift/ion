/**
 * The remembered worktree choice: where it is saved, who hears about it, and
 * how a project's saved ephemeral answer outranks `.ion/worktree.json`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const settings = vi.hoisted(() => ({ disk: {} as Record<string, unknown>, writes: [] as Array<{ patch: Record<string, unknown>; subject?: string | null }> }))
const broadcasts = vi.hoisted(() => [] as unknown[][])
const policy = vi.hoisted(() => ({ ephemeralDefault: false }))

vi.mock('../../persistence/effective-settings', () => ({
  effectiveSubject: () => 'user@example.com',
  readEffectiveSettings: () => settings.disk,
  writeEffectiveSettings: (patch: Record<string, unknown>, subject?: string | null) => {
    settings.writes.push({ patch, subject })
    settings.disk = { ...settings.disk, ...patch }
  },
}))
vi.mock('../../broadcast', () => ({ broadcast: (...args: unknown[]) => broadcasts.push(args) }))
vi.mock('../ephemeral-policy', () => ({ readEphemeralPolicy: () => ({ ephemeralDefault: policy.ephemeralDefault, ephemeralMayDiscard: false }) }))

import { rememberWorktreeChoice, worktreeEphemeralDefault } from '../worktree-choice'

const project = { addedManually: true, lastUsedAt: 0, repoRemote: 'github.com/acme/app' }

beforeEach(() => {
  settings.disk = { projects: { '/repo': project }, worktreeBranchDefaults: { '/other': 'dev' } }
  settings.writes = []
  broadcasts.length = 0
  policy.ephemeralDefault = false
})

describe('rememberWorktreeChoice', () => {
  it('saves the branch and the ephemeral answer, keeps other fields, and tells this person', () => {
    rememberWorktreeChoice('/repo', 'main', true)

    expect(settings.writes).toEqual([{
      subject: 'user@example.com',
      patch: {
        worktreeBranchDefaults: { '/other': 'dev', '/repo': 'main' },
        projects: { '/repo': { ...project, worktreeEphemeral: true } },
      },
    }])
    expect(broadcasts).toEqual([
      ['ion:settings-changed', 'worktreeBranchDefaults', { '/other': 'dev', '/repo': 'main' }, 'user@example.com'],
      ['ion:settings-changed', 'projects', { '/repo': { ...project, worktreeEphemeral: true } }, 'user@example.com'],
    ])
  })

  it('saves only the branch when no ephemeral answer was given', () => {
    rememberWorktreeChoice('/repo', 'main', undefined)
    expect(Object.keys(settings.writes[0].patch)).toEqual(['worktreeBranchDefaults'])
  })

  it('saves only the branch for a directory that is not a registered project', () => {
    rememberWorktreeChoice('/unlisted', 'main', true)
    expect(settings.writes[0].patch).toEqual({ worktreeBranchDefaults: { '/other': 'dev', '/unlisted': 'main' } })
  })
})

describe('worktreeEphemeralDefault', () => {
  it('falls back to the manifest when the project saved nothing', () => {
    policy.ephemeralDefault = true
    expect(worktreeEphemeralDefault('/repo')).toEqual({ ephemeral: true, source: 'manifest' })
  })

  it('prefers the project answer over the manifest, including a saved no', () => {
    policy.ephemeralDefault = true
    rememberWorktreeChoice('/repo/', 'main', false)
    expect(worktreeEphemeralDefault('/repo')).toEqual({ ephemeral: false, source: 'project' })
  })
})
