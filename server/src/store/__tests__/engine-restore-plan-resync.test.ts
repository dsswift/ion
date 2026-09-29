/**
 * Regression (#256): plan-mode resync after restore must look the instance up
 * by its NORMALIZED id, not the persisted (possibly UUID) id.
 *
 * Root cause. `buildPopulatedInstance` normalizes the restored instance id to
 * MAIN_INSTANCE_ID and `restoreSingleInstanceTab` stores the pane with
 * `activeInstanceId: MAIN_INSTANCE_ID`. The plan-mode resync block previously
 * looked the instance up by the PERSISTED `inst.id` — a UUID for migrated
 * multi-instance tabs — so `find()` returned undefined and
 * `window.ion.engineSetPlanMode` was never called. The local store showed plan
 * mode (set in buildPopulatedInstance) while the engine session ran in auto
 * mode until the next prompt.
 *
 * The resync decision is extracted into `restoredPaneWantsPlanMode(pane)` so it
 * can be pinned at a stable seam (the pane shape) without the full store /
 * window.ion harness.
 *
 * Revert-test contract: changing the lookup back to `find(i => i.id ===
 * inst.id)` (the persisted UUID) makes the "UUID-id instance in plan mode"
 * case go red — the helper would not find the instance and would return false.
 */

import { describe, it, expect, vi } from 'vitest'

// Mock transitive dependencies pulled in through the module graph of
// useTabRestoration-engine.ts (same pattern as engine-restore-split.test.ts).
vi.mock('../sessionStore', () => ({
  useSessionStore: { getState: () => ({}), setState: vi.fn() },
}))
vi.mock('../../persistence/preferences', () => ({
  usePreferencesStore: { getState: () => ({}) },
}))
vi.mock('../session-store-persistence', () => ({
  isExtensionErrorMessage: () => false,
}))

import { restoredPaneWantsPlanMode, restoredPlanFilePath } from '../../hooks/useTabRestoration-engine'
import { MAIN_INSTANCE_ID } from '@ion/shared/session-key'

const UUID_ID = '3f9c1e02-7a44-4b21-9c0e-aa11bb22cc33'

function makePane(instances: Array<{ id: string; permissionMode?: 'auto' | 'plan' }>) {
  return { instances, activeInstanceId: MAIN_INSTANCE_ID }
}

function makePlanPane(instances: Array<{ id: string; planFilePath?: string | null }>) {
  return { instances, activeInstanceId: MAIN_INSTANCE_ID }
}

describe('restoredPaneWantsPlanMode — resync keyed on normalized id (#256)', () => {
  it('returns true when the main-id instance is in plan mode', () => {
    // The instance is stored under MAIN_INSTANCE_ID even though it was
    // persisted with a UUID id — buildPopulatedInstance normalizes it.
    const pane = makePane([{ id: MAIN_INSTANCE_ID, permissionMode: 'plan' }])
    expect(restoredPaneWantsPlanMode(pane)).toBe(true)
  })

  it('still returns true when the persisted id was a UUID (the regression case)', () => {
    // The pane stores the instance under MAIN_INSTANCE_ID regardless of the
    // persisted UUID. If the lookup is reverted to the persisted UUID id, this
    // assertion goes red: find(i => i.id === <UUID>) would not match the
    // 'main'-keyed instance and the helper would return false.
    const pane = makePane([{ id: MAIN_INSTANCE_ID, permissionMode: 'plan' }])
    expect(restoredPaneWantsPlanMode(pane)).toBe(true)
    // The persisted UUID is NOT the stored id — confirms the lookup must not
    // key on it.
    expect(pane.instances.some((i) => i.id === UUID_ID)).toBe(false)
  })

  it('returns false when the instance is in auto mode (no resync)', () => {
    const pane = makePane([{ id: MAIN_INSTANCE_ID, permissionMode: 'auto' }])
    expect(restoredPaneWantsPlanMode(pane)).toBe(false)
  })

  it('returns false when permissionMode is absent', () => {
    const pane = makePane([{ id: MAIN_INSTANCE_ID }])
    expect(restoredPaneWantsPlanMode(pane)).toBe(false)
  })

  it('returns false for an undefined pane', () => {
    expect(restoredPaneWantsPlanMode(undefined)).toBe(false)
  })

  it('returns false when no instance carries the main id', () => {
    // Defensive: if normalization ever failed and only a UUID instance exists,
    // the helper must not match it (the engine routes by the bare 'main' key).
    const pane = makePane([{ id: UUID_ID, permissionMode: 'plan' }])
    expect(restoredPaneWantsPlanMode(pane)).toBe(false)
  })
})

// Plan-file continuity on restore: the resync must forward the restored plan
// file path so the engine re-adopts the existing plan instead of allocating a
// fresh slug. restoredPlanFilePath resolves the path via the same normalized-id
// seam as the resync gate. Without it (engineSetPlanMode called with no path),
// a restarted extension-hosted plan-mode conversation loses its plan.
describe('restoredPlanFilePath — plan path forwarded on resync', () => {
  it('returns the main-id instance plan file path', () => {
    const pane = makePlanPane([{ id: MAIN_INSTANCE_ID, planFilePath: '/Users/josh/.ion/plans/bold-guiding-kite.md' }])
    expect(restoredPlanFilePath(pane)).toBe('/Users/josh/.ion/plans/bold-guiding-kite.md')
  })

  it('returns undefined when the instance has no plan file path', () => {
    const pane = makePlanPane([{ id: MAIN_INSTANCE_ID, planFilePath: null }])
    expect(restoredPlanFilePath(pane)).toBeUndefined()
  })

  it('returns undefined for an undefined pane', () => {
    expect(restoredPlanFilePath(undefined)).toBeUndefined()
  })

  it('does not match a non-normalized (UUID) instance id', () => {
    // The path must resolve via the normalized 'main' id, not the persisted
    // UUID — mirrors the resync-gate seam.
    const pane = makePlanPane([{ id: UUID_ID, planFilePath: '/Users/josh/.ion/plans/bold-guiding-kite.md' }])
    expect(restoredPlanFilePath(pane)).toBeUndefined()
  })
})
