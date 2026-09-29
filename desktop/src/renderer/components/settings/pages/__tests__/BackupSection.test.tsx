// @vitest-environment jsdom
/**
 * BackupSection — export previews the chosen scope, treats a cancelled save
 * dialog as no result, and reports what it wrote; restore closes when the
 * file pick is cancelled, reports an unreadable backup, and restores with
 * the chosen conflict policy and tab-layout choice.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHarness, type Harness } from './page-harness'

const log = vi.hoisted(() => ({ rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rDebug: vi.fn() }))
vi.mock('../../../../rendererLogger', () => log)
const shell = vi.hoisted(() => ({
  conversationExportPreview: vi.fn(),
  conversationExport: vi.fn(),
  conversationRestorePreview: vi.fn(),
  conversationRestore: vi.fn(),
  onConversationBackupProgress: vi.fn(() => () => {}),
}))
const hostMock = vi.hoisted(() => ({ pickSavePath: vi.fn(), pickFile: vi.fn() }))
vi.mock('../../../../host/host-instance', () => ({ host: { ...hostMock, shell } }))

const { BackupSection } = await import('../BackupSection')

const MANIFEST = { version: 1, createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'x', ionVersion: '1.2.3', scope: 'all', conversationCount: 7, hostname: 'build-host' }

let h: Harness
beforeEach(() => {
  for (const fn of [...Object.values(shell), ...Object.values(hostMock), ...Object.values(log)]) fn.mockReset()
  shell.onConversationBackupProgress.mockReturnValue(() => {})
  shell.conversationExportPreview.mockImplementation(async (scope: string) => (scope === 'all'
    ? { ok: true, conversationCount: 1047, totalUncompressedBytes: 2048, estimatedCompressedBytes: 1024 }
    : { ok: true, conversationCount: 12, totalUncompressedBytes: 2048, estimatedCompressedBytes: 1024, tabCount: 3 }))
  h = createHarness()
})
afterEach(() => h.unmount())

describe('BackupSection export', () => {
  it('previews each scope, naming tabs only for currently-open', async () => {
    await h.render(<BackupSection />)
    expect(h.container.querySelector('[data-settings-anchor="backup"]')).not.toBeNull()
    await h.click('Export conversations…')
    expect(shell.conversationExportPreview).toHaveBeenCalledWith('all')
    expect(h.container.textContent).toContain('1,047 conversation sessions, ~1.0 KB compressed')
    await h.click('Currently open')
    expect(h.container.textContent).toContain('3 tabs across 12 conversation sessions')
  })

  it('a cancelled save dialog exports nothing and shows no result', async () => {
    hostMock.pickSavePath.mockResolvedValue({ filePath: null })
    await h.render(<BackupSection />)
    await h.click('Export conversations…')
    await h.click('Choose destination and export')
    expect(shell.conversationExport).not.toHaveBeenCalled()
    expect(log.rInfo).toHaveBeenCalledWith('backup', 'export cancelled at the save dialog')
    expect(h.container.textContent).not.toContain('Export failed')
  })

  it('exports to the picked path and reports what it wrote', async () => {
    hostMock.pickSavePath.mockResolvedValue({ filePath: '/tmp/out.zip' })
    shell.conversationExport.mockResolvedValue({ ok: true, destinationPath: '/tmp/out.zip', conversationCount: 1047, bytesWritten: 4096 })
    await h.render(<BackupSection />)
    await h.click('Export conversations…')
    await h.click('Choose destination and export')
    expect(shell.conversationExport).toHaveBeenCalledWith({ scope: 'all', destinationPath: '/tmp/out.zip' })
    expect(h.container.textContent).toContain('Exported 1,047 conversations')
    expect(h.container.textContent).toContain('/tmp/out.zip (4.0 KB)')
    await h.click('Done')
    expect(h.container.textContent).not.toContain('Exported')
  })

  it('reports a failed export', async () => {
    hostMock.pickSavePath.mockResolvedValue({ filePath: '/tmp/out.zip' })
    shell.conversationExport.mockRejectedValue(new Error('disk full'))
    await h.render(<BackupSection />)
    await h.click('Export conversations…')
    await h.click('Choose destination and export')
    expect(h.container.textContent).toContain('Export failed')
    expect(h.container.textContent).toContain('disk full')
  })
})

describe('BackupSection restore', () => {
  it('closes when the file pick is cancelled', async () => {
    hostMock.pickFile.mockResolvedValue(null)
    await h.render(<BackupSection />)
    await h.click('Restore from backup…')
    expect(log.rInfo).toHaveBeenCalledWith('backup', 'restore cancelled at the open dialog')
    expect(h.container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('reports an unreadable backup', async () => {
    hostMock.pickFile.mockResolvedValue(['/tmp/bad.zip'])
    shell.conversationRestorePreview.mockResolvedValue({ ok: false, error: 'not a backup' })
    await h.render(<BackupSection />)
    await h.click('Restore from backup…')
    expect(h.container.textContent).toContain('Restore failed')
    expect(h.container.textContent).toContain('not a backup')
    expect(h.maybeControl('Restore')).toBeUndefined()
  })

  it('restores with the chosen conflict policy and tab layout', async () => {
    hostMock.pickFile.mockResolvedValue(['/tmp/good.zip'])
    shell.conversationRestorePreview.mockResolvedValue({ ok: true, sourcePath: '/tmp/good.zip', manifest: MANIFEST })
    shell.conversationRestore.mockResolvedValue({ ok: true, restored: 5, skipped: 2, overwritten: 0, renamed: 0, errors: [] })
    await h.render(<BackupSection />)
    await h.click('Restore from backup…')
    expect(h.container.textContent).toContain('build-host')
    expect(h.container.textContent).toContain('Contains 7 conversations (full archive)')
    await h.click('Restore as new IDs')
    await h.click('Also restore tab layout')
    await h.click('Restore')
    expect(shell.conversationRestore).toHaveBeenCalledWith({ sourcePath: '/tmp/good.zip', conflictPolicy: 'rename', restoreTabs: true })
    expect(h.container.textContent).toContain('Restored 5 new files, skipped 2.')
    expect(h.container.textContent).toContain('Restart Ion to see restored conversations in the Inbox.')
  })
})
