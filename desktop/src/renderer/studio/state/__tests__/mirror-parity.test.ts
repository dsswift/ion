// @vitest-environment jsdom
/**
 * Mirror-parity gate (mechanism 2 of the overlay↔Studio parity contract).
 *
 * Enumerates every function-valued key on the REAL session store and
 * asserts each is classified in exactly one of FORWARDED_ACTIONS or
 * MIRROR_LOCAL_ACTIONS. Adding a store action without classifying it —
 * or leaving a stale entry behind after removing one — fails here, forcing
 * an explicit parity decision. See shared/studio-mirror-actions.ts.
 */
import { describe, it, expect, vi } from 'vitest'
import { FORWARDED_ACTIONS, MIRROR_LOCAL_ACTIONS, validForwardedAction } from '../../../../shared/studio-mirror-actions'

describe('mirror-parity classification', async () => {
  const { useSessionStore } = await import('../../../stores/sessionStore')
  const state = useSessionStore.getState() as unknown as Record<string, unknown>
  const storeActions = Object.keys(state)
    .filter((k) => typeof state[k] === 'function')
    .sort()

  it('every store action is classified exactly once', () => {
    const forwarded = new Set(Object.keys(FORWARDED_ACTIONS))
    const local = new Set(Object.keys(MIRROR_LOCAL_ACTIONS))
    const unclassified = storeActions.filter((a) => !forwarded.has(a) && !local.has(a))
    const doubled = storeActions.filter((a) => forwarded.has(a) && local.has(a))
    expect(unclassified, 'unclassified store actions — add each to FORWARDED_ACTIONS or MIRROR_LOCAL_ACTIONS with a justification').toEqual([])
    expect(doubled, 'actions classified in BOTH tables').toEqual([])
  })

  it('only forwards actions that exist on the current store', () => {
    const actions = new Set(storeActions)
    const staleForwardedActions = Object.keys(FORWARDED_ACTIONS)
      .filter((action) => !actions.has(action))
    expect(staleForwardedActions).toEqual([])
  })

  it('every mirror-local entry carries a justification', () => {
    for (const [name, reason] of Object.entries(MIRROR_LOCAL_ACTIONS)) {
      expect(reason.length, `${name} needs a justification`).toBeGreaterThan(8)
    }
  })
})

describe('Studio attachment mirror', () => {
  it('shows forwarded queued attachments before owner snapshot debounce completes', async () => {
    const { reconcileAttachmentTabs } = await import('../secondary-store')
    const attachment = {
      id: 'queued-image', type: 'image' as const, name: 'pasted image.png',
      path: '/tmp/pasted-image.png', mimeType: 'image/png',
    }
    const tabs = [{ id: 'tab-a', attachments: [] }] as never

    const staged = reconcileAttachmentTabs(tabs, 'tab-a', 'addAttachments', [[attachment]])
    expect(staged[0].attachments).toEqual([attachment])

    const cleared = reconcileAttachmentTabs(staged, 'tab-a', 'clearAttachments', [])
    expect(cleared[0].attachments).toEqual([])
  })
})

describe('Studio rewind composer mirror', () => {
  it('restores the owner rewind result into the exact Studio composer', async () => {
    const { useSessionStore } = await import('../../../stores/sessionStore')
    const { reconcileForwardedRewind } = await import('../secondary-store')
    const image = {
      id: 'rewound-image', type: 'image' as const, name: 'diagram.png',
      path: '/tmp/diagram.png', mimeType: 'image/png',
    }
    useSessionStore.setState({
      tabs: [
        { id: 'tab-a', pendingInput: 'leave alone', attachments: [] },
        { id: 'tab-b', attachments: [] },
      ] as never,
      conversationPanes: new Map([
        ['tab-a', {
          activeInstanceId: 'main',
          instances: [
            { id: 'main', draftInput: 'other draft' },
            { id: 'worker', draftInput: '' },
          ],
        }],
        ['tab-b', { activeInstanceId: 'main', instances: [{ id: 'main', draftInput: '' }] }],
      ]) as never,
    })

    const applied = reconcileForwardedRewind(
      'rewindEngineInstance',
      ['tab-a', 'worker', 'message-1', 1],
      { ok: true, prefill: { text: 'full\nmulti-line prompt', attachments: [image] } },
    )

    expect(applied).toBe(true)
    const state = useSessionStore.getState()
    const pane = state.conversationPanes.get('tab-a')!
    expect(pane.instances.find((instance) => instance.id === 'worker')?.draftInput).toBe('full\nmulti-line prompt')
    expect(pane.instances.find((instance) => instance.id === 'main')?.draftInput).toBe('other draft')
    expect(state.tabs.find((tab) => tab.id === 'tab-a')?.pendingInput).toBe('full\nmulti-line prompt')
    expect(state.tabs.find((tab) => tab.id === 'tab-a')?.attachments).toEqual([image])
    expect(state.tabs.find((tab) => tab.id === 'tab-b')?.pendingInput).toBeUndefined()
    useSessionStore.setState({ tabs: [], conversationPanes: new Map(), activeTabId: undefined })
  })

  it('leaves the Studio composer untouched when the owner rejects the rewind', async () => {
    const { useSessionStore } = await import('../../../stores/sessionStore')
    const { reconcileForwardedRewind } = await import('../secondary-store')
    useSessionStore.setState({
      tabs: [{ id: 'tab-a', pendingInput: 'existing text', attachments: [] }] as never,
      conversationPanes: new Map([
        ['tab-a', { activeInstanceId: 'main', instances: [{ id: 'main', draftInput: 'existing text' }] }],
      ]) as never,
    })

    const applied = reconcileForwardedRewind(
      'rewindEngineInstance',
      ['tab-a', 'main', 'message-1'],
      { ok: false, error: 'rewind rejected' },
    )

    expect(applied).toBe(false)
    const state = useSessionStore.getState()
    expect(state.tabs[0].pendingInput).toBe('existing text')
    expect(state.conversationPanes.get('tab-a')?.instances[0].draftInput).toBe('existing text')
    useSessionStore.setState({ tabs: [], conversationPanes: new Map(), activeTabId: undefined })
  })
})

describe('applyMirrorOverrides', () => {
  it('swaps every forwarded action for an IPC forwarder and leaves locals intact', async () => {
    const forwarded: Array<{ action: string; args: unknown[] }> = []
    ;(window as unknown as { ion: unknown }).ion = {
      ...(window as unknown as { ion?: object }).ion,
      studioCallAction: (action: string, args: unknown[]) => {
        forwarded.push({ action, args })
        const value = action === 'rewindEngineInstance'
          ? { ok: true, prefill: { text: 'restored by forwarder', attachments: [] } }
          : undefined
        return Promise.resolve({ ok: true, value })
      },
    }
    const { useSessionStore } = await import('../../../stores/sessionStore')
    const { applyMirrorOverrides } = await import('../secondary-store')
    useSessionStore.setState({
      activeTabId: 'tab-123',
      tabs: [{ id: 'tab-123', attachments: [] }] as never,
      conversationPanes: new Map([
        ['tab-123', { activeInstanceId: 'main', instances: [{ id: 'main', draftInput: '' }] }],
      ]) as never,
    })
    const before = useSessionStore.getState() as unknown as Record<string, unknown>
    const localBefore = before.toggleGitPanel

    const swapped = applyMirrorOverrides()
    const storeActions = new Set(Object.keys(before).filter((action) => typeof before[action] === 'function'))
    const expectedForwarded = Object.keys(FORWARDED_ACTIONS)
      .filter((action) => storeActions.has(action))
      .sort()
    expect(swapped.sort()).toEqual(expectedForwarded)

    const after = useSessionStore.getState() as unknown as Record<string, unknown>
    // A forwarded action now routes over IPC instead of mutating locally.
    await (after.selectTab as (id: string) => Promise<unknown>)('tab-123')
    expect(forwarded).toEqual([{ action: 'selectTab', args: ['tab-123'] }])
    // Mirror-local actions are untouched.
    expect(after.toggleGitPanel).toBe(localBefore)
    // A rewind forwarder applies the returned composer state in this window.
    await (after.rewindEngineInstance as (...args: unknown[]) => Promise<unknown>)('tab-123', 'main', 'message-1')
    expect(forwarded).toEqual([
      { action: 'selectTab', args: ['tab-123'] },
      { action: 'rewindEngineInstance', args: ['tab-123', 'main', 'message-1'] },
    ])
    expect(useSessionStore.getState().tabs[0].pendingInput).toBe('restored by forwarder')
    expect(useSessionStore.getState().conversationPanes.get('tab-123')?.instances[0].draftInput).toBe('restored by forwarder')
    // Idempotent: a second call swaps nothing.
    expect(applyMirrorOverrides()).toEqual([])
    useSessionStore.setState({ tabs: [], conversationPanes: new Map(), activeTabId: undefined })
  })

  it('reflects forwarded tab selection before the owner round trip resolves', async () => {
    let resolveOwner: ((value: { ok: true; value: undefined }) => void) | undefined
    ;(window as unknown as { ion: unknown }).ion = {
      ...(window as unknown as { ion?: object }).ion,
      studioCallAction: () => new Promise((resolve) => { resolveOwner = resolve }),
    }
    const { useSessionStore } = await import('../../../stores/sessionStore')
    const { applyMirrorOverrides } = await import('../secondary-store')
    useSessionStore.setState({
      activeTabId: 'tab-a',
      tabs: [{ id: 'tab-a', attachments: [] }, { id: 'tab-b', attachments: [] }] as never,
      conversationPanes: new Map([
        ['tab-a', { activeInstanceId: 'main', instances: [{ id: 'main', draftInput: '' }] }],
        ['tab-b', { activeInstanceId: 'main', instances: [{ id: 'main', draftInput: '' }] }],
      ]) as never,
    })
    applyMirrorOverrides()

    const selection = (useSessionStore.getState().selectTab as unknown as (id: string) => Promise<unknown>)('tab-b')
    expect(useSessionStore.getState().activeTabId).toBe('tab-b')
    resolveOwner?.({ ok: true, value: undefined })
    await selection
    useSessionStore.setState({ tabs: [], conversationPanes: new Map(), activeTabId: undefined })
  })

  /**
   * EVERY forwarded override must return a thenable.
   *
   * The real store actions are async and call sites chain on that signature:
   * `.then()`, `.catch()`, `.finally()`, `await`. A void-returning override
   * turns each into `TypeError: Cannot read properties of undefined (reading
   * 'then')` inside a click handler — and TypeScript cannot catch it, because
   * the overrides are installed via `setState(... as never)` so every call site
   * still sees the store's promise-returning types.
   *
   * That was live: the AI-assisted conflict resolver's `.catch` — the branch
   * that puts a refusal in the error banner — never ran in the Studio window, and
   * the dialog neither closed nor reported. Roughly a dozen other call sites
   * across WorktreesSection / IntegrationSection / WorktreeRowMenu had the same
   * shape.
   *
   * Iterating FORWARDED_ACTIONS rather than a hardcoded list is deliberate: a
   * newly-forwarded async action is covered the moment it joins the table.
   *
   * Red on revert: drop `return Promise.resolve(undefined)` from the forwarder
   * in secondary-store.ts and every action here fails.
   */
  it('returns a thenable from every forwarded override', async () => {
    ;(window as unknown as { ion: unknown }).ion = {
      ...(window as unknown as { ion?: object }).ion,
      studioCallAction: () => Promise.resolve({ ok: true, value: undefined }),
    }
    const { useSessionStore } = await import('../../../stores/sessionStore')
    const { applyMirrorOverrides } = await import('../secondary-store')
    applyMirrorOverrides()
    const after = useSessionStore.getState() as unknown as Record<string, unknown>

    const notThenable: string[] = []
    for (const [name, spec] of Object.entries(FORWARDED_ACTIONS)) {
      const fn = after[name]
      if (typeof fn !== 'function') continue
      // Placeholder args satisfying the declared arity. A forwarder ignores
      // their content — it only serializes them onto the wire.
      const args = Array.from({ length: spec.minArgs }, (_, i) =>
        i === spec.tabIdAt ? 'tab-1' : 'x')
      const ret = (fn as (...a: unknown[]) => unknown)(...args)
      if (typeof (ret as { then?: unknown } | undefined)?.then !== 'function') {
        notThenable.push(name)
      }
    }
    expect(
      notThenable,
      'forwarded overrides whose return value cannot be chained — a .then/.catch/await on these throws in the Studio window',
    ).toEqual([])
  })

  /**
   * The forwarder resolves the OWNER'S actual return value.
   *
   * This is what makes `const result = await store.retireWorktree(…)` work in
   * the mirror. A resolved-but-empty promise fixed the TypeError above but left
   * every await-and-inspect call site reading fields off `undefined`, so the
   * round trip has to carry the value back.
   *
   * Red on revert: return `undefined` (or a bare resolve) from the forwarder
   * instead of `reply.value` and this fails.
   */
  it("resolves the owner's return value", async () => {
    const ownerResult = { ok: false, error: 'worktree has uncommitted changes' }
    ;(window as unknown as { ion: unknown }).ion = {
      ...(window as unknown as { ion?: object }).ion,
      studioCallAction: () => Promise.resolve({ ok: true, value: ownerResult }),
    }
    const { useSessionStore } = await import('../../../stores/sessionStore')
    const { applyMirrorOverrides } = await import('../secondary-store')
    applyMirrorOverrides()
    const after = useSessionStore.getState() as unknown as Record<string, unknown>

    const result = await (after.retireWorktree as (...a: unknown[]) => Promise<unknown>)(
      '/repo', '/repo/wt', 'branch',
    )
    // The domain result arrives intact — a refusal reads as a refusal, not as
    // an absent answer.
    expect(result).toEqual(ownerResult)
  })

  /**
   * A transport fault resolves `undefined` rather than rejecting.
   *
   * "No owner window" and "the owner never replied" are not failures a click
   * handler can recover from beyond reporting "no result", and throwing would
   * hijack a `.catch` written for the action's own domain errors. The mirror
   * logs the fault; the caller sees the same shape a valueless action produces.
   */
  it('resolves undefined when the round trip fails, without rejecting', async () => {
    ;(window as unknown as { ion: unknown }).ion = {
      ...(window as unknown as { ion?: object }).ion,
      studioCallAction: () => Promise.resolve({ ok: false, error: 'no owner window' }),
    }
    const { useSessionStore } = await import('../../../stores/sessionStore')
    const { applyMirrorOverrides } = await import('../secondary-store')
    applyMirrorOverrides()
    const after = useSessionStore.getState() as unknown as Record<string, unknown>

    await expect(
      (after.selectTab as (id: string) => Promise<unknown>)('tab-123'),
    ).resolves.toBeUndefined()
  })
})

describe('validForwardedAction (main-side wire validation)', () => {
  it('accepts a well-shaped forwarded call', () => {
    expect(validForwardedAction('selectTab', ['tab-1'])).toBe(true)
    expect(validForwardedAction('submit', ['tab-1', 'hello', { model: 'x' }])).toBe(true)
  })
  it('rejects unknown actions, bad arity, and bad tab ids', () => {
    expect(validForwardedAction('handleNormalizedEvent', ['t', {}])).toBe(false) // local, not forwarded
    expect(validForwardedAction('definitely-not-an-action', [])).toBe(false)
    expect(validForwardedAction('selectTab', [])).toBe(false) // arity
    expect(validForwardedAction('selectTab', [42])).toBe(false) // tabId type
    expect(validForwardedAction('selectTab', ['x'.repeat(200)])).toBe(false) // tabId length
    expect(validForwardedAction(42, ['tab-1'])).toBe(false)
    expect(validForwardedAction('selectTab', 'tab-1')).toBe(false) // args not array
  })

  /**
   * Regression coverage for a defect class: several FORWARDED_ACTIONS specs
   * declared an arity that did not match the real store action's signature,
   * making legitimate calls structurally unrejectable (an arity mismatch
   * fails validForwardedAction BEFORE the call ever reaches the store), or
   * validating the wrong argument as a tabId. Each case below is the exact
   * shape a real caller sends — validForwardedAction must accept it.
   */
  it('accepts the real-arity call for every action whose spec was previously mismatched', () => {
    // clearTab: real signature is () => void — no arguments, no tabId.
    expect(validForwardedAction('clearTab', [])).toBe(true)
    // reorderTabs: real signature is (tabs: TabState[]) => void — one array arg.
    expect(validForwardedAction('reorderTabs', [[{ id: 'tab-1' }]])).toBe(true)
    // addDirectory/removeDirectory: real signature is (dir: string) => void,
    // acting on the owner's active tab — no tabId argument at all, and a long
    // filesystem path must not be rejected as an oversized "tabId".
    const longPath = '/Users/example/very/long/project/path/' + 'x'.repeat(150)
    expect(validForwardedAction('addDirectory', [longPath])).toBe(true)
    expect(validForwardedAction('removeDirectory', [longPath])).toBe(true)
    // setupWorktree: real signature is (tabId, sourceBranch, setAsDefault) —
    // all three required.
    expect(validForwardedAction('setupWorktree', ['tab-1', 'main', false])).toBe(true)
    // forceRecoverTab: real signature is (tabId, reason) — both required.
    expect(validForwardedAction('forceRecoverTab', ['tab-1', 'stuck'])).toBe(true)
    // resumeSession: up to 5 optional-tail arguments must all be accepted.
    expect(validForwardedAction('resumeSession', ['sess-1', 'title', '/proj', 'Custom', '/enc'])).toBe(true)
    // resumeSessionWithChain: historicalSessionIds is a required 2nd argument;
    // up to 6 total arguments must be accepted.
    expect(validForwardedAction('resumeSessionWithChain', ['sess-1', ['sess-0'], 'title', '/proj', 'Custom', '/enc'])).toBe(true)
    // editQueuedMessage: real signature is (tabId) — a single argument.
    expect(validForwardedAction('editQueuedMessage', ['tab-1'])).toBe(true)
    // rewindEngineInstance: (tabId, instanceId, messageId, userTurnIndex?) —
    // both the 3-arg and 4-arg real call shapes must be accepted.
    expect(validForwardedAction('rewindEngineInstance', ['tab-1', 'main', 'msg-1'])).toBe(true)
    expect(validForwardedAction('rewindEngineInstance', ['tab-1', 'main', 'msg-1', 2])).toBe(true)
    // resetEngineInstance: (tabId, instanceId) — both required.
    expect(validForwardedAction('resetEngineInstance', ['tab-1', 'main'])).toBe(true)
    // addEngineInstance: (tabId) — a single argument.
    expect(validForwardedAction('addEngineInstance', ['tab-1'])).toBe(true)
    // landAndRetireWorktree: (repoPath, entry) — the row-menu land composite. No
    // tabId argument (it operates on a worktree-list row, not a tab).
    expect(validForwardedAction('landAndRetireWorktree', ['/repo', { worktreePath: '/repo/wt', branchName: 'feature', sourceBranch: 'main', label: 'Feature' }])).toBe(true)
    // cycleBenchConversation: (repoPath, sourceBranch) — the bench bar's cycle
    // control.
    expect(validForwardedAction('cycleBenchConversation', ['/repo', 'main'])).toBe(true)
  })

  it('rejects the arities the previous (broken) specs would have wrongly required or wrongly allowed', () => {
    // clearTab took NO arguments; a call WITH one must be rejected, not
    // silently accepted (the real action ignores its arguments entirely, so
    // encoding one on the wire would misrepresent what is being validated).
    expect(validForwardedAction('clearTab', ['tab-1'])).toBe(false)
    // reorderTabs is exactly one argument — two must be rejected.
    expect(validForwardedAction('reorderTabs', [[], 'extra'])).toBe(false)
    // setupWorktree requires all three arguments — two must be rejected.
    expect(validForwardedAction('setupWorktree', ['tab-1', 'main'])).toBe(false)
    // forceRecoverTab requires both arguments — one must be rejected.
    expect(validForwardedAction('forceRecoverTab', ['tab-1'])).toBe(false)
    // editQueuedMessage is exactly one argument — the previously-required
    // two-argument minimum must no longer gate a legitimate single-arg call
    // (already covered above); a zero-arg call must still be rejected.
    expect(validForwardedAction('editQueuedMessage', [])).toBe(false)
    // resetEngineInstance requires both arguments — one must be rejected.
    expect(validForwardedAction('resetEngineInstance', ['tab-1'])).toBe(false)
    // addEngineInstance is exactly one argument — two must be rejected.
    expect(validForwardedAction('addEngineInstance', ['tab-1', 'extra'])).toBe(false)
  })
})

describe('mirror never persists', () => {
  it('sessionStore skips setupPersistence when the window role is mirror', async () => {
    // window-role detects by entry path; simulate the Studio window.
    vi.resetModules()
    window.history.replaceState({}, '', '/studio.html')
    // Let debounced owner-store persistence from earlier module tests finish
    // before installing this test's spy on the shared preload bridge.
    await new Promise((resolve) => setTimeout(resolve, 150))
    // The earlier owner-mode import in this jsdom window registered the
    // flush global; clear it so the assertion sees only the mirror import.
    delete (window as unknown as { __ionForceFlushTabs?: unknown }).__ionForceFlushTabs
    const saveTabs = vi.fn()
    ;(window as unknown as { ion: Record<string, unknown> }).ion = {
      ...((window as unknown as { ion?: Record<string, unknown> }).ion ?? {}),
      saveTabs,
      // Module-init side effects of preferences.ts (read-only loads).
      loadSettings: () => Promise.resolve(null),
      getEnterprisePolicy: () => Promise.resolve(null),
      on: vi.fn(),
      off: vi.fn(),
    }
    const { useSessionStore } = await import('../../../stores/sessionStore')
    // Mutate state that WOULD trigger the persistence subscriber in the owner.
    useSessionStore.setState({ isExpanded: true })
    await new Promise((r) => setTimeout(r, 250)) // past the 100ms debounce
    expect(saveTabs).not.toHaveBeenCalled()
    // The all-windows flush global is owner-only.
    expect((window as unknown as { __ionForceFlushTabs?: unknown }).__ionForceFlushTabs).toBeUndefined()
    // Keep the preload spy alive while any owner-mode debounce queued by prior
    // module tests drains; test teardown otherwise turns that timer into an
    // unhandled missing-bridge error.
    await new Promise((resolve) => setTimeout(resolve, 150))
    window.history.replaceState({}, '', '/')
  })
})
