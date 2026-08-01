/**
 * Pins the `providerLabel` + `isCustom` projection onto
 * `desktop_snapshot.availableModels`.
 *
 * iOS never receives `ProviderEntry` — the desktop flattens per-provider data
 * onto each model entry (the same precedent `hasAuth` established). The phone's
 * provider-grouped model picker needs two pieces of that flattened data:
 *
 *   - `providerLabel`: the resolved human-facing provider name, which honors
 *     the operator's `engine.json` `displayName` override before falling back
 *     to the built-in name map and finally the capitalized id. Resolving it on
 *     the desktop keeps that table in exactly one place.
 *   - `isCustom`: drives the `custom` badge the desktop picker already renders.
 *
 * The test exercises the FULL path — `engineBridge.listModels()` →
 * `updateCache()` → `modelCache` → `buildSnapshotEvent()` — rather than
 * asserting on a hand-built cache, because the defect this guards against is a
 * missing field in the `updateCache` projection, not in the snapshot builder
 * (which passes `modelCache.models` through verbatim).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  listModelsMock: vi.fn(),
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

// The cache object is shared by both modules under test: models.ts writes it
// and snapshot-polling.ts reads it, so the mock must hand out one instance.
import { modelCache } from '../state'

vi.mock('../state', () => ({
  state: {
    get mainWindow() {
      return { webContents: { executeJavaScript: vi.fn().mockResolvedValue({}) } }
    },
  },
  sessionPlane: {},
  engineBridge: {
    listModels: (...args: any[]) => mocks.listModelsMock(...args),
    on: vi.fn(),
  },
  activeAssistantMessages: new Map(),
  lastMessagePreview: new Map(),
  lastForwardedTabStatus: new Map(),
  extensionCommandRegistry: new Map(),
  deviceFocusMap: new Map(),
  terminalScrollback: new Map(),
  modelCache: { models: [] as any[], lastFetched: 0 },
  enterprisePolicyCache: { policy: null, newConversationDefaults: null },
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
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

import { refreshModelCache } from '../ipc/models'
import { buildSnapshotEvent } from '../remote/snapshot-polling'

/** Project the engine's list_models result and return the snapshot entries. */
async function projectModels(result: { models: any[]; providers: any[] }): Promise<any[]> {
  mocks.listModelsMock.mockResolvedValue(result)
  await refreshModelCache()
  const { event } = await buildSnapshotEvent()
  return (event.availableModels as any[]) ?? []
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildSnapshotEvent: providerLabel projection', () => {
  beforeEach(() => {
    modelCache.models = []
    mocks.listModelsMock.mockReset()
  })

  it('resolves providerLabel from the built-in provider name map', async () => {
    const models = await projectModels({
      models: [{ id: 'claude-opus-4-6', providerId: 'anthropic', contextWindow: 1000000 }],
      providers: [{ id: 'anthropic', hasAuth: true }],
    })

    expect(models).toHaveLength(1)
    expect(models[0].providerLabel).toBe('Anthropic')
  })

  it("prefers the operator's engine.json displayName over the built-in name", async () => {
    const models = await projectModels({
      models: [{ id: 'claude-opus-4-6', providerId: 'anthropic', contextWindow: 1000000 }],
      providers: [{ id: 'anthropic', hasAuth: true, displayName: 'Acme Gateway' }],
    })

    expect(models[0].providerLabel).toBe('Acme Gateway')
  })

  it('falls back to the capitalized provider id for an unknown provider', async () => {
    const models = await projectModels({
      models: [{ id: 'custom-model', providerId: 'skunkworks', contextWindow: 8000 }],
      providers: [{ id: 'skunkworks', hasAuth: true }],
    })

    expect(models[0].providerLabel).toBe('Skunkworks')
  })

  it('labels every model in a multi-provider list', async () => {
    const models = await projectModels({
      models: [
        { id: 'claude-opus-4-6', providerId: 'anthropic', contextWindow: 1000000 },
        { id: 'gpt-4.1', providerId: 'openai', contextWindow: 1000000 },
        { id: 'grok-3', providerId: 'xai', contextWindow: 131072 },
      ],
      providers: [
        { id: 'anthropic', hasAuth: true },
        { id: 'openai', hasAuth: false },
        { id: 'xai', hasAuth: true },
      ],
    })

    expect(models.map((m) => m.providerLabel)).toEqual(['Anthropic', 'OpenAI', 'xAI'])
    // hasAuth stays flattened per model alongside the new label — the picker
    // dims a whole group from these per-model flags.
    expect(models.map((m) => m.hasAuth)).toEqual([true, false, true])
  })
})

describe('buildSnapshotEvent: isCustom projection', () => {
  beforeEach(() => {
    modelCache.models = []
    mocks.listModelsMock.mockReset()
  })

  it('carries isCustom through for an operator-defined model', async () => {
    const models = await projectModels({
      models: [{ id: 'my-local-llama', providerId: 'ollama', contextWindow: 32000, isCustom: true }],
      providers: [{ id: 'ollama', hasAuth: true }],
    })

    expect(models[0].isCustom).toBe(true)
  })

  it('leaves isCustom undefined for a stock model', async () => {
    const models = await projectModels({
      models: [{ id: 'claude-opus-4-6', providerId: 'anthropic', contextWindow: 1000000 }],
      providers: [{ id: 'anthropic', hasAuth: true }],
    })

    expect(models[0].isCustom).toBeUndefined()
  })
})
