/**
 * IndexedDB-backed device settings + env-cache store for `BrowserStudioHost`
 * (spec 18). Mirrors `desktop.json`'s key set (minus paths and fonts, which
 * need the OS) so `host.deviceSettings()`/`setDeviceSetting()`/`getEnvCache()`
 * behave identically to the Electron host from the caller's perspective —
 * same keys in, same shape out, just backed by a browser database `ion-web`
 * (object stores `deviceSettings`, `envCache`) instead of a JSON file on disk.
 *
 * Falls back to an in-memory Map when IndexedDB is unavailable (private
 * browsing throws opening a database in some browsers): the tab still
 * functions for its own lifetime, just without persistence across reloads
 * (spec 18 edge case). Warned once, not on every call, so the fallback
 * doesn't drown real logs.
 */
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { rWarn } from '../rendererLogger'

const DB_NAME = 'ion-web'
const DB_VERSION = 1
const SETTINGS_STORE = 'deviceSettings'
const ENV_CACHE_STORE = 'envCache'
const SETTINGS_KEY = 'settings'

export interface CachedWelcome {
  welcome: StudioFrame
  cachedAt: number
}

interface MemoryFallback {
  settings: Record<string, unknown>
  envCache: Map<string, CachedWelcome>
}

let warnedFallback = false
let memoryFallback: MemoryFallback | null = null

function fallback(reason: string): MemoryFallback {
  if (!memoryFallback) memoryFallback = { settings: {}, envCache: new Map() }
  if (!warnedFallback) {
    warnedFallback = true
    rWarn('web.storage', 'IndexedDB unavailable; falling back to in-memory storage for this tab', { reason })
  }
  return memoryFallback
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB is not available'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) db.createObjectStore(SETTINGS_STORE)
      if (!db.objectStoreNames.contains(ENV_CACHE_STORE)) db.createObjectStore(ENV_CACHE_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'))
  })
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}

export async function getDeviceSettings(): Promise<Record<string, unknown>> {
  try {
    const db = await openDb()
    const value = await idbRequest(db.transaction(SETTINGS_STORE, 'readonly').objectStore(SETTINGS_STORE).get(SETTINGS_KEY))
    db.close()
    return { ...((value as Record<string, unknown> | undefined) ?? {}) }
  } catch (err) {
    return { ...fallback(err instanceof Error ? err.message : String(err)).settings }
  }
}

export async function setDeviceSetting(key: string, value: unknown): Promise<void> {
  try {
    const db = await openDb()
    const store = db.transaction(SETTINGS_STORE, 'readwrite').objectStore(SETTINGS_STORE)
    const current = (await idbRequest(store.get(SETTINGS_KEY))) as Record<string, unknown> | undefined
    await idbRequest(store.put({ ...current, [key]: value }, SETTINGS_KEY))
    db.close()
  } catch (err) {
    const mem = fallback(err instanceof Error ? err.message : String(err))
    mem.settings = { ...mem.settings, [key]: value }
  }
}

export async function getEnvCache(environmentId: string): Promise<CachedWelcome | null> {
  try {
    const db = await openDb()
    const value = await idbRequest(db.transaction(ENV_CACHE_STORE, 'readonly').objectStore(ENV_CACHE_STORE).get(environmentId))
    db.close()
    return (value as CachedWelcome | undefined) ?? null
  } catch (err) {
    return fallback(err instanceof Error ? err.message : String(err)).envCache.get(environmentId) ?? null
  }
}

export async function setEnvCache(environmentId: string, entry: CachedWelcome): Promise<void> {
  try {
    const db = await openDb()
    await idbRequest(db.transaction(ENV_CACHE_STORE, 'readwrite').objectStore(ENV_CACHE_STORE).put(entry, environmentId))
    db.close()
  } catch (err) {
    fallback(err instanceof Error ? err.message : String(err)).envCache.set(environmentId, entry)
  }
}

/** Test-only: clears the module-level fallback and its warned-once latch. */
export function resetWebStorageForTests(): void {
  memoryFallback = null
  warnedFallback = false
}
