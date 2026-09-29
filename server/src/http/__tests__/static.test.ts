import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { gzipSync } from 'zlib'
import { startHealth, type HealthHandle } from '../health'
import { staticRoute } from '../static'

let health: HealthHandle | null = null
let tmpDir: string | null = null

afterEach(async () => {
  if (health) await health.close()
  health = null
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  tmpDir = null
})

function baseUrl(h: HealthHandle): string {
  const address = h.tcpServer?.address()
  if (!address || typeof address === 'string') throw new Error('expected an AddressInfo from the ephemeral TCP listener')
  return `http://127.0.0.1:${address.port}`
}

function makeWebDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ion-static-route-test-'))
  tmpDir = dir
  return dir
}

describe('GET / (static web route)', () => {
  it('404s with web_disabled when web.enabled is false', async () => {
    health = startHealth({ port: 0, notFound: staticRoute({ enabled: false }) })
    const res = await fetch(`${baseUrl(health)}/`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'web_disabled' })
  })

  it('404s with web_missing (and logs only once) when web.enabled but the dir does not exist', async () => {
    const webDir = join(tmpdir(), 'ion-static-route-nonexistent-' + Math.random().toString(36).slice(2))
    health = startHealth({ port: 0, notFound: staticRoute({ enabled: true, webDir }) })
    const url = baseUrl(health)
    const first = await fetch(`${url}/`)
    const second = await fetch(`${url}/`)
    expect(first.status).toBe(404)
    expect(await first.json()).toEqual({ error: 'web_missing' })
    expect(second.status).toBe(404)
    expect(await second.json()).toEqual({ error: 'web_missing' })
  })

  it('serves index.html at / with no-store when enabled', async () => {
    const webDir = makeWebDir()
    writeFileSync(join(webDir, 'index.html'), '<html>hi</html>')
    health = startHealth({ port: 0, notFound: staticRoute({ enabled: true, webDir }) })
    const res = await fetch(`${baseUrl(health)}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    // no-store, not no-cache: no-cache lets a CDN STORE the entry document and
    // only revalidate, and a CDN told to cache HTML ignores that. A stale
    // index.html names an older build's hashed bundles, so every browser runs
    // old client code while the server runs new code.
    expect(res.headers.get('cache-control')).toBe('no-store, no-cache, must-revalidate')
    expect(await res.text()).toBe('<html>hi</html>')
  })

  it('serves a hashed asset with immutable long-lived caching', async () => {
    const webDir = makeWebDir()
    mkdirSync(join(webDir, 'assets'))
    writeFileSync(join(webDir, 'assets', 'index.abcd1234.js'), 'console.log(1)')
    health = startHealth({ port: 0, notFound: staticRoute({ enabled: true, webDir }) })
    const res = await fetch(`${baseUrl(health)}/assets/index.abcd1234.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })

  it('negotiates a .gz sibling when Accept-Encoding allows and the sibling exists', async () => {
    const webDir = makeWebDir()
    const plain = 'body { color: red; }'
    writeFileSync(join(webDir, 'style.css'), plain)
    writeFileSync(join(webDir, 'style.css.gz'), gzipSync(Buffer.from(plain)))
    health = startHealth({ port: 0, notFound: staticRoute({ enabled: true, webDir }) })
    const res = await fetch(`${baseUrl(health)}/style.css`, { headers: { 'Accept-Encoding': 'gzip' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toBe('gzip')
  })

  it('falls back to index.html for an unresolved deep-link path (SPA routing)', async () => {
    const webDir = makeWebDir()
    writeFileSync(join(webDir, 'index.html'), '<html>spa</html>')
    health = startHealth({ port: 0, notFound: staticRoute({ enabled: true, webDir }) })
    const res = await fetch(`${baseUrl(health)}/some/deep/route`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<html>spa</html>')
  })

  it('refuses a path-traversal request', async () => {
    const webDir = makeWebDir()
    writeFileSync(join(webDir, 'index.html'), '<html>hi</html>')
    health = startHealth({ port: 0, notFound: staticRoute({ enabled: true, webDir }) })
    const res = await fetch(`${baseUrl(health)}/..%2f..%2fetc%2fpasswd`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })
})
