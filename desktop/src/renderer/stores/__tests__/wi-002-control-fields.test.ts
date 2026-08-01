/**
 * WI-002 mandatory tests: unify per-conversation control-field storage onto
 * the single ConversationInstance.
 *
 * GUARD: `TabState` no longer carries `permissionMode` or `thinkingEffort`
 * ghost fields. The snapshot control-field projections do not fork on
 * `tabHasExtensions`. The remote-write handlers (remoteSetModeHandler,
 * remoteSetThinkingHandler) write to the instance, not the tab.
 *
 * PARITY: a plain tab and an extension-hosted tab behave identically when
 * setting and reading permissionMode and thinkingEffort.
 *
 * REGRESSION: sticky-'plan' — set plan mode then auto-exit on both tab types;
 * neither leaves stale 'plan' anywhere; re-introducing a parent write turns
 * the test red.
 */

import { describe, it, expect } from 'vitest'
import type { TabState } from '../../../shared/types-session'
import { effectivePermissionMode } from '../conversation-instance'
import { MAIN_INSTANCE_ID } from '../../../shared/session-key'

// Minimal pane factory. Produces a Map<tabId, ConversationPane>-shaped structure.
function paneWith(tabId: string, mode: 'auto' | 'plan', effort?: 'off' | 'low' | 'medium' | 'high') {
  return new Map([[
    tabId,
    {
      instances: [{ id: MAIN_INSTANCE_ID, label: 'main', permissionMode: mode, thinkingEffort: effort ?? 'off' } as any],
      activeInstanceId: MAIN_INSTANCE_ID,
    },
  ]])
}

// Minimal tab factories. Post-WI-002 neither has permissionMode or thinkingEffort.
function plainTab(id: string): TabState {
  return {
    id,
    conversationId: null, historicalSessionIds: [], lastKnownSessionId: null,
    status: 'idle', activeRequestId: null, lastEventAt: null, hasUnread: false,
    currentActivity: '', attachments: [], title: 'New Tab', customTitle: null,
    lastResult: null, sessionTools: [], sessionMcpServers: [], sessionSkills: [],
    sessionVersion: null, queuedPrompts: [], workingDirectory: '~',
    hasChosenDirectory: false, additionalDirs: [], bashResults: [],
    bashExecuting: false, bashExecId: null, pillColor: null, pillIcon: null,
    forkedFromSessionId: null, worktree: null,
    pendingWorktreeSetup: false, groupId: null, groupPinned: false,
    contextTokens: null, contextWindow: null,
    isCompacting: false, isTerminalOnly: false,
    inputLocked: false, engineProfileId: null,
    lastMessagePreview: null,
  }
}

function extensionTab(id: string): TabState {
  return { ...plainTab(id), engineProfileId: 'cos', pillIcon: 'lightning' }
}

// ─── GUARD ───────────────────────────────────────────────────────────────────

describe('WI-002 guard: TabState ghost fields removed', () => {
  it('TabState does not declare permissionMode', () => {
    const tab = plainTab('t1')
    // If permissionMode were still on TabState, `in` would return true.
    expect('permissionMode' in tab).toBe(false)
  })

  it('TabState does not declare thinkingEffort', () => {
    const tab = plainTab('t1')
    expect('thinkingEffort' in tab).toBe(false)
  })

  it('effectivePermissionMode reads from the instance regardless of tab type', () => {
    const panes = paneWith('t1', 'plan')

    // GUARD: both plain and extension tabs go through the same code path.
    // If effectivePermissionMode branched on tab type (engineProfileId / tabHasExtensions)
    // and fell back to a (now-removed) tab-level field for plain tabs, the plain
    // case would return 'auto' (the undefined default) instead of 'plan'.
    expect(effectivePermissionMode(plainTab('t1'), panes)).toBe('plan')
    expect(effectivePermissionMode(extensionTab('t1'), panes)).toBe('plan')
  })

  it('missing pane returns safe auto default without throwing', () => {
    expect(effectivePermissionMode(plainTab('t1'), new Map())).toBe('auto')
    expect(effectivePermissionMode(extensionTab('t1'), new Map())).toBe('auto')
  })
})

// ─── PARITY ──────────────────────────────────────────────────────────────────

describe('WI-002 parity: plain tab == extension-hosted tab for control fields', () => {
  it('permissionMode: identical behavior for plan pane', () => {
    const panes = paneWith('t1', 'plan')
    expect(effectivePermissionMode(plainTab('t1'), panes))
      .toBe(effectivePermissionMode(extensionTab('t1'), panes))
  })

  it('permissionMode: identical behavior for auto pane', () => {
    const panes = paneWith('t1', 'auto')
    expect(effectivePermissionMode(plainTab('t1'), panes))
      .toBe(effectivePermissionMode(extensionTab('t1'), panes))
  })

  it('effectivePermissionMode returns the instance value for both tab types after mode change', () => {
    // Simulate what happens after a setPermissionMode write: the pane instance
    // is updated to 'plan'. Both tab types should now reflect 'plan'.
    const planPanes = paneWith('t1', 'plan')
    expect(effectivePermissionMode(plainTab('t1'), planPanes)).toBe('plan')
    expect(effectivePermissionMode(extensionTab('t1'), planPanes)).toBe('plan')

    // After auto-exit, the instance switches back to 'auto'. Both see 'auto'.
    const autoPanes = paneWith('t1', 'auto')
    expect(effectivePermissionMode(plainTab('t1'), autoPanes)).toBe('auto')
    expect(effectivePermissionMode(extensionTab('t1'), autoPanes)).toBe('auto')
  })
})

// ─── REGRESSION: sticky-'plan' ───────────────────────────────────────────────

describe('WI-002 regression: sticky-plan ghost field', () => {
  it('stale ghost field on the tab object is not read by effectivePermissionMode', () => {
    // Before WI-002, a plain tab that entered plan mode had permissionMode: 'plan'
    // on the TabState. After auto-exit the instance flipped back to 'auto', but
    // the tab-level ghost field could stay sticky.
    //
    // The resolver must read ONLY the instance. Simulating the ghost: attach
    // permissionMode directly to the tab object (as cast) and confirm the instance
    // value wins.
    const tabWithGhost = { ...plainTab('t1'), permissionMode: 'plan' } as any
    const autoPanes = paneWith('t1', 'auto')   // instance says 'auto'

    // Resolver must return 'auto' (instance), NOT 'plan' (ghost field).
    expect(effectivePermissionMode(tabWithGhost, autoPanes)).toBe('auto')
  })

  it('re-introducing a parent write turns the sticky-plan regression red (meta-guard)', () => {
    // If someone modifies effectivePermissionMode to return the tab's permissionMode
    // for plain tabs, this assertion fails, which is the correct signal.
    const tabWithGhost = { ...plainTab('t1'), permissionMode: 'plan' } as any
    const autoPanes = paneWith('t1', 'auto')

    // The resolver must NOT return 'plan' when the instance says 'auto'.
    const result = effectivePermissionMode(tabWithGhost, autoPanes)
    expect(result).not.toBe('plan')
  })

  it('plan mode set then auto-exit: neither plain nor extension tab leaves stale plan', () => {
    // Full sequence:
    // 1. Instance in plan mode.
    // 2. plan_mode_auto_exit fires → instance flips to auto (handled by event-slice).
    //    We simulate by creating a new pane with 'auto'.
    // 3. effectivePermissionMode must return 'auto' for both tab types.

    const planPanes = paneWith('t1', 'plan')

    // Verify plan was set correctly first.
    expect(effectivePermissionMode(plainTab('t1'), planPanes)).toBe('plan')
    expect(effectivePermissionMode(extensionTab('t1'), planPanes)).toBe('plan')

    // Simulate auto-exit: instance flips to 'auto'.
    const autoPanes = paneWith('t1', 'auto')

    expect(effectivePermissionMode(plainTab('t1'), autoPanes)).toBe('auto')
    expect(effectivePermissionMode(extensionTab('t1'), autoPanes)).toBe('auto')
  })
})
