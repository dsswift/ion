/**
 * Test harness for the Studio wire protocol tests: starts a real local
 * (Unix socket, or a named pipe on Windows) and TCP listener via
 * `startStudioListeners`, and gives tests
 * a real `ws` client connected to either transport plus small frame
 * send/receive helpers. Not a `*.test.ts` file itself, so vitest's
 * `include: ['src/**\/*.test.{ts,tsx}']` never collects it directly.
 */
import { createServer, type Server } from 'http'
import { mkdtempSync, rmSync } from 'fs'
import { connect as netConnect } from 'net'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import WebSocket from 'ws'
import type { HealthHandle, ReadinessState } from '../../http/health'
import { startStudioListeners, type StudioListenersHandle, type StudioListenersOptions } from '../listener'
import { connectionRegistry } from '../connection'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { PROTOCOL_VERSION } from '@ion/shared/studio-wire/version'

function fakeHealth(tcpServer: Server | null, localServer: Server | null): HealthHandle {
  let readiness: ReadinessState = { ready: true }
  return {
    servers: [tcpServer, localServer].filter((s): s is Server => !!s),
    tcpServer,
    localServer,
    setReadiness: (state) => {
      readiness = state
    },
    getReadiness: () => readiness,
    close: () =>
      Promise.all(
        [tcpServer, localServer].filter((s): s is Server => !!s).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
      ).then(() => undefined),
  }
}

export interface Harness {
  tcpPort: number
  socketPath: string
  studio: StudioListenersHandle
  close(): Promise<void>
}

/** Start both a TCP and a local-socket Studio listener pair for one test. */
export async function startHarness(options: Partial<StudioListenersOptions> = {}): Promise<Harness> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ion-studio-wire-test-'))
  // Windows cannot listen on a filesystem path; its local sockets are pipes.
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\${basename(tmpDir)}` : join(tmpDir, 'studio.sock')

  const tcpServer = createServer()
  await new Promise<void>((resolve) => tcpServer.listen(0, '127.0.0.1', resolve))
  const address = tcpServer.address()
  if (!address || typeof address === 'string') throw new Error('expected an AddressInfo from the ephemeral TCP listener')
  const tcpPort = address.port

  const localServer = createServer()
  await new Promise<void>((resolve) => localServer.listen(socketPath, resolve))

  const health = fakeHealth(tcpServer, localServer)
  const studio = startStudioListeners(health, {
    environmentId: 'env-test',
    label: 'Test Environment',
    serverVersion: '0.0.0-test',
    ...options,
  })

  return {
    tcpPort,
    socketPath,
    studio,
    async close() {
      await studio.close()
      await health.close()
      rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}

export function connectTcp(harness: Harness): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${harness.tcpPort}`)
}

export function connectLocal(harness: Harness): WebSocket {
  if (process.platform === 'win32') {
    return new WebSocket('ws://localhost/', { createConnection: () => netConnect(harness.socketPath) })
  }
  return new WebSocket(`ws+unix://${harness.socketPath}:/`)
}

export function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
}

export function sendFrame(ws: WebSocket, frame: StudioFrame): void {
  ws.send(JSON.stringify(frame))
}

/** Wait for the next TEXT frame and parse it as JSON. Rejects on a binary frame or socket close. */
export function nextFrame(ws: WebSocket, timeoutMs = 2000): Promise<StudioFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('nextFrame timed out')), timeoutMs)
    const onMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
      if (isBinary) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(JSON.parse((data as Buffer).toString('utf-8')) as StudioFrame)
    }
    const onClose = (): void => {
      clearTimeout(timer)
      reject(new Error('socket closed before a frame arrived'))
    }
    ws.once('close', onClose)
    ws.on('message', onMessage)
  })
}

export function helloFrame(overrides: Partial<Extract<StudioFrame, { type: 'studio_hello' }>> = {}): StudioFrame {
  return {
    type: 'studio_hello',
    protocolVersion: PROTOCOL_VERSION,
    clientId: `client-${Math.random().toString(36).slice(2, 8)}`,
    clientKind: 'desktop',
    capabilities: [],
    credential: { kind: 'local' },
    ...overrides,
  }
}

/** Complete a hello and return the welcome frame. Throws if refused. */
export async function helloAndWelcome(ws: WebSocket, overrides: Partial<Extract<StudioFrame, { type: 'studio_hello' }>> = {}): Promise<Extract<StudioFrame, { type: 'studio_welcome' }>> {
  sendFrame(ws, helloFrame(overrides))
  const frame = await nextFrame(ws)
  if (frame.type !== 'studio_welcome') throw new Error(`expected studio_welcome, got ${frame.type}`)
  return frame
}

export function closeSocket(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve()
      return
    }
    ws.once('close', () => resolve())
    ws.close()
  })
}

/** TEST ONLY. Clears the process-wide connection registry between tests. */
export function resetConnectionRegistryForTest(): void {
  for (const conn of connectionRegistry.all()) connectionRegistry.remove(conn)
}
