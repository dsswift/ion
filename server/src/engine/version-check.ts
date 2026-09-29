import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('version-check', msg, fields)
}

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('version-check', msg, fields)
}

export interface EngineVersionCheck {
  ok: boolean
  version: string
  minVersion: string
  reason?: 'engine_incompatible' | 'unparseable_version'
}

/**
 * Parses a `major.minor.patch` semver string, ignoring any `-prerelease` or
 * `+build` suffix (this codebase has no dependency on a full semver parser
 * and none of `minVersion`/an engine build version carry meaningful
 * prerelease ordering -- see `server.json`'s `engine.minVersion` in the
 * manifest, which is always a bare `major.minor.patch`). Returns `null` when
 * `raw` does not start with three dot-separated non-negative integers.
 */
function parseVersion(raw: string): [number, number, number] | null {
  // The first `major.minor.patch` anywhere in the string, not only at the
  // start: a release engine reports the tag `git describe` produced, e.g.
  // `desktop-v1.100.1-257-g2271d2a91`, which is not a bare semver and was
  // rejected as unparseable on every boot.
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw.trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * `0.0.0` is no minimum at all, so any engine meets it, including a dev
 * build whose version (`dev-<commit>`) carries no semver.
 */
function isNoConstraint(min: [number, number, number]): boolean {
  return min[0] === 0 && min[1] === 0 && min[2] === 0
}

/** -1 when `a` < `b`, 0 when equal, 1 when `a` > `b`. */
function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

/**
 * Compares an engine's reported version against `server.json`'s
 * `engine.minVersion` (manifest C5/C14). `minVersion: "0.0.0"` (the C5
 * default) always passes -- it means "no constraint". An unparseable
 * `version` or `minVersion` fails open on the side of refusing readiness
 * (`ok: false`) rather than silently skipping the check, since a version the
 * server cannot even parse is not evidence of compatibility.
 */
export function checkEngineVersion(version: string, minVersion: string): EngineVersionCheck {
  const parsedMin = parseVersion(minVersion)
  if (parsedMin && isNoConstraint(parsedMin)) {
    log('engine version check passed: no minimum version', { version, minVersion })
    return { ok: true, version, minVersion }
  }
  const parsedVersion = parseVersion(version)
  if (!parsedVersion || !parsedMin) {
    warn('engine version check: unparseable version string', { version, minVersion })
    return { ok: false, version, minVersion, reason: 'unparseable_version' }
  }
  const ok = compareVersions(parsedVersion, parsedMin) >= 0
  if (ok) {
    log('engine version check passed', { version, minVersion })
    return { ok: true, version, minVersion }
  }
  warn('engine version check failed: engine below minVersion', { version, minVersion })
  return { ok: false, version, minVersion, reason: 'engine_incompatible' }
}

/**
 * Whether `version` meets `minVersion`, without logging: the same comparison
 * as `checkEngineVersion`, for a report that is read on every poll. False when
 * either string is unparseable, for the same reason.
 */
export function meetsMinVersion(version: string, minVersion: string): boolean {
  const parsedMin = parseVersion(minVersion)
  if (parsedMin && isNoConstraint(parsedMin)) return true
  const parsedVersion = parseVersion(version)
  if (!parsedVersion || !parsedMin) return false
  return compareVersions(parsedVersion, parsedMin) >= 0
}
