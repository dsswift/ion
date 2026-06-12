import type { BrowserWindow, Tray } from 'electron'
import type { ChildProcess } from 'child_process'
import type { watch } from 'fs'
import type { RemoteTransport } from './remote/transport'
import { EngineBridge } from './engine-bridge'
import { EngineControlPlane } from './engine-control-plane'
import { wireEarlyStopPolicy } from './early-stop-policy'
import { PairingManager } from './remote/pairing'
import { RelayDiscovery } from './remote/discovery'

export const DEBUG_MODE = process.env.Ion_DEBUG === '1'
export const SPACES_DEBUG = DEBUG_MODE || process.env.Ion_SPACES_DEBUG === '1'

export interface FileWatcherEntry {
  watcher: ReturnType<typeof watch>
  refCount: number
  debounceTimer: ReturnType<typeof setTimeout> | null
}

export const engineBridge = new EngineBridge()
export const sessionPlane = new EngineControlPlane(engineBridge)

// Wire the reference policy for the engine's wire-protocol early-stop
// continuation hook. The desktop is one specific consumer of this hook;
// any harness engineer can implement their own policy in a similar way
// by subscribing to engine_early_stop_decision_request on their socket
// connection. See desktop/src/main/early-stop-policy.ts for the
// architectural rationale.
wireEarlyStopPolicy(sessionPlane as unknown as Parameters<typeof wireEarlyStopPolicy>[0], engineBridge)
export const pairingManager = new PairingManager()
export const relayDiscovery = new RelayDiscovery()

export const bashProcesses = new Map<string, ChildProcess>()
export const fileWatchers = new Map<string, FileWatcherEntry>()
export const recentlyWrittenPaths = new Set<string>()
export const activeAssistantMessages = new Map<string, { id: string; content: string }>()
export const activeToolInputs = new Map<string, Map<string, string>>() // tabId -> (toolId -> accumulated input)
export const lastMessagePreview = new Map<string, string>()
export const terminalOutputAccumulator = new Map<string, string>()

/**
 * Main-process scrollback buffer per terminal key.
 * Accumulates terminal output so that `handleRequestTerminalSnapshot` can
 * serve buffer content even when the renderer hasn't mounted an xterm instance
 * for the terminal (e.g. terminal tabs created remotely from iOS).
 * Capped at MAX_SCROLLBACK_SIZE bytes per key.
 */
export const terminalScrollback = new Map<string, string>()
export const MAX_SCROLLBACK_SIZE = 100_000

interface MutableState {
  mainWindow: BrowserWindow | null
  tray: Tray | null
  remoteTransport: RemoteTransport | null
  forceQuit: boolean
  toggleSequence: number
  screenshotCounter: number
  pasteCounter: number
  cachedFonts: string[] | null
  terminalOutputFlushTimer: ReturnType<typeof setInterval> | null
  tabSnapshotInterval: ReturnType<typeof setInterval> | null
}

export const state: MutableState = {
  mainWindow: null,
  tray: null,
  remoteTransport: null,
  forceQuit: false,
  toggleSequence: 0,
  screenshotCounter: 0,
  pasteCounter: 0,
  cachedFonts: null,
  terminalOutputFlushTimer: null,
  tabSnapshotInterval: null,
}

/** Cached model list from engine, populated by LIST_MODELS IPC and included in remote snapshots. */
export const modelCache = {
  models: [] as Array<{ id: string; providerId: string; label: string; contextWindow: number; hasAuth: boolean }>,
  lastFetched: 0,
}

/**
 * Per-session extension-command registry cache.
 *
 * Keyed by engine session key — `tabId` for CLI tabs, `${tabId}:${instanceId}`
 * for engine tabs (matches the keying used by `engineBridge.sendCommand`).
 * Populated and invalidated by `engine_command_registry` events emitted from
 * the Go engine (see `engine/internal/session/command_registry.go`). The cache
 * is a routing HINT for the unified prompt pipeline, not a source of truth:
 *
 *   - HIT  → "this name is registered with extensions on this session,
 *            dispatch confidently."
 *   - MISS → "either the name is not an extension command OR our snapshot is
 *            stale (mid-session registration race). Dispatch anyway; the
 *            engine resolves the live table at dispatch time and emits
 *            engine_command_result with CommandError='unknown_command' if it
 *            disclaims the name. The pipeline falls through to `.md`
 *            expansion on that signal."
 *
 * Snapshot semantics: every event REPLACES the prior entry for the key. An
 * empty `commands: []` payload is the authoritative "no extension commands
 * live for this session" signal — we delete the cache entry on empty so a
 * subsequent re-population creates a fresh entry. See AGENTS.md §4.
 *
 * Entries are populated reactively from engine events; never written by
 * dispatch code. Reads are O(1) Set.has lookups, called once per slash
 * command parsed by the unified pipeline.
 */
export const extensionCommandRegistry = new Map<string, Set<string>>()

/**
 * Per-device iOS focus and intercept-preference state.
 *
 * Keyed by deviceId. iOS sends `report_focus` whenever the focused tab changes,
 * the app foregrounds/backgrounds, or the intercept preference toggles. The
 * desktop reads this map in `event-wiring-intercept.ts` when an
 * `engine_intercept` event arrives to decide which devices to forward it to
 * and whether to perform abort + re-prompt for "redirect" level events.
 *
 * tabId null means the iOS device is backgrounded or has no tab focused.
 * Entries are removed when the device disconnects (see transport-init.ts).
 */
export const deviceFocusMap = new Map<string, { tabId: string | null; interceptEnabled: boolean }>()

/**
 * Dedupe set for AskUserQuestion / ExitPlanMode `permission_request`
 * envelopes synthesized from engine-view `engine_status.permissionDenials`
 * and forwarded to iOS. The engine emits engine_status repeatedly
 * (cost-only ticks fire ~1ms after the denial-carrying tick), so we'd
 * otherwise re-push the same `denied-<toolUseId>` question over and over
 * — each one fires a push notification, which is the visible spam.
 *
 * Keyed by the synthetic `questionId` (`denied-<toolUseId>`). The toolUseId
 * is engine-assigned and unique per call, so a fresh question always
 * misses the set. Entries are cleared:
 *   - When the user answers (renderer clears tab.permissionDenied → next
 *     engine_status sees no denials → nothing to forward; the answered
 *     toolUseId is never seen again because the engine doesn't re-emit it).
 *   - When the engine tab is closed (closeTab; see wiring below).
 *
 * Memory bound: ~one entry per AskUserQuestion ever asked on this desktop
 * process. Acceptable — toolUseId is a short string and the process is
 * already long-lived; if it becomes a leak we can prune on engine_dead
 * or on snapshot reconcile.
 */
export const forwardedEnginePermissionDenials = new Set<string>()

/**
 * Last tab status forwarded to iOS for engine-view tabs.
 *
 * Engine-view events bypass `EngineControlPlane` (compound key mismatch:
 * the control plane is keyed by bare tabId, engine-view events arrive as
 * `tabId:instanceId`). That means no `tab-status-change` event fires on
 * the sessionPlane for engine tabs — iOS never learns the tab transitioned
 * from 'running' to 'idle'/'completed'.
 *
 * `wireEngineBridgeEvents` synthesizes `tab_status` messages for iOS from
 * `engine_status.fields.state`. This map deduplicates: we only forward
 * when the derived status differs from the last forwarded value.
 *
 * Keyed by bare tabId (not compound key) since `tab_status` is a per-tab
 * concept on iOS.
 */
export const lastForwardedEngineTabStatus = new Map<string, string>()

