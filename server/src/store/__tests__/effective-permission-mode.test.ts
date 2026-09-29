/**
 * effectivePermissionMode — WI-002 post-collapse test.
 *
 * After WI-002, TabState.permissionMode is gone. All tabs (plain and
 * extension-hosted) read permissionMode from the active ConversationInstance.
 * There is no tab-type fork in effectivePermissionMode.
 *
 * GUARD TEST: effectivePermissionMode must NOT branch on tab type. Any fork on
 * engineProfileId or tabHasExtensions inside the resolver turns the parity
 * cases below red (plain tab with plan-mode pane must read 'plan').
 *
 * PARITY TEST: a plain tab and an extension-hosted tab both return the same
 * value from effectivePermissionMode when they have identical pane state.
 *
 * REGRESSION: sticky-'plan' — if the parent tab had a stale 'plan' value in
 * old TabState (ghost field era), effectivePermissionMode must NOT read it.
 * Only the instance is authoritative.
 */

import { describe, it, expect } from 'vitest'
import { effectivePermissionMode } from '../conversation-instance'
import { MAIN_INSTANCE_ID } from '@ion/shared/session-key'

function paneWith(mode: 'auto' | 'plan') {
  return new Map([[
    'tab1',
    { instances: [{ id: MAIN_INSTANCE_ID, label: 'main', permissionMode: mode } as any], activeInstanceId: MAIN_INSTANCE_ID },
  ]])
}

// Minimal tab shape — engineProfileId is orthogonal to permissionMode storage
// post-WI-002; the resolver accepts { id: string } only.
const plainTab = { id: 'tab1', engineProfileId: null }
const extensionTab = { id: 'tab1', engineProfileId: 'cos' }

describe('effectivePermissionMode (WI-002 unified)', () => {
  // --- GUARD: no tab-type fork ---
  it('plain tab reads the active instance mode (not a tab-level ghost field)', () => {
    // A plain tab with a plan-mode instance must return 'plan'.
    // If the resolver had a branch returning a (now-removed) tab.permissionMode,
    // it would return 'auto' (the default) and this test would fail.
    expect(effectivePermissionMode(plainTab, paneWith('plan'))).toBe('plan')
  })

  it('extension-hosted tab reads the active instance mode', () => {
    expect(effectivePermissionMode(extensionTab, paneWith('plan'))).toBe('plan')
  })

  // --- PARITY: plain == extension-hosted for identical pane ---
  it('plain and extension-hosted tab return identical value for plan pane', () => {
    const panes = paneWith('plan')
    expect(effectivePermissionMode(plainTab, panes)).toBe(effectivePermissionMode(extensionTab, panes))
  })

  it('plain and extension-hosted tab return identical value for auto pane', () => {
    const panes = paneWith('auto')
    expect(effectivePermissionMode(plainTab, panes)).toBe(effectivePermissionMode(extensionTab, panes))
  })

  // --- REGRESSION: sticky-'plan' ghost field must not leak ---
  // Before WI-002, a plain tab that was set to plan mode would have
  // tab.permissionMode === 'plan' even after mode was changed to 'auto' on
  // the instance. The resolver must read ONLY the instance.
  it('sticky ghost field does not affect result (regression)', () => {
    // Simulate old ghost field: if someone snuck an old-style property onto
    // the tab object, it must be ignored. Only the instance is authoritative.
    const tabWithGhost = { id: 'tab1', engineProfileId: null, permissionMode: 'plan' } as any
    // Instance says 'auto' — resolver must return 'auto', not the ghost 'plan'.
    expect(effectivePermissionMode(tabWithGhost, paneWith('auto'))).toBe('auto')
  })

  it('re-introducing a parent write turns sticky-plan regression red (meta-test)', () => {
    // If someone "fixes" effectivePermissionMode to return tab.permissionMode
    // as a fallback for plain tabs, this test catches it.
    // A tab whose ghost field says 'plan' but instance says 'auto' MUST return 'auto'.
    const stickyPlanTab = { id: 'tab1', engineProfileId: null, permissionMode: 'plan' } as any
    const autoPanes = paneWith('auto')
    expect(effectivePermissionMode(stickyPlanTab, autoPanes)).not.toBe('plan')
  })

  // --- Missing pane: safe fallback ---
  it('missing pane: falls back to auto without throwing', () => {
    expect(effectivePermissionMode(plainTab, new Map())).toBe('auto')
    expect(effectivePermissionMode(extensionTab, new Map())).toBe('auto')
  })
})
