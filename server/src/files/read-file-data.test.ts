import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileData } from './read-file-data'

describe('readFileData', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ion-read-data-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('returns the exact bytes as base64', () => {
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff])
    const path = join(dir, 'deck.pptx')
    writeFileSync(path, bytes)
    expect(readFileData({ filePath: path })).toEqual({ base64: bytes.toString('base64'), size: bytes.length })
  })

  it('refuses a relative path, a directory, and a missing file', () => {
    mkdirSync(join(dir, 'sub'))
    expect(readFileData({ filePath: 'relative.docx' })).toBeNull()
    expect(readFileData({ filePath: join(dir, 'sub') })).toBeNull()
    expect(readFileData({ filePath: join(dir, 'missing.docx') })).toBeNull()
    expect(readFileData(null)).toBeNull()
  })
})
