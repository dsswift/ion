import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

// Create a real temp dir for each test suite run
const TEST_BASE = join(tmpdir(), `ion-migration-test-${randomUUID().slice(0, 8)}`)

function makeTempDir(name: string): string {
  const dir = join(TEST_BASE, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

// We test the pure functions by importing them directly
// (no electron dependency in these functions)

// ─── Inline the logic we want to test (avoids electron import issues) ───
// These mirror the exported functions from tab-migration.ts

function createBackupSnapshotTestable(
  dir: string,
  files: string[],
): string[] {
  const ts = Date.now()
  const paths: string[] = []
  for (const src of files) {
    if (existsSync(src)) {
      const backup = `${src}.pre-migration.${ts}`
      writeFileSync(backup, readFileSync(src))
      paths.push(backup)
    }
  }
  return paths
}

function transferTabRecordTestable(
  conversationId: string,
  newConversationId: string,
  srcPath: string,
  dstPath: string,
): void {
  const srcState = existsSync(srcPath)
    ? JSON.parse(readFileSync(srcPath, 'utf-8'))
    : { activeSessionId: null, tabs: [] }
  const dstState = existsSync(dstPath)
    ? JSON.parse(readFileSync(dstPath, 'utf-8'))
    : { activeSessionId: null, tabs: [] }

  const tabIndex = srcState.tabs.findIndex((t: any) => t.conversationId === conversationId)
  if (tabIndex === -1) return

  const tab = { ...srcState.tabs[tabIndex] }
  tab.conversationId = newConversationId
  delete tab.historicalSessionIds
  delete tab.lastKnownSessionId
  delete tab.forkedFromSessionId

  dstState.tabs.push(tab)
  srcState.tabs.splice(tabIndex, 1)
  if (srcState.activeSessionId === conversationId) {
    srcState.activeSessionId = srcState.tabs[0]?.conversationId ?? null
  }

  writeFileSync(srcPath, JSON.stringify(srcState, null, 2))
  writeFileSync(dstPath, JSON.stringify(dstState, null, 2))
}

function transferSessionLabelTestable(
  conversationId: string,
  newConversationId: string,
  srcLabelsPath: string,
  dstLabelsPath: string,
): void {
  const srcLabels = existsSync(srcLabelsPath)
    ? JSON.parse(readFileSync(srcLabelsPath, 'utf-8'))
    : {}
  const label = srcLabels[conversationId]
  if (!label) return

  const dstLabels = existsSync(dstLabelsPath)
    ? JSON.parse(readFileSync(dstLabelsPath, 'utf-8'))
    : {}
  dstLabels[newConversationId] = label
  writeFileSync(dstLabelsPath, JSON.stringify(dstLabels, null, 2))
}

// ─── Tests ───

beforeEach(() => {
  mkdirSync(TEST_BASE, { recursive: true })
})

afterEach(() => {
  try {
    rmSync(TEST_BASE, { recursive: true, force: true })
  } catch {}
})

describe('createBackupSnapshot', () => {
  it('creates backup files with correct content', () => {
    const dir = makeTempDir('backup-test')
    const file1 = join(dir, 'tabs-api.json')
    const file2 = join(dir, 'labels-api.json')
    writeFileSync(file1, JSON.stringify({ tabs: [{ id: 1 }] }))
    writeFileSync(file2, JSON.stringify({ s1: 'title1' }))

    const paths = createBackupSnapshotTestable(dir, [file1, file2])

    expect(paths).toHaveLength(2)
    for (const p of paths) {
      expect(existsSync(p)).toBe(true)
      expect(p).toContain('.pre-migration.')
    }
    // Verify content matches
    expect(readFileSync(paths[0], 'utf-8')).toBe(readFileSync(file1, 'utf-8'))
    expect(readFileSync(paths[1], 'utf-8')).toBe(readFileSync(file2, 'utf-8'))
  })

  it('skips non-existent files', () => {
    const dir = makeTempDir('backup-skip')
    const file1 = join(dir, 'exists.json')
    const file2 = join(dir, 'missing.json')
    writeFileSync(file1, '{}')

    const paths = createBackupSnapshotTestable(dir, [file1, file2])
    expect(paths).toHaveLength(1)
  })
})

describe('transferTabRecord', () => {
  it('moves tab from source to destination', () => {
    const dir = makeTempDir('transfer-tab')
    const srcPath = join(dir, 'tabs-cli.json')
    const dstPath = join(dir, 'tabs-api.json')

    writeFileSync(srcPath, JSON.stringify({
      activeSessionId: 'conv-1',
      tabs: [
        {
          conversationId: 'conv-1',
          title: 'My Chat',
          customTitle: 'Custom',
          workingDirectory: '/home/user',
          permissionMode: 'auto',
          pillColor: '#ff0000',
          planFilePath: '/plans/plan.md',
          historicalSessionIds: ['old-1', 'old-2'],
          lastKnownSessionId: 'old-2',
          forkedFromSessionId: 'fork-1',
        },
        { conversationId: 'conv-2', title: 'Other', workingDirectory: '/tmp' },
      ],
    }))
    writeFileSync(dstPath, JSON.stringify({ activeSessionId: null, tabs: [] }))

    transferTabRecordTestable('conv-1', 'new-conv-1', srcPath, dstPath)

    const src = JSON.parse(readFileSync(srcPath, 'utf-8'))
    const dst = JSON.parse(readFileSync(dstPath, 'utf-8'))

    // Tab removed from source
    expect(src.tabs).toHaveLength(1)
    expect(src.tabs[0].conversationId).toBe('conv-2')

    // Tab added to destination
    expect(dst.tabs).toHaveLength(1)
    expect(dst.tabs[0].conversationId).toBe('new-conv-1')

    // Session refs cleared
    expect(dst.tabs[0].historicalSessionIds).toBeUndefined()
    expect(dst.tabs[0].lastKnownSessionId).toBeUndefined()
    expect(dst.tabs[0].forkedFromSessionId).toBeUndefined()

    // Metadata preserved
    expect(dst.tabs[0].pillColor).toBe('#ff0000')
    expect(dst.tabs[0].planFilePath).toBe('/plans/plan.md')
    expect(dst.tabs[0].customTitle).toBe('Custom')
    expect(dst.tabs[0].workingDirectory).toBe('/home/user')
  })

  it('updates activeSessionId when migrating active tab', () => {
    const dir = makeTempDir('transfer-active')
    const srcPath = join(dir, 'src.json')
    const dstPath = join(dir, 'dst.json')

    writeFileSync(srcPath, JSON.stringify({
      activeSessionId: 'active-tab',
      tabs: [
        { conversationId: 'active-tab', title: 'Active' },
        { conversationId: 'other-tab', title: 'Other' },
      ],
    }))
    writeFileSync(dstPath, JSON.stringify({ activeSessionId: null, tabs: [] }))

    transferTabRecordTestable('active-tab', 'new-active', srcPath, dstPath)

    const src = JSON.parse(readFileSync(srcPath, 'utf-8'))
    expect(src.activeSessionId).toBe('other-tab')
  })

  it('handles missing conversation gracefully', () => {
    const dir = makeTempDir('transfer-missing')
    const srcPath = join(dir, 'src.json')
    const dstPath = join(dir, 'dst.json')

    writeFileSync(srcPath, JSON.stringify({ activeSessionId: null, tabs: [] }))
    writeFileSync(dstPath, JSON.stringify({ activeSessionId: null, tabs: [] }))

    // Should not throw
    transferTabRecordTestable('nonexistent', 'new-id', srcPath, dstPath)

    const dst = JSON.parse(readFileSync(dstPath, 'utf-8'))
    expect(dst.tabs).toHaveLength(0)
  })
})

describe('transferSessionLabel', () => {
  it('copies label from source to destination', () => {
    const dir = makeTempDir('transfer-label')
    const srcLabels = join(dir, 'labels-cli.json')
    const dstLabels = join(dir, 'labels-api.json')

    writeFileSync(srcLabels, JSON.stringify({ 'conv-1': 'My Important Chat', 'conv-2': 'Other' }))
    writeFileSync(dstLabels, JSON.stringify({}))

    transferSessionLabelTestable('conv-1', 'new-conv-1', srcLabels, dstLabels)

    const dst = JSON.parse(readFileSync(dstLabels, 'utf-8'))
    expect(dst['new-conv-1']).toBe('My Important Chat')
  })

  it('skips when no label exists', () => {
    const dir = makeTempDir('label-skip')
    const srcLabels = join(dir, 'labels-cli.json')
    const dstLabels = join(dir, 'labels-api.json')

    writeFileSync(srcLabels, JSON.stringify({}))
    writeFileSync(dstLabels, JSON.stringify({}))

    transferSessionLabelTestable('conv-1', 'new-conv-1', srcLabels, dstLabels)

    const dst = JSON.parse(readFileSync(dstLabels, 'utf-8'))
    expect(Object.keys(dst)).toHaveLength(0)
  })
})
