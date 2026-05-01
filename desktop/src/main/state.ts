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
export const lastMessagePreview = new Map<string, string>()
export const terminalOutputAccumulator = new Map<string, string>()

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
