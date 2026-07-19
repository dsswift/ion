import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { projectRendererTab } from '../snapshot-project'

/**
 * Behavioral tests for the engineProfileId parity fix.
 *
 * Root cause: the main-process `mapped` projection in snapshot.ts built each
 * tab's wire shape with `hasEngineExtension` but never copied `engineProfileId`,
 * so iOS always received null for that field and fell back to the literal "EXT"
 * harness badge label regardless of the actual profile name.
 *
 * Coverage strategy
 * ─────────────────
 * Main-process path — `projectRendererTab` is the extracted pure helper that
 * owns the field-mapping contract for the `mapped` block. Tests here feed real
 * input shapes and assert output values directly (behavioral, not source-scan).
 *
 * Renderer IIFE path — the IIFE is evaluated in the renderer process via
 * `executeJavaScript` and cannot be imported or called from a unit test. A
 * static source scan is the only feasible coverage for that path; it is kept
 * intentionally narrow (just the presence of the assignment expression) with a
 * comment explaining why. See snapshot-iife-scope.test.ts for the broader IIFE
 * scope guards.
 */

// ─── Behavioral: main-process mapped projection ──────────────────────────────

describe('projectRendererTab — engineProfileId wire projection', () => {
  const BASE = {
    lastMessage: null,
    permissionQueue: [],
  }

  it('carries a non-null engineProfileId through to the wire shape', () => {
    const result = projectRendererTab(
      { id: 't1', title: 'My Tab', engineProfileId: 'profile-abc', hasEngineExtension: true },
      BASE,
    )
    expect(result.engineProfileId).toBe('profile-abc')
  })

  it('projects null when engineProfileId is null', () => {
    const result = projectRendererTab(
      { id: 't2', title: 'Plain Tab', engineProfileId: null },
      BASE,
    )
    expect(result.engineProfileId).toBeNull()
  })

  it('projects null when engineProfileId is absent (plain tab)', () => {
    const result = projectRendererTab(
      { id: 't3', title: 'Plain Tab' },
      BASE,
    )
    expect(result.engineProfileId).toBeNull()
  })

  it('projects null when engineProfileId is empty string', () => {
    // tabHasExtensions treats empty string as no-profile; the projection
    // must coerce it to null so iOS wire consumers get a clean null sentinel.
    const result = projectRendererTab(
      { id: 't4', title: 'Empty Profile Tab', engineProfileId: '' },
      BASE,
    )
    expect(result.engineProfileId).toBeNull()
  })

  it('preserves engineProfileId across all other field projections', () => {
    // Full-shape round-trip: verify nothing else in the projection clobbers the field.
    const result = projectRendererTab(
      {
        id: 't5',
        title: 'Full Tab',
        customTitle: 'Custom',
        status: 'idle',
        workingDirectory: '/home/user',
        permissionMode: 'auto',
        engineProfileId: 'profile-xyz',
        hasEngineExtension: true,
        groupId: 'g1',
        pillColor: '#ff0000',
        pillIcon: 'star',
      },
      { lastMessage: 'hello', permissionQueue: [] },
    )
    expect(result.engineProfileId).toBe('profile-xyz')
    // Spot-check that other fields were projected too (not just engineProfileId)
    expect(result.id).toBe('t5')
    expect(result.title).toBe('Custom')
    expect(result.groupId).toBe('g1')
    expect(result.pillColor).toBe('#ff0000')
  })
})

// ─── Static scan: renderer IIFE path ─────────────────────────────────────────
//
// The renderer IIFE is a string evaluated via executeJavaScript in the renderer
// process. It cannot be imported, invoked, or mocked in a unit test — the
// entire IIFE string never runs in Node. A source scan is the only feasible
// coverage for this path. It is intentionally narrow: just the presence of the
// assignment expression `engineProfileId: t.engineProfileId`. A broader test
// would over-specify the formatting and break on whitespace changes.
//
// The main-process path (above) carries the behavioral parity assertion.

// The legacy IIFE now lives in snapshot-renderer-poll.ts (cold-start / stall
// fallback). The canonical extracted projection is behaviorally pinned in
// renderer/stores/__tests__/remote-projection.test.ts.
const SNAPSHOT_SRC = readFileSync(
  join(__dirname, '..', 'snapshot-renderer-poll.ts'),
  'utf-8',
)

function extractIifeString(src: string): string {
  const start = src.indexOf('executeJavaScript(`')
  if (start === -1) throw new Error('executeJavaScript template literal not found')
  const open = src.indexOf('`', start)
  const close = src.indexOf('`', open + 1)
  if (close === -1) throw new Error('executeJavaScript template literal not closed')
  return src.slice(open + 1, close)
}

describe('engineProfileId — renderer IIFE source guard', () => {
  it('IIFE tab-map return object assigns engineProfileId from t.engineProfileId', () => {
    const iife = extractIifeString(SNAPSHOT_SRC)
    // Confirm the assignment is present in the tab-mapping body.
    const tabsMapIdx = iife.indexOf('s.tabs.map(function(t)')
    expect(tabsMapIdx, 'IIFE should contain s.tabs.map(function(t))').toBeGreaterThan(-1)
    const tabMapBody = iife.slice(tabsMapIdx)
    expect(tabMapBody).toMatch(/engineProfileId:\s*t\.engineProfileId/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// WI-002 parity: thinkingEffort snapshot projection (#259 FIX 2)
//
// projectRendererTab must project thinkingEffort identically for plain and
// extension-hosted tab inputs. There is no tab-type fork in the projection.
// ─────────────────────────────────────────────────────────────────────────────

describe('projectRendererTab — thinkingEffort parity (WI-002 FIX 2)', () => {
  const BASE = { lastMessage: null, permissionQueue: [] }

  it('plain tab with high thinkingEffort projects thinkingEffort:high', () => {
    const result = projectRendererTab(
      { id: 't1', title: 'T', thinkingEffort: 'high', engineProfileId: null },
      BASE,
    )
    expect(result.thinkingEffort).toBe('high')
  })

  it('extension-hosted tab with high thinkingEffort projects thinkingEffort:high', () => {
    const result = projectRendererTab(
      { id: 't2', title: 'T', thinkingEffort: 'high', engineProfileId: 'cos', hasEngineExtension: true },
      BASE,
    )
    expect(result.thinkingEffort).toBe('high')
  })

  it('plain and extension-hosted tabs return identical thinkingEffort for the same input', () => {
    const plainResult = projectRendererTab(
      { id: 't1', thinkingEffort: 'medium', engineProfileId: null },
      BASE,
    )
    const extResult = projectRendererTab(
      { id: 't2', thinkingEffort: 'medium', engineProfileId: 'cos', hasEngineExtension: true },
      BASE,
    )
    expect(plainResult.thinkingEffort).toBe(extResult.thinkingEffort)
  })

  it('thinkingEffort:off is coerced to undefined (not sent to iOS)', () => {
    const plain = projectRendererTab(
      { id: 't1', thinkingEffort: 'off', engineProfileId: null },
      BASE,
    )
    const ext = projectRendererTab(
      { id: 't2', thinkingEffort: 'off', engineProfileId: 'cos', hasEngineExtension: true },
      BASE,
    )
    expect(plain.thinkingEffort).toBeUndefined()
    expect(ext.thinkingEffort).toBeUndefined()
  })

  it('absent thinkingEffort is coerced to undefined', () => {
    const plain = projectRendererTab({ id: 't1', engineProfileId: null }, BASE)
    const ext = projectRendererTab({ id: 't2', engineProfileId: 'cos', hasEngineExtension: true }, BASE)
    expect(plain.thinkingEffort).toBeUndefined()
    expect(ext.thinkingEffort).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Elicitation queue snapshot projection (extension ctx.elicit → iOS parity).
//
// An extension's ctx.elicit() parks the engine on an indefinite human-wait; the
// queue must reach iOS through the snapshot so a paired phone can answer and
// the run is not silently stuck. projectRendererTab carries it; the renderer
// IIFE captures activeInst.elicitationQueue. Both are pinned here.
// ─────────────────────────────────────────────────────────────────────────────

describe('projectRendererTab — elicitationQueue wire projection', () => {
  it('carries the elicitation queue through to the wire shape', () => {
    const queue = [{ requestId: 'e1', mode: 'approval', schema: { agent: 'dev-lead' } }]
    const result = projectRendererTab(
      { id: 't1', title: 'T', engineProfileId: null },
      { lastMessage: null, permissionQueue: [], elicitationQueue: queue },
    )
    expect(result.elicitationQueue).toEqual(queue)
  })

  it('defaults to an empty array when no elicitation queue is provided', () => {
    const result = projectRendererTab(
      { id: 't2', title: 'T', engineProfileId: null },
      { lastMessage: null, permissionQueue: [] },
    )
    expect(result.elicitationQueue).toEqual([])
  })
})

describe('elicitationQueue — renderer IIFE source guard', () => {
  it('IIFE captures the active instance elicitationQueue and projects it', () => {
    const iife = extractIifeString(SNAPSHOT_SRC)
    // The capture: var elicitQueue = (activeInst && activeInst.elicitationQueue ...
    expect(iife).toMatch(/elicitQueue\s*=\s*\(activeInst\s*&&\s*activeInst\.elicitationQueue/)
    // The projection onto the per-tab object.
    expect(iife).toMatch(/elicitationQueue:\s*elicitQueue/)
  })
})
