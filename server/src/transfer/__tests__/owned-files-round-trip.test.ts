/**
 * A conversation's files move with it, and come back without a trace.
 *
 * Two data folders stand in for two machines. The conversation names a plan
 * in the shared plans folder, a plan in its own folder, a file from the
 * shared attachment store, spilled tool output, and a chart. After the move
 * every one of them is on the destination in the conversation's own space,
 * every stored path points there, and the source holds none of them except
 * the shared-store file. Moving it back finds nothing left behind to collide
 * with. Before files moved with the conversation, the destination's paths
 * pointed at the machine it left and the source kept a stale plan.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { PersistedTab } from '@ion/shared/types-persistence'
import { runTransferExport } from '../export'
import { runTransferImport } from '../import'
import { removeTransferredSource } from '../remove-source'
import { _resetParentIndexForTest } from '../parent-index'
import { readTabsState, persistSealPendingOnTabsFile, writeTabsState } from '../tabs-file'
import { scanMessagesForAttachments } from '../../remote/handlers/tab-attachment-scan'
import { makeTestPaths, minimalPersistedTab } from './fixtures'
import type { TransferPaths } from '../paths'

afterEach(() => _resetParentIndexForTest())

function write(path: string, content: string): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
  return path
}

interface Seeded {
  legacyPlan: string
  ownPlan: string
  attached: string
  spill: string
  chart: string
}

function seed(paths: TransferPaths): Seeded {
  const conv = paths.conversationsDir
  const s: Seeded = {
    legacyPlan: write(join(paths.dataDir, 'plans', 'old-plan.md'), '# legacy plan'),
    ownPlan: write(join(conv, 'c1', 'plans', 'own-plan.md'), '# own plan'),
    attached: write(join(paths.dataDir, 'user-attachments', 'abc123.pdf'), 'pdf bytes'),
    spill: write(join(conv, 'tool-results', 'c1', 'result-1.txt'), 'full tool output'),
    chart: write(join(paths.dataDir, 'resources', 'c1', 'chart-k1.json'), '{"chartId":"k1"}'),
  }
  const tree = [
    { meta: true, id: 'c1', version: 2, leafId: 'e4', workingDirectory: join(paths.dataDir, 'project') },
    { id: 'e1', parentId: null, type: 'plan_marker', timestamp: 1, data: { operation: 'created', planFilePath: s.legacyPlan, planSlug: 'old-plan' } },
    { id: 'e2', parentId: 'e1', type: 'plan_marker', timestamp: 2, data: { operation: 'created', planFilePath: s.ownPlan, planSlug: 'own-plan' } },
    { id: 'e3', parentId: 'e2', type: 'message', timestamp: 3, data: { role: 'user', content: `[Attached file: ${s.attached}]\n\nread it` } },
    { id: 'e4', parentId: 'e3', type: 'message', timestamp: 4, data: { role: 'user', content: `Full output saved to: ${s.spill} — use the Read tool` } },
  ]
  write(join(conv, 'c1.tree.jsonl'), tree.map((l) => JSON.stringify(l)).join('\n') + '\n')
  write(join(conv, 'c1.llm.jsonl'), `${JSON.stringify({ meta: true, id: 'c1', version: 2, model: 'm', system: '', createdAt: 1 })}\n${JSON.stringify({ role: 'user', content: `[Attached file: ${s.attached}]` })}\n`)
  const tab = minimalPersistedTab({
    id: 'tab-1',
    conversationId: 'c1',
    workingDirectory: join(paths.dataDir, 'project'),
    conversationPane: { activeInstanceId: 'main', instances: [{ id: 'main', label: 'main', planFilePath: s.legacyPlan }] },
  } as Partial<PersistedTab> & { id: string; conversationId: string })
  writeTabsState(paths.tabsFile, { activeSessionId: null, tabs: [tab] })
  return s
}

function tabContentFor(attached: string) {
  return { instances: { main: { messages: [{ id: 'm1', role: 'user', content: 'read it', attachments: [{ id: 'a1', type: 'file', name: 'abc123.pdf', path: attached }] }] } } }
}

async function move(from: TransferPaths, to: TransferPaths, tabContent: unknown): Promise<void> {
  const exported = await runTransferExport({
    tab: { id: 'tab-1', status: 'idle', worktree: null },
    tabRecord: readTabsState(from.tabsFile).tabs[0],
    tabContent: tabContent as never,
    targetEnvironmentId: 'env-to',
    sourceEnvironmentId: 'env-from',
    paths: from,
    destinationPath: join(from.dataDir, 'export.zip'),
    isWorktreeDirty: async () => false,
    buildWorktreeBundle: async () => null,
    persistSealPending: (sealPending) => persistSealPendingOnTabsFile(from.tabsFile, 'tab-1', sealPending),
  })
  if (!exported.ok) throw new Error(`export refused: ${exported.refusal.code}`)
  const landing = join(to.dataDir, 'project')
  mkdirSync(landing, { recursive: true })
  const imported = await runTransferImport({ archivePath: exported.archivePath, paths: to, callerSubject: 'user@example.com', landing: { kind: 'checkout', dir: landing }, checkoutWorktreeFromBundle: async () => null })
  if (!imported.ok) throw new Error(`import refused: ${imported.refusal.code} ${imported.refusal.message}`)
  const removed = await removeTransferredSource({ tabId: 'tab-1', targetEnvironmentId: 'env-to', paths: from })
  if (!removed.ok) throw new Error(`remove refused: ${removed.refusal.code}`)
}

describe('transfer: a conversation\'s files move with it', () => {
  it('lands every file in the conversation\'s own space, rewrites every path, and leaves nothing to collide with on the way back', async () => {
    const a = makeTestPaths('owned-a')
    const b = makeTestPaths('owned-b')
    const s = seed(a)

    await move(a, b, tabContentFor(s.attached))

    const bConv = b.conversationsDir
    const expected = {
      legacyPlan: join(bConv, 'c1', 'plans', 'old-plan.md'),
      ownPlan: join(bConv, 'c1', 'plans', 'own-plan.md'),
      attached: join(bConv, 'c1', 'attachments', 'abc123.pdf'),
      spill: join(bConv, 'tool-results', 'c1', 'result-1.txt'),
      chart: join(b.dataDir, 'resources', 'c1', 'chart-k1.json'),
    }
    expect(readFileSync(expected.legacyPlan, 'utf-8')).toBe('# legacy plan')
    expect(readFileSync(expected.ownPlan, 'utf-8')).toBe('# own plan')
    expect(readFileSync(expected.attached, 'utf-8')).toBe('pdf bytes')
    expect(readFileSync(expected.spill, 'utf-8')).toBe('full tool output')
    expect(existsSync(expected.chart)).toBe(true)

    // Every stored path points at the destination.
    for (const name of ['c1.tree.jsonl', 'c1.llm.jsonl']) {
      const text = readFileSync(join(bConv, name), 'utf-8')
      expect(text).not.toContain(a.dataDir)
    }
    const tree = readFileSync(join(bConv, 'c1.tree.jsonl'), 'utf-8')
    for (const path of [expected.legacyPlan, expected.ownPlan, expected.attached, expected.spill]) expect(tree).toContain(path)
    const tab = readTabsState(b.tabsFile).tabs[0]
    expect(tab.conversationPane?.instances[0].planFilePath).toBe(expected.legacyPlan)
    const content = JSON.parse(readFileSync(join(b.tabContentDir, 'tab-1.json'), 'utf-8'))
    const listed = scanMessagesForAttachments({ messages: content.instances.main.messages, planFilePath: tab.conversationPane?.instances[0].planFilePath ?? null })
    expect(listed.map((e) => e.path).sort()).toEqual([expected.attached, expected.legacyPlan].sort())
    for (const entry of listed) expect(existsSync(entry.path)).toBe(true)

    // The source holds none of it, except the shared-store file.
    expect(existsSync(s.legacyPlan)).toBe(false)
    expect(existsSync(join(a.conversationsDir, 'c1'))).toBe(false)
    expect(existsSync(join(a.conversationsDir, 'tool-results', 'c1'))).toBe(false)
    expect(existsSync(join(a.dataDir, 'resources', 'c1'))).toBe(false)
    expect(existsSync(s.attached)).toBe(true)

    // And back: nothing left behind collides.
    await move(b, a, content)
    const aConv = a.conversationsDir
    expect(readdirSync(join(aConv, 'c1', 'plans')).sort()).toEqual(['old-plan.md', 'own-plan.md'])
    expect(readdirSync(join(aConv, 'c1', 'attachments'))).toEqual(['abc123.pdf'])
    expect(readFileSync(join(aConv, 'c1.tree.jsonl'), 'utf-8')).not.toContain(b.dataDir)
    expect(existsSync(join(bConv, 'c1'))).toBe(false)
  })

  it('keeps a shared plan another tab still has open', async () => {
    const a = makeTestPaths('shared-plan-a')
    const b = makeTestPaths('shared-plan-b')
    const s = seed(a)
    const state = readTabsState(a.tabsFile)
    state.tabs.push(minimalPersistedTab({
      id: 'tab-old-fork',
      conversationId: 'other',
      conversationPane: { activeInstanceId: 'main', instances: [{ id: 'main', label: 'main', planFilePath: s.legacyPlan }] },
    } as Partial<PersistedTab> & { id: string; conversationId: string }))
    writeTabsState(a.tabsFile, state)

    await move(a, b, tabContentFor(s.attached))

    expect(readFileSync(s.legacyPlan, 'utf-8')).toBe('# legacy plan')
    expect(existsSync(join(b.conversationsDir, 'c1', 'plans', 'old-plan.md'))).toBe(true)
  })
})
