/**
 * The server's own version, from `package.json`.
 *
 * Read relative to this module so it works from both `src/` (dev) and the
 * bundled `dist/` layout. Consumers: the `studio_welcome` frame's
 * `serverVersion`, and the conversation-backup manifest, which stamps the
 * version that wrote an archive so a restore can tell an old archive apart.
 */
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { warn as _warn } from './logger'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('server-version', msg, fields)
}

/** `server/package.json`'s `version`. Reports `0.0.0` (and logs) when no candidate file carries one. */
export function readServerVersion(): string {
  try {
    // `dist/package.json` sits beside the bundle (build.mjs stamps the
    // version into it) and is what the packaged desktop ships; the parent
    // `server/package.json` is the dev layout.
    const here = dirname(fileURLToPath(import.meta.url))
    const candidates = [join(here, 'package.json'), join(here, '..', 'package.json')]
    const pkgPath = candidates.find((p) => { try { return typeof (JSON.parse(readFileSync(p, 'utf-8')) as { version?: unknown }).version === 'string' } catch { return false } })
    if (!pkgPath) throw new Error(`no package.json with a version at ${candidates.join(' or ')}`)
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch (err) {
    warn('server package.json version read failed; reporting 0.0.0', { error: String(err) })
    return '0.0.0'
  }
}
