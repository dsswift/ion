import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { previewExport, runExport } from '../conversation-backup/export'
import { previewRestore, runRestore } from '../conversation-backup/restore'
import { validateManifest, buildManifest } from '../conversation-backup/manifest'

let root: string
let conversationsDir: string
let ionHome: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ion-backup-test-'))
  ionHome = join(root, '.ion')
  conversationsDir = join(ionHome, 'conversations')
  // Create the home + conversations dir structure
  require('fs').mkdirSync(conversationsDir, { recursive: true })
})

afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }) } catch {}
})

function writeConversationFiles(id: string, content: { llm: string; tree: string; memory?: string }) {
  writeFileSync(join(conversationsDir, id + '.llm.jsonl'), content.llm)
  writeFileSync(join(conversationsDir, id + '.tree.jsonl'), content.tree)
  if (content.memory) writeFileSync(join(conversationsDir, id + '.memory.md'), content.memory)
}

function writeMetadataFile(name: string, content: any) {
  writeFileSync(join(ionHome, name), JSON.stringify(content, null, 2))
}

describe('export / restore round-trip', () => {
  it('exports all conversations and restores them byte-for-byte (skip policy on empty dest)', async () => {
    // Arrange: two conversations on disk.
    writeConversationFiles('conv-A', {
      llm: '{"meta":true,"id":"conv-A","version":2}\n{"role":"user","content":"hi"}\n',
      tree: '{"meta":true,"id":"conv-A","version":2}\n{"id":"e1","type":"message"}\n',
      memory: '# Session memory for conv-A\n',
    })
    writeConversationFiles('conv-B', {
      llm: '{"meta":true,"id":"conv-B","version":2}\n',
      tree: '{"meta":true,"id":"conv-B","version":2}\n',
    })
    writeMetadataFile('tabs-api.json', { tabs: [{ conversationId: 'conv-A' }, { conversationId: 'conv-B' }] })
    writeMetadataFile('session-chains-api.json', { chains: { 'conv-A': [] }, reverse: {} })
    writeMetadataFile('session-labels-api.json', { 'conv-A': 'Important' })

    const zipPath = join(root, 'backup.zip')
    const exportResult = await runExport({
      scope: 'all',
      destinationPath: zipPath,
      sources: {
        conversationsDir,
        tabsFiles: [join(ionHome, 'tabs-api.json'), join(ionHome, 'tabs-cli.json')],
        chainsFiles: [join(ionHome, 'session-chains-api.json'), join(ionHome, 'session-chains-cli.json')],
        labelsFiles: [join(ionHome, 'session-labels-api.json'), join(ionHome, 'session-labels-cli.json')],
      },
      ionVersion: '1.0.0-test',
      backendSnapshot: 'api',
    })
    expect(exportResult.ok).toBe(true)
    expect(exportResult.conversationCount).toBe(2)
    expect(existsSync(zipPath)).toBe(true)

    // Wipe the conversations directory.
    rmSync(conversationsDir, { recursive: true, force: true })
    require('fs').mkdirSync(conversationsDir, { recursive: true })

    // Act: restore.
    const restoreResult = await runRestore({
      zipPath,
      conflictPolicy: 'skip',
      restoreTabs: false,
      sources: { conversationsDir, ionHomeDir: ionHome },
    })

    // Assert: both conversations recovered with original content.
    expect(restoreResult.ok).toBe(true)
    expect(restoreResult.restored).toBe(5) // 2 llm + 2 tree + 1 memory
    expect(readFileSync(join(conversationsDir, 'conv-A.llm.jsonl'), 'utf-8')).toBe(
      '{"meta":true,"id":"conv-A","version":2}\n{"role":"user","content":"hi"}\n',
    )
    expect(readFileSync(join(conversationsDir, 'conv-B.llm.jsonl'), 'utf-8')).toBe(
      '{"meta":true,"id":"conv-B","version":2}\n',
    )
    expect(readFileSync(join(conversationsDir, 'conv-A.memory.md'), 'utf-8')).toBe(
      '# Session memory for conv-A\n',
    )
  })

  it('skip policy preserves local files when they already exist', async () => {
    writeConversationFiles('conv-A', {
      llm: '{"original":"content"}\n',
      tree: '{"original":"tree"}\n',
    })

    const zipPath = join(root, 'backup.zip')
    await runExport({
      scope: 'all',
      destinationPath: zipPath,
      sources: {
        conversationsDir,
        tabsFiles: [],
        chainsFiles: [],
        labelsFiles: [],
      },
      ionVersion: '1.0.0-test',
      backendSnapshot: 'api',
    })

    // Replace local files with different content.
    writeConversationFiles('conv-A', {
      llm: '{"newer":"content"}\n',
      tree: '{"newer":"tree"}\n',
    })

    const result = await runRestore({
      zipPath,
      conflictPolicy: 'skip',
      restoreTabs: false,
      sources: { conversationsDir, ionHomeDir: ionHome },
    })

    expect(result.ok).toBe(true)
    expect(result.skipped).toBe(2)
    expect(result.restored).toBe(0)
    expect(result.overwritten).toBe(0)
    // Local content preserved.
    expect(readFileSync(join(conversationsDir, 'conv-A.llm.jsonl'), 'utf-8')).toBe('{"newer":"content"}\n')
  })

  it('overwrite policy replaces local files', async () => {
    writeConversationFiles('conv-A', { llm: '{"original":true}\n', tree: '{"tree-original":true}\n' })

    const zipPath = join(root, 'backup.zip')
    await runExport({
      scope: 'all',
      destinationPath: zipPath,
      sources: { conversationsDir, tabsFiles: [], chainsFiles: [], labelsFiles: [] },
      ionVersion: '1.0.0-test',
      backendSnapshot: 'api',
    })

    writeConversationFiles('conv-A', { llm: '{"local-changed":true}\n', tree: '{"local-tree-changed":true}\n' })

    const result = await runRestore({
      zipPath,
      conflictPolicy: 'overwrite',
      restoreTabs: false,
      sources: { conversationsDir, ionHomeDir: ionHome },
    })

    expect(result.ok).toBe(true)
    expect(result.overwritten).toBe(2)
    expect(readFileSync(join(conversationsDir, 'conv-A.llm.jsonl'), 'utf-8')).toBe('{"original":true}\n')
  })

  it('rename policy writes files under fresh IDs and leaves local intact', async () => {
    writeConversationFiles('conv-A', { llm: '{"backup-llm":true}\n', tree: '{"backup-tree":true}\n' })

    const zipPath = join(root, 'backup.zip')
    await runExport({
      scope: 'all',
      destinationPath: zipPath,
      sources: { conversationsDir, tabsFiles: [], chainsFiles: [], labelsFiles: [] },
      ionVersion: '1.0.0-test',
      backendSnapshot: 'api',
    })

    writeConversationFiles('conv-A', { llm: '{"local-llm":true}\n', tree: '{"local-tree":true}\n' })

    const result = await runRestore({
      zipPath,
      conflictPolicy: 'rename',
      restoreTabs: false,
      sources: { conversationsDir, ionHomeDir: ionHome },
    })

    expect(result.ok).toBe(true)
    expect(result.renamed).toBe(2)
    // Local files untouched.
    expect(readFileSync(join(conversationsDir, 'conv-A.llm.jsonl'), 'utf-8')).toBe('{"local-llm":true}\n')

    // A fresh-ID file should now exist alongside conv-A with the backup
    // content. The rename uses {millis}-{12hex} so we can find it by
    // looking for any new .llm.jsonl that isn't conv-A.
    const files: string[] = require('fs').readdirSync(conversationsDir)
    const newLlm = files.find((f: string) => f.endsWith('.llm.jsonl') && f !== 'conv-A.llm.jsonl')
    expect(newLlm).toBeDefined()
    if (newLlm) {
      expect(readFileSync(join(conversationsDir, newLlm), 'utf-8')).toBe('{"backup-llm":true}\n')
      // Filename pattern: <13-digit millis>-<12 hex chars>.llm.jsonl
      expect(newLlm).toMatch(/^\d{13}-[0-9a-f]{12}\.llm\.jsonl$/)
    }
  })

  it('preview reads the manifest without extracting', async () => {
    writeConversationFiles('conv-A', { llm: '{}\n', tree: '{}\n' })
    writeMetadataFile('tabs-api.json', { tabs: [{ conversationId: 'conv-A' }] })

    const zipPath = join(root, 'backup.zip')
    await runExport({
      scope: 'currently-open',
      destinationPath: zipPath,
      sources: {
        conversationsDir,
        tabsFiles: [join(ionHome, 'tabs-api.json')],
        chainsFiles: [],
        labelsFiles: [],
      },
      ionVersion: '1.2.3-test',
      backendSnapshot: 'api',
    })

    const preview = await previewRestore(zipPath)
    expect(preview.ok).toBe(true)
    expect(preview.manifest?.ionVersion).toBe('1.2.3-test')
    expect(preview.manifest?.scope).toBe('currently-open')
    expect(preview.manifest?.backendSnapshot).toBe('api')
  })

  it('restoreTabs=false leaves the local tabs file alone', async () => {
    writeConversationFiles('conv-A', { llm: '{}\n', tree: '{}\n' })
    writeMetadataFile('tabs-api.json', { tabs: [{ conversationId: 'conv-A', title: 'in-backup' }] })

    const zipPath = join(root, 'backup.zip')
    await runExport({
      scope: 'all',
      destinationPath: zipPath,
      sources: {
        conversationsDir,
        tabsFiles: [join(ionHome, 'tabs-api.json')],
        chainsFiles: [],
        labelsFiles: [],
      },
      ionVersion: '1.0.0',
      backendSnapshot: 'api',
    })

    // Change the local tabs file before restoring.
    writeMetadataFile('tabs-api.json', { tabs: [{ conversationId: 'conv-Z', title: 'local-only' }] })

    await runRestore({
      zipPath,
      conflictPolicy: 'skip',
      restoreTabs: false,
      sources: { conversationsDir, ionHomeDir: ionHome },
    })

    const localTabs = JSON.parse(readFileSync(join(ionHome, 'tabs-api.json'), 'utf-8'))
    // Tabs file was not touched.
    expect(localTabs.tabs).toEqual([{ conversationId: 'conv-Z', title: 'local-only' }])
  })

  it('restoreTabs=true merges backup tabs into local without overwriting existing tab IDs', async () => {
    writeConversationFiles('conv-A', { llm: '{}\n', tree: '{}\n' })
    writeMetadataFile('tabs-api.json', {
      tabs: [
        { conversationId: 'conv-A', title: 'in-backup-A' },
        { conversationId: 'conv-only-in-backup', title: 'unique-to-backup' },
      ],
    })

    const zipPath = join(root, 'backup.zip')
    await runExport({
      scope: 'all',
      destinationPath: zipPath,
      sources: {
        conversationsDir,
        tabsFiles: [join(ionHome, 'tabs-api.json')],
        chainsFiles: [],
        labelsFiles: [],
      },
      ionVersion: '1.0.0',
      backendSnapshot: 'api',
    })

    writeMetadataFile('tabs-api.json', {
      tabs: [{ conversationId: 'conv-A', title: 'updated-locally-after-export' }],
    })

    await runRestore({
      zipPath,
      conflictPolicy: 'skip',
      restoreTabs: true,
      sources: { conversationsDir, ionHomeDir: ionHome },
    })

    const merged = JSON.parse(readFileSync(join(ionHome, 'tabs-api.json'), 'utf-8'))
    // Local conv-A is preserved (not overwritten by backup version).
    const convA = merged.tabs.find((t: any) => t.conversationId === 'conv-A')
    expect(convA.title).toBe('updated-locally-after-export')
    // conv-only-in-backup is appended.
    const backupOnly = merged.tabs.find((t: any) => t.conversationId === 'conv-only-in-backup')
    expect(backupOnly).toBeDefined()
    expect(backupOnly.title).toBe('unique-to-backup')
  })
})

describe('manifest', () => {
  it('builds a manifest with the expected shape', () => {
    const m = buildManifest({
      scope: 'all',
      conversationCount: 42,
      backendSnapshot: 'api',
      ionVersion: '1.0.0',
      hostname: 'test-host',
    })
    expect(m.version).toBe(1)
    expect(m.scope).toBe('all')
    expect(m.conversationCount).toBe(42)
    expect(m.backendSnapshot).toBe('api')
    expect(m.ionVersion).toBe('1.0.0')
    expect(m.hostname).toBe('test-host')
    expect(m.createdBy).toBe('ion-desktop')
    expect(typeof m.createdAt).toBe('string')
  })

  it('rejects manifest with unsupported version', () => {
    const result = validateManifest({
      version: 9999,
      createdAt: '2026-06-08T00:00:00Z',
      createdBy: 'ion-desktop',
      ionVersion: '1.0',
      scope: 'all',
      conversationCount: 1,
      backendSnapshot: 'api',
      hostname: 'host',
    })
    expect(typeof result).toBe('string')
    if (typeof result === 'string') {
      expect(result).toContain('unsupported manifest.version')
    }
  })

  it('rejects manifest with missing required fields', () => {
    expect(validateManifest({})).toBeTypeOf('string')
    expect(validateManifest(null)).toBeTypeOf('string')
    expect(validateManifest('not an object')).toBeTypeOf('string')
  })

  it('accepts a fully-valid manifest and echoes its fields back', () => {
    const result = validateManifest({
      version: 1,
      createdAt: '2026-06-08T00:00:00Z',
      createdBy: 'ion-desktop',
      ionVersion: '1.0.0',
      scope: 'all',
      conversationCount: 7,
      backendSnapshot: 'cli',
      hostname: 'mac-mini',
    })
    expect(typeof result).toBe('object')
    if (typeof result === 'object') {
      expect(result.version).toBe(1)
      expect(result.scope).toBe('all')
      expect(result.hostname).toBe('mac-mini')
    }
  })
})

describe('previewExport tab count', () => {
  // The export preview must report a tab count separate from the
  // conversation count so the UI can render "N tabs across M conversation
  // sessions" — otherwise the user sees a large number ("1,047") that
  // doesn't match their visible tab strip and gets confused.
  //
  // Rules:
  //   - 'currently-open' scope: tabCount = sum of tabs[].length across
  //     every input tabs file (api + cli). Conversation sessions can
  //     expand far beyond the tab count because each tab references
  //     multiple session IDs.
  //   - 'all' scope: tabCount = undefined (the tabs files aren't read
  //     for this path). The renderer uses the undefined check to switch
  //     to single-number phrasing.

  it('reports tabCount summed across both backend tabs files for currently-open scope', () => {
    writeConversationFiles('conv-A1', { llm: '{}\n', tree: '{}\n' })
    writeConversationFiles('conv-A2', { llm: '{}\n', tree: '{}\n' })
    writeConversationFiles('conv-B1', { llm: '{}\n', tree: '{}\n' })
    writeMetadataFile('tabs-api.json', {
      tabs: [
        { conversationId: 'conv-A1' },
        { conversationId: 'conv-A2' },
      ],
    })
    writeMetadataFile('tabs-cli.json', {
      tabs: [
        { conversationId: 'conv-B1' },
      ],
    })

    const preview = previewExport({
      scope: 'currently-open',
      sources: {
        conversationsDir,
        tabsFiles: [join(ionHome, 'tabs-api.json'), join(ionHome, 'tabs-cli.json')],
        chainsFiles: [],
        labelsFiles: [],
      },
    })

    expect(preview.tabCount).toBe(3)             // 2 API + 1 CLI
    expect(preview.conversationCount).toBe(3)    // each tab has exactly one conversationId
  })

  it('reports a conversation count larger than the tab count when chains expand it', () => {
    // One tab — but its conversationId is the root of a chain with two
    // continuations recorded in session-chains-api.json. All three IDs
    // must be exported and counted; the tab count stays at 1.
    writeConversationFiles('root', { llm: '{}\n', tree: '{}\n' })
    writeConversationFiles('cont-1', { llm: '{}\n', tree: '{}\n' })
    writeConversationFiles('cont-2', { llm: '{}\n', tree: '{}\n' })
    writeMetadataFile('tabs-api.json', {
      tabs: [{ conversationId: 'root' }],
    })
    writeMetadataFile('session-chains-api.json', {
      chains: { root: ['cont-1', 'cont-2'] },
      reverse: { 'cont-1': 'root', 'cont-2': 'root' },
    })

    const preview = previewExport({
      scope: 'currently-open',
      sources: {
        conversationsDir,
        tabsFiles: [join(ionHome, 'tabs-api.json')],
        chainsFiles: [join(ionHome, 'session-chains-api.json')],
        labelsFiles: [],
      },
    })

    expect(preview.tabCount).toBe(1)
    expect(preview.conversationCount).toBe(3)
  })

  it('reports tabCount=0 (not undefined) when tabs files exist but are empty', () => {
    // A user who just installed Ion sees "0 tabs across 0 conversation
    // sessions" — strictly more informative than swallowing the zero.
    // tabCount=0 still passes the `tabCount !== undefined` UI check so
    // the "N tabs across" phrasing renders.
    writeMetadataFile('tabs-api.json', { tabs: [] })

    const preview = previewExport({
      scope: 'currently-open',
      sources: {
        conversationsDir,
        tabsFiles: [join(ionHome, 'tabs-api.json')],
        chainsFiles: [],
        labelsFiles: [],
      },
    })

    expect(preview.tabCount).toBe(0)
    expect(preview.conversationCount).toBe(0)
  })

  it('returns undefined tabCount for all scope (signals UI to skip tab phrasing)', () => {
    // 'all' scope enumerates ~/.ion/conversations/ directly and never
    // touches the tabs files. tabCount must be undefined — not zero —
    // so the renderer can switch from "N tabs across M sessions" to
    // just "M conversation sessions" instead of misleadingly saying
    // "0 tabs across M sessions" when there are in fact open tabs.
    writeConversationFiles('conv-A', { llm: '{}\n', tree: '{}\n' })
    writeConversationFiles('conv-B', { llm: '{}\n', tree: '{}\n' })
    writeMetadataFile('tabs-api.json', {
      tabs: [{ conversationId: 'conv-A' }, { conversationId: 'conv-B' }],
    })

    const preview = previewExport({
      scope: 'all',
      sources: {
        conversationsDir,
        tabsFiles: [join(ionHome, 'tabs-api.json')],
        chainsFiles: [],
        labelsFiles: [],
      },
    })

    expect(preview.tabCount).toBeUndefined()
    expect(preview.conversationCount).toBe(2)
  })

  it('reports tabCount when tabs file is the legacy top-level-array shape', () => {
    // Older Ion versions persisted tabs as `[tab1, tab2, ...]` rather
    // than `{ tabs: [...] }`. The collector already accepts both shapes;
    // tab counting must too.
    writeConversationFiles('conv-A', { llm: '{}\n', tree: '{}\n' })
    writeFileSync(
      join(ionHome, 'tabs-api.json'),
      JSON.stringify([{ conversationId: 'conv-A' }, { conversationId: 'conv-A-2' }]),
    )

    const preview = previewExport({
      scope: 'currently-open',
      sources: {
        conversationsDir,
        tabsFiles: [join(ionHome, 'tabs-api.json')],
        chainsFiles: [],
        labelsFiles: [],
      },
    })

    expect(preview.tabCount).toBe(2)
  })
})
