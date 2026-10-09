/**
 * Every HTTP request the server answers is one `http.request` span, routes
 * and the 404 fallback alike, ended when the response ends; a browser's
 * `traceparent` header is its parent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const logger = vi.hoisted(() => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn(), info: vi.fn() }))
vi.mock('../../logger', () => logger)

import { startHealth, type HealthHandle } from '../health'
import { capturedSpans, spansNamed } from '../../tracing/__tests__/span-capture'

let health: HealthHandle

function baseUrl(): string {
  const address = health.tcpServer?.address()
  if (!address || typeof address === 'string') throw new Error('expected an AddressInfo')
  return `http://127.0.0.1:${address.port}`
}

beforeEach(async () => {
  health = startHealth({ port: 0, host: '127.0.0.1', routes: { '/slow': (_req, res) => { setTimeout(() => res.end('ok'), 30) } } })
  await new Promise((resolve) => health.tcpServer!.once('listening', resolve))
  for (const fn of Object.values(logger)) fn.mockClear()
})
afterEach(() => health.close())

async function spanFor(path: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 50; i++) {
    const found = spansNamed(logger, 'http.request').find((s) => s.fields.path === path)
    if (found) return found.fields
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`no http.request span for ${path}: ${JSON.stringify(capturedSpans(logger))}`)
}

describe('http.request', () => {
  it('spans a built-in route, a registered route, and the 404 fallback with method, path, and status', async () => {
    await fetch(`${baseUrl()}/healthz?probe=1`)
    await fetch(`${baseUrl()}/slow`, { method: 'POST' })
    await fetch(`${baseUrl()}/nowhere`)
    expect(await spanFor('/healthz')).toMatchObject({ span_kind: 'server', method: 'GET', status: 200, outcome: 'finished' })
    const slow = await spanFor('/slow')
    expect(slow).toMatchObject({ method: 'POST', status: 200 })
    expect(slow.duration_ms as number).toBeGreaterThanOrEqual(25)
    expect(await spanFor('/nowhere')).toMatchObject({ status: 404 })
  })

  it('joins the caller\'s traceparent header', async () => {
    await fetch(`${baseUrl()}/readyz`, { headers: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' } })
    expect(await spanFor('/readyz')).toMatchObject({ trace_id: '4bf92f3577b34da6a3ce929d0e0e4736', parent_span_id: '00f067aa0ba902b7' })
  })
})
