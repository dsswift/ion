import type { BrowserWindow, Tray } from 'electron'
import type { ChildProcess } from 'child_process'
import type { watch } from 'fs'
import type { RemoteTransport } from './remote/transport'
import { EngineBridge } from './engine-bridge'
import { EngineControlPlane } from './engine-control-plane'
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

