import { beforeEach, describe, expect, it, vi } from 'vitest'

const state: { activeTabId: string | null } = { activeTabId: 'tab-a' }
let listener: ((next: typeof state) => void) | null = null

const store = {
  getState: () => ({ ...state }),
  setState: (update: Partial<typeof state>) => {
    Object.assign(state, update)
    listener?.(state)
  },
  subscribe: (next: (next: typeof state) => void) => {
    listener = next
    return () => { listener = null }
  },
}

vi.mock('@ion/server/store/sessionStore', () => ({ useSessionStore: store }))

const action = vi.fn(() => Promise.resolve(null))
let frameHandler: ((environmentId: string, frame: unknown) => void) | null = null
const onFrame = vi.fn((cb: typeof frameHandler) => {
  frameHandler = cb
  return vi.fn()
})

vi.mock('../host/host-instance', () => ({ host: { onFrame }, action }))
vi.mock('../rendererLogger', () => ({ rWarn: vi.fn() }))

describe('othersFocusedOn / drivingSubjectFor', () => {
  it('excludes the caller\'s own subject from focus and driving results', async () => {
    const { othersFocusedOn, drivingSubjectFor } = await import('./presence-store')
    const entries = [
      { subject: 'local:alice', displayName: 'Alice', focusedTabId: 'tab-a' },
      { subject: 'local:bob', displayName: 'Bob', focusedTabId: 'tab-a' },
    ]
    expect(othersFocusedOn(entries, 'local:alice', 'tab-a')).toEqual([entries[1]])
    expect(drivingSubjectFor({ 'tab-a': 'local:alice' }, 'local:alice', 'tab-a')).toBeNull()
    expect(drivingSubjectFor({ 'tab-a': 'local:bob' }, 'local:alice', 'tab-a')).toBe('local:bob')
    expect(drivingSubjectFor({}, 'local:alice', 'tab-a')).toBeNull()
  })
})

describe('initPresenceSync', () => {
  beforeEach(() => {
    vi.resetModules()
    onFrame.mockClear()
    frameHandler = null
  })

  it('captures the caller\'s own subject and replaces state from studio_welcome', async () => {
    const { initPresenceSync, usePresenceStore } = await import('./presence-store')
    initPresenceSync()
    frameHandler?.('local', {
      type: 'studio_welcome',
      principal: { subject: 'local:alice', displayName: 'Alice' },
      snapshot: { presence: { entries: [{ subject: 'local:alice', displayName: 'Alice', focusedTabId: null }], driving: {} } },
    })
    expect(usePresenceStore.getState().ownSubject).toBe('local:alice')
    expect(usePresenceStore.getState().entries).toEqual([{ subject: 'local:alice', displayName: 'Alice', focusedTabId: null }])
  })

  it('replaces state wholesale from a studio:presence broadcast', async () => {
    const { initPresenceSync, usePresenceStore } = await import('./presence-store')
    initPresenceSync()
    frameHandler?.('local', {
      type: 'studio_event',
      channel: 'studio:presence',
      payload: { entries: [{ subject: 'local:bob', displayName: 'Bob', focusedTabId: 'tab-a' }], driving: { 'tab-a': 'local:bob' } },
    })
    expect(usePresenceStore.getState().entries).toEqual([{ subject: 'local:bob', displayName: 'Bob', focusedTabId: 'tab-a' }])
    expect(usePresenceStore.getState().driving).toEqual({ 'tab-a': 'local:bob' })
  })
})

describe('initPresenceFocusReporter', () => {
  beforeEach(() => {
    vi.resetModules()
    action.mockClear()
    state.activeTabId = 'tab-a'
    listener = null
  })

  it('reports the initial active tab, then only real changes (dedupes repeats)', async () => {
    const { initPresenceFocusReporter } = await import('./presence-store')
    initPresenceFocusReporter()
    await Promise.resolve()
    expect(action).toHaveBeenCalledTimes(1)
    expect(action).toHaveBeenCalledWith('local', 'presence.focus', ['tab-a'])

    store.setState({ activeTabId: 'tab-b' })
    store.setState({ activeTabId: 'tab-b' })
    await Promise.resolve()
    expect(action).toHaveBeenCalledTimes(2)
    expect(action).toHaveBeenLastCalledWith('local', 'presence.focus', ['tab-b'])
  })
})
