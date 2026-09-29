/**
 * env-cache — `~/.ion/env-cache/<environmentId>.json`: the last
 * `studio_welcome` frame verbatim plus `cachedAt`. Written by main on every
 * welcome (`ipc/studio-bridge.ts`).
 *
 * What it is NOT, any more: a way to paint an offline Environment's
 * conversations. That reader is gone -- an Environment this desktop cannot
 * reach now has its rows dropped rather than served from a cache
 * (`renderer/studio/state/secondary-store-purge.ts`), because a cached tab
 * list is a photograph of another machine and invites decisions against
 * state that has already moved.
 *
 * What remains are the welcome's own facts about an Environment, which do
 * not go stale in that dangerous way and are needed before a wire exists:
 * the enterprise policy applied at start-up (`app-lifecycle.ts`), the
 * telemetry-health notifier's environment identity, this desktop's own
 * environment id for the nearby door, and a pairing's registered client id
 * in Settings.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { dataDir } from '@ion/server/paths'
import { join } from 'path'
import { atomicWriteFileSync } from '@ion/server/utils/atomicWrite'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { log as _log, warn as _warn } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('env-cache', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('env-cache', msg, fields)
}

export interface EnvCacheEntry {
  welcome: StudioFrame
  cachedAt: number
}

function cacheDir(): string {
  return join(dataDir(), 'env-cache')
}

function cacheFile(environmentId: string): string {
  return join(cacheDir(), `${environmentId}.json`)
}

/** Writes the whole welcome frame plus a cache timestamp for one environment. */
export function writeEnvCache(environmentId: string, welcome: StudioFrame): void {
  const dir = cacheDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const entry: EnvCacheEntry = { welcome, cachedAt: Date.now() }
  atomicWriteFileSync(cacheFile(environmentId), JSON.stringify(entry), 0o644)
  log('env cache written', { environment_id: environmentId })
}

/** Reads back one environment's cached welcome, or null when absent/unreadable. */
export function readEnvCache(environmentId: string): EnvCacheEntry | null {
  const file = cacheFile(environmentId)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as EnvCacheEntry
  } catch (err) {
    warn('env cache unreadable; ignoring', { environment_id: environmentId, error: (err as Error).message })
    return null
  }
}
