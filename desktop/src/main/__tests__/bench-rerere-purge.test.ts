import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('../git-runner', () => ({ runGit: vi.fn() }))
vi.mock('../integration/bench-resolution-validation', () => ({ forgetRererePaths: vi.fn() }))

import { runGit } from '../git-runner'
import { countRerereRecordings, discardAllRerereRecordings } from '../integration/bench-rerere-purge'

const git = vi.mocked(runGit)

beforeEach(() => git.mockReset())

describe('rerere purge helpers', () => {
  it('counts and discards recordings from git common dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ion-rerere-'))
    const common = join(root, '.git')
    await mkdir(join(common, 'rr-cache', 'one'), { recursive: true })
    await mkdir(join(common, 'rr-cache', 'two'), { recursive: true })
    git.mockResolvedValue(common)

    await expect(countRerereRecordings(root)).resolves.toEqual({ ok: true, count: 2 })
    await expect(discardAllRerereRecordings(root)).resolves.toEqual({ ok: true, count: 2 })
    await expect(countRerereRecordings(root)).resolves.toEqual({ ok: true, count: 0 })
  })

  it('treats a missing rr-cache as zero recordings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ion-rerere-empty-'))
    git.mockResolvedValue(join(root, '.git'))
    await expect(countRerereRecordings(root)).resolves.toEqual({ ok: true, count: 0 })
  })
})
