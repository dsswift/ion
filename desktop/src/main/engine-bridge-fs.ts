import { IS_REMOTE } from './engine-bridge'
import { engineBridge } from './state'
import { log } from './logger'
import type { EngineDirListing, EngineHostInfo } from '../shared/types'

/** Returns the bridge singleton.
 *
 *  The import cycle (state → control-plane → engine-bridge-fs → state) is
 *  safe because the binding is read inside a function body, never at
 *  module-eval time. The first call is when the directory picker opens — long
 *  after all modules have finished initialising.
 *
 *  A runtime `require('./state')` would work in a multi-file Electron build
 *  (Node resolves siblings at runtime), but it silently breaks when esbuild
 *  produces a single-file bundle: there is no sibling `state.js` to require.
 *  A static `import` is resolved by esbuild at bundle time and is safe for
 *  both build modes. */
function bridge(): import('./engine-bridge').EngineBridge {
  return engineBridge
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
    log('engine-bridge-fs', 'getEngineHostInfo: cache hit')
    return { ok: true, data: hostInfoCache }
  }
  const result = await bridge().request<EngineHostInfo>('get_host_info')
  if (result.ok && result.data) {
    hostInfoCache = result.data
    log('engine-bridge-fs', 'getEngineHostInfo: fetched home=' + result.data.home + ' host=' + result.data.hostname)
  } else {
    log('engine-bridge-fs', 'getEngineHostInfo: failed err=' + result.error)
  }
  return result
}

/** Browse a directory on the engine's host. Path `""` or `"~"` resolves to
 *  the engine user's home. Other paths must be absolute. */
export async function listEngineDirectory(
  path: string,
  showHidden: boolean,
): Promise<{ ok: boolean; error?: string; data?: EngineDirListing }> {
  log('engine-bridge-fs', 'listEngineDirectory: path=' + path + ' showHidden=' + showHidden)
  return bridge().request<EngineDirListing>('list_directory', { path, showHidden })
}
