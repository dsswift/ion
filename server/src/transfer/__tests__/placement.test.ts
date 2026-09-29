/**
 * Where arriving files land: in the conversation's own space, never on top
 * of a different file, and reusing an identical one.
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { placeAttachments } from '../import-files'
import { sha256OfBuffer } from '../entries'
import type { TransferManifest } from '../manifest'
import { makeTestPaths } from './fixtures'

function manifestWith(attachments: Array<{ sourcePath: string; kind: 'plan' | 'file'; bytes: string }>, stagingDir: string): TransferManifest {
  const files: Record<string, string> = {}
  const list = attachments.map((a, i) => {
    const entry = `attachments/${i}`
    mkdirSync(join(stagingDir, 'attachments'), { recursive: true })
    writeFileSync(join(stagingDir, entry), a.bytes)
    files[entry] = sha256OfBuffer(Buffer.from(a.bytes))
    return { entry, sourcePath: a.sourcePath, kind: a.kind, ownerId: 'c1' }
  })
  return {
    files,
    attachments: list,
    sourceRoots: { conversationsDir: '/src/.ion/conversations', dataDir: '/src/.ion', workingDirectory: '/src/project', separator: '/' },
  } as unknown as TransferManifest
}

describe('placeAttachments', () => {
  it('puts each file in the conversation\'s own folder, renaming only on a real collision', () => {
    const paths = makeTestPaths('placement')
    const staging = join(paths.dataDir, 'staging')
    const dest = { conversationsDir: paths.conversationsDir, dataDir: paths.dataDir }
    const existing = join(paths.conversationsDir, 'c1', 'attachments', 'same.pdf')
    mkdirSync(join(existing, '..'), { recursive: true })
    writeFileSync(existing, 'identical')
    const manifest = manifestWith([
      { sourcePath: '/src/.ion/plans/calm-fox.md', kind: 'plan', bytes: 'plan' },
      { sourcePath: '/src/project/.ion/plans/cc-plan.md', kind: 'plan', bytes: 'cc' },
      { sourcePath: '/src/Downloads/report.pdf', kind: 'file', bytes: 'one' },
      { sourcePath: '/src/other/report.pdf', kind: 'file', bytes: 'two' },
      { sourcePath: '/src/x/same.pdf', kind: 'file', bytes: 'identical' },
    ], staging)
    const landed = join(paths.dataDir, 'project')

    const placed = placeAttachments(staging, manifest, dest, landed).map((p) => [p.destination, p.existing])

    expect(placed[0]).toEqual([join(paths.conversationsDir, 'c1', 'plans', 'calm-fox.md'), false])
    expect(placed[1]).toEqual([join(landed, '.ion', 'plans', 'cc-plan.md'), false])
    expect(placed[2]).toEqual([join(paths.conversationsDir, 'c1', 'attachments', 'report.pdf'), false])
    const second = placed[3][0] as string
    expect(second).toMatch(/report-[0-9a-f]{8}\.pdf$/)
    expect(placed[4]).toEqual([existing, true])
  })
})
