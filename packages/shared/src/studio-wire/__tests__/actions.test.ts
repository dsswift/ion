import { describe, expect, it } from 'vitest'
import { FORWARDED_ACTIONS, MIRROR_LOCAL_ACTIONS, validForwardedAction } from '../actions'
import { ACTIONS, scopeSatisfies } from '../action-scopes'
import { SCOPES } from '../types'

describe('studio-wire actions registry', () => {
  it('has exactly one ACTIONS entry per FORWARDED_ACTIONS entry', () => {
    expect(Object.keys(ACTIONS).sort()).toEqual(Object.keys(FORWARDED_ACTIONS).sort())
  })

  it('gives every action a scope from the C4 scope union', () => {
    for (const [name, spec] of Object.entries(ACTIONS)) {
      expect(SCOPES, `action ${name} has an out-of-union scope`).toContain(spec.requiredScope)
    }
  })

  it('carries the forwarder arg-shape spec verbatim as argsSchema', () => {
    for (const [name, spec] of Object.entries(FORWARDED_ACTIONS)) {
      expect(ACTIONS[name].argsSchema).toEqual(spec)
    }
  })

  it('classifies terminal-panel actions as terminal:operate', () => {
    expect(ACTIONS.runInTerminal.requiredScope).toBe('terminal:operate')
    expect(ACTIONS.toggleTerminal.requiredScope).toBe('terminal:operate')
  })

  it('classifies worktree/bench mutations as git:write', () => {
    expect(ACTIONS.syncWorktree.requiredScope).toBe('git:write')
    expect(ACTIONS.benchAssemble.requiredScope).toBe('git:write')
    expect(ACTIONS.retireWorktree.requiredScope).toBe('git:write')
  })

  it('forwards the worktree/bench refresh reads instead of running them mirror-local', () => {
    // These were misclassified under a "read-only IPC fetch into a
    // per-window derived cache" theory that predates the server-owned
    // store (ADR-033). Their real implementation is `git`/filesystem I/O
    // that only exists in the server process; running them mirror-local
    // (in ANY Studio window, not just a browser client) hits
    // `host-api-git.ts`'s build-time renderer stub and throws "cannot run
    // in the Studio renderer" from a render-time effect.
    for (const name of [
      'refreshWorktreeInventory',
      'refreshBench',
      'refreshWorkspaceViews',
      'benchRerereCount',
    ]) {
      expect(FORWARDED_ACTIONS, `${name} must be forwarded, not mirror-local`).toHaveProperty(name)
      expect(MIRROR_LOCAL_ACTIONS, `${name} must not also be mirror-local`).not.toHaveProperty(name)
      expect(ACTIONS[name].requiredScope).toBe('git:write')
    }
  })

  it('forwards requestCloseTab instead of running its git appraisal mirror-local', () => {
    // requestCloseTab's worktree appraisal calls host-api-git.ts's
    // gitWorktreeAppraise -- real git I/O, server-owned per ADR-033. Its
    // reconciliation is special-cased in secondary-store-reconcile.ts
    // (reconcileForwardedCloseIntent) because the close dialog is per-window.
    expect(FORWARDED_ACTIONS).toHaveProperty('requestCloseTab')
    expect(MIRROR_LOCAL_ACTIONS).not.toHaveProperty('requestCloseTab')
    expect(ACTIONS.requestCloseTab.requiredScope).toBe('conversations:operate')
    // confirmCloseTab/cancelCloseTab stay mirror-local: they only clear the
    // per-window closeIntent requestCloseTab (now forwarded) raised locally.
    expect(FORWARDED_ACTIONS).not.toHaveProperty('confirmCloseTab')
    expect(FORWARDED_ACTIONS).not.toHaveProperty('cancelCloseTab')
  })

  it('forwards engine pass-throughs instead of running them mirror-local', () => {
    // These were classified under the pre-ADR-033 model, where "pass-through
    // to engine" meant an IPC round trip to a bridge every window had. Their
    // real implementation (host-api-engine.ts / host-api-misc.ts) now only
    // exists in the server process; running them mirror-local either rejects
    // outright (respondPermission, respondElicitation, respondEngineDialog,
    // interrupt's engineAbort, abortDispatch/abortDispatches,
    // submitRemotePrompt's prompt()) or silently no-ops
    // (stopBackgroundTask's engineStopBackgroundTask, initStaticInfo's
    // start(), loadSkeletonMessages' loadChainHistory/loadTabContent).
    for (const name of [
      'respondPermission',
      'respondElicitation',
      'respondEngineDialog',
      'interrupt',
      'abortDispatch',
      'abortDispatches',
      'stopBackgroundTask',
      'submitRemotePrompt',
      'initStaticInfo',
      'loadSkeletonMessages',
    ]) {
      expect(FORWARDED_ACTIONS, `${name} must be forwarded, not mirror-local`).toHaveProperty(name)
      expect(MIRROR_LOCAL_ACTIONS, `${name} must not also be mirror-local`).not.toHaveProperty(name)
      expect(ACTIONS[name].requiredScope).toBe('conversations:operate')
    }
  })

  it('classifies tab/prompt-pipeline actions as conversations:operate', () => {
    expect(ACTIONS.selectTab.requiredScope).toBe('conversations:operate')
    expect(ACTIONS.submit.requiredScope).toBe('conversations:operate')
  })

  it('accepts setTabModel with an explicit providerId third argument', () => {
    // Regression: the qualified-model-id fix (send-slice.ts resolvePromptModel)
    // depends on a picker/remote pick reaching the store as
    // setTabModel(tabId, model, providerId). A stale maxArgs:2 spec would
    // silently reject the providerId argument on the forwarded-action path
    // (Studio mirror / iOS via studio_action), the same failure mode the
    // other stale-spec regression tests above pin.
    expect(FORWARDED_ACTIONS.setTabModel).toEqual({ minArgs: 1, maxArgs: 3, tabIdAt: 0 })
    expect(validForwardedAction('setTabModel', ['tab-1', 'claude-fable-5-1'])).toBe(true)
    expect(validForwardedAction('setTabModel', ['tab-1', 'claude-fable-5-1', 'anthropic'])).toBe(true)
    expect(validForwardedAction('setTabModel', ['tab-1', 'claude-fable-5-1', 'anthropic', 'extra'])).toBe(false)
  })
})

describe('scopeSatisfies', () => {
  it('is true when the exact scope is present', () => {
    expect(scopeSatisfies(['terminal:operate'], 'terminal:operate')).toBe(true)
  })

  it('is false when neither the exact scope nor admin is present', () => {
    expect(scopeSatisfies(['conversations:operate'], 'terminal:operate')).toBe(false)
  })

  it('admin satisfies every scope', () => {
    for (const scope of SCOPES) {
      expect(scopeSatisfies(['admin'], scope)).toBe(true)
    }
  })
})

describe('FORWARDED_ACTIONS: actions that act on the active tab', () => {
  // These name no tab. A window holds tabs from several environments, so the
  // mirror must route them by the window's active tab and carry its id.
  it('marks every no-tab action that acts on the active tab, and none that names one', () => {
    const marked = Object.entries(FORWARDED_ACTIONS).filter(([, spec]) => spec.activeTab).map(([name]) => name).sort()
    expect(marked).toEqual(['addAttachments', 'addDirectory', 'clearAttachments', 'clearTab', 'removeAttachment', 'removeDirectory', 'setPermissionMode', 'setThinkingEffort', 'togglePermissionMode'])
    for (const name of marked) expect(FORWARDED_ACTIONS[name].tabIdAt).toBeUndefined()
  })
})
