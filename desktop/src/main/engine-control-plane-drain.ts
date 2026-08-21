/**
 * Drain and shutdown for EngineControlPlane.
 *
 * Split out of engine-control-plane.ts (600-line cap) as one cohesive seam: the
 * three functions here are the only ones that read or write the drain latch, and
 * shutdown is what releases it.
 */
import type { EngineBridge } from './engine-bridge'
import type { TabEntry } from './engine-control-plane-events'
import { log as _log, warn as _warn } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('main', msg, fields)
}

/** The drain latch. Owned by the control plane, mutated only in this file. */
export interface DrainLatch {
  resolve: (() => void) | null
  externalCheck: (() => boolean) | null
}

export function makeDrainLatch(): DrainLatch {
  return { resolve: null, externalCheck: null }
}

export interface DrainBlocker {
  tabId: string
  status: string
}

function logDrainState(
  msg: string,
  hasRunningTabs: () => boolean,
  blockers: () => DrainBlocker[],
  hasExternalWork?: () => boolean,
): void {
  const tabBlockers = blockers()
  const externalWork = hasExternalWork?.() ?? false
  log(msg, {
    running_tab_count: tabBlockers.length,
    running_tab_ids: tabBlockers.map(({ tabId }) => tabId),
    running_tab_statuses: tabBlockers.map(({ status }) => status),
    has_running_tabs: hasRunningTabs(),
    has_external_work: externalWork,
  })
}

/** Resolve once no tab is running and no external work remains. */
export function drain(
  latch: DrainLatch,
  hasRunningTabs: () => boolean,
  blockers: () => DrainBlocker[],
  hasExternalWork?: () => boolean,
): Promise<void> {
  if (!hasRunningTabs() && (!hasExternalWork || !hasExternalWork())) {
    logDrainState('drain: no work, resolving immediately', hasRunningTabs, blockers, hasExternalWork)
    return Promise.resolve()
  }
  logDrainState('drain: waiting for active work', hasRunningTabs, blockers, hasExternalWork)
  latch.externalCheck = hasExternalWork || null
  return new Promise<void>((resolve) => {
    latch.resolve = resolve
  })
}

/** Re-evaluate the latch. Called on every status transition. */
export function checkDrain(
  latch: DrainLatch,
  hasRunningTabs: () => boolean,
  blockers: () => DrainBlocker[],
): void {
  if (!latch.resolve) return
  const tabBlockers = blockers()
  const externalWork = latch.externalCheck?.() ?? false
  if (hasRunningTabs() || externalWork) {
    log('drain: still waiting for active work', {
      running_tab_count: tabBlockers.length,
      running_tab_ids: tabBlockers.map(({ tabId }) => tabId),
      running_tab_statuses: tabBlockers.map(({ status }) => status),
      has_external_work: externalWork,
    })
    return
  }
  log('drain: active work complete, releasing quit', { running_tab_count: 0, has_external_work: false })
  latch.resolve()
  latch.resolve = null
  latch.externalCheck = null
}

/**
 * Tear down the desktop's half of the engine relationship.
 *
 * `stopSessions` is the whole Quit Desktop / Quit All distinction, and it is a
 * parameter rather than a default because the two answers are opposites.
 *
 * The engine is a launchd daemon, not a desktop subprocess: its sessions outlive
 * the window, and ownership is released with a grace window (`reapGraceWindow`,
 * engine/internal/server/session_ownership.go) precisely so a desktop restart
 * reattaches to work still in flight. Quitting the window must therefore drop
 * the SOCKET and nothing else — the grace window decides what happens next.
 *
 * This unconditionally stopped every session, which is why "Quit Desktop —
 * closes the window but keeps engine sessions running" (the literal text of the
 * quit dialog) ended a `stop_session` per open conversation and defeated the
 * grace window it was written to rely on.
 *
 * Quit All is the case that genuinely wants the stops: the operator asked for
 * the engine to go away, and stopping sessions before the daemon boots out gives
 * each one a chance to finish its own teardown.
 */
export function shutdown(
  latch: DrainLatch,
  tabs: Map<string, TabEntry>,
  bridge: EngineBridge,
  opts: { stopSessions: boolean },
): void {
  if (opts.stopSessions) {
    for (const tabId of tabs.keys()) {
      bridge.stopSession(tabId).catch((err) => warn('shutdown: stop session failed', { tab_id: tabId, error: String(err) }))
    }
  } else {
    log('shutdown: leaving engine sessions running', { tab_count: tabs.size })
  }
  bridge.disconnect().catch((err) => warn('shutdown: bridge disconnect failed', { error: String(err) }))
  tabs.clear()
  if (latch.resolve) {
    latch.resolve()
    latch.resolve = null
    latch.externalCheck = null
  }
}
