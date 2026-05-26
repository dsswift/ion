import { IS_REMOTE } from './engine-bridge'
import type { EngineDirListing, EngineHostInfo } from '../shared/types'

/** Lazy lookup of the bridge singleton. Avoids a static import of './state',
 *  which transitively imports EngineControlPlane and would create a circular
 *  load-order dependency (state -> control-plane -> engine-bridge-fs -> state).
 *  The first call after app boot is when the picker is opened, by which
 *  point state.ts has finished initializing. */
function bridge(): import('./engine-bridge').EngineBridge {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('./state').engineBridge
}

/**
 * Engine-host filesystem helpers layered on top of the bridge.
 *
 * Lives in its own module so the bridge stays focused on raw socket /
 * session plumbing. These helpers cover the engine-side `get_host_info` and
 * `list_directory` RPCs (engine/internal/server/fs_browse.go) used by the
 * remote-aware directory picker.
 */

/** Cached engine host info. The engine host's home / username / OS don't
 *  change for the life of the desktop process, so a per-process cache is
 *  enough; the user relaunches if they switch engines. */
let hostInfoCache: EngineHostInfo | null = null

/** Whether the bridge points at a remote engine (TCP) vs a local one (Unix
 *  socket). Driven entirely by the ION_DESKTOP_ENGINE_SOCKET env var at
 *  process start, so it never changes for the life of the process. */
export function engineIsRemote(): boolean {
  return IS_REMOTE
}

/** Fetch the engine host's home, username, hostname, OS, and path separator.
 *  Cached after the first successful call until the next disconnect. */
export async function getEngineHostInfo(): Promise<{ ok: boolean; error?: string; data?: EngineHostInfo }> {
  if (hostInfoCache) {
    return { ok: true, data: hostInfoCache }
  }
  const result = await bridge().request<EngineHostInfo>('get_host_info')
  if (result.ok && result.data) {
    hostInfoCache = result.data
  }
  return result
}

/** Browse a directory on the engine's host. Path `""` or `"~"` resolves to
 *  the engine user's home. Other paths must be absolute. */
export async function listEngineDirectory(
  path: string,
  showHidden: boolean,
): Promise<{ ok: boolean; error?: string; data?: EngineDirListing }> {
  return bridge().request<EngineDirListing>('list_directory', { path, showHidden })
}
