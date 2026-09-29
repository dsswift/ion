/**
 * Pins the two read options a client on a constrained route passes:
 * `includeHidden: false` on a listing and `maxBytes` on a file or image read.
 * Both are additive: a call that names neither behaves as it always has.
 */
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { fsReadDir, fsReadFile } from '../file-api'
import { readImageDataUrl } from '../../store/session-reads'

let dir: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ion-file-api-')))
  writeFileSync(join(dir, 'visible.txt'), 'hello world')
  writeFileSync(join(dir, '.hidden'), 'secret')
  mkdirSync(join(dir, '.git'))
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([1, 0, 2]))
  writeFileSync(join(dir, 'dot.png'), Buffer.alloc(64, 7))
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('fs.readDir includeHidden', () => {
  it('lists hidden entries, flagged, when the option is absent', () => {
    const { entries } = fsReadDir({ directory: dir })
    expect(entries.map((e) => e.name).sort()).toEqual(['.git', '.hidden', 'blob.bin', 'dot.png', 'visible.txt'])
    expect(entries.find((e) => e.name === '.hidden')?.isHidden).toBe(true)
  })

  it('leaves them out when includeHidden is false', () => {
    expect(fsReadDir({ directory: dir, includeHidden: false }).entries.map((e) => e.name).sort()).toEqual(['blob.bin', 'dot.png', 'visible.txt'])
  })

  it('treats includeHidden: true as the default', () => {
    expect(fsReadDir({ directory: dir, includeHidden: true }).entries).toHaveLength(5)
  })
})

describe('fs.readFile maxBytes', () => {
  it('reads a file inside the limit', () => {
    expect(fsReadFile({ filePath: join(dir, 'visible.txt'), maxBytes: 11 })).toEqual({ content: 'hello world' })
  })

  it('refuses a file over a lowered limit, saying so', () => {
    expect(fsReadFile({ filePath: join(dir, 'visible.txt'), maxBytes: 10 })).toEqual({ content: null, error: 'File too large (>10 bytes)' })
  })

  it('never raises the limit the editor itself reads under', () => {
    writeFileSync(join(dir, 'big.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61))
    expect(fsReadFile({ filePath: join(dir, 'big.txt'), maxBytes: 64 * 1024 * 1024 })).toEqual({ content: null, error: 'File too large (>2MB)' })
  })

  it('refuses a binary file', () => {
    expect(fsReadFile({ filePath: join(dir, 'blob.bin') })).toEqual({ content: null, error: 'Binary file' })
  })
})

describe('session.readImageDataUrl maxBytes', () => {
  it('embeds an image inside the limit', async () => {
    const result = await readImageDataUrl(join(dir, 'dot.png'), { maxBytes: 64 })
    expect(result.dataUrl?.startsWith('data:image/png;base64,')).toBe(true)
    expect(result.error).toBeUndefined()
  })

  it('refuses an image over a lowered limit and says why', async () => {
    expect(await readImageDataUrl(join(dir, 'dot.png'), { maxBytes: 63 })).toEqual({ dataUrl: null, error: 'Image too large (>63 bytes)' })
  })

  it('names the reason for a missing file and for a file that is not an image', async () => {
    expect(await readImageDataUrl(join(dir, 'nope.png'))).toEqual({ dataUrl: null, error: 'File not found' })
    expect(await readImageDataUrl(join(dir, 'visible.txt'))).toEqual({ dataUrl: null, error: 'Unsupported image extension' })
  })
})
