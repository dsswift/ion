import { afterEach, describe, expect, it } from 'vitest'
import type { Connection } from '../connection'
import { connectionRegistry } from '../connection'
import { MISC_ACTIONS } from '../misc-actions'
import { registerPresence, presenceSnapshot, focusedTabOf, _resetPresenceForTest } from '../presence'

function fakeConn(id: string, subject: string, displayName: string): Connection {
  return { id, principal: { subject, displayName }, interceptEnabled: false } as unknown as Connection
}

afterEach(() => {
  _resetPresenceForTest()
  for (const conn of connectionRegistry.all()) connectionRegistry.remove(conn)
})

describe('presence.attention', () => {
  it('gates background git work on ANY attentive connection, and a dropped connection takes its attention with it', async () => {
    const { focusState } = await import('../../git/focus-state')
    const desktop = fakeConn('d', 'local:josh', 'Josh')
    const web = fakeConn('w', 'oidc:alice', 'Alice')
    for (const c of [desktop, web]) { connectionRegistry.add(c); registerPresence(c) }

    expect(await MISC_ACTIONS['presence.attention'].handler(desktop, [false])).toEqual({ ok: true, value: null })
    expect(focusState.windowFocused).toBe(false)
    await MISC_ACTIONS['presence.attention'].handler(web, [true])
    expect(focusState.windowFocused).toBe(true)
    // The browser tab drops; the backgrounded desktop is all that is left.
    const { unregisterPresence } = await import('../presence')
    unregisterPresence(web)
    expect(focusState.windowFocused).toBe(false)
  })

  it('refuses a non-boolean', async () => {
    const conn = fakeConn('c1', 'oidc:alice', 'Alice')
    connectionRegistry.add(conn)
    registerPresence(conn)
    expect((await MISC_ACTIONS['presence.attention'].handler(conn, ['yes'])).ok).toBe(false)
  })
})

describe('presence.focus', () => {
  it('requires conversations:read', () => {
    expect(MISC_ACTIONS['presence.focus'].requiredScope).toBe('conversations:read')
  })

  it('sets the calling connections own tab focus', async () => {
    const conn = fakeConn('c1', 'oidc:alice', 'Alice')
    connectionRegistry.add(conn)
    registerPresence(conn)

    const outcome = await MISC_ACTIONS['presence.focus'].handler(conn, ['tab-1'])
    expect(outcome).toEqual({ ok: true, value: null })
    expect(presenceSnapshot()).toEqual([{ subject: 'oidc:alice', displayName: 'Alice', focusedTabId: 'tab-1' }])
  })

  // The third argument is what lets an intercept treat this client as one
  // that will act on it (`engine/event-wiring-intercept.ts`).
  it('records the intercept preference when the options carry one, and leaves it alone otherwise', async () => {
    const conn = fakeConn('c1', 'oidc:alice', 'Alice')
    connectionRegistry.add(conn)
    registerPresence(conn)
    expect(conn.interceptEnabled).toBe(false)
    await MISC_ACTIONS['presence.focus'].handler(conn, ['tab-1', null, { interceptEnabled: true }])
    expect(conn.interceptEnabled).toBe(true)
    expect(focusedTabOf(conn)).toBe('tab-1')
    await MISC_ACTIONS['presence.focus'].handler(conn, ['tab-2'])
    expect(conn.interceptEnabled).toBe(true)
    await MISC_ACTIONS['presence.focus'].handler(conn, ['tab-2', null, { interceptEnabled: false }])
    expect(conn.interceptEnabled).toBe(false)
  })

  it('clears focus when given null', async () => {
    const conn = fakeConn('c1', 'oidc:alice', 'Alice')
    connectionRegistry.add(conn)
    registerPresence(conn)
    await MISC_ACTIONS['presence.focus'].handler(conn, ['tab-1'])

    await MISC_ACTIONS['presence.focus'].handler(conn, [null])
    expect(presenceSnapshot()[0].focusedTabId).toBeNull()
  })

  it('refuses a malformed tabId', async () => {
    const conn = fakeConn('c1', 'oidc:alice', 'Alice')
    connectionRegistry.add(conn)
    registerPresence(conn)

    const outcome = await MISC_ACTIONS['presence.focus'].handler(conn, [42])
    expect(outcome.ok).toBe(false)
  })

  it('never lets a call set focus for a different connection -- only the caller conn is ever touched', async () => {
    const alice = fakeConn('c1', 'oidc:alice', 'Alice')
    const bob = fakeConn('c2', 'oidc:bob', 'Bob')
    connectionRegistry.add(alice)
    registerPresence(alice)
    connectionRegistry.add(bob)
    registerPresence(bob)

    await MISC_ACTIONS['presence.focus'].handler(alice, ['tab-1'])
    const bobEntry = presenceSnapshot().find((p) => p.subject === 'oidc:bob')
    expect(bobEntry?.focusedTabId).toBeNull()
  })
})
