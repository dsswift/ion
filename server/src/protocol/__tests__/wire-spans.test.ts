/**
 * The spans one connection's life writes on a real listener: `hello.auth`
 * around the handshake (with the snapshot's `snapshot.build` and
 * `tabs_index.build` under it), `action.handle` for an action the client
 * sends, and `thin.first_paint` for a thin connection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const logger = vi.hoisted(() => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(), info: vi.fn(), logWeb: vi.fn(), flushLogs: vi.fn(), setLogLevel: vi.fn() }))
vi.mock('../../logger', () => logger)
vi.mock('../../engine/engine-bridge-fs', () => ({
  getEngineHostInfo: vi.fn(() => Promise.resolve({ ok: true, data: { version: '1.2.3' } })),
  getEnterprisePolicy: vi.fn(() => Promise.resolve(null)),
}))
vi.mock('../../state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../state')>()),
  engineBridge: { connected: true, request: vi.fn(async () => ({ ok: false })) },
  deviceFocusMap: new Map(),
  state: { remoteTransport: null, remoteWorktreeStates: new Map() },
  enterprisePolicyCache: { policy: null },
  sessionPlane: { on: vi.fn() },
}))

import { startHarness, connectLocal, waitOpen, sendFrame, nextFrame, helloFrame, closeSocket, resetConnectionRegistryForTest, type Harness } from './harness'
import { capturedSpans, spansNamed, theSpan } from '../../tracing/__tests__/span-capture'

let harness: Harness
let dataDir: string
let originalIonDataDir: string | undefined

beforeEach(async () => {
  originalIonDataDir = process.env.ION_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'ion-wire-spans-'))
  process.env.ION_DATA_DIR = dataDir
  harness = await startHarness()
  for (const fn of Object.values(logger)) fn.mockClear()
})

afterEach(async () => {
  await harness.close()
  resetConnectionRegistryForTest()
  if (originalIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalIonDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

describe('spans on the Studio wire', () => {
  it('spans the hello, with the snapshot and tabs index built under it, and every action after it', async () => {
    const ws = connectLocal(harness)
    await waitOpen(ws)
    sendFrame(ws, helloFrame({ clientId: 'client-spans' }))
    expect((await nextFrame(ws)).type).toBe('studio_welcome')

    const hello = theSpan(logger, 'hello.auth')
    expect(hello.fields).toMatchObject({ span_kind: 'server', client_kind: 'desktop', credential_kind: 'local', transport: 'local', accepted: true })
    expect(typeof hello.fields.user).toBe('string')
    const snapshot = theSpan(logger, 'snapshot.build')
    expect(snapshot.fields).toMatchObject({ view: 'mirror', parent_span_id: hello.fields.span_id, trace_id: hello.fields.trace_id })
    const index = spansNamed(logger, 'tabs_index.build')
    expect(index.length).toBeGreaterThan(0)
    expect(index[0].fields.trace_id).toBe(hello.fields.trace_id)

    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    sendFrame(ws, { type: 'studio_action', id: 'a1', action: 'no.such.action', args: [], traceparent })
    const result = await nextFrame(ws)
    expect(result.type).toBe('studio_action_result')
    const action = theSpan(logger, 'action.handle')
    expect(action.fields).toMatchObject({ action: 'no.such.action', surface: 'mirror', client_kind: 'desktop', trace_id: '4bf92f3577b34da6a3ce929d0e0e4736', parent_span_id: '00f067aa0ba902b7', outcome: 'error:unknown_action' })
    await closeSocket(ws)
  })

  it('spans a thin connection\'s first paint under its hello', async () => {
    const ws = connectLocal(harness)
    await waitOpen(ws)
    sendFrame(ws, { ...helloFrame({ clientId: 'client-thin-spans' }), view: 'thin' } as never)
    expect((await nextFrame(ws)).type).toBe('studio_welcome')
    // The first paint is sent after the welcome; wait for its span.
    for (let i = 0; i < 50 && spansNamed(logger, 'thin.first_paint').length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    const paint = theSpan(logger, 'thin.first_paint')
    expect(paint.fields.error, JSON.stringify(paint.fields)).toBeUndefined()
    expect(typeof paint.fields.event_count).toBe('number')
    expect(capturedSpans(logger).some((s) => s.name === 'snapshot.build' && s.fields.view === 'thin')).toBe(true)
    await closeSocket(ws)
  })
})
