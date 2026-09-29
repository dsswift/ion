/**
 * A moved conversation's extension resources: collected from the producers
 * on export, handed to the same-named producers on import, and never lost.
 * A producer that fails to export refuses the move; a destination that
 * cannot take an item undoes what it accepted and refuses.
 */
import { describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { mkdirSync, existsSync } from 'fs'
import { exportExtensionResources, forgetExtensionResources, importExtensionResources, type ResourceWire } from '../extension-resources'
import { runTransferExport } from '../export'
import { runTransferImport } from '../import'
import { readTabsState, persistSealPendingOnTabsFile } from '../tabs-file'
import { makeTestPaths, writeConversationFixture, minimalPersistedTab, writeTabsFile } from './fixtures'

function wire(responses: Record<string, { ok: boolean; error?: string; data?: unknown }>): ResourceWire & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    ensureSession: async () => ({ ok: true }),
    request: async <T,>(cmd: string) => {
      calls.push(cmd)
      return responses[cmd] as { ok: boolean; error?: string; data?: T }
    },
  }
}

const report = { id: 'r1', kind: 'report', producer: 'cos2', content: 'body', createdAt: '2026-09-23T00:00:00Z', conversationId: 'c1' }

describe('extension resources on transfer', () => {
  it('collects every producer\'s items, stamped with kind and producer, and skips Studio control kinds', async () => {
    const w = wire({ resource_export: { ok: true, data: { producers: [
      { kind: 'report', producer: 'cos2', exportSupported: true, items: [{ ...report, kind: '', producer: '' }] },
      { kind: 'ion-studio.composer-action', producer: 'studio-sdk', exportSupported: true, items: [{ id: 'a', content: '', createdAt: '' }] },
    ] } } })
    const out = await exportExtensionResources(w, 'tab-1', ['c1'])
    expect(out).toEqual({ ok: true, items: [report] })
  })

  it('refuses the export when a producer fails, naming it', async () => {
    const w = wire({ resource_export: { ok: true, data: { producers: [{ kind: 'report', producer: 'cos2', exportSupported: true, error: 'disk' }] } } })
    const out = await exportExtensionResources(w, 'tab-1', ['c1'])
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.message).toContain('cos2')
  })

  it('undoes accepted items and names the extension that is missing here', async () => {
    const w = wire({
      resource_import: { ok: true, data: { items: [
        { kind: 'report', producer: 'cos2', id: 'r1', outcome: 'accepted' },
        { kind: 'brief', producer: 'absent-ext', id: 'b1', outcome: 'no_producer' },
      ] } },
      resource_forget: { ok: true, data: { producers: [] } },
    })
    const out = await importExtensionResources(w, 'tab-1', ['c1'], [report, { ...report, id: 'b1', kind: 'brief', producer: 'absent-ext' }])
    expect(out).toMatchObject({ ok: false, code: 'resource_producer_missing' })
    if (!out.ok) expect(out.message).toContain('absent-ext')
    expect(w.calls).toEqual(['resource_import', 'resource_forget'])
  })

  it('forgets through the tab\'s session', async () => {
    const w = wire({ resource_forget: { ok: true, data: { producers: [{ kind: 'report', producer: 'cos2', outcome: 'forgotten', removed: 1 }] } } })
    await forgetExtensionResources(w, 'tab-1', ['c1'])
    expect(w.calls).toEqual(['resource_forget'])
  })

  it('a destination that cannot take the resources imports nothing, and the source keeps everything', async () => {
    const source = makeTestPaths('ext-source')
    const target = makeTestPaths('ext-target')
    writeConversationFixture(source.conversationsDir, 'c1')
    writeTabsFile(source.tabsFile, [minimalPersistedTab({ id: 'tab-1', conversationId: 'c1' })])
    const exported = await runTransferExport({
      tab: { id: 'tab-1', status: 'idle', worktree: null },
      tabRecord: readTabsState(source.tabsFile).tabs[0],
      tabContent: null,
      targetEnvironmentId: 'env-target',
      sourceEnvironmentId: 'env-source',
      paths: source,
      destinationPath: join(source.dataDir, 'export.zip'),
      isWorktreeDirty: async () => false,
      buildWorktreeBundle: async () => null,
      persistSealPending: (sealPending) => persistSealPendingOnTabsFile(source.tabsFile, 'tab-1', sealPending),
      exportResources: async () => ({ ok: true, items: [report] }),
    })
    if (!exported.ok) throw new Error(exported.refusal.code)
    expect(exported.manifest.extensionResources).toEqual([report])

    const landing = join(target.dataDir, 'here')
    mkdirSync(landing, { recursive: true })
    const importResources = vi.fn(async () => ({ ok: false as const, code: 'resource_producer_missing' as const, message: 'cos2 is not installed here' }))
    const imported = await runTransferImport({ archivePath: exported.archivePath, paths: target, callerSubject: 'user@example.com', landing: { kind: 'checkout', dir: landing }, checkoutWorktreeFromBundle: async () => null, importResources })

    expect(imported).toMatchObject({ ok: false, refusal: { code: 'resource_producer_missing' } })
    expect(importResources).toHaveBeenCalledWith({ tabId: 'tab-1', conversationIds: ['c1'], items: [report] })
    expect(existsSync(join(target.conversationsDir, 'c1.llm.jsonl'))).toBe(false)
    expect(readTabsState(target.tabsFile).tabs).toEqual([])
    expect(existsSync(join(source.conversationsDir, 'c1.llm.jsonl'))).toBe(true)
  })

  it('an export whose producers fail refuses and releases the conversation', async () => {
    const source = makeTestPaths('ext-refuse')
    writeConversationFixture(source.conversationsDir, 'c1')
    writeTabsFile(source.tabsFile, [minimalPersistedTab({ id: 'tab-1', conversationId: 'c1' })])
    const released = vi.fn()
    const exported = await runTransferExport({
      tab: { id: 'tab-1', status: 'idle', worktree: null },
      tabRecord: readTabsState(source.tabsFile).tabs[0],
      tabContent: null,
      targetEnvironmentId: 'env-target',
      sourceEnvironmentId: 'env-source',
      paths: source,
      destinationPath: join(source.dataDir, 'export.zip'),
      isWorktreeDirty: async () => false,
      buildWorktreeBundle: async () => null,
      persistSealPending: (sealPending) => persistSealPendingOnTabsFile(source.tabsFile, 'tab-1', sealPending),
      releaseSealPending: released,
      exportResources: async () => ({ ok: false, message: 'cos2 could not hand over this conversation\'s resources' }),
    })
    expect(exported).toMatchObject({ ok: false, refusal: { code: 'resource_export_failed' } })
    expect(released).toHaveBeenCalled()
  })
})
