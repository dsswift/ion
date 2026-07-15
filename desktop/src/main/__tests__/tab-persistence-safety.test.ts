/**
 * Tab persistence safety — SAVE_TABS sanity guard + LOAD_TABS startup recovery
 *
 * Tests the four defence layers added to ipc/settings.ts:
 *   Layer 1: Rolling backup — every save renames the current file to .prev
 *   Layer 2: Sanity guard  — refuses writes that drop tab count by >50%
 *   Layer 3: Startup recovery — LOAD_TABS prefers .prev when primary is tiny
 *   Layer 4: Logging — covered implicitly (log calls appear in every path)
 *
 * These tests exercise the logic directly without Electron IPC by
 * inlining the same fs operations from the handler. The handler's logic
 * is simple enough (read / compare / rename / write) that mirroring it
 * in a helper-function style gives confidence without needing to mock
 * ipcMain.handle.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

// ─── Temp directory per test run ───

const TEST_BASE = join(tmpdir(), `ion-tab-safety-${randomUUID().slice(0, 8)}`)

function freshDir(): string {
  const dir = join(TEST_BASE, randomUUID().slice(0, 8))
  mkdirSync(dir, { recursive: true })
  return dir
}

afterEach(() => {
  try { rmSync(TEST_BASE, { recursive: true, force: true }) } catch {}
})

// ─── Inline helpers mirroring ipc/settings.ts ───

const TAB_GUARD_MIN_COUNT = 10

function readOnDiskTabCount(tabsFile: string): number {
  try {
    if (existsSync(tabsFile)) {
      const data = JSON.parse(readFileSync(tabsFile, 'utf-8'))
      const tabs = data?.tabs
      return Array.isArray(tabs) ? tabs.length : 0
    }
  } catch {}
  return 0
}

function makeTabs(count: number): { activeSessionId: string | null; tabs: Array<{ conversationId: string; title: string }> } {
  const tabs = Array.from({ length: count }, (_, i) => ({
    conversationId: `session-${i}`,
    title: `Tab ${i}`,
  }))
  return { activeSessionId: tabs[0]?.conversationId || null, tabs }
}

/**
 * Simulates the SAVE_TABS handler logic (layers 1, 2, 4).
 * Returns { saved: boolean; rejectedPath?: string } for assertions.
 */
function saveTabs(
  tabsFile: string,
  data: Record<string, unknown>,
): { saved: boolean; rejectedPath?: string } {
  const incomingCount = Array.isArray(data?.tabs) ? (data.tabs as unknown[]).length : 0
  const onDiskCount = readOnDiskTabCount(tabsFile)

  // Layer 2: sanity guard
  if (onDiskCount >= TAB_GUARD_MIN_COUNT && incomingCount < onDiskCount * 0.5) {
    const rejectedPath = tabsFile + '.rejected'
    writeFileSync(rejectedPath, JSON.stringify(data, null, 2))
    return { saved: false, rejectedPath }
  }

  // Layer 1: rolling backup
  if (existsSync(tabsFile)) {
    try {
      renameSync(tabsFile, tabsFile + '.prev')
    } catch {}
  }

  writeFileSync(tabsFile, JSON.stringify(data, null, 2))
  return { saved: true }
}

/**
 * Simulates the LOAD_TABS handler logic (layer 3).
 */
function loadTabs(tabsFile: string): any {
  const prevFile = tabsFile + '.prev'
  let primary: any = null
  let primaryCount = 0
  if (existsSync(tabsFile)) {
    primary = JSON.parse(readFileSync(tabsFile, 'utf-8'))
    primaryCount = Array.isArray(primary?.tabs) ? primary.tabs.length : 0
  }

  // Layer 3: startup recovery
  if (existsSync(prevFile)) {
    try {
      const prev = JSON.parse(readFileSync(prevFile, 'utf-8'))
      const prevCount = Array.isArray(prev?.tabs) ? prev.tabs.length : 0
      if (prevCount > primaryCount && primaryCount < TAB_GUARD_MIN_COUNT) {
        return prev
      }
    } catch {}
  }

  return primary
}

// ─── Tests ───

describe('Layer 1: rolling backup', () => {
  it('renames the current file to .prev on each save', () => {
    const dir = freshDir()
    const tabsFile = join(dir, 'tabs-api.json')
    const prevFile = tabsFile + '.prev'

    // First save — no .prev created (no prior file to rename)
    saveTabs(tabsFile, makeTabs(5))
    expect(existsSync(tabsFile)).toBe(true)
    expect(existsSync(prevFile)).toBe(false)

    // Second save — .prev now contains the first save's data
    const firstData = readFileSync(tabsFile, 'utf-8')
    saveTabs(tabsFile, makeTabs(6))
    expect(existsSync(prevFile)).toBe(true)
    expect(readFileSync(prevFile, 'utf-8')).toBe(firstData)
  })

  it('.prev is overwritten on each subsequent save', () => {
    const dir = freshDir()
    const tabsFile = join(dir, 'tabs-api.json')
    const prevFile = tabsFile + '.prev'

    saveTabs(tabsFile, makeTabs(5))
    saveTabs(tabsFile, makeTabs(6))
    saveTabs(tabsFile, makeTabs(7))

    // .prev should contain the 6-tab save (the one just before the 7-tab save)
    const prev = JSON.parse(readFileSync(prevFile, 'utf-8'))
    expect(prev.tabs.length).toBe(6)

    const current = JSON.parse(readFileSync(tabsFile, 'utf-8'))
    expect(current.tabs.length).toBe(7)
  })
})

describe('Layer 2: sanity guard on tab count regression', () => {
  it('allows normal tab count reductions (close one tab at a time)', () => {
    const dir = freshDir()
    const tabsFile = join(dir, 'tabs-api.json')

    // Start with 20 tabs
    saveTabs(tabsFile, makeTabs(20))
    // Close one
    const result = saveTabs(tabsFile, makeTabs(19))
    expect(result.saved).toBe(true)
    expect(JSON.parse(readFileSync(tabsFile, 'utf-8')).tabs.length).toBe(19)
  })

  it('rejects a catastrophic drop from 65 to 4', () => {
    const dir = freshDir()
    const tabsFile = join(dir, 'tabs-api.json')

    saveTabs(tabsFile, makeTabs(65))
    const result = saveTabs(tabsFile, makeTabs(4))

    expect(result.saved).toBe(false)
    expect(result.rejectedPath).toBe(tabsFile + '.rejected')
    // Primary file still has 65 tabs (untouched)
    expect(JSON.parse(readFileSync(tabsFile, 'utf-8')).tabs.length).toBe(65)
    // Rejected file has the 4-tab data for forensics
    expect(JSON.parse(readFileSync(tabsFile + '.rejected', 'utf-8')).tabs.length).toBe(4)
  })

  it('does not activate when on-disk count is below the minimum threshold', () => {
    const dir = freshDir()
    const tabsFile = join(dir, 'tabs-api.json')

    // 5 tabs → 1 tab is a >50% drop but below the threshold (10)
    saveTabs(tabsFile, makeTabs(5))
    const result = saveTabs(tabsFile, makeTabs(1))
    expect(result.saved).toBe(true)
    expect(JSON.parse(readFileSync(tabsFile, 'utf-8')).tabs.length).toBe(1)
  })

  it('allows exactly 50% reduction (boundary)', () => {
    const dir = freshDir()
    const tabsFile = join(dir, 'tabs-api.json')

    saveTabs(tabsFile, makeTabs(20))
    const result = saveTabs(tabsFile, makeTabs(10))
    expect(result.saved).toBe(true)
  })

  it('rejects just below 50% (boundary)', () => {
    const dir = freshDir()
    const tabsFile = join(dir, 'tabs-api.json')

    saveTabs(tabsFile, makeTabs(20))
    const result = saveTabs(tabsFile, makeTabs(9))
    expect(result.saved).toBe(false)
  })
})

describe('Layer 3: startup recovery from .prev file', () => {
  it('uses .prev when primary has few tabs and .prev has more', () => {
    const dir = freshDir()
    const tabsFile = join(dir, 'tabs-api.json')
    const prevFile = tabsFile + '.prev'

    writeFileSync(tabsFile, JSON.stringify(makeTabs(4), null, 2))
    writeFileSync(prevFile, JSON.stringify(makeTabs(65), null, 2))

    const result = loadTabs(tabsFile)
    expect(result.tabs.length).toBe(65)
  })

  it('uses primary when it has enough tabs even if .prev has more', () => {
    const dir = freshDir()
    const tabsFile = join(dir, 'tabs-api.json')
    const prevFile = tabsFile + '.prev'

    writeFileSync(tabsFile, JSON.stringify(makeTabs(50), null, 2))
    writeFileSync(prevFile, JSON.stringify(makeTabs(65), null, 2))

    const result = loadTabs(tabsFile)
    expect(result.tabs.length).toBe(50)
  })

  it('uses primary when no .prev file exists', () => {
    const dir = freshDir()
    const tabsFile = join(dir, 'tabs-api.json')

    writeFileSync(tabsFile, JSON.stringify(makeTabs(4), null, 2))

    const result = loadTabs(tabsFile)
    expect(result.tabs.length).toBe(4)
  })

  it('returns null when neither file exists', () => {
    const dir = freshDir()
    const tabsFile = join(dir, 'tabs-api.json')

    const result = loadTabs(tabsFile)
    expect(result).toBeNull()
  })

  it('uses primary when .prev is corrupt', () => {
    const dir = freshDir()
    const tabsFile = join(dir, 'tabs-api.json')
    const prevFile = tabsFile + '.prev'

    writeFileSync(tabsFile, JSON.stringify(makeTabs(4), null, 2))
    writeFileSync(prevFile, 'NOT VALID JSON')

    const result = loadTabs(tabsFile)
    expect(result.tabs.length).toBe(4)
  })

  it('does not use .prev when .prev has fewer tabs than primary', () => {
    const dir = freshDir()
    const tabsFile = join(dir, 'tabs-api.json')
    const prevFile = tabsFile + '.prev'

    writeFileSync(tabsFile, JSON.stringify(makeTabs(10), null, 2))
    writeFileSync(prevFile, JSON.stringify(makeTabs(3), null, 2))

    const result = loadTabs(tabsFile)
    expect(result.tabs.length).toBe(10)
  })
})

describe('Layers 1+2+3 integration', () => {
  it('end-to-end: catastrophic save is rejected, .prev survives, startup recovers', () => {
    const dir = freshDir()
    const tabsFile = join(dir, 'tabs-api.json')

    // Simulate normal operation: save 65 tabs
    saveTabs(tabsFile, makeTabs(65))
    expect(JSON.parse(readFileSync(tabsFile, 'utf-8')).tabs.length).toBe(65)

    // Simulate crash: renderer tries to save 4 tabs (guard rejects it)
    const crashResult = saveTabs(tabsFile, makeTabs(4))
    expect(crashResult.saved).toBe(false)

    // Primary still has 65 tabs
    expect(JSON.parse(readFileSync(tabsFile, 'utf-8')).tabs.length).toBe(65)

    // On restart, LOAD_TABS returns 65 tabs
    const loaded = loadTabs(tabsFile)
    expect(loaded.tabs.length).toBe(65)
  })

  it('guard + .prev fallback: if guard is bypassed somehow, .prev still saves us', () => {
    const dir = freshDir()
    const tabsFile = join(dir, 'tabs-api.json')
    const prevFile = tabsFile + '.prev'

    // Write 65 tabs directly (simulate the on-disk state)
    writeFileSync(tabsFile, JSON.stringify(makeTabs(65), null, 2))

    // Simulate the guard being bypassed: primary is overwritten with 4 tabs,
    // but .prev still has 65 tabs (from a prior normal save)
    writeFileSync(prevFile, JSON.stringify(makeTabs(65), null, 2))
    writeFileSync(tabsFile, JSON.stringify(makeTabs(4), null, 2))

    // Startup recovery kicks in
    const loaded = loadTabs(tabsFile)
    expect(loaded.tabs.length).toBe(65)
  })
})
