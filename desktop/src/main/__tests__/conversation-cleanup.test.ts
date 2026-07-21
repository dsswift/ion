import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({ app: { getPath: vi.fn() }, ipcMain: { on: vi.fn(), handle: vi.fn() } }))

import { collectProtectedIds, resolveCleanupMode } from '../conversation-cleanup'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-cleanup-test-'))
})

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

function writeJson(name: string, value: unknown): string {
  const path = join(dir, name)
  writeFileSync(path, JSON.stringify(value), 'utf-8')
  return path
}

function writeRaw(name: string, raw: string): string {
  const path = join(dir, name)
  writeFileSync(path, raw, 'utf-8')
  return path
}

describe('collectProtectedIds', () => {
  it('collects every ID source from a populated tabs file', () => {
    const tabsFile = writeJson('tabs-api.json', {
      tabs: [
        {
          conversationId: 'conv-A',
          lastKnownSessionId: 'last-A',
          historicalSessionIds: ['hist-A1', 'hist-A2'],
          engineSessionIds: { rootInstance: 'engsess-A1', child: 'engsess-A2' },
          engineInstances: [
            { id: 'inst1', conversationIds: ['inst-A1', 'inst-A2'] },
            { id: 'inst2', conversationIds: ['inst-A3'] },
          ],
        },
        {
          conversationId: 'conv-B',
        },
      ],
    })

    const result = collectProtectedIds({
      tabsFiles: [tabsFile],
      chainsFiles: [],
      labelsFiles: [],
    })

    const expected = new Set([
      'conv-A', 'last-A',
      'hist-A1', 'hist-A2',
      'engsess-A1', 'engsess-A2',
      'inst-A1', 'inst-A2', 'inst-A3',
      'conv-B',
    ])
    expect(new Set(result.ids)).toEqual(expected)
    expect(result.breakdown.tabs).toHaveLength(1)
    expect(result.breakdown.tabs[0].tabCount).toBe(2)
    expect(result.breakdown.tabs[0].idsContributed).toBe(10)
  })

  it('reads both chain roots and continuations and reverse-map entries', () => {
    const chainsFile = writeJson('session-chains-api.json', {
      chains: {
        'root-1': ['cont-1a', 'cont-1b'],
        'root-2': ['cont-2a'],
      },
      reverse: {
        'cont-1a': 'root-1',
        'cont-1b': 'root-1',
        'cont-2a': 'root-2',
        'orphan-cont': 'orphan-root',
      },
    })

    const result = collectProtectedIds({
      tabsFiles: [],
      chainsFiles: [chainsFile],
      labelsFiles: [],
    })

    const expected = new Set([
      'root-1', 'cont-1a', 'cont-1b',
      'root-2', 'cont-2a',
      'orphan-cont', 'orphan-root',
    ])
    expect(new Set(result.ids)).toEqual(expected)
  })

  it('reads every key from a labels file', () => {
    const labelsFile = writeJson('session-labels-api.json', {
      'labeled-1': 'first label',
      'labeled-2': 'second label',
    })

    const result = collectProtectedIds({
      tabsFiles: [],
      chainsFiles: [],
      labelsFiles: [labelsFile],
    })

    expect(new Set(result.ids)).toEqual(new Set(['labeled-1', 'labeled-2']))
  })

  it('returns empty results without throwing when all files are missing', () => {
    const result = collectProtectedIds({
      tabsFiles: [join(dir, 'never-existed-tabs.json')],
      chainsFiles: [join(dir, 'never-existed-chains.json')],
      labelsFiles: [join(dir, 'never-existed-labels.json')],
    })

    expect(result.ids).toHaveLength(0)
    expect(result.breakdown.filesPresent).toBe(0)
  })

  it('continues collecting from valid files when one source is malformed', () => {
    writeRaw('tabs-api.json', '{this is not valid json')
    const labelsFile = writeJson('session-labels-api.json', { 'good-id': 'still readable' })

    const result = collectProtectedIds({
      tabsFiles: [join(dir, 'tabs-api.json')],
      chainsFiles: [],
      labelsFiles: [labelsFile],
    })

    // tabs file was present but unparseable → contributes 0
    // labels file is fine → contributes 1
    expect(new Set(result.ids)).toEqual(new Set(['good-id']))
    expect(result.breakdown.filesPresent).toBe(2)
    expect(result.breakdown.tabs[0].idsContributed).toBe(0)
    expect(result.breakdown.labels[0].idsContributed).toBe(1)
  })

  it('unions IDs across both api and cli backends', () => {
    const apiTabs = writeJson('tabs-api.json', { tabs: [{ conversationId: 'api-conv' }] })
    const cliTabs = writeJson('tabs-cli.json', { tabs: [{ conversationId: 'cli-conv' }] })

    const result = collectProtectedIds({
      tabsFiles: [apiTabs, cliTabs],
      chainsFiles: [],
      labelsFiles: [],
    })

    expect(new Set(result.ids)).toEqual(new Set(['api-conv', 'cli-conv']))
    expect(result.breakdown.tabs).toHaveLength(2)
  })

  it('reports filesPresent so the caller can distinguish empty-disk from collector-bug', () => {
    // Files exist but contain valid-but-empty content.
    const tabsFile = writeJson('tabs-api.json', { tabs: [] })
    const chainsFile = writeJson('session-chains-api.json', { chains: {}, reverse: {} })
    const labelsFile = writeJson('session-labels-api.json', {})

    const result = collectProtectedIds({
      tabsFiles: [tabsFile],
      chainsFiles: [chainsFile],
      labelsFiles: [labelsFile],
    })

    // The collector must distinguish "files exist, just empty" from
    // "files missing entirely" — the abort-on-zero guard in runCleanup
    // uses filesPresent > 0 to decide whether to bail.
    expect(result.ids).toHaveLength(0)
    expect(result.breakdown.filesPresent).toBe(3)
  })

  it('accepts tabs.json files where the top level is an array', () => {
    // Older tabs files may persist as a raw array rather than { tabs: [...] }.
    const tabsFile = writeJson('tabs-api.json', [{ conversationId: 'legacy-conv' }])

    const result = collectProtectedIds({
      tabsFiles: [tabsFile],
      chainsFiles: [],
      labelsFiles: [],
    })

    expect(result.ids).toEqual(['legacy-conv'])
  })

  it('skips non-string ID fields without crashing', () => {
    const tabsFile = writeJson('tabs-api.json', {
      tabs: [
        {
          conversationId: 123 as any,                  // wrong type
          lastKnownSessionId: null,                    // null
          historicalSessionIds: ['valid', 42 as any],  // mixed
          engineSessionIds: { a: 'ok', b: null },      // mixed values
          engineInstances: [{ conversationIds: ['inst-ok', null as any] }],
        },
        {
          conversationId: 'real-conv',
        },
      ],
    })

    const result = collectProtectedIds({
      tabsFiles: [tabsFile],
      chainsFiles: [],
      labelsFiles: [],
    })

    expect(new Set(result.ids)).toEqual(new Set(['valid', 'ok', 'inst-ok', 'real-conv']))
  })
})

describe('resolveCleanupMode (D-018 retention policy)', () => {
  it('defaults to dry-run with the 14-day window when no retention policy is set', () => {
    expect(resolveCleanupMode(undefined)).toEqual({ dryRun: true, maxAgeDays: 14 })
  })

  it('performs live deletion against the policy TTL when retention is declared', () => {
    expect(resolveCleanupMode(90)).toEqual({ dryRun: false, maxAgeDays: 90 })
  })

  it('floors a fractional TTL', () => {
    expect(resolveCleanupMode(30.9)).toEqual({ dryRun: false, maxAgeDays: 30 })
  })

  it('treats zero as no policy (dry-run)', () => {
    expect(resolveCleanupMode(0)).toEqual({ dryRun: true, maxAgeDays: 14 })
  })

  it('treats a negative TTL as no policy (dry-run)', () => {
    expect(resolveCleanupMode(-5)).toEqual({ dryRun: true, maxAgeDays: 14 })
  })

  it('treats a non-finite TTL as no policy (dry-run)', () => {
    expect(resolveCleanupMode(Number.NaN)).toEqual({ dryRun: true, maxAgeDays: 14 })
    expect(resolveCleanupMode(Number.POSITIVE_INFINITY)).toEqual({ dryRun: true, maxAgeDays: 14 })
  })
})
