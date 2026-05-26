import { create } from 'zustand'
import type { EngineHostInfo, EngineDirListing } from '../../shared/types'

/**
 * Renderer-side state for the engine-host filesystem and remote-aware
 * directory picker.
 *
 * When the desktop is connected to a remote engine, the engine's host has its
 * own filesystem (different user, different paths). The local Electron file
 * dialog browses *this* Mac, so it would let the user pick paths that don't
 * exist on the engine. Engine-mediated sessions need a picker that browses
 * the engine's filesystem instead.
 *
 * This store owns:
 *   - `isRemote`     — whether the bridge points at a remote engine
 *   - `hostInfo`     — cached engine-host metadata (home, username, etc.)
 *   - `picker`       — imperative-modal state. A caller invokes
 *     `openRemotePicker(start)` and gets a Promise<string | null>; the modal
 *     reads `picker.open` to render itself and calls `resolvePicker(path)`
 *     when the user confirms or cancels.
 */
interface RemoteFsState {
  isRemote: boolean
  hostInfo: EngineHostInfo | null

  /** Picker modal state. `open` toggles visibility; `resolve` is the awaiting
   *  promise's resolver. */
  picker: {
    open: boolean
    startPath: string
    resolve: ((path: string | null) => void) | null
  }

  /** Initialize from main process. Called once on app boot. */
  init(): Promise<void>

  /** Open the remote directory picker. Returns the picked path or null on
   *  cancel. */
  openRemotePicker(startPath?: string): Promise<string | null>

  /** Resolve the open picker (called by the modal on confirm/cancel). */
  resolvePicker(path: string | null): void

  /** Convenience for the modal: list a directory on the engine host. */
  listDirectory(path: string, showHidden: boolean): Promise<EngineDirListing | null>
}

export const useRemoteFsStore = create<RemoteFsState>((set, get) => ({
  isRemote: false,
  hostInfo: null,
  picker: { open: false, startPath: '', resolve: null },

  async init() {
    const isRemote = await window.ion.engineIsRemote().catch(() => false)
    set({ isRemote })
    // hostInfo is loaded lazily on first picker open so we don't block boot
    // on a slow/unreachable engine.
  },

  async openRemotePicker(startPath?: string): Promise<string | null> {
    let start = startPath ?? ''
    if (!start) {
      // Default to the engine user's home so the picker opens somewhere useful
      // even on a fresh tab.
      let info = get().hostInfo
      if (!info) {
        const res = await window.ion.getEngineHostInfo().catch(() => null)
        if (res?.ok && res.data) {
          info = res.data
          set({ hostInfo: info })
        }
      }
      start = info?.home ?? ''
    }
    return new Promise<string | null>((resolve) => {
      set({ picker: { open: true, startPath: start, resolve } })
    })
  },

  resolvePicker(path: string | null) {
    const { picker } = get()
    picker.resolve?.(path)
    set({ picker: { open: false, startPath: '', resolve: null } })
  },

  async listDirectory(path: string, showHidden: boolean): Promise<EngineDirListing | null> {
    const res = await window.ion.listEngineDirectory(path, showHidden).catch(() => null)
    if (!res?.ok || !res.data) return null
    return res.data
  },
}))

/**
 * Helper used at call sites: decide whether to use the native Electron file
 * dialog or the remote engine-host picker.
 *
 * Use this for any session whose prompts get spawned by the engine
 * (i.e. anything routed through the engine bridge). Terminal-only tabs run a
 * local pty and should keep using the native dialog.
 */
export async function pickDirectoryForSession(opts: {
  isTerminalOnly?: boolean
  currentPath?: string
}): Promise<string | null> {
  const { isRemote, openRemotePicker } = useRemoteFsStore.getState()
  const useRemote = !opts.isTerminalOnly && isRemote
  if (useRemote) {
    return openRemotePicker(opts.currentPath)
  }
  return window.ion.selectDirectory()
}
