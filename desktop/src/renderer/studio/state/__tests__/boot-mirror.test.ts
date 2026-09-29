// @vitest-environment jsdom
/**
 * `bootMirror` runs the same set of mirror syncs on every client, and every
 * one of them is a wire subscription.
 *
 * Regression pin for the defect behind "the terminal panel below the
 * composer does not open". Five sync bridges were once gated on a
 * `windowMirrorSync` capability a browser client did not have, on the
 * reasoning that a browser tab has no sibling window to mirror. What is
 * mirrored is the SERVER's store, so `toggleTerminal` forwarded to the
 * server, the server flipped `terminalOpenTabIds`, and the bridge that
 * would have told the client never ran.
 *
 * The Electron-only IPC pull that once ran beside the wire hydrators for
 * the LOCAL Environment is gone with the capability: both clients hydrate
 * from `studio_welcome.snapshot` and the per-principal sync channels.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const calls = vi.hoisted(() => ({ names: [] as string[] }))
const capabilities = vi.hoisted(() => ({ value: [] as string[] }))

function record(name: string) {
  return vi.fn(() => { calls.names.push(name) })
}

vi.mock('../../../host/host-instance', () => ({
  host: { capabilities: () => capabilities.value },
}))
vi.mock('../secondary-store', () => ({
  applyMirrorOverrides: vi.fn(() => []),
  initTabsSyncFromWire: record('initTabsSyncFromWire'),
  initPermissionResolutionSync: record('initPermissionResolutionSync'),
  initUserMessageEcho: record('initUserMessageEcho'),
  initHistoryReplace: record('initHistoryReplace'),
}))
vi.mock('../secondary-store-wire-sync', () => ({
  initConversationTerminalSyncFromWire: record('initConversationTerminalSyncFromWire'),
  initWorktreeSyncFromWire: record('initWorktreeSyncFromWire'),
}))
vi.mock('../body-sync', () => ({ initBodySyncFromWire: record('initBodySyncFromWire') }))
vi.mock('../environment-settings-store', () => ({ initEnvironmentSettingsFromWire: record('initEnvironmentSettingsFromWire') }))
// Registers a reader over the client's own preference store; the store itself is not under test.
vi.mock('@ion/server/store/client-preferences', () => ({ registerClientPreferences: vi.fn() }))
vi.mock('../../../preferences', () => ({ usePreferencesStore: { getState: () => ({}) } }))
vi.mock('../declare-preferences', () => ({ initPreferenceDeclaration: record('initPreferenceDeclaration') }))
vi.mock('../../../stores/presence-store', () => ({
  initPresenceSync: record('initPresenceSync'),
  initPresenceFocusReporter: record('initPresenceFocusReporter'),
}))
vi.mock('../../../host/auth-url-open', () => ({ initAuthUrlOpen: record('initAuthUrlOpen') }))
vi.mock('../../dispatch-split-state', () => ({ initDispatchSplitConversationGuard: vi.fn() }))
vi.mock('../../../rendererLogger', () => ({ rInfo: vi.fn() }))

/** `bootMirror` is idempotent by module-level flag, so each case needs a fresh module. */
async function bootWith(caps: string[]): Promise<string[]> {
  calls.names = []
  capabilities.value = caps
  vi.resetModules()
  const { bootMirror } = await import('../boot-mirror')
  bootMirror()
  return calls.names
}

beforeEach(() => { calls.names = [] })

/** Every bridge, identical on both clients. */
const ALWAYS = [
  'initTabsSyncFromWire',
  'initConversationTerminalSyncFromWire',
  'initWorktreeSyncFromWire',
  'initBodySyncFromWire',
  'initEnvironmentSettingsFromWire',
  'initPreferenceDeclaration',
  'initPermissionResolutionSync',
  'initUserMessageEcho',
  'initHistoryReplace',
  'initPresenceSync',
  'initPresenceFocusReporter',
  'initAuthUrlOpen',
]

/** The Electron-only pull variants, which no longer exist. */
const DELETED_PULLS = ['initTabsSync', 'initConversationTerminalSync', 'initWorktreeSync']

describe('bootMirror', () => {
  it('runs every mirror sync for a browser client', async () => {
    const ran = await bootWith([])
    for (const name of ALWAYS) expect(ran, `${name} must run in a browser client`).toContain(name)
    for (const name of DELETED_PULLS) expect(ran).not.toContain(name)
  })

  it('runs the identical set for an Electron window', async () => {
    const electron = await bootWith(['nativeShell'])
    const browser = await bootWith([])
    expect(electron).toEqual(browser)
  })
})
