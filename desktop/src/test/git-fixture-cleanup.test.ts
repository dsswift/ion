import { beforeEach, describe, expect, it, vi } from 'vitest'

const { rmSync } = vi.hoisted(() => ({ rmSync: vi.fn() }))

vi.mock('node:fs', () => ({ rmSync }))

import { removeGitFixture } from './git-fixture-cleanup'

describe('removeGitFixture', () => {
  beforeEach(() => {
    rmSync.mockReset()
  })

  it('retries transient recursive-removal failures with a bounded delay', () => {
    removeGitFixture('/tmp/example-repo')

    expect(rmSync).toHaveBeenCalledWith('/tmp/example-repo', {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
  })
})
