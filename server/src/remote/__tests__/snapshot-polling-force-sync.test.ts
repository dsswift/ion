/**
 * Explicit-sync path — one snapshot, with force semantics.
 *
 * sendSync (tabs-sync.ts) is the single snapshot sender: it always sends
 * regardless of any gate's hash state, because an explicit sync means the
 * client may have missed deltas and is asking for a full refresh —
 * suppressing it is the "missed a delta, never re-sent" freeze. Priming the
 * gate so the next tick does not double-send belongs to the sender, and is
 * covered by thin-sync.test.ts ("a first paint primes the gate").
 *
 * Coverage:
 *   1. sendSync sends the snapshot on first call.
 *   2. sendSync sends again on an identical second call (force semantics —
 *      no hash gate ever suppresses an explicit sync).
 *   3. Snapshot payload carries tabs, settings, recent directories (with
 *      ephemeral workspaces excluded), worktree state and settled history.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Electron is not installed in CI (npm ci --ignore-scripts skips the binary
// download). Any module in the transitive import chain that does
// `import ... from 'electron'` at the top level will throw at load time
// without this stub. This test runs headless main-process logic only.
vi.mock('electron', () => ({
  app: { get isPackaged() { return false } },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  ipcMain: { on: vi.fn(), handle: vi.fn(), removeHandler: vi.fn() },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
  nativeImage: { createFromPath: vi.fn(), createFromBuffer: vi.fn() },
  shell: { openExternal: vi.fn() },
}))

// ── Module-level mocks (hoisted so vi.mock sees them) ──────────────────────
const { mockGetRemoteTabStates, mockReadSettings } = vi.hoisted(() => ({
  mockGetRemoteTabStates: vi.fn(),
  mockReadSettings: vi.fn((..._a: any[]) => ({})),
}))

vi.mock('../../state', () => ({
  state: {
    tabSnapshotInterval: null,
    mainWindow: null,
    remoteWorktreeStates: new Map(),
  },
  modelCache: { models: [] },
  engineBridge: null,
  sessionPlane: {},
  activeAssistantMessages: new Map(),
  lastMessagePreview: new Map(),
  lastForwardedTabStatus: new Map(),
  extensionCommandRegistry: new Map(),
  terminalScrollback: new Map(),
  enterprisePolicyCache: { policy: null, newConversationDefaults: null },
}))

// tabs-sync reads the enterprise theme policy synchronously; the state mock
// above carries a null policy so this resolves to null (unmanaged).
vi.mock('../../theme-policy', () => ({
  getEnterpriseThemePolicy: vi.fn((..._a: any[]) => null),
}))

vi.mock('../../persistence/settings-store', () => ({
  settingsDir: () => '/tmp/ion-snapshot-polling-force-test',
  onStreamThinkingToRemoteChange: vi.fn(() => () => {}),
  readSettings: (...args: any[]) => mockReadSettings(...args),
  readClaudeCompat: vi.fn((..._a: any[]) => false),
  tabsFile: () => '/tmp/ion-force-sync-test/tabs.json',
}))

vi.mock('../snapshot', () => ({
  getRemoteTabStates: (...args: any[]) => mockGetRemoteTabStates(...args),
}))

vi.mock('../git-watcher-bridge', () => ({
  reconcileGitWatchedDirectories: vi.fn(),
}))

vi.mock('../../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../../projectable-settings', () => ({
  projectCurrentSettings: vi.fn((..._a: any[]) => ({})),
  projectableSchema: vi.fn((..._a: any[]) => []),
  projectableGroups: vi.fn((..._a: any[]) => []),
  projectablePages: vi.fn((..._a: any[]) => []),
}))

vi.mock('../../engine-bridge-fs', () => ({
  getEnterprisePolicyNewConversationDefaults: vi.fn(async (..._a: any[]) => null),
}))

vi.mock('../handlers/display', () => ({
  readRemoteDisplay: vi.fn((..._a: any[]) => null),
}))

// Theme-pack sync: mock the loader so the test never scans the developer's
// real ~/.ion/themes (nondeterministic) and the manifest payload is pinned.
const { mockBuildThemeManifest, mockRescanThemePacks } = vi.hoisted(() => ({
  mockBuildThemeManifest: vi.fn((..._a: any[]) => ({ themes: [{ id: 'acme-corp', name: 'Acme', version: '1.0.0', tokens: { accent: '#FF6600FF' } }], hash: 'fixed-hash' })),
  mockRescanThemePacks: vi.fn((..._a: any[]) => false),
}))
vi.mock('../../theme-packs', () => ({
  buildThemeManifest: () => mockBuildThemeManifest(),
  rescanThemePacks: () => mockRescanThemePacks(),
}))

vi.mock('../../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../../terminal-manager-instance', () => ({ terminalManager: {} }))
vi.mock('../../ipc-validation', () => ({ resolveDiscoveryWorkingDir: vi.fn() }))
vi.mock('../handlers/tabs-prompt', () => ({ handlePrompt: vi.fn(), handleCancel: vi.fn() }))
vi.mock('../handlers/tabs-session-chain', () => ({
  resolveTabSessionChain: vi.fn(),
  paginateHistory: vi.fn(),
}))
vi.mock('@ion/shared/session-message-mapper', () => ({ mapSessionHistory: vi.fn() }))
vi.mock('../../prompt-pipeline', () => ({ processIncomingPrompt: vi.fn() }))

import { state } from '../../state'
import { sendSync } from '../handlers/tabs-sync'
import { resetSnapshotHash } from '../snapshot-polling'

// ── Helpers ──────────────────────────────────────────────────────────────────

const FIXED_TABS = [{ id: 't1', title: 'Tab', workingDirectory: '/tmp', status: 'idle' }]
const FIXED_SETTINGS = {
  recentBaseDirectories: ['/tmp'],
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('sendSync — single snapshot sender with force semantics', () => {
  const collected: any[] = []
  const collector = (event: any) => collected.push(event)

  beforeEach(() => {
    resetSnapshotHash()
    collected.length = 0
    mockGetRemoteTabStates.mockResolvedValue({ tabs: FIXED_TABS, resourceManifest: {} })
    mockReadSettings.mockReturnValue(FIXED_SETTINGS)
  })

  it('sends the snapshot on first call', async () => {
    await sendSync(collector)
    const snaps = collected.filter((e) => e.type === 'desktop_snapshot')
    expect(snaps).toHaveLength(1)
    expect(snaps[0].tabs).toHaveLength(1)
  })

  it('sends the snapshot even when state is unchanged (force semantics)', async () => {
    await sendSync(collector)
    collected.length = 0
    // Second call with identical data — MUST still send (no hash gate here).
    await sendSync(collector)
    expect(collected.filter((e) => e.type === 'desktop_snapshot')).toHaveLength(1)
  })

  it('excludes ephemeral workspaces from recent directory projection', async () => {
    mockReadSettings.mockReturnValue({
      ...FIXED_SETTINGS,
      recentBaseDirectories: [
        '/tmp',
        '/Users/example/.ion/worktrees/project-a3f1',
        '/Users/example/.ion/integration/project-main',
      ],
    })

    await sendSync(collector)

    const snap = collected.find((event) => event.type === 'desktop_snapshot')
    expect(snap.recentDirectories).toEqual(['/tmp'])
  })

  it('includes main-owned worktree state and settled history in the snapshot', async () => {
    state.remoteWorktreeStates.set('/repo', { repoPath: '/repo', worktrees: [], benches: [] })
    await sendSync(collector)
    const snap = collected.find((event) => event.type === 'desktop_snapshot')
    expect(snap.worktreeStates).toEqual([{ repoPath: '/repo', worktrees: [], benches: [] }])
    expect(snap.settledTabs).toEqual([])
    state.remoteWorktreeStates.clear()
  })

  it('includes tabs and settings fields in the sent event', async () => {
    await sendSync(collector)
    const snap = collected.find((e) => e.type === 'desktop_snapshot')
    expect(snap.tabs).toEqual(FIXED_TABS)
    expect(snap.recentDirectories).toEqual(['/tmp'])
  })
})
