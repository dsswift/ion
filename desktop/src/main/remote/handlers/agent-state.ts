// agent-state.ts — serve an on-demand agent-roster re-send.
//
// Why a scoped command rather than reusing desktop_sync: sync rebuilds every
// tab plus engine profiles, the settings snapshot, and terminal buffers. Using
// that to recover one dropped roster is exactly the amplification this work
// removes. A client that noticed a degraded or missing roster wants the
// roster, not the world.
//
// This exists because the transport had no recovery path at all. When an
// oversized desktop_agent_state was dropped, the "periodic resync heals it"
// comment was wrong: the resync IS a frame subject to the same size gate, so a
// payload oversized by one byte was dropped forever. Degrading (see
// transport-degrade.ts) fixes the common case; this covers the rest.

import { state } from '../../state'
import { log as _log, warn as _warn } from '../../logger'
import { getAgentState, hasAgentState, getKnownInstanceId } from '../../agent-state-mirror'
import type { RemoteCommand } from '../protocol'

function log(msg: string, fields?: Record<string, unknown>): void { _log('RemoteAgentState', msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn('RemoteAgentState', msg, fields) }

/**
 * Delay before the desktop-initiated self-heal re-send.
 *
 * Long enough that the condition which forced a degrade (a burst of oversized
 * payloads) has usually passed, short enough that a user watching the agents
 * panel sees it correct itself rather than waiting for the next resync.
 */
const SELF_HEAL_DELAY_MS = 2000

/** Tabs with a pending self-heal, so a burst schedules one re-send, not N. */
const pendingSelfHeal = new Set<string>()

/**
 * Roster hashes whose delivery already failed (degraded or dropped), per tab.
 *
 * This is the give-up half of self-heal, and it exists because the retry half
 * once ran unbounded: a 30.7 MB roster for a dead session was re-serialized
 * and re-degraded every 2 seconds across engine restarts — the self-heal's
 * own send scheduled the next self-heal, forever. Re-sending a payload that
 * is byte-identical to one that already failed cannot succeed; only a NEW
 * roster from the engine can change the outcome, and its different hash is
 * what re-arms the retry.
 */
const lastFailedHash = new Map<string, string>()

/** Hashes already warned about, so the suppression logs once, not per tick. */
const warnedFailedHash = new Set<string>()

/** FNV-1a over the serialized roster — cheap, stable, collision-safe enough
 * for "is this the exact payload that just failed". */
function hashAgents(agents: unknown): string {
  const s = JSON.stringify(agents) ?? ''
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16) + ':' + s.length
}

/**
 * Record that a roster failed to deliver at full fidelity (the transport
 * degraded or dropped it). Called by the transport size gate.
 */
export function noteAgentStateDeliveryFailure(tabId: string, agents: unknown): void {
  if (!tabId) return
  lastFailedHash.set(tabId, hashAgents(agents))
}

/**
 * Re-arm self-heal for a tab (or every tab) — a genuinely new roster, a tab
 * close, or an engine reconnect voids the failure record.
 */
export function resetAgentStateSelfHeal(tabId?: string): void {
  if (tabId === undefined) {
    lastFailedHash.clear()
    warnedFailedHash.clear()
    return
  }
  lastFailedHash.delete(tabId)
}

/**
 * Handle `desktop_request_agent_state`.
 *
 * Served entirely from the main-process mirror — no renderer round-trip, which
 * is the whole point of owning this state in main.
 */
export function handleRequestAgentState(
  cmd: Extract<RemoteCommand, { type: 'desktop_request_agent_state' }>,
  deviceId: string,
): void {
  const { tabId } = cmd
  if (!tabId) {
    warn('request_agent_state: missing tabId', { device_id: deviceId })
    return
  }
  if (!state.remoteTransport) {
    warn('request_agent_state: no transport', { tab_id: tabId, device_id: deviceId })
    return
  }

  const instanceId = cmd.instanceId ?? getKnownInstanceId(tabId)
  const known = hasAgentState(tabId, instanceId)
  const agents = getAgentState(tabId, instanceId)

  // An unknown tab still gets an answer. Under the complete-snapshot contract
  // an empty roster is the authoritative "no agents are live" signal, so
  // staying silent would leave the client rendering rows the desktop no longer
  // knows about — the exact failure the request was sent to resolve.
  log('request_agent_state: serving from mirror', {
    tab_id: tabId, instance_id: instanceId, device_id: deviceId,
    agents: agents.length, known,
  })

  state.remoteTransport.sendToDevice(deviceId, {
    type: 'desktop_agent_state', tabId, instanceId, agents,
  })
}

/**
 * Schedule one full re-send of a tab's roster after a degrade or drop.
 *
 * This is the desktop-side half of recovery, and it deliberately does not wait
 * for a client to ask. iOS needs a release to send the new request command;
 * this heals a transient overflow without one. A payload that is still
 * oversized simply degrades or drops again, and that is logged.
 */
export function scheduleAgentStateSelfHeal(tabId: string, instanceId: string | null): void {
  if (!tabId || pendingSelfHeal.has(tabId)) return
  pendingSelfHeal.add(tabId)

  setTimeout(() => {
    pendingSelfHeal.delete(tabId)
    if (!state.remoteTransport) return

    const agents = getAgentState(tabId, instanceId)

    // Give-up gate: a payload identical to one that already failed will fail
    // identically. Suppress the re-send and wait for the engine to emit a
    // different roster — that is the only event that can change the outcome.
    const h = hashAgents(agents)
    if (lastFailedHash.get(tabId) === h) {
      const warnKey = `${tabId}:${h}`
      if (!warnedFailedHash.has(warnKey)) {
        if (warnedFailedHash.size > 256) warnedFailedHash.clear() // bound the dedup set; re-warning is harmless
        warnedFailedHash.add(warnKey)
        warn('agent_state self-heal: suppressed — payload unchanged since last delivery failure', {
          tab_id: tabId, instance_id: instanceId, agents: agents.length, hash: h,
        })
      }
      return
    }

    log('agent_state self-heal: re-sending roster', {
      tab_id: tabId, instance_id: instanceId, agents: agents.length,
    })
    state.remoteTransport.send({ type: 'desktop_agent_state', tabId, instanceId, agents })
  }, SELF_HEAL_DELAY_MS).unref?.()
}

/** Test hook: clear pending self-heals between cases. */
export function __resetAgentStateSelfHealForTest(): void {
  pendingSelfHeal.clear()
}
