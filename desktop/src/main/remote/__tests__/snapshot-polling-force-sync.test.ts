/**
 * Explicit-sync path — single snapshot with force semantics (B6-2 / B7).
 *
 * The former forceSyncSnapshot (snapshot-polling.ts) is retired: handleSync
 * used to call BOTH forceSyncSnapshot (snapshot #1) AND sendSync (snapshot #2)
 * — two full snapshot builds + sends per sync, multiplied by the iOS retry
 * loop (up to 5 attempts). sendSync (tabs-sync.ts) is now the single snapshot
 * sender with force semantics: it always sends regardless of the poll gate's
 * hash state, and afterwards updates ONLY the recipient devices' per-device
 * hash entries (noteSnapshotSentToDevices) so the next poll tick neither
 * double-sends to the synced device nor suppresses the send to other devices.
 *
 * Coverage:
 *   1. sendSync sends the snapshot on first call.
 *   2. sendSync sends again on an identical second call (force semantics —
 *      the hash gate never suppresses an explicit sync).
 *   3. Per-device hash update: after sendSync to device A, a poll tick with
 *      devices A+B and unchanged state sends to B only (B7). Red on the old
 *      global-hash code: the forced sync updated the single shared hash and
 *      the poll then skipped BOTH devices.
 *   4. handleSync sends exactly ONE desktop_snapshot (B6-2). Red on the old
 *      code: forceSyncSnapshot + sendSync produced two.
 *   5. Snapshot payload carries tabs and settings fields.
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
const { mockSend, mockSendToDevice, mockGetConnectedDeviceIds, mockGetRemoteTabStates, mockReadSettings } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockSendToDevice: vi.fn(),
  mockGetConnectedDeviceIds: vi.fn(),
  mockGetRemoteTabStates: vi.fn(),
  mockReadSettings: vi.fn(),
}))

vi.mock('../../state', () => ({
  state: {
    remoteTransport: {
      state: 'connected',
      send: mockSend,
      sendToDevice: mockSendToDevice,
      getConnectedDeviceIds: mockGetConnectedDeviceIds,
    },
    tabSnapshotInterval: null,
    mainWindow: null,
  },
  modelCache: { models: [] },
  engineBridge: null,
  sessionPlane: {},
  activeAssistantMessages: new Map(),
  lastMessagePreview: new Map(),
  lastForwardedTabStatus: new Map(),
  extensionCommandRegistry: new Map(),
  terminalScrollback: new Map(),
}))

vi.mock('../../settings-store', () => ({
  readSettings: (...args: unknown[]) => mockReadSettings(...args),
  readClaudeCompat: vi.fn(() => false),
  TABS_FILE: '/tmp/ion-force-sync-test/tabs.json',
}))

vi.mock('../snapshot', () => ({
  getRemoteTabStates: (...args: unknown[]) => mockGetRemoteTabStates(...args),
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
  projectCurrentSettings: vi.fn(() => ({})),
  projectableSchema: vi.fn(() => []),
  projectableGroups: vi.fn(() => []),
}))

vi.mock('../../engine-bridge-fs', () => ({
  getEnterprisePolicyNewConversationDefaults: vi.fn(async () => null),
}))

vi.mock('../handlers/display', () => ({
  readRemoteDisplay: vi.fn(() => null),
}))

// handleSync deps beyond tabs-sync
vi.mock('../handlers/diagnostics', () => ({ autoPullDiagnosticLogs: vi.fn() }))
vi.mock('../../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../../terminal-manager-instance', () => ({ terminalManager: {} }))
vi.mock('../../ipc-validation', () => ({ resolveDiscoveryWorkingDir: vi.fn() }))
vi.mock('../handlers/tabs-prompt', () => ({ handlePrompt: vi.fn(), handleCancel: vi.fn() }))
vi.mock('../handlers/tabs-session-chain', () => ({
  resolveTabSessionChain: vi.fn(),
  paginateHistory: vi.fn(),
  planPathFromHistory: vi.fn(),
  toRemoteMessage: vi.fn(),
}))
vi.mock('../../../shared/session-message-mapper', () => ({ mapSessionHistory: vi.fn() }))
vi.mock('../handlers/load-conversation-gate', () => ({ shouldServeLoad: vi.fn() }))
vi.mock('../client-msg-id-map', () => ({ lookupClientMsgId: vi.fn(), clearClientMsgIdsForTab: vi.fn() }))
vi.mock('../../prompt-pipeline', () => ({ processIncomingPrompt: vi.fn() }))

import { sendSync } from '../handlers/tabs-sync'
import { handleSync } from '../handlers/tabs'
import { resetSnapshotHash, pollSnapshotOnce } from '../snapshot-polling'

// ── Helpers ──────────────────────────────────────────────────────────────────

const FIXED_TABS = [{ id: 't1', title: 'Tab', workingDirectory: '/tmp', status: 'idle' }]
const FIXED_SETTINGS = {
  recentBaseDirectories: ['/tmp'],
  tabGroupMode: 'off',
  tabGroups: [],
  preferredModel: 'claude-sonnet-4-20250514',
}

function snapshotEvents(calls: any[][], eventIndex: number): any[] {
  return calls.map((c) => c[eventIndex]).filter((e) => e?.type === 'desktop_snapshot')
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('sendSync — single snapshot sender with force semantics', () => {
  const collected: any[] = []
  const collector = (event: any) => collected.push(event)

  beforeEach(() => {
    resetSnapshotHash()
    collected.length = 0
    mockSend.mockClear()
    mockSendToDevice.mockClear()
    mockGetConnectedDeviceIds.mockReturnValue([])
    mockGetRemoteTabStates.mockResolvedValue({ tabs: FIXED_TABS, resourceManifest: {} })
    mockReadSettings.mockReturnValue(FIXED_SETTINGS)
  })

  it('sends the snapshot on first call', async () => {
    await sendSync(collector, ['device-A'])
    const snaps = collected.filter((e) => e.type === 'desktop_snapshot')
    expect(snaps).toHaveLength(1)
    expect(snaps[0].tabs).toHaveLength(1)
  })

  it('sends the snapshot even when state is unchanged (force semantics)', async () => {
    await sendSync(collector, ['device-A'])
    collected.length = 0
    // Second call with identical data — MUST still send (no hash gate here).
    await sendSync(collector, ['device-A'])
    expect(collected.filter((e) => e.type === 'desktop_snapshot')).toHaveLength(1)
  })

  it('updates ONLY the recipient device hash: next poll sends to the other device, not the synced one (B7)', async () => {
    // Forced sync to device A only.
    await sendSync(collector, ['device-A'])

    // Poll tick with A and B connected, state unchanged since the sync.
    mockGetConnectedDeviceIds.mockReturnValue(['device-A', 'device-B'])
    await pollSnapshotOnce()

    const toA = snapshotEvents(mockSendToDevice.mock.calls.filter((c) => c[0] === 'device-A'), 1)
    const toB = snapshotEvents(mockSendToDevice.mock.calls.filter((c) => c[0] === 'device-B'), 1)
    expect(toB).toHaveLength(1) // B never got the forced sync — must receive
    expect(toA).toHaveLength(0) // A just got it via sendSync — must NOT re-receive
  })

  it('includes tabs and settings fields in the sent event', async () => {
    await sendSync(collector, [])
    const snap = collected.find((e) => e.type === 'desktop_snapshot')
    expect(snap.tabs).toEqual(FIXED_TABS)
    expect(snap.recentDirectories).toEqual(['/tmp'])
    expect(snap.tabGroupMode).toBe('off')
    expect(snap.preferredModel).toBe('claude-sonnet-4-20250514')
  })
})

describe('handleSync — exactly one snapshot per sync (B6-2)', () => {
  beforeEach(() => {
    resetSnapshotHash()
    mockSend.mockClear()
    mockSendToDevice.mockClear()
    mockGetConnectedDeviceIds.mockReturnValue(['device-A'])
    mockGetRemoteTabStates.mockResolvedValue({ tabs: FIXED_TABS, resourceManifest: {} })
    mockReadSettings.mockReturnValue(FIXED_SETTINGS)
  })

  it('sends exactly ONE desktop_snapshot to the requesting device', async () => {
    await handleSync('device-A')
    const snaps = snapshotEvents(mockSendToDevice.mock.calls.filter((c) => c[0] === 'device-A'), 1)
    expect(snaps).toHaveLength(1)
  })

  it('still sends the rest of the sync envelope (engine profiles, settings snapshot)', async () => {
    await handleSync('device-A')
    const types = mockSendToDevice.mock.calls.filter((c) => c[0] === 'device-A').map((c) => c[1]?.type)
    expect(types).toContain('desktop_engine_profiles')
    expect(types).toContain('desktop_settings_snapshot')
  })
})
