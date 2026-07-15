// @vitest-environment jsdom
/**
 * Mirror-parity gate (mechanism 2 of the overlay↔ATV parity contract).
 *
 * Enumerates every function-valued key on the REAL session store and
 * asserts each is classified in exactly one of FORWARDED_ACTIONS or
 * MIRROR_LOCAL_ACTIONS. Adding a store action without classifying it —
 * or leaving a stale entry behind after removing one — fails here, forcing
 * an explicit parity decision. See shared/atv-mirror-actions.ts.
 */
import { describe, it, expect, vi } from 'vitest'
import { FORWARDED_ACTIONS, MIRROR_LOCAL_ACTIONS, validForwardedAction } from '../../../../shared/atv-mirror-actions'

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

  it('no stale table entries: every classified action exists on the store', () => {
    const actions = new Set(storeActions)
    const staleForwarded = Object.keys(FORWARDED_ACTIONS).filter((a) => !actions.has(a))
    const staleLocal = Object.keys(MIRROR_LOCAL_ACTIONS).filter((a) => !actions.has(a))
    expect(staleForwarded, 'FORWARDED_ACTIONS entries with no store action').toEqual([])
    expect(staleLocal, 'MIRROR_LOCAL_ACTIONS entries with no store action').toEqual([])
  })

  it('every mirror-local entry carries a justification', () => {
    for (const [name, reason] of Object.entries(MIRROR_LOCAL_ACTIONS)) {
      expect(reason.length, `${name} needs a justification`).toBeGreaterThan(8)
    }
  })
})

describe('applyMirrorOverrides', () => {
  it('swaps every forwarded action for an IPC forwarder and leaves locals intact', async () => {
    const forwarded: Array<{ action: string; args: unknown[] }> = []
    ;(window as unknown as { ion: unknown }).ion = {
      ...(window as unknown as { ion?: object }).ion,
      atvForwardAction: (action: string, args: unknown[]) => forwarded.push({ action, args }),
    }
    const { useSessionStore } = await import('../../../stores/sessionStore')
    const { applyMirrorOverrides } = await import('../secondary-store')
    const before = useSessionStore.getState() as unknown as Record<string, unknown>
    const localBefore = before.toggleGitPanel

    const swapped = applyMirrorOverrides()
    expect(swapped.sort()).toEqual(Object.keys(FORWARDED_ACTIONS).sort())

    const after = useSessionStore.getState() as unknown as Record<string, unknown>
    // A forwarded action now routes over IPC instead of mutating locally.
    ;(after.selectTab as (id: string) => void)('tab-123')
    expect(forwarded).toEqual([{ action: 'selectTab', args: ['tab-123'] }])
    // Mirror-local actions are untouched.
    expect(after.toggleGitPanel).toBe(localBefore)
    // Idempotent: a second call swaps nothing.
    expect(applyMirrorOverrides()).toEqual([])
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
})

describe('mirror never persists', () => {
  it('sessionStore skips setupPersistence when the window role is mirror', async () => {
    // window-role detects by entry path; simulate the ATV window.
    vi.resetModules()
    window.history.replaceState({}, '', '/atv.html')
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
    window.history.replaceState({}, '', '/')
  })
})
