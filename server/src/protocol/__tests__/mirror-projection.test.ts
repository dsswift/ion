/**
 * mirror-projection — the per-connection payload cut-down for the three
 * `'per-principal'` mirror-sync channels (A1). Each was broadcast unfiltered
 * before this fix: `studio:tabs-sync` sent every principal's tab titles,
 * working directories, conversation ids, live statuses, and staged
 * attachment content to every connection.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { projectForConnection } from '../mirror-projection'
import { _resetPrincipalIndexForTest } from '../tabs-index'
import { currentServerConfig, setCurrentServerConfig, _resetCurrentServerConfigForTest } from '../../config/current'
import type { Connection } from '../connection'
import type { StudioWorktreeSnapshot } from '@ion/shared/types-studio'
import type { StudioConversationTerminalPublish } from '@ion/shared/studio-conversation-terminal-sync'

let dataDir: string
let originalIonDataDir: string | undefined

beforeEach(() => {
  originalIonDataDir = process.env.ION_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'ion-mirror-projection-'))
  process.env.ION_DATA_DIR = dataDir
  writeFileSync(
    join(dataDir, 'tabs.json'),
    JSON.stringify({
      tabs: [
        { id: 'tab-alice', conversationId: 'conv-alice', principalSubject: 'local:alice' },
        { id: 'tab-bob', conversationId: 'conv-bob', principalSubject: 'local:bob' },
        { id: 'tab-legacy', conversationId: 'conv-legacy' },
      ],
    }),
  )
})

afterEach(() => {
  _resetPrincipalIndexForTest()
  _resetCurrentServerConfigForTest()
  if (originalIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalIonDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

function connFor(subject: string | null, scopes: Connection['scopes'] = ['conversations:read', 'conversations:operate']): Connection {
  return {
    principal: subject === null ? null : { subject, displayName: subject },
    scopes,
  } as unknown as Connection
}

describe('studio:tabs-sync projection', () => {
  const basePayload = {
    schemaVersion: 4,
    activeSessionId: null,
    activeTabIndex: 1, // points at tab-bob
    tabs: [
      { id: 'tab-alice', conversationId: 'conv-alice', title: 'Alice', customTitle: null, workingDirectory: '/a', hasChosenDirectory: true, additionalDirs: [] },
      { id: 'tab-bob', conversationId: 'conv-bob', title: 'Bob', customTitle: null, workingDirectory: '/b', hasChosenDirectory: true, additionalDirs: [] },
    ],
    settledHistory: [
      { id: 'tab-alice-old', conversationId: 'conv-alice-old', title: 'Alice old', customTitle: null, workingDirectory: '/a', hasChosenDirectory: true, additionalDirs: [] },
    ],
    revision: 42,
    liveTabStatus: { 'tab-alice': 'idle', 'tab-bob': 'running' },
    liveIsCompacting: { 'tab-alice': false, 'tab-bob': true },
    queuedAttachments: { 'tab-alice': [], 'tab-bob': [{ id: 'att-1' }] },
  }

  beforeEach(() => {
    writeFileSync(
      join(dataDir, 'tabs.json'),
      JSON.stringify({
        tabs: [
          { id: 'tab-alice', conversationId: 'conv-alice', principalSubject: 'local:alice' },
          { id: 'tab-bob', conversationId: 'conv-bob', principalSubject: 'local:bob' },
        ],
        settledHistory: [{ id: 'tab-alice-old', conversationId: 'conv-alice-old', principalSubject: 'local:alice' }],
      }),
    )
  })

  it('keeps only the connecting principal\'s own tabs, settled history, and per-tab maps', () => {
    const conn = connFor('local:alice')
    const result = projectForConnection('studio:tabs-sync', basePayload, conn) as typeof basePayload

    expect(result.tabs.map((t) => t.id)).toEqual(['tab-alice'])
    expect(result.settledHistory?.map((t) => t.id)).toEqual(['tab-alice-old'])
    expect(Object.keys(result.liveTabStatus)).toEqual(['tab-alice'])
    expect(Object.keys(result.liveIsCompacting)).toEqual(['tab-alice'])
    expect(Object.keys(result.queuedAttachments)).toEqual(['tab-alice'])
    // Bob's staged attachment content never reaches Alice's connection.
    expect(result.queuedAttachments['tab-bob']).toBeUndefined()
  })

  it('with sign-in configured, a settled conversation reaches its owner and nobody else', () => {
    setCurrentServerConfig({
      ...currentServerConfig(),
      oidc: { issuer: 'https://issuer.example.org', audience: 'ion-server', scope: 'api://ion-server/.default', clientId: 'browser-client', rolesToScopes: {}, defaultScopes: [], allowedSubjects: [], clientSecret: '' },
    })

    const mine = projectForConnection('studio:tabs-sync', basePayload, connFor('local:alice')) as typeof basePayload
    const theirs = projectForConnection('studio:tabs-sync', basePayload, connFor('local:bob')) as typeof basePayload

    expect(mine.settledHistory?.map((t) => t.id)).toEqual(['tab-alice-old'])
    expect(theirs.settledHistory).toEqual([])
  })

  it('nulls activeTabIndex when the active tab was filtered away', () => {
    const conn = connFor('local:alice') // activeTabIndex 1 points at tab-bob, which Alice does not own
    const result = projectForConnection('studio:tabs-sync', basePayload, conn) as typeof basePayload
    expect(result.activeTabIndex).toBeNull()
  })

  it('re-points activeTabIndex at the filtered array when the active tab survives', () => {
    const conn = connFor('local:bob')
    const result = projectForConnection('studio:tabs-sync', basePayload, conn) as typeof basePayload
    expect(result.tabs.map((t) => t.id)).toEqual(['tab-bob'])
    expect(result.activeTabIndex).toBe(0)
  })

  it('a local/paired connection (no principal) gets the payload unfiltered', () => {
    const conn = connFor(null)
    const result = projectForConnection('studio:tabs-sync', basePayload, conn)
    expect(result).toBe(basePayload)
  })

  it('FR-02: shared tenancy passes every tab through unfiltered, even to a connected principal', () => {
    setCurrentServerConfig({ ...currentServerConfig(), tenancy: { mode: 'shared' } })
    const conn = connFor('local:alice')
    const result = projectForConnection('studio:tabs-sync', basePayload, conn) as typeof basePayload
    expect(result.tabs.map((t) => t.id)).toEqual(['tab-alice', 'tab-bob'])
    expect(result.activeTabIndex).toBe(1)
  })
})

describe('studio:conversation-terminals projection', () => {
  it('keeps only panes/openTabIds the connecting principal owns', () => {
    const payload: StudioConversationTerminalPublish = {
      panes: [
        { tabId: 'tab-alice', instances: [], activeInstanceId: null },
        { tabId: 'tab-bob', instances: [], activeInstanceId: null },
      ],
      openTabIds: ['tab-alice', 'tab-bob'],
    }
    const result = projectForConnection('studio:conversation-terminals', payload, connFor('local:alice')) as StudioConversationTerminalPublish
    expect(result.panes.map((p) => p.tabId)).toEqual(['tab-alice'])
    expect(result.openTabIds).toEqual(['tab-alice'])
  })

  it('a local/paired connection gets every pane', () => {
    const payload: StudioConversationTerminalPublish = {
      panes: [{ tabId: 'tab-alice', instances: [], activeInstanceId: null }],
      openTabIds: ['tab-alice'],
    }
    const result = projectForConnection('studio:conversation-terminals', payload, connFor(null))
    expect(result).toBe(payload)
  })
})

describe('studio:worktree-sync projection', () => {
  const payload: StudioWorktreeSnapshot = {
    revision: 7,
    ready: true,
    inventory: { '/repo': [] },
    workspaces: { '/bench': [] },
    benchSourceTips: [],
    benchRetired: [],
    gitConflictAlerts: [],
    worktreePipeline: null,
    workspaceOperationLedger: [],
  }

  it('collapses to an empty-but-valid snapshot for a connection without git:write', () => {
    const conn = connFor('local:alice', ['conversations:operate'])
    const result = projectForConnection('studio:worktree-sync', payload, conn) as StudioWorktreeSnapshot
    expect(result.inventory).toEqual({})
    expect(result.workspaces).toEqual({})
    expect(result.ready).toBe(true) // shape survives, only content is stripped
    expect(result.revision).toBe(7)
  })

  it('passes through unfiltered for a connection with git:write', () => {
    const conn = connFor('local:alice', ['conversations:operate', 'git:write'])
    const result = projectForConnection('studio:worktree-sync', payload, conn)
    expect(result).toBe(payload)
  })

  it('passes through unfiltered for admin', () => {
    const conn = connFor('local:alice', ['admin'])
    const result = projectForConnection('studio:worktree-sync', payload, conn)
    expect(result).toBe(payload)
  })

  it('a local/paired connection gets the real inventory', () => {
    const conn = connFor(null, [])
    const result = projectForConnection('studio:worktree-sync', payload, conn)
    expect(result).toBe(payload)
  })
})

describe('projectForConnection — non-per-principal channel passthrough', () => {
  it('returns the payload unchanged for a channel this module does not project', () => {
    const conn = connFor('local:alice')
    const payload = { theme: 'dark' }
    expect(projectForConnection('ion:settings-changed', payload, conn)).toBe(payload)
  })
})
