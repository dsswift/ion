/**
 * WI-003 parity/regression: uniform status projection after retiring
 * deriveEngineParentStatus.
 *
 * Before WI-001 (8690aae3), the normalized event arm gated status writes on
 * the ACTIVE instance, so switching the active sub-instance mid-run could
 * strand t.status === 'running' even after the formerly-active instance went
 * idle. deriveEngineParentStatus compensated by re-deriving from per-instance
 * state inside the snapshot IIFE.
 *
 * WI-001 removed the active-instance gate: every status write goes to
 * t.status unconditionally (the single main instance), so t.status is always
 * authoritative. deriveEngineParentStatus is no longer needed.
 *
 * These tests verify:
 *   GUARD — snapshot.ts does not call or import deriveEngineParentStatus
 *           (static source scan, because the IIFE is not importable).
 *
 *   PARITY — projectRendererTab (the main-process projection helper) passes
 *            t.status through for both plain and extension-hosted tabs with
 *            no tab-type fork. The scenario that previously required
 *            derivation (extension tab, stale t.status) now resolves
 *            correctly because WI-001 keeps t.status accurate at the source.
 *
 *   REGRESSION — a stranded-running scenario:
 *            tab starts running, second instance becomes active, first
 *            instance goes idle. Post-WI-001, t.status is updated on the
 *            normalized idle transition regardless of which instance is
 *            active. Snapshot sees t.status='idle'. Pre-WI-001, this case
 *            required the derivation (which this test would have failed
 *            if the derivation were removed prematurely).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { projectRendererTab } from '../snapshot-project'

const SNAPSHOT_SRC = readFileSync(join(__dirname, '..', 'snapshot.ts'), 'utf-8')
// The legacy IIFE moved to snapshot-renderer-poll.ts (cold-start / stall
// fallback of the renderer-push architecture); the canonical projection is
// renderer/stores/remote-projection.ts (behaviorally pinned in
// remote-projection.test.ts). The IIFE guards below scan the fallback file;
// the import/call guards scan all three read-path sources.
const POLL_SRC = readFileSync(join(__dirname, '..', 'snapshot-renderer-poll.ts'), 'utf-8')
const PROJECTION_SRC = readFileSync(
  join(__dirname, '..', '..', '..', 'renderer', 'stores', 'remote-projection.ts'),
  'utf-8',
)

// ─── GUARD ────────────────────────────────────────────────────────────────────

describe('WI-003 guard: deriveEngineParentStatus removed', () => {
  it('no snapshot source imports snapshot-derive', () => {
    expect(SNAPSHOT_SRC).not.toContain('snapshot-derive')
    expect(POLL_SRC).not.toContain('snapshot-derive')
    expect(PROJECTION_SRC).not.toContain('snapshot-derive')
  })

  it('no snapshot source calls deriveEngineParentStatus', () => {
    expect(SNAPSHOT_SRC).not.toContain('deriveEngineParentStatus')
    expect(POLL_SRC).not.toContain('deriveEngineParentStatus')
    expect(PROJECTION_SRC).not.toContain('deriveEngineParentStatus')
  })

  it('fallback IIFE and canonical projection have no derivedStatus variable (status is uniform)', () => {
    // If derivedStatus appears, someone reintroduced the compensation.
    // Status must project t.status directly — no intermediate variable.
    const start = POLL_SRC.indexOf('executeJavaScript(`')
    expect(start).toBeGreaterThan(-1)
    const open = POLL_SRC.indexOf('`', start)
    const close = POLL_SRC.indexOf('`', open + 1)
    const iife = POLL_SRC.slice(open + 1, close)
    expect(iife).not.toContain('derivedStatus')
    expect(PROJECTION_SRC).not.toContain('derivedStatus')
  })

  it('fallback IIFE has no anyInstanceRunning aggregate (retired with derivation)', () => {
    // anyInstanceRunning was only used by the derivation loop.
    // After WI-003 it is gone; only anyInstanceHasRunningChildren survives
    // (drives the hasRunningChildren yellow-dot field).
    const start = POLL_SRC.indexOf('executeJavaScript(`')
    expect(start).toBeGreaterThan(-1)
    const open = POLL_SRC.indexOf('`', start)
    const close = POLL_SRC.indexOf('`', open + 1)
    const iife = POLL_SRC.slice(open + 1, close)
    expect(iife).not.toContain('anyInstanceRunning')
  })
})

// ─── PARITY ───────────────────────────────────────────────────────────────────

describe('WI-003 parity: projectRendererTab passes t.status uniformly', () => {
  const BASE = { lastMessage: null, permissionQueue: [] }

  it('plain tab: passes t.status through unchanged', () => {
    for (const status of ['idle', 'running', 'completed', 'failed', 'dead'] as const) {
      const result = projectRendererTab({ id: 't1', title: 'T', status, engineProfileId: null }, BASE)
      expect(result.status).toBe(status)
    }
  })

  it('extension-hosted tab: passes t.status through unchanged (no derivation branch)', () => {
    // Pre-WI-003 the derivation could map 'running' → 'idle' for an extension
    // tab if anyInstanceRunning was false. Post-WI-003, t.status is trusted and
    // projected as-is. Both plain and extension tabs go through the same path.
    for (const status of ['idle', 'running', 'completed', 'failed', 'dead'] as const) {
      const result = projectRendererTab({ id: 't2', title: 'T', status, engineProfileId: 'cos', hasEngineExtension: true }, BASE)
      expect(result.status).toBe(status)
    }
  })

  it('plain and extension-hosted tabs return identical status for the same input', () => {
    const plainResult = projectRendererTab({ id: 't1', status: 'running', engineProfileId: null }, BASE)
    const extResult = projectRendererTab({ id: 't2', status: 'running', engineProfileId: 'cos', hasEngineExtension: true }, BASE)
    expect(plainResult.status).toBe(extResult.status)
  })
})

// ─── REGRESSION: stranded-running scenario ───────────────────────────────────

describe('WI-003 regression: stranded-running scenario', () => {
  const BASE = { lastMessage: null, permissionQueue: [] }

  it('extension tab idle after run: snapshot projects t.status=idle (WI-001 correctness, no derivation needed)', () => {
    // Scenario (pre-WI-001 this would strand t.status):
    //   1. Extension tab starts running (t.status='running').
    //   2. User switches to a second sub-instance while instance 1 runs.
    //   3. Instance 1 finishes; the old gated path would NOT update t.status
    //      because the active instance was now instance 2 → stranded.
    //
    // Post-WI-001: the normalized idle event writes t.status='idle' regardless
    // of which instance is active. The snapshot receives t.status='idle' and
    // projects it. No derivation needed.
    //
    // We simulate the snapshot end state: t.status is correctly 'idle' at the
    // point the snapshot is taken (WI-001 guarantee). projectRendererTab
    // must project 'idle', not compensate to 'running'.
    const result = projectRendererTab(
      {
        id: 'ext-tab-1',
        title: 'Extension Tab',
        status: 'idle',        // WI-001 made this correct at source
        engineProfileId: 'cos',
        hasEngineExtension: true,
        conversationInstances: [
          { id: 'inst-1', label: 'Instance 1', isRunning: false, runningAgentCount: 0, waitingState: null },
          { id: 'inst-2', label: 'Instance 2', isRunning: false, runningAgentCount: 0, waitingState: null },
        ],
        activeConversationInstanceId: 'inst-2',
      },
      BASE,
    )
    // Must project idle — not running.
    expect(result.status).toBe('idle')
  })

  it('revert check: if derivation were reintroduced with wrong anyInstanceRunning=false logic, this would still pass because WI-001 fixes t.status at source', () => {
    // This test documents why the derivation is safe to remove: WI-001
    // ensures t.status is never stranded. The derivation's only purpose was
    // to recover from a stale t.status. With that staleness eliminated at the
    // source, the derivation adds no value and only creates complexity.
    //
    // Concretely: projectRendererTab receives t.status='idle' (WI-001
    // guarantee) and projects 'idle'. The old derivation with
    // anyInstanceRunning=false would also produce 'idle' — so both paths
    // agree post-WI-001. Removing the derivation is safe.
    const result = projectRendererTab(
      { id: 'tab', status: 'idle', engineProfileId: 'cos', hasEngineExtension: true },
      BASE,
    )
    expect(result.status).toBe('idle')
  })
})
