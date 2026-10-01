/**
 * plain-destination: resolving where a plain conversation lands.
 *
 * The case these pin is the one that shipped broken: a source running a
 * build that does not report the conversation's repository. The dialog then
 * had nothing to match against, offered every project on the destination
 * with none selected — and, worse, produced no checklist at all, so nothing
 * stopped Transfer running with no directory.
 */
import { describe, expect, it } from 'vitest'
import type { EnvironmentProject, TransferPreflight } from '@ion/shared/types-environment-admin'
import { sourceProjectFor, homeRelativeParent, effectiveProject, plainChecks, destinationChoices, projectNameFor } from '../plain-destination'

function project(dir: string, repoRemote?: string, displayName?: string, originUrl?: string): EnvironmentProject {
  return { dir, entry: { repoRemote } as EnvironmentProject['entry'], displayName: displayName ?? dir.split('/').pop()!, exists: true, isGitRepo: true, originUrl }
}

function preflight(over: Partial<TransferPreflight> = {}): TransferPreflight {
  return { projectDir: null, projectDirs: [], allProjectDirs: [], sourceDirectoryExists: false, hasSourceBranch: false, knownTips: [], worktreeCopy: null, ...over }
}

describe('sourceProjectFor', () => {
  const projects = [
    project('/Users/them/source/personal/ion', 'github.com/o/ion', 'ion', 'git@github.com:o/ion.git'),
    project('/Users/them/source', 'github.com/o/umbrella'),
  ]

  it('resolves the innermost project that contains the directory', () => {
    const resolved = sourceProjectFor('/Users/them/source/personal/ion/desktop', projects)
    expect(resolved?.repoRemote).toBe('github.com/o/ion')
    expect(resolved?.originUrl).toBe('git@github.com:o/ion.git')
  })

  it('matches the project directory itself', () => {
    expect(sourceProjectFor('/Users/them/source/personal/ion', projects)?.repoRemote).toBe('github.com/o/ion')
  })

  it('does not mistake a sibling with a shared prefix for a parent', () => {
    expect(sourceProjectFor('/Users/them/source/personal/ion-other', projects)?.repoRemote).toBe('github.com/o/umbrella')
  })

  it('returns nothing for a directory in no project, or a project without a remote', () => {
    expect(sourceProjectFor('/tmp/scratch', projects)).toBeNull()
    expect(sourceProjectFor('/Users/them/notes', [project('/Users/them/notes')])).toBeNull()
  })
})

describe('homeRelativeParent', () => {
  it('puts a clone in the same place relative to home', () => {
    expect(homeRelativeParent('/Users/them/source/personal/ion')).toBe('~/source/personal')
    expect(homeRelativeParent('/home/them/src/ion')).toBe('~/src')
    expect(homeRelativeParent('/Users/them/ion')).toBe('~')
  })

  it('keeps an absolute parent outside any home', () => {
    expect(homeRelativeParent('/Users/Shared/source/personal/ion')).toBe('/Users/Shared/source/personal')
    expect(homeRelativeParent('/opt/work/ion')).toBe('/opt/work')
  })
})

describe('effectiveProject', () => {
  const resolved = { workingDirectory: '/Users/them/ion', repoRemote: 'github.com/o/ion', originUrl: 'u', suggestedParentDir: '~' }

  it('prefers the source\'s own report when it names a repository', () => {
    const reported = { workingDirectory: '/Users/them/ion', repoRemote: 'github.com/o/other', originUrl: 'v', suggestedParentDir: '~/x' }
    expect(effectiveProject(reported, resolved)).toBe(reported)
  })

  it('uses what this desktop resolved when the source reports nothing', () => {
    expect(effectiveProject(undefined, resolved)?.repoRemote).toBe('github.com/o/ion')
    expect(effectiveProject({ ...resolved, repoRemote: '' }, resolved)?.repoRemote).toBe('github.com/o/ion')
  })
})

describe('plainChecks against a source too old to describe the conversation', () => {
  it('still refuses to go without a directory to land in', () => {
    const checks = plainChecks(null, preflight({ allProjectDirs: ['/a', '/b'] }), '', 'This Mac', [])
    expect(checks.find((c) => c.id === 'lands')?.state).toBe('blocked')
  })

  it('lands in the chosen directory once one is picked', () => {
    const checks = plainChecks(null, preflight({ allProjectDirs: ['/a', '/b'] }), '/b', 'This Mac', [])
    expect(checks.find((c) => c.id === 'lands')).toMatchObject({ state: 'ok', detail: '/b' })
  })
})

describe('destinationChoices', () => {
  it('preselects the one matching checkout', () => {
    expect(destinationChoices(preflight({ projectDirs: ['/Users/Shared/source/personal/ion'] })).auto).toBe('/Users/Shared/source/personal/ion')
  })

  it('preselects nothing when there are two, or none to match', () => {
    expect(destinationChoices(preflight({ projectDirs: ['/a', '/b'] })).auto).toBe('')
    expect(destinationChoices(preflight({ allProjectDirs: ['/a'] })).auto).toBe('')
  })

  // A match narrows the default, never the menu.
  it('lists the matches first and every other project after them, once each', () => {
    const choice = destinationChoices(preflight({ projectDirs: ['/src/ion'], allProjectDirs: ['/notes', '/src/ion', '/src/atlas'] }))
    expect(choice.matches).toEqual(['/src/ion'])
    expect(choice.others).toEqual(['/notes', '/src/atlas'])
  })
})

describe('projectNameFor', () => {
  it('names a directory by its project on that machine, else by its last segment', () => {
    const projects = [project('/Users/Shared/source/personal/ion', 'r', 'Ion')]
    expect(projectNameFor('/Users/Shared/source/personal/ion', projects)).toBe('Ion')
    expect(projectNameFor('/Users/josh/atlas', projects)).toBe('atlas')
  })
})
