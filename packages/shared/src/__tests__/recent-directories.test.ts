import { describe, expect, it } from 'vitest'
import { isEphemeralWorkspaceDirectory, sanitizeRecentDirectories } from '../recent-directories'

describe('recent directory workspace policy', () => {
  it.each([
    '~/.ion/worktrees/project-a3f1',
    '~\\.ion\\worktrees\\project-a3f1\\src',
    '/Users/example/.ion/worktrees/project-a3f1',
    '/Users/example/.ion/integration/project-main',
    'C:\\Users\\example\\.ion\\integration\\project-main\\src',
  ])('identifies managed ephemeral workspace %s', (directory) => {
    expect(isEphemeralWorkspaceDirectory(directory)).toBe(true)
  })

  it.each([
    '/Users/example/source/project',
    '/Users/example/.ion/worktrees-old/project',
    '/Users/example/.ion/integrations/project',
    'project/.ion/worktrees/local-copy',
  ])('keeps non-managed project directory %s', (directory) => {
    expect(isEphemeralWorkspaceDirectory(directory)).toBe(false)
  })

  it('keeps local-directory order and removes matching stale usage counters', () => {
    const result = sanitizeRecentDirectories(
      [
        '/Volumes/projects/alpha',
        '/Users/example/.ion/worktrees/project-a3f1',
        '/Volumes/projects/beta',
        '/Users/example/.ion/integration/project-main',
      ],
      {
        '/Volumes/projects/alpha': 3,
        '/Users/example/.ion/worktrees/project-a3f1': 8,
        '/Volumes/projects/beta': 2,
        '/Users/example/.ion/integration/project-main': 5,
      },
    )

    expect(result).toEqual({
      directories: ['/Volumes/projects/alpha', '/Volumes/projects/beta'],
      usageCounts: {
        '/Volumes/projects/alpha': 3,
        '/Volumes/projects/beta': 2,
      },
      removed: true,
    })
  })

  it('does not report a migration when no ephemeral directory is persisted', () => {
    expect(sanitizeRecentDirectories(['/Volumes/offline/project'], { '/Volumes/offline/project': 1 })).toEqual({
      directories: ['/Volumes/offline/project'],
      usageCounts: { '/Volumes/offline/project': 1 },
      removed: false,
    })
  })
})
