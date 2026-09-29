import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Connection } from '../connection'
import { connectionRegistry } from '../connection'
import {
  registerPresence,
  unregisterPresence,
  setFocusedTab,
  setDriving,
  presenceSnapshot,
  drivingMap,
  wirePresenceDrivingTracking,
  _resetPresenceForTest,
} from '../presence'
import { sessionPlane } from '../../state'

function fakeConn(id: string, subject: string, displayName: string): Connection {
  return { id, principal: { subject, displayName } } as unknown as Connection
}

afterEach(() => {
  _resetPresenceForTest()
  for (const conn of connectionRegistry.all()) connectionRegistry.remove(conn)
  // wirePresenceDrivingTracking() attaches to the shared sessionPlane
  // singleton -- without this, each test that calls it accumulates one
  // more 'tab-status-change' listener for the rest of this file's run.
  sessionPlane.removeAllListeners('tab-status-change')
  vi.restoreAllMocks()
})

describe('registerPresence / unregisterPresence / presenceSnapshot', () => {
  it('an unregistered subject has no presence entry', () => {
    expect(presenceSnapshot()).toEqual([])
  })

  it('registering a connection adds it to the snapshot with no focus', () => {
    const conn = fakeConn('c1', 'oidc:alice', 'Alice')
    connectionRegistry.add(conn)
    registerPresence(conn)
    expect(presenceSnapshot()).toEqual([{ subject: 'oidc:alice', displayName: 'Alice', focusedTabId: null }])
  })

  it('unregistering removes the connection from the snapshot', () => {
    const conn = fakeConn('c1', 'oidc:alice', 'Alice')
    connectionRegistry.add(conn)
    registerPresence(conn)
    connectionRegistry.remove(conn)
    unregisterPresence(conn)
    expect(presenceSnapshot()).toEqual([])
  })

  it('a connection with no principal is never registered', () => {
    const conn = { id: 'c1', principal: null } as unknown as Connection
    connectionRegistry.add(conn)
    registerPresence(conn)
    expect(presenceSnapshot()).toEqual([])
  })

  it('carries multiple connected principals, in registration order', () => {
    const alice = fakeConn('c1', 'oidc:alice', 'Alice')
    const bob = fakeConn('c2', 'oidc:bob', 'Bob')
    connectionRegistry.add(alice)
    registerPresence(alice)
    connectionRegistry.add(bob)
    registerPresence(bob)
    expect(presenceSnapshot().map((p) => p.subject)).toEqual(['oidc:alice', 'oidc:bob'])
  })
})

describe('setFocusedTab', () => {
  it('sets and clears a registered connections tab focus', () => {
    const conn = fakeConn('c1', 'oidc:alice', 'Alice')
    connectionRegistry.add(conn)
    registerPresence(conn)

    setFocusedTab(conn, 'tab-1')
    expect(presenceSnapshot()[0].focusedTabId).toBe('tab-1')

    setFocusedTab(conn, null)
    expect(presenceSnapshot()[0].focusedTabId).toBeNull()
  })

  it('is a no-op for an unregistered connection', () => {
    const conn = fakeConn('c1', 'oidc:alice', 'Alice')
    setFocusedTab(conn, 'tab-1')
    expect(presenceSnapshot()).toEqual([])
  })
})

describe('setDriving / wirePresenceDrivingTracking', () => {
  it('records a driving entry', () => {
    setDriving('tab-1', 'oidc:alice')
    expect(drivingMap()).toEqual({ 'tab-1': 'oidc:alice' })
  })

  it('a later driver on the same tab replaces the earlier one', () => {
    setDriving('tab-1', 'oidc:alice')
    setDriving('tab-1', 'oidc:bob')
    expect(drivingMap()).toEqual({ 'tab-1': 'oidc:bob' })
  })

  it('clears the driving entry once the tab leaves running', () => {
    wirePresenceDrivingTracking()
    setDriving('tab-1', 'oidc:alice')
    expect(drivingMap()).toEqual({ 'tab-1': 'oidc:alice' })

    sessionPlane.emit('tab-status-change', 'tab-1', 'idle', 'running')
    expect(drivingMap()).toEqual({})
  })

  it('does not clear the driving entry while the tab stays running', () => {
    wirePresenceDrivingTracking()
    setDriving('tab-1', 'oidc:alice')

    sessionPlane.emit('tab-status-change', 'tab-1', 'running', 'running')
    expect(drivingMap()).toEqual({ 'tab-1': 'oidc:alice' })
  })

  it('a status change on an unrelated tab does not clear this ones driving entry', () => {
    wirePresenceDrivingTracking()
    setDriving('tab-1', 'oidc:alice')

    sessionPlane.emit('tab-status-change', 'tab-2', 'idle', 'running')
    expect(drivingMap()).toEqual({ 'tab-1': 'oidc:alice' })
  })
})
