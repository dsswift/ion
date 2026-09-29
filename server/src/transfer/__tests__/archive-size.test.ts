/**
 * buildTransferArchive reports the size of the archive it wrote.
 *
 * That number is published to the receiving client as the transfer's
 * `totalBytes`, and the client completes its receive by counting bytes
 * against it. It was being taken from `archiver`'s progress event
 * (`fs.processedBytes`), which counts the UNCOMPRESSED bytes read off disk —
 * always larger than the deflated archive. The receiver therefore counted to
 * the real end of the stream, found itself short of a total that described a
 * different quantity, and waited forever.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, statSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildTransferArchive } from '../archive'
import { planTransferEntries, digestEntries } from '../entries'
import type { TransferManifest } from '../manifest'

function manifest(): TransferManifest {
  return {
    version: 1,
    rootConversationId: 'root-1',
    conversationIds: ['root-1'],
    sourceEnvironmentId: 'env-source',
    exportedAt: 0,
    tabRecord: { id: 'tab-1' } as TransferManifest['tabRecord'],
    tabContent: null,
    worktree: null,
    files: {},
    attachments: [],
    missingAttachments: [],
    sourceRoots: { conversationsDir: '/src/conversations', dataDir: '/src', workingDirectory: '/src/project', separator: '/' },
    resourceState: { read: [], deleted: [] },
    extensionResources: [],
  }
}

describe('buildTransferArchive', () => {
  it('reports the bytes it wrote, not the bytes it read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ion-archive-size-'))
    try {
      const conversationsDir = join(root, 'conversations')
      mkdirSync(conversationsDir, { recursive: true })
      // Highly compressible on purpose: the archive must come out materially
      // smaller than its input, so a result that still reports input bytes
      // cannot pass by coincidence.
      const line = `${JSON.stringify({ role: 'assistant', content: 'x'.repeat(200) })}\n`
      writeFileSync(join(conversationsDir, 'root-1.llm.jsonl'), line.repeat(500))
      const destinationPath = join(root, 'out', 'archive.zip')

      const entries = planTransferEntries(conversationsDir, [{ id: 'root-1', paths: [join(conversationsDir, 'root-1.llm.jsonl')], ownedDir: null, toolResultsDir: null }], null)
      const result = await buildTransferArchive({
        destinationPath,
        manifest: { ...manifest(), files: await digestEntries(entries) },
        entries,
      })

      expect(result.ok).toBe(true)
      const onDisk = statSync(destinationPath).size
      expect(result.bytesWritten).toBe(onDisk)
      // The defect's signature: the input was much larger than the archive.
      expect(onDisk).toBeLessThan(statSync(join(conversationsDir, 'root-1.llm.jsonl')).size)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
