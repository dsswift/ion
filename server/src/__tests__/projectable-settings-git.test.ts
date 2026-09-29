/**
 * The phone's Git workflow section shows the same settings Studio's does.
 * The projection carries every git key a projected type can hold; the
 * directory-to-branch map (`worktreeBranchDefaults`) is the one the phone
 * edits through `settings.load`/`settings.save` instead.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../persistence/effective-settings', () => ({ readEffectiveSettings: () => ({}) }))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import type { WorktreeCompletionStrategy } from '@ion/shared/types-session'
import { projectableSchema } from '../projectable-settings'

describe('projected git workflow settings', () => {
  const git = () => projectableSchema().filter((e) => e.page === 'workflow' && e.section === 'git')

  it('projects every git workflow key but the branch defaults map', () => {
    expect(git().map((e) => e.key).sort()).toEqual([
      'commitCommand', 'gitOpsMode', 'gitWatcherIgnoredDirectories', 'worktreeCompletionStrategy', 'worktreeSkipPrTitle',
    ])
  })

  it('offers every completion strategy the server runs, with Studio labels', () => {
    const strategies: WorktreeCompletionStrategy[] = ['merge-ff', 'merge', 'pr']
    const entry = git().find((e) => e.key === 'worktreeCompletionStrategy')
    expect(entry?.choices?.map((c) => c.value)).toEqual(strategies)
    expect(entry?.choices?.map((c) => c.label)).toEqual(['Linear (sync + ff)', 'Merge commit', 'Pull request'])
  })

  it('projects the watcher ignore list as a server-wide list of text', () => {
    const entry = git().find((e) => e.key === 'gitWatcherIgnoredDirectories')
    expect(entry).toMatchObject({ type: 'list', itemType: 'string', scope: 'environment', defaultValue: ['~/.ion'] })
  })
})
