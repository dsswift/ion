/** `GET /versionz` answers the version report as JSON with no credential, on the same listeners as `/healthz`. */
import { request } from 'http'
import type { AddressInfo } from 'net'
import { afterEach, describe, expect, it } from 'vitest'
import { startHealth, type HealthHandle } from '../health'
import { versionzRoute } from '../versionz'

let handle: HealthHandle | null = null
afterEach(async () => { await handle?.close(); handle = null })

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path }, (res) => {
      let body = ''
      res.on('data', (c: Buffer) => { body += c.toString() })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    }).on('error', reject).end()
  })
}

describe('/versionz', () => {
  it('serves the report without a credential', async () => {
    const engine = {
      request: async <T,>(cmd: string) => (cmd === 'health'
        ? { ok: true, data: { version: '2.0.0', compat: [] } }
        : { ok: true, data: [] }) as { ok: boolean; data?: T },
    }
    handle = startHealth({ port: 0, host: '127.0.0.1', routes: { '/versionz': versionzRoute(engine) } })
    await new Promise((r) => handle!.tcpServer!.once('listening', r))
    const { port } = handle.tcpServer!.address() as AddressInfo
    const res = await get(port, '/versionz')
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as { engineVersion: string; formats: Array<{ id: string }> }
    expect(body.engineVersion).toBe('2.0.0')
    expect(body.formats.some((f) => f.id === 'transfer-archive')).toBe(true)
  })
})
