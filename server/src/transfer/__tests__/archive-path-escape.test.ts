/**
 * An archive entry cannot write outside the staging directory. Entry names
 * come from whoever built the archive, and extraction joins them onto the
 * staging directory; yauzl refuses a name with `..` before that happens,
 * and the refusal fails the whole extraction. Pinned because the transfer
 * now carries entries under more prefixes than it did.
 */
import { describe, expect, it } from 'vitest'
import { createWriteStream, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ZipArchive } from 'archiver'
import { extractTransferArchive } from '../archive'

function zip(path: string, entries: Record<string, string>): Promise<void> {
  const archive = new ZipArchive({ zlib: { level: 1 } })
  const done = new Promise<void>((resolve, reject) => {
    const out = createWriteStream(path)
    out.on('close', () => resolve())
    out.on('error', reject)
    archive.pipe(out)
  })
  for (const [name, body] of Object.entries(entries)) archive.append(body, { name })
  void archive.finalize()
  return done
}

describe('extractTransferArchive', () => {
  it('refuses an entry that would land outside the staging directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ion-escape-'))
    const archive = join(root, 'evil.zip')
    // archiver cleans a `../` out of a name it is given, so the name is
    // written as `aa/` and patched in place (same length, CRC unaffected).
    await zip(archive, { 'transfer.json': '{}', 'aa/escaped.txt': 'x' })
    writeFileSync(archive, Buffer.from(readFileSync(archive).toString('latin1').split('aa/escaped.txt').join('../escaped.txt'), 'latin1'))
    const result = await extractTransferArchive(archive, join(root, 'stage'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('invalid relative path')
    expect(existsSync(join(root, 'escaped.txt'))).toBe(false)
  })
})
