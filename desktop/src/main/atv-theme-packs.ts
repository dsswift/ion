/**
 * atv-theme-packs — main-process discovery and raw reads for ATV theme packs.
 *
 * Discovery, not enumeration: the pools are whatever pack directories exist.
 * Two roots are scanned:
 *   - bundled: <resources>/atv/themes  (ships with the app)
 *   - user:    ~/.ion/atv/themes      (user-installed packs)
 * A user pack whose id collides with a bundled pack shadows it, so a user can
 * override the shipped theme without forking the app.
 *
 * The main process reads JSON raw and serves asset bytes; validation happens
 * in the renderer (theme/schema.ts) so tests and user packs flow through the
 * same public loader path. Asset reads are containment-guarded: a resolved
 * path escaping the pack root (traversal, absolute path, symlink) is refused.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import { join, resolve, sep } from 'path'
import { log as _log } from './logger'
import type { AtvRawPackBundle, AtvThemeListEntry } from '../shared/types-atv'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('atv', msg, fields)
}

const PACK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const ASSET_DIRS = ['characters', 'pets', 'furniture', 'floors', 'walls'] as const

function bundledRoot(): string {
  return join(__dirname, '../../resources/atv/themes')
}

function userRoot(): string {
  return join(homedir(), '.ion', 'atv', 'themes')
}

interface PackLocation {
  id: string
  root: string
  builtin: boolean
}

function readJson(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    log('theme_packs: unreadable json', { path, error: String(err) })
    return null
  }
}

/** Scan both roots. User packs shadow bundled packs on id collision. */
function scanPackLocations(): Map<string, PackLocation> {
  const found = new Map<string, PackLocation>()
  const roots: Array<{ root: string; builtin: boolean }> = [
    { root: bundledRoot(), builtin: true },
    { root: userRoot(), builtin: false },
  ]
  for (const { root, builtin } of roots) {
    if (!existsSync(root)) continue
    let dirs: string[] = []
    try {
      dirs = readdirSync(root)
    } catch (err) {
      log('theme_packs: root unreadable', { root, error: String(err) })
      continue
    }
    for (const dir of dirs) {
      if (!PACK_ID_RE.test(dir)) continue
      const packDir = join(root, dir)
      try {
        if (!statSync(packDir).isDirectory()) continue
      } catch {
        continue
      }
      if (!existsSync(join(packDir, 'theme.json'))) {
        log('theme_packs: skipping dir without theme.json', { dir: packDir })
        continue
      }
      if (found.has(dir) && !builtin) {
        log('theme_packs: user pack shadows bundled pack', { pack_id: dir })
      }
      found.set(dir, { id: dir, root: packDir, builtin })
    }
  }
  return found
}

/** List discovered packs with their display metadata. */
export function listThemePacks(): AtvThemeListEntry[] {
  const out: AtvThemeListEntry[] = []
  for (const loc of scanPackLocations().values()) {
    const theme = readJson(join(loc.root, 'theme.json'))
    if (typeof theme !== 'object' || theme === null) {
      log('theme_packs: skipping pack with invalid theme.json', { pack_id: loc.id })
      continue
    }
    const t = theme as Record<string, unknown>
    if (t.id !== loc.id) {
      log('theme_packs: skipping pack whose theme id mismatches its directory', {
        pack_id: loc.id,
        theme_id: String(t.id),
      })
      continue
    }
    out.push({
      id: loc.id,
      name: typeof t.name === 'string' ? t.name : loc.id,
      version: typeof t.version === 'string' ? t.version : '0.0.0',
      builtin: loc.builtin,
    })
  }
  log('theme_packs: listed', { count: out.length })
  return out
}

/**
 * Read everything JSON in one pack, raw. The renderer validates. Returns null
 * for an unknown pack id.
 */
export function readPackBundle(packId: string): AtvRawPackBundle | null {
  if (!PACK_ID_RE.test(packId)) return null
  const loc = scanPackLocations().get(packId)
  if (!loc) {
    log('theme_packs: bundle for unknown pack', { pack_id: packId })
    return null
  }
  const bundle: AtvRawPackBundle = {
    packId,
    builtin: loc.builtin,
    theme: readJson(join(loc.root, 'theme.json')),
    characters: {},
    pets: {},
    furniture: {},
    floors: {},
    walls: {},
    bubbles: null,
    dressing: {},
  }
  for (const kind of ASSET_DIRS) {
    const kindDir = join(loc.root, kind)
    if (!existsSync(kindDir)) continue
    let ids: string[] = []
    try {
      ids = readdirSync(kindDir)
    } catch {
      continue
    }
    for (const id of ids) {
      if (!PACK_ID_RE.test(id)) continue
      const manifestPath = join(kindDir, id, 'manifest.json')
      if (!existsSync(manifestPath)) continue
      const json = readJson(manifestPath)
      if (json != null) bundle[kind][id] = json
    }
  }
  const bubblesPath = join(loc.root, 'bubbles', 'manifest.json')
  if (existsSync(bubblesPath)) bundle.bubbles = readJson(bubblesPath)
  const dressingDir = join(loc.root, 'dressing')
  if (existsSync(dressingDir)) {
    for (const file of readdirSync(dressingDir)) {
      if (!file.endsWith('.json')) continue
      const zone = file.slice(0, -'.json'.length)
      const json = readJson(join(dressingDir, file))
      if (json != null) bundle.dressing[zone] = json
    }
  }
  log('theme_packs: bundle read', {
    pack_id: packId,
    characters: Object.keys(bundle.characters).length,
    furniture: Object.keys(bundle.furniture).length,
  })
  return bundle
}

/**
 * Read raw PNG bytes for an asset inside a pack. Containment-guarded:
 * the realpath of the requested file must remain under the realpath of the
 * pack root, so traversal segments, absolute paths, and symlinked escapes
 * are all refused.
 */
export function readThemeAsset(packId: string, relPath: string): Buffer | null {
  if (!PACK_ID_RE.test(packId)) return null
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 512) return null
  if (!relPath.endsWith('.png')) {
    log('theme_packs: asset read refused (not a png)', { pack_id: packId, rel_path: relPath })
    return null
  }
  const loc = scanPackLocations().get(packId)
  if (!loc) return null
  let realRoot: string
  try {
    realRoot = realpathSync(loc.root)
  } catch {
    return null
  }
  const candidate = resolve(realRoot, relPath)
  let realFile: string
  try {
    realFile = realpathSync(candidate)
  } catch {
    log('theme_packs: asset read refused (missing)', { pack_id: packId, rel_path: relPath })
    return null
  }
  if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) {
    log('theme_packs: asset read refused (escapes pack root)', { pack_id: packId, rel_path: relPath })
    return null
  }
  try {
    return readFileSync(realFile)
  } catch (err) {
    log('theme_packs: asset read failed', { pack_id: packId, rel_path: relPath, error: String(err) })
    return null
  }
}
