/**
 * snapshot-renderer-poll — the fallback path for the push snapshot
 * architecture, now a direct in-process call.
 *
 * The primary snapshot source is the push cache: `remote-projection-push.ts`
 * projects `RemoteTabStatesPayload` from the store on change and pushes it;
 * `getRemoteTabStates()` (snapshot.ts) serves that cache. This fallback runs
 * whenever the cache is empty or older than `RENDERER_CACHE_MAX_AGE_MS`.
 *
 * On the desktop, the store lived in a renderer window and this file used to
 * reach it via `executeJavaScript`, calling a projection function the owner
 * renderer published on a window global (`PROJECTION_GLOBAL`) — the
 * historical alternative, a ~300-line transcription of the projection as a
 * template literal, had already drifted from the real one once (missing the
 * inbox-classification fields) and is exactly the two-implementations-of-one-
 * contract defect this indirection replaced.
 *
 * The server owns the store directly in the same process: there is no window
 * boundary to cross, so this is now a plain function call to the same
 * `projectRemoteTabStates` the push path calls — one implementation, called
 * from both places, with nothing left to keep in sync.
 */

import { debug } from '../logger'
import type { RemoteTabStatesPayload } from '@ion/shared/remote-projection-types'
import { useSessionStore } from '../store/sessionStore'
import { projectRemoteTabStates } from '../store/remote-projection'

/** Run the fallback projection once and return the payload. */
export function pollRendererTabStates(): Promise<RemoteTabStatesPayload> {
  const result = projectRemoteTabStates(useSessionStore.getState())
  debug('snapshot-fallback', 'fallback projection polled', { tab_count: result.tabs.length })
  return Promise.resolve(result)
}
