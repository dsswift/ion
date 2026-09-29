/**
 * fsReadDir — `isHidden` marking and the includeHidden contract.
 *
 * Every client's listing must compute `isHidden` the same way, so one
 * implementation answers them all. This pins that the value is actually
 * present on each entry, not merely that a listing comes back: an earlier
 * remote path built its own inline entry shape with no `isHidden` field at
 * all, so a remote user saw every entry — dotfile or not — rendered
 * identically.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { fsReadDir } from '../../../files/file-api'

describe('fsReadDir isHidden parity', () => {
  let dir: string

  beforeEach(() => {
    vi.clearAllMocks()
    dir = mkdtempSync(join(tmpdir(), 'ion-fs-list-dir-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('marks a dotfile as isHidden', () => {
    writeFileSync(join(dir, '.env'), 'SECRET=1')
    writeFileSync(join(dir, 'index.ts'), 'export {}')

    const { entries } = fsReadDir({ directory: dir, includeHidden: true })

    expect(entries.find((e) => e.name === '.env')?.isHidden).toBe(true)
    expect(entries.find((e) => e.name === 'index.ts')?.isHidden).toBe(false)
  })

  it('omits dotfiles entirely when includeHidden is false', () => {
    writeFileSync(join(dir, '.env'), 'SECRET=1')
    writeFileSync(join(dir, 'index.ts'), 'export {}')

    const { entries } = fsReadDir({ directory: dir, includeHidden: false })

    expect(entries.map((e) => e.name)).toEqual(['index.ts'])
  })

  it('does not mark an ordinary subdirectory as hidden', () => {
    mkdirSync(join(dir, 'src'))

    const { entries } = fsReadDir({ directory: dir, includeHidden: true })

    expect(entries.find((e) => e.name === 'src')?.isHidden).toBe(false)
  })
})
