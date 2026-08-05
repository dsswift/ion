/**
 * Favicon IPC — main-process fetch + cache for renderer link favicons.
 *
 * The renderer CSP allows only `img-src 'self' data: blob:`, so conversation
 * link favicons cannot be loaded from the network by the renderer. This
 * handler fetches Google's favicon service in the main process, caches the
 * bytes (memory + disk under ~/.ion/favicon-cache with a TTL), and returns a
 * `data:` URL. Failure returns null — the renderer falls back to its Globe
 * glyph — and is logged at debug (an unreachable favicon host is routine
 * offline behavior, not an error).
 */

import { ipcMain } from 'electron'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { IPC } from '../../shared/types'
import { debug } from '../logger'
import { isValidFaviconHost } from '../ipc-validation'

const CACHE_DIR = join(homedir(), '.ion', 'favicon-cache')
const DISK_TTL_MS = 7 * 24 * 60 * 60 * 1000 // one week
const MAX_ICON_BYTES = 64 * 1024

// data-URL (or null sentinel) per host. Negative results are cached for the
// session so an offline machine doesn't re-fetch per link render.
const memoryCache = new Map<string, string | null>()

function diskPath(host: string): string {
  return join(CACHE_DIR, `${createHash('sha256').update(host).digest('hex')}.png`)
}

function readDiskCache(host: string): string | null {
  try {
    const p = diskPath(host)
    const st = statSync(p)
    if (Date.now() - st.mtimeMs > DISK_TTL_MS) return null
    const bytes = readFileSync(p)
    return `data:image/png;base64,${bytes.toString('base64')}`
  } catch {
    // silent-ok: cache miss (ENOENT) is the normal path
    return null
  }
}

function writeDiskCache(host: string, bytes: Buffer): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(diskPath(host), bytes)
  } catch (err) {
    debug('favicon', 'disk cache write failed', { host, error: String(err) })
  }
}

async function fetchFavicon(host: string): Promise<string | null> {
  const url = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) {
      debug('favicon', 'favicon fetch non-ok', { host, status: res.status })
      return null
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0 || buf.length > MAX_ICON_BYTES) {
      debug('favicon', 'favicon size out of bounds', { host, size: buf.length })
      return null
    }
    writeDiskCache(host, buf)
    const mime = res.headers.get('content-type')?.split(';')[0] || 'image/png'
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch (err) {
    debug('favicon', 'favicon fetch failed', { host, error: String(err) })
    return null
  }
}

export function registerFaviconIpc(): void {
  ipcMain.handle(IPC.FAVICON_GET, async (_evt, host: unknown): Promise<string | null> => {
    if (typeof host !== 'string' || !isValidFaviconHost(host)) {
      debug('favicon', 'rejected invalid favicon host', { host: String(host).slice(0, 128) })
      return null
    }
    const normalized = host.toLowerCase()
    const cached = memoryCache.get(normalized)
    if (cached !== undefined) return cached
    const fromDisk = readDiskCache(normalized)
    if (fromDisk) {
      memoryCache.set(normalized, fromDisk)
      return fromDisk
    }
    const fetched = await fetchFavicon(normalized)
    memoryCache.set(normalized, fetched)
    return fetched
  })
}

/** Test-only: reset the memory cache between cases. */
export function __resetFaviconCacheForTests(): void {
  memoryCache.clear()
}
