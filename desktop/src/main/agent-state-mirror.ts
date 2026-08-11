// agent-state-mirror.ts — the main process's own copy of per-tab agent state.
//
// Why this exists: `sendCurrentEngineState` used to answer an iOS resync by
// running `webContents.executeJavaScript` against the renderer, reading
// `window.__Ion_SESSION_STORE__`, and shipping whatever came back. That is
// backwards. The main process receives `engine_agent_state` FIRST — it is the
// thing that forwards the event to the renderer — so scraping the renderer
// asks a downstream copy for data main already had.
//
// It was also expensive in exactly the wrong way. The renderer had to
// serialize the whole agent roster and hand it across the IPC boundary on
// every resync; with the 35 MB payload from the production incident that was
// tens of megabytes of structured-clone work on the UI thread, which is a
// direct contributor to the renderer and main CPU this work set out to reduce.
//
// Deliberately NOT folded into `state.rendererSnapshotCache`. That cache is a
// renderer projection fed into the 5s snapshot poll and its per-device hash.
// Putting agent metadata in it would make the renderer authoritative for data
// main sees first, and would fold every `elapsed` tick into the snapshot hash
// so the whole snapshot re-sends continuously — reintroducing the
// amplification this change removes.

import type { AgentStateUpdate } from '../shared/types-engine'
import { debug, warn } from './logger'

interface MirrorEntry {
  tabId: string
  instanceId: string | null
  agents: AgentStateUpdate[]
  updatedAt: number
}

/**
 * Bound on tracked wire keys. A long-lived desktop cycles through many tabs
 * and extension instances; without a bound this map is a slow leak of whole
 * agent rosters. Well above any plausible concurrent tab count, so the sweep
 * only ever reaps genuinely dead keys.
 */
const MAX_MIRROR_KEYS = 512

const mirror = new Map<string, MirrorEntry>()

/** Compose the wire key (`tabId` or `tabId:instanceId`). */
function wireKey(tabId: string, instanceId: string | null): string {
  return instanceId ? `${tabId}:${instanceId}` : tabId
}

/**
 * Record the authoritative agent roster for a wire key.
 *
 * Called from the engine event path, upstream of the renderer forward, so the
 * mirror is never staler than what the renderer holds.
 */
export function recordAgentState(
  tabId: string,
  instanceId: string | null,
  agents: AgentStateUpdate[],
): void {
  if (!tabId) return

  mirror.set(wireKey(tabId, instanceId), {
    tabId,
    instanceId,
    // Copy the array: the caller's reference belongs to the event pipeline and
    // may be reused or mutated downstream.
    agents: [...agents],
    updatedAt: Date.now(),
  })

  if (mirror.size > MAX_MIRROR_KEYS) sweepOldest()
}

/**
 * Read the recorded roster for a wire key.
 *
 * Returns an empty array for an unknown key rather than null. Under the
 * complete-snapshot contract an empty roster is the authoritative "no agents
 * are live" signal, and that is the honest answer when the mirror has never
 * seen the key: the alternative is a caller that skips the send entirely and
 * leaves the phone rendering rows the desktop no longer knows about.
 */
export function getAgentState(tabId: string, instanceId: string | null): AgentStateUpdate[] {
  const entry = mirror.get(wireKey(tabId, instanceId))
  if (entry) return entry.agents

  // Fall back to the bare key: an extension-hosted instance forwards under a
  // compound key, but a resync may ask with the instance unresolved.
  if (instanceId) {
    const bare = mirror.get(tabId)
    if (bare) return bare.agents
  }
  return []
}

/** Whether any roster has been recorded for this wire key. */
export function hasAgentState(tabId: string, instanceId: string | null): boolean {
  return mirror.has(wireKey(tabId, instanceId)) || (!!instanceId && mirror.has(tabId))
}

/** Drop every entry for a tab (all its instances). Called on tab close. */
export function clearAgentStateForTab(tabId: string): void {
  let removed = 0
  for (const key of [...mirror.keys()]) {
    if (key === tabId || key.startsWith(`${tabId}:`)) {
      mirror.delete(key)
      removed++
    }
  }
  if (removed > 0) debug('main', 'agent_state_mirror: cleared for tab', { tab_id: tabId, removed })
}

/** Drop everything. Used on engine restart, when all prior state is void. */
export function clearAllAgentState(): void {
  const size = mirror.size
  mirror.clear()
  if (size > 0) debug('main', 'agent_state_mirror: cleared all', { removed: size })
}

/** Test/diagnostic accessor for the tracked key count. */
export function agentStateMirrorSize(): number {
  return mirror.size
}

/** Evict the least-recently-updated entries back under the cap. */
function sweepOldest(): void {
  const entries = [...mirror.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)
  const excess = mirror.size - MAX_MIRROR_KEYS
  for (let i = 0; i < excess; i++) mirror.delete(entries[i][0])
  warn('main', 'agent_state_mirror: swept entries over cap', {
    cap: MAX_MIRROR_KEYS,
    swept: excess,
    remaining: mirror.size,
  })
}
