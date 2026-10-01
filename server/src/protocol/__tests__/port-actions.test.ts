/**
 * Pins the `port.*` studio_action surface: its scope, that the server
 * answers the names, and that its paced binary send is not counted against
 * the push cap.
 */
import { describe, expect, it, vi } from 'vitest'
import { BinaryChannel } from '@ion/shared/studio-wire/channels'
import { PORT_FORWARD_CAPABILITY } from '@ion/shared/port-forward'

vi.mock('../../terminal/terminal-manager-instance', () => ({ terminalManager: { activitySnapshot: () => [] } }))

import { PORT_ACTIONS } from '../port-actions'
import { registeredActionSpec } from '../actions'
import { SERVER_CAPABILITIES } from '../hello'
import { Connection } from '../connection'
import type { ConnectionSocket } from '../connection-socket'

describe('PORT_ACTIONS', () => {
  it('asks for the scope a Terminal does', () => {
    for (const [name, spec] of Object.entries(PORT_ACTIONS)) expect(spec.requiredScope, name).toBe('terminal:operate')
  })

  it('is answered by the action dispatcher', () => {
    expect(registeredActionSpec('port.open')).toEqual({ requiredScope: 'terminal:operate', localOnly: false })
    expect(registeredActionSpec('port.listeners')).toEqual({ requiredScope: 'terminal:operate', localOnly: false })
  })

  it('is advertised in the welcome, so a client can tell an old server apart', () => {
    expect(SERVER_CAPABILITIES).toContain(PORT_FORWARD_CAPABILITY)
  })

  it('refuses a malformed open as an error result, not a throw', async () => {
    const conn = { id: 'conn-1', scopes: [] } as unknown as Connection
    expect(await PORT_ACTIONS['port.open'].handler(conn, [{ streamId: 's1', port: 'http' }])).toMatchObject({ ok: false, error: { code: 'bad_request' } })
    expect(await PORT_ACTIONS['port.open'].handler(conn, [])).toMatchObject({ ok: false, error: { code: 'bad_request' } })
  })
})

describe('Connection.sendBinaryPaced', () => {
  function heldSocket() {
    const callbacks: Array<(err?: Error) => void> = []
    const socket = {
      send: (_data: string | Buffer, cb?: (err?: Error) => void) => { if (cb) callbacks.push(cb) },
      close(): void {},
      terminate(): void {},
      ping(): void {},
      on(): ConnectionSocket { return socket },
    } as ConnectionSocket
    return { socket, callbacks }
  }

  it('resolves once the frame has left the socket', async () => {
    const { socket, callbacks } = heldSocket()
    const conn = new Connection(socket, 'tcp')
    let settled: boolean | null = null
    void conn.sendBinaryPaced(BinaryChannel.PORT_DATA, 's1', new Uint8Array(8)).then((ok) => { settled = ok })
    await Promise.resolve()
    expect(settled).toBeNull()
    callbacks[0]()
    await Promise.resolve()
    expect(settled).toBe(true)
  })

  it('never closes the connection as a slow client, however much is in flight', () => {
    const { socket } = heldSocket()
    const conn = new Connection(socket, 'tcp', 1024)
    for (let i = 0; i < 8; i += 1) void conn.sendBinaryPaced(BinaryChannel.PORT_DATA, 's1', new Uint8Array(1024))
    expect(conn.isClosed).toBe(false)
    expect(conn.buffer.size).toBe(0)
  })

  it('resolves false on a closed connection', async () => {
    const { socket } = heldSocket()
    const conn = new Connection(socket, 'tcp')
    conn.markClosed()
    expect(await conn.sendBinaryPaced(BinaryChannel.PORT_DATA, 's1', new Uint8Array(1))).toBe(false)
  })
})
