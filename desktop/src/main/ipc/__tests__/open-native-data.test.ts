import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { safeCopyName, writeOpenCopy } from '../open-native-data'

describe('writeOpenCopy', () => {
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ion-open-copy-')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('writes the bytes under the display name, keyed by content', () => {
    const a = writeOpenCopy(root, 'Report.docx', Buffer.from('one'))
    const b = writeOpenCopy(root, 'Report.docx', Buffer.from('two'))
    expect(basename(a)).toBe('Report.docx')
    expect(readFileSync(a, 'utf8')).toBe('one')
    expect(readFileSync(b, 'utf8')).toBe('two')
    expect(dirname(a)).not.toBe(dirname(b))
  })

  it('never lets the name leave the copy directory', () => {
    expect(safeCopyName('../../etc/passwd')).toBe('passwd')
    expect(safeCopyName('..')).toBe('attachment')
    expect(safeCopyName('a:b?.docx')).toBe('a_b_.docx')
    const copy = writeOpenCopy(root, '../escape.txt', Buffer.from('x'))
    expect(copy.startsWith(root)).toBe(true)
  })
})
