/**
 * theme-packs — main-process discovery, validation, and asset serving for
 * desktop/iOS color theme packs.
 *
 * Discovery, not enumeration: the pool is whatever pack directories exist.
 * Two roots are scanned:
 *   - user:   ~/.ion/themes                          (user-installed packs)
 *   - system: /Library/Application Support/Ion/themes (machine-scope MDM
 *             drops; per-platform equivalents below)
 * A system pack whose id collides with a user pack shadows it — enterprise
 * wins. Built-in theme ids are reserved and refused (see theme-pack-types).
 *
 * Manifest validation is shared with the renderer + tests
 * (`shared/theme-pack-types.ts`). Asset reads are containment-guarded: a
 * resolved path escaping the pack root (traversal, absolute path, symlink)
 * is refused. Assets are capped at 3 MB each so the iOS lazy-fetch response
 * stays comfortably under the 6 MB wire plaintext gate after base64.
 */
import { createHash } from 'crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, watch, type FSWatcher } from 'fs'
import { homedir } from 'os'
import { extname, join, resolve, sep } from 'path'
import { log as _log } from './logger'
import { darkColors } from '../renderer/theme/palette-dark'
import {
  BUILTIN_THEME_IDS,
  THEME_PACK_ID_RE,
  validateThemePackManifest,
  type CustomThemeForRenderer,
  type LoadedThemeAsset,
  type LoadedThemePack,
  type ThemeAssetSlot,
  type ThemePackAssetRefs,
} from '../shared/theme-pack-types'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('themes', msg, fields)
}

/** Per-asset byte cap. 3 MB raw ≈ 4 MB after base64 — headroom under the
 * 6 MB wire plaintext gate even with two assets in flight. */
export const THEME_ASSET_MAX_BYTES = 3 * 1024 * 1024

const ASSET_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

/** The live ColorPalette key set — the desktop-token contract. */
const DESKTOP_TOKEN_KEYS: ReadonlySet<string> = new Set(Object.keys(darkColors))

// Test seam: overridden by resetThemePacksForTest so loader tests can point
// both roots at temp directories without mocking os/fs.
let rootOverrides: { user: string; system: string } | null = null

export function userThemesRoot(): string {
  return rootOverrides?.user ?? join(homedir(), '.ion', 'themes')
}

/** Machine-scope root for MDM-deployed packs. Root/admin-owned on a managed
 * device, which is what makes "enterprise wins" meaningful. */
export function systemThemesRoot(): string {
  if (rootOverrides) return rootOverrides.system
  if (process.platform === 'darwin') return '/Library/Application Support/Ion/themes'
  if (process.platform === 'win32') return join(process.env.PROGRAMDATA ?? 'C:\\ProgramData', 'Ion', 'themes')
  return '/etc/ion/themes'
}

// ─── Scan ───

function validateAssets(
  packDir: string,
  packId: string,
  refs: ThemePackAssetRefs | undefined,
  side: 'desktop' | 'ios',
): LoadedThemeAsset[] {
  if (!refs) return []
  const out: LoadedThemeAsset[] = []
  let realRoot: string
  try {
    realRoot = realpathSync(packDir)
  } catch (err) {
    log('asset validation skipped; pack dir unreadable', { pack_id: packId, error: String(err) })
    return []
  }
  for (const slot of ['background', 'logo'] as const) {
    const rel = refs[slot]
    if (!rel) continue
    const mime = ASSET_MIME_BY_EXT[extname(rel).toLowerCase()]
    if (!mime) {
      log('asset dropped: unsupported type', { pack_id: packId, side, slot, rel_path: rel })
      continue
    }
    const candidate = resolve(realRoot, rel)
    let realFile: string
    try {
      realFile = realpathSync(candidate)
    } catch {
      log('asset dropped: missing', { pack_id: packId, side, slot, rel_path: rel })
      continue
    }
    if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) {
      log('asset dropped: escapes pack root', { pack_id: packId, side, slot, rel_path: rel })
      continue
    }
    let size: number
    try {
      size = statSync(realFile).size
    } catch (err) {
      log('asset dropped: stat failed', { pack_id: packId, side, slot, error: String(err) })
      continue
    }
    if (size === 0 || size > THEME_ASSET_MAX_BYTES) {
      log('asset dropped: size out of bounds', { pack_id: packId, side, slot, bytes: size, cap: THEME_ASSET_MAX_BYTES })
      continue
    }
    let bytes: Buffer
    try {
      bytes = readFileSync(realFile)
    } catch (err) {
      log('asset dropped: read failed', { pack_id: packId, side, slot, error: String(err) })
      continue
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    out.push({ slot, relPath: rel, sha256, size, mime })
  }
  return out
}

function scanRoot(root: string, source: 'user' | 'system', into: Map<string, LoadedThemePack>): void {
  if (!existsSync(root)) return
  let dirs: string[] = []
  try {
    dirs = readdirSync(root)
  } catch (err) {
    log('root unreadable', { root, error: String(err) })
    return
  }
  for (const dir of dirs) {
    if (!THEME_PACK_ID_RE.test(dir)) continue
    const packDir = join(root, dir)
    try {
      if (!statSync(packDir).isDirectory()) continue
    } catch {
      continue
    }
    const manifestPath = join(packDir, 'theme.json')
    if (!existsSync(manifestPath)) {
      log('skipping dir without theme.json', { dir: packDir })
      continue
    }
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    } catch (err) {
      log('skipping pack with unreadable theme.json', { pack_id: dir, error: String(err) })
      continue
    }
    const result = validateThemePackManifest(raw, dir, DESKTOP_TOKEN_KEYS)
    for (const diagnostic of result.diagnostics) {
      log('manifest diagnostic', {
        pack_id: dir,
        source,
        surface: diagnostic.surface,
        fatal: diagnostic.fatal,
        message: diagnostic.message,
      })
    }
    if (!result.ok || !result.pack) {
      log('skipping invalid pack', { pack_id: dir, source, error: result.error })
      continue
    }
    if (into.has(dir) && source === 'system') {
      log('system pack shadows user pack', { pack_id: dir })
    }
    into.set(dir, {
      manifest: result.pack,
      source,
      desktopAssets: validateAssets(packDir, dir, result.pack.desktop?.assets, 'desktop'),
      iosAssets: validateAssets(packDir, dir, result.pack.ios?.assets, 'ios'),
      diagnostics: result.diagnostics,
    })
  }
}

function scan(): LoadedThemePack[] {
  const found = new Map<string, LoadedThemePack>()
  // User first, then system — system overwrites on collision (enterprise wins).
  scanRoot(userThemesRoot(), 'user', found)
  scanRoot(systemThemesRoot(), 'system', found)
  const packs = [...found.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))
  log('scanned', {
    count: packs.length,
    ids: packs.map((p) => p.manifest.id).join(','),
  })
  return packs
}

// ─── Cache + change notification ───

let cache: LoadedThemePack[] | null = null
const changeListeners = new Set<() => void>()

/** Current packs (lazy first scan, then cached until rescan). */
export function getThemePacks(): LoadedThemePack[] {
  if (cache === null) cache = scan()
  return cache
}

/** Structural fingerprint used to decide whether a rescan changed anything. */
function fingerprint(packs: LoadedThemePack[]): string {
  return JSON.stringify(
    packs.map((p) => [p.manifest, p.source, p.desktopAssets, p.iosAssets]),
  )
}

/**
 * Re-scan both roots. Returns true when the pack set changed; on change,
 * every registered listener fires (renderer push, settings-snapshot
 * rebroadcast, iOS theme-manifest rebroadcast).
 */
export function rescanThemePacks(): boolean {
  const before = cache === null ? null : fingerprint(cache)
  cache = scan()
  const changed = before !== fingerprint(cache)
  if (changed) {
    log('pack set changed; notifying listeners', { listeners: changeListeners.size })
    for (const listener of changeListeners) {
      try {
        listener()
      } catch (err) {
        log('change listener threw', { error: String(err) })
      }
    }
  }
  return changed
}

/** Subscribe to pack-set changes (fired by rescanThemePacks on diff). */
export function onThemePacksChanged(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

// ─── Watcher ───

let watchers: FSWatcher[] = []
let rescanTimer: NodeJS.Timeout | null = null

/**
 * Watch both roots for pack installs/removals/edits (MDM drops land while
 * the app runs). Events are debounced into one rescan. The user root may
 * not exist yet on first launch — watch what exists; a later install is
 * still caught by the sync-time rescan in the remote handlers.
 */
export function startThemePackWatcher(): void {
  stopThemePackWatcher()
  for (const root of [userThemesRoot(), systemThemesRoot()]) {
    if (!existsSync(root)) continue
    try {
      const w = watch(root, { recursive: true }, () => {
        if (rescanTimer) clearTimeout(rescanTimer)
        rescanTimer = setTimeout(() => {
          rescanTimer = null
          log('watcher triggered rescan')
          rescanThemePacks()
        }, 500)
      })
      watchers.push(w)
      log('watching themes root', { root })
    } catch (err) {
      log('failed to watch themes root', { root, error: String(err) })
    }
  }
}

export function stopThemePackWatcher(): void {
  for (const w of watchers) w.close()
  watchers = []
  if (rescanTimer) {
    clearTimeout(rescanTimer)
    rescanTimer = null
  }
}

// ─── Consumers ───

/** True when `id` is a built-in or an installed pack with a desktop
 * component — the validity test for `selectedTheme` writes. */
export function isKnownDesktopThemeId(id: string, builtinIds: readonly string[]): boolean {
  if (builtinIds.includes(id)) return true
  return getThemePacks().some((p) => p.manifest.id === id && p.manifest.desktop !== undefined)
}

/** Enum choices for the `selectedTheme` projectable schema: installed packs
 * that carry a desktop component. */
export function customThemeChoices(): Array<{ value: string; label: string }> {
  return getThemePacks()
    .filter((p) => p.manifest.desktop !== undefined)
    .map((p) => ({ value: p.manifest.id, label: p.manifest.name }))
}

function assetDataUrl(pack: LoadedThemePack, asset: LoadedThemeAsset): string | null {
  const packDir = join(pack.source === 'user' ? userThemesRoot() : systemThemesRoot(), pack.manifest.id)
  const bytes = readThemeAssetBytes(packDir, asset.relPath)
  if (!bytes) return null
  return `data:${asset.mime};base64,${bytes.toString('base64')}`
}

/** Containment-guarded raw read (same guard as validation — re-checked at
 * read time because the file can change between scan and read). */
function readThemeAssetBytes(packDir: string, relPath: string): Buffer | null {
  let realRoot: string
  try {
    realRoot = realpathSync(packDir)
  } catch {
    return null
  }
  const candidate = resolve(realRoot, relPath)
  let realFile: string
  try {
    realFile = realpathSync(candidate)
  } catch {
    log('asset read refused: missing', { rel_path: relPath })
    return null
  }
  if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) {
    log('asset read refused: escapes pack root', { rel_path: relPath })
    return null
  }
  try {
    const size = statSync(realFile).size
    if (size === 0 || size > THEME_ASSET_MAX_BYTES) {
      log('asset read refused: size out of bounds', { rel_path: relPath, bytes: size })
      return null
    }
    return readFileSync(realFile)
  } catch (err) {
    log('asset read failed', { rel_path: relPath, error: String(err) })
    return null
  }
}

/**
 * Custom themes as the renderer registry consumes them: desktop components
 * only, base + tokens + inline asset data URLs.
 */
export function getRendererThemes(): CustomThemeForRenderer[] {
  const out: CustomThemeForRenderer[] = []
  for (const pack of getThemePacks()) {
    const desktop = pack.manifest.desktop
    const diagnostics = pack.diagnostics.filter((d) => d.surface === 'ios' || d.surface === 'desktop')
    if (!desktop && diagnostics.length === 0) continue
    const entry: CustomThemeForRenderer = {
      id: pack.manifest.id,
      name: pack.manifest.name,
      version: pack.manifest.version,
      tokens: desktop?.tokens ?? {},
      ...(desktop ? { base: desktop.base } : { desktopAvailable: false }),
    }
    if (desktop?.forcedColorScheme) entry.forcedColorScheme = desktop.forcedColorScheme
    // Diagnostics are typed at validation time, so accepted-but-degraded
    // components and rejected `.base` components retain their surface.
    const iosDiagnostics = pack.diagnostics.filter((d) => d.surface === 'ios')
    const desktopDiagnostics = pack.diagnostics.filter((d) => d.surface === 'desktop')
    if (iosDiagnostics.length > 0) entry.iosDiagnostics = iosDiagnostics
    if (desktopDiagnostics.length > 0) entry.desktopDiagnostics = desktopDiagnostics
    for (const asset of pack.desktopAssets) {
      const dataUrl = assetDataUrl(pack, asset)
      if (!dataUrl) continue
      if (asset.slot === 'background') entry.backgroundDataUrl = dataUrl
      else entry.logoDataUrl = dataUrl
    }
    out.push(entry)
  }
  return out
}

/** The wire shape of one synced theme in `desktop_theme_manifest`. */
export interface ThemeManifestEntry {
  id: string
  name: string
  version: string
  tokens: Record<string, string>
  /** Built-in id the iOS component inherits omitted required tokens from
   * (required-when-partial). Absent when the component supplies the complete
   * required set. iOS resolves the inheritance against its compiled-in
   * built-in themes. */
  base?: (typeof BUILTIN_THEME_IDS)[number]
  preferredColorScheme?: 'light' | 'dark'
  assets?: Array<{ slot: ThemeAssetSlot; sha256: string; size: number }>
}

/**
 * Build the `desktop_theme_manifest` payload: the iOS components of every
 * installed pack (built-ins never ride the wire). The hash fingerprints the
 * canonical payload so iOS can skip re-persisting an unchanged set.
 */
export function buildThemeManifest(): { themes: ThemeManifestEntry[]; hash: string } {
  const themes: ThemeManifestEntry[] = []
  for (const pack of getThemePacks()) {
    const ios = pack.manifest.ios
    if (!ios) continue
    const entry: ThemeManifestEntry = {
      id: pack.manifest.id,
      name: pack.manifest.name,
      version: pack.manifest.version,
      tokens: ios.tokens,
    }
    if (ios.base) entry.base = ios.base
    if (ios.preferredColorScheme) entry.preferredColorScheme = ios.preferredColorScheme
    if (pack.iosAssets.length > 0) {
      entry.assets = pack.iosAssets.map((a) => ({ slot: a.slot, sha256: a.sha256, size: a.size }))
    }
    themes.push(entry)
  }
  const hash = createHash('sha256').update(JSON.stringify(themes)).digest('hex')
  return { themes, hash }
}

/**
 * Read one iOS-side asset for the wire lazy-fetch
 * (`desktop_request_theme_asset`). Returns null for unknown pack/slot,
 * containment escape, or size violation.
 */
export function readIosThemeAsset(
  themeId: string,
  slot: ThemeAssetSlot,
): { dataUrl: string; sha256: string } | null {
  if (!THEME_PACK_ID_RE.test(themeId)) return null
  const pack = getThemePacks().find((p) => p.manifest.id === themeId)
  if (!pack) {
    log('ios asset request for unknown pack', { pack_id: themeId, slot })
    return null
  }
  const asset = pack.iosAssets.find((a) => a.slot === slot)
  if (!asset) {
    log('ios asset request for undeclared slot', { pack_id: themeId, slot })
    return null
  }
  const dataUrl = assetDataUrl(pack, asset)
  if (!dataUrl) return null
  return { dataUrl, sha256: asset.sha256 }
}

/** Test hook: reset module state (and optionally point the scan roots at
 * temp directories) so each test starts from a clean scan. */
export function resetThemePacksForTest(roots?: { user: string; system: string }): void {
  cache = null
  changeListeners.clear()
  stopThemePackWatcher()
  rootOverrides = roots ?? null
}
