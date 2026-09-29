/**
 * Verification is what makes deleting the source safe.
 *
 * The destination re-hashes every file it extracted and every file it
 * committed against the digests the source recorded in the manifest. These
 * pin that a payload which does not match is refused — because the client
 * only asks the source to delete itself after this import answers ok.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import yauzl from 'yauzl'
import { ZipArchive } from 'archiver'
import { runTransferExport } from '../export'
import { runTransferImport } from '../import'
import { readTabsState, persistSealPendingOnTabsFile } from '../tabs-file'
import { makeTestPaths, writeConversationFixture, minimalPersistedTab, writeTabsFile } from './fixtures'
import type { TransferPaths } from '../paths'

/** A directory that exists on the destination: an import refuses to land a plain conversation anywhere else. */
function landingDir(paths: TransferPaths): string {
  const dir = join(paths.dataDir, 'projects', 'ion')
  mkdirSync(dir, { recursive: true })
  return dir
}

async function exportFrom(paths: TransferPaths): Promise<string> {
  const destinationPath = join(paths.dataDir, 'export.zip')
  const result = await runTransferExport({
    tab: { id: 'tab-1', status: 'idle', worktree: null },
    tabRecord: readTabsState(paths.tabsFile).tabs[0],
    tabContent: null,
    targetEnvironmentId: 'env-target',
    sourceEnvironmentId: 'env-source',
    paths,
    destinationPath,
    isWorktreeDirty: async () => false,
    buildWorktreeBundle: async () => null,
    persistSealPending: (sealPending) => persistSealPendingOnTabsFile(paths.tabsFile, 'tab-1', sealPending),
  })
  if (!result.ok) throw new Error(`export refused: ${result.refusal.code}`)
  return result.archivePath
}

/** Rewrite one entry's bytes, leaving the manifest (and its digests) alone. */
function tamper(archivePath: string, entryName: string, replacement: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const out = join(mkdtempSync(join(tmpdir(), 'ion-tamper-')), 'tampered.zip')
    const archive = new ZipArchive({ zlib: { level: 6 } })
    const chunks: Buffer[] = []
    archive.on('data', (c: Buffer) => chunks.push(c))
    archive.on('error', reject)
    archive.on('end', () => {
      writeFileSync(out, Buffer.concat(chunks))
      resolve(out)
    })
    yauzl.open(archivePath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err)
      zipfile.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName === entryName) {
          archive.append(replacement, { name: entry.fileName })
          zipfile.readEntry()
          return
        }
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return reject(streamErr)
          const buf: Buffer[] = []
          stream.on('data', (c: Buffer) => buf.push(c))
          stream.on('end', () => {
            archive.append(Buffer.concat(buf), { name: entry.fileName })
            zipfile.readEntry()
          })
        })
      })
      zipfile.on('end', () => { void archive.finalize() })
      zipfile.readEntry()
    })
  })
}

describe('transfer import verification', () => {
  it('refuses an archive whose contents do not match the digests the source recorded', async () => {
    const source = makeTestPaths('verify-source')
    const target = makeTestPaths('verify-target')
    writeConversationFixture(source.conversationsDir, 'root-1')
    writeTabsFile(source.tabsFile, [minimalPersistedTab({ id: 'tab-1', conversationId: 'root-1' })])

    const archivePath = await exportFrom(source)
    const tampered = await tamper(archivePath, 'conversations/root-1.llm.jsonl', Buffer.from('{"meta":true,"id":"root-1","version":2}\n'))

    const result = await runTransferImport({ archivePath: tampered, paths: target, callerSubject: 'importer@example.com', landing: { kind: 'checkout', dir: landingDir(target) }, checkoutWorktreeFromBundle: async () => null })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.refusal.code).toBe('verification_failed')
    expect(result.refusal.message).toContain('root-1.llm.jsonl')
    // Nothing was committed, so the source is still the only copy.
    expect(readTabsState(target.tabsFile).tabs).toHaveLength(0)
  })

  it('accepts an untouched archive and reports how many files it verified', async () => {
    const source = makeTestPaths('verify-ok-source')
    const target = makeTestPaths('verify-ok-target')
    writeConversationFixture(source.conversationsDir, 'root-1')
    mkdirSync(join(source.conversationsDir, 'root-1', 'images'), { recursive: true })
    writeFileSync(join(source.conversationsDir, 'root-1', 'images', 'a.png'), Buffer.from([9, 8, 7]))
    writeTabsFile(source.tabsFile, [minimalPersistedTab({ id: 'tab-1', conversationId: 'root-1' })])

    const archivePath = await exportFrom(source)
    const result = await runTransferImport({ archivePath, paths: target, callerSubject: 'importer@example.com', landing: { kind: 'checkout', dir: landingDir(target) }, checkoutWorktreeFromBundle: async () => null })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // .llm.jsonl, .tree.jsonl, and the image.
    expect(result.verifiedFiles).toBe(3)
    expect(readFileSync(join(target.conversationsDir, 'root-1', 'images', 'a.png'))).toEqual(Buffer.from([9, 8, 7]))
    rmSync(source.dataDir, { recursive: true, force: true })
  })
})
