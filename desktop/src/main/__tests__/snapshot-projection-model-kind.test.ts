/**
 * Pins that `modelKind` flows through the `modelCache → desktop_snapshot.availableModels`
 * projection path without being dropped.
 *
 * Regression test for the gap found in /align review: `modelKind` was added to
 * `ModelEntry` (Go/TS/contracts.json) and to `modelCache.models`, and
 * `buildSnapshotEvent` passes `modelCache.models` verbatim as `availableModels`,
 * but the `desktop_snapshot` wire-type declaration did not include `modelKind?`
 * and neither did `RemoteModelEntry.swift` — so the field flowed over the wire
 * silently without any type contract.
 *
 * This test ensures the field is present in the projection output whenever
 * `modelCache.models` carries it, pinning the full `modelCache → snapshot` path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  getRemoteTabStatesMock: vi.fn().mockResolvedValue({ tabs: [], resourceManifest: {} }),
  readSettingsMock: vi.fn().mockReturnValue({
    recentBaseDirectories: [],
    tabGroupMode: 'off',
    tabGroups: [],
    preferredModel: undefined,
    engineDefaultModel: undefined,
  }),
}))

// ─── Module mocks ─────────────────────────────────────────────────────────────

// modelCache is mutated per-test below to inject modelKind entries.
import { modelCache } from '../state'

vi.mock('../state', () => ({
  state: {
    get mainWindow() {
      return { webContents: { executeJavaScript: vi.fn().mockResolvedValue({}) } }
    },
  },
  sessionPlane: {},
  engineBridge: {},
  activeAssistantMessages: new Map(),
  lastMessagePreview: new Map(),
  lastForwardedTabStatus: new Map(),
  extensionCommandRegistry: new Map(),
  deviceFocusMap: new Map(),
  terminalScrollback: new Map(),
  modelCache: { models: [] as any[] },
  enterprisePolicyCache: { policy: null },
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../remote/snapshot', () => ({
  getRemoteTabStates: (...args: any[]) => mocks.getRemoteTabStatesMock(...args),
}))

vi.mock('../settings-store', () => ({
  readSettings: (...args: any[]) => mocks.readSettingsMock(...args),
}))

vi.mock('../remote/git-watcher-bridge', () => ({
  reconcileGitWatchedDirectories: vi.fn(),
}))

// ─── SUT ─────────────────────────────────────────────────────────────────────

import { buildSnapshotEvent } from '../remote/snapshot-polling'

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildSnapshotEvent: modelKind projection', () => {
  beforeEach(() => {
    modelCache.models = []
  })

  it('includes modelKind when a model entry carries it', async () => {
    modelCache.models = [
      {
        id: 'dall-e-3',
        providerId: 'openai',
        label: 'DALL-E 3',
        contextWindow: 0,
        hasAuth: false,
        modelKind: 'image',
      },
    ] as any[]

    const { event } = await buildSnapshotEvent()
    const models = event.availableModels as any[] | undefined
    expect(models).toBeDefined()
    expect(models).toHaveLength(1)
    expect(models![0].modelKind).toBe('image')
  })

  it('omits modelKind for standard chat models that carry no modelKind field', async () => {
    modelCache.models = [
      {
        id: 'claude-opus-4-6',
        providerId: 'anthropic',
        label: 'Opus 4.6',
        contextWindow: 1000000,
        hasAuth: true,
      },
    ] as any[]

    const { event } = await buildSnapshotEvent()
    const models = event.availableModels as any[] | undefined
    expect(models).toBeDefined()
    expect(models![0].modelKind).toBeUndefined()
  })

  it('passes through modelKind for all models in a mixed list', async () => {
    modelCache.models = [
      {
        id: 'claude-opus-4-6',
        providerId: 'anthropic',
        label: 'Opus 4.6',
        contextWindow: 1000000,
        hasAuth: true,
      },
      {
        id: 'dall-e-3',
        providerId: 'openai',
        label: 'DALL-E 3',
        contextWindow: 0,
        hasAuth: true,
        modelKind: 'image',
      },
      {
        id: 'gpt-image-1',
        providerId: 'openai',
        label: 'GPT Image 1',
        contextWindow: 0,
        hasAuth: true,
        modelKind: 'image',
      },
    ] as any[]

    const { event } = await buildSnapshotEvent()
    const models = event.availableModels as any[] | undefined
    expect(models).toBeDefined()
    expect(models).toHaveLength(3)
    expect(models![0].modelKind).toBeUndefined() // chat model
    expect(models![1].modelKind).toBe('image')
    expect(models![2].modelKind).toBe('image')
  })

  it('sets availableModels to undefined when modelCache is empty', async () => {
    modelCache.models = []
    const { event } = await buildSnapshotEvent()
    expect(event.availableModels).toBeUndefined()
  })
})
