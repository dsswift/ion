/**
 * Theme-pack loader: the single public path from pack directories to a
 * render-ready LoadedTheme. The shipped pack, user packs, and test fixtures
 * all flow through here — no special-casing per source.
 *
 * Pipeline per pack: read raw bundle → validate manifests (schema.ts) →
 * resolve extend/replace (merge.ts) → fetch PNG bytes → verify decoded
 * dimensions against each manifest → decode to bitmaps.
 *
 * I/O and decoding are injected (AtvAssetSource / decode option) so node
 * tests validate real pack bytes without a canvas: pngDimensions() gives the
 * geometry check, and the test decode step returns null bitmaps.
 */
import type {
  AtvBubbleKind,
  AtvBubblesManifest,
  AtvCharacterManifest,
  AtvDressingTemplate,
  AtvFloorManifest,
  AtvFurnitureManifest,
  AtvPetManifest,
  AtvRawPackBundle,
  AtvThemeListEntry,
  AtvThemeManifest,
  AtvWallManifest,
} from '../../../shared/types-atv'
import {
  checkDims,
  expectedAnimationDims,
  expectedFurnitureDims,
  pngDimensions,
  validateBubblesManifest,
  validateCharacterManifest,
  validateDressingTemplate,
  validateFloorManifest,
  validateFurnitureManifest,
  validatePetManifest,
  validateThemeManifest,
  validateWallManifest,
} from './schema'
import { checkPackMinimums, mergePacks, type PackEntry, type ValidatedPack } from './merge'

/** Decoded bitmap. ImageBitmap in the renderer; null under node tests. */
export type AtvBitmap = ImageBitmap | null

export interface LoadedStrip {
  frames: number
  frameW: number
  frameH: number
  bitmap: AtvBitmap
}

export interface LoadedCharacter {
  manifest: AtvCharacterManifest
  animations: Record<string, LoadedStrip>
}

export interface LoadedPet {
  manifest: AtvPetManifest
  animations: Record<string, LoadedStrip>
}

export interface LoadedFurniture {
  manifest: AtvFurnitureManifest
  /** Keyed by images variant or states key. */
  images: Record<string, LoadedStrip>
}

export interface LoadedTheme {
  theme: AtvThemeManifest
  tileSize: number
  characters: Map<string, LoadedCharacter>
  pets: Map<string, LoadedPet>
  furniture: Map<string, LoadedFurniture>
  floors: Map<string, { manifest: AtvFloorManifest; bitmap: AtvBitmap }>
  walls: Map<string, { manifest: AtvWallManifest; bitmap: AtvBitmap }>
  bubbles: Record<AtvBubbleKind, AtvBitmap>
  dressing: Map<string, AtvDressingTemplate>
  /** Assets skipped during load, with reasons (surfaced in the toolbar). */
  skipped: string[]
}

/** Injectable I/O: prod = preload IPC bridge, tests = node fs. */
export interface AtvAssetSource {
  listThemes(): Promise<AtvThemeListEntry[]>
  readBundle(packId: string): Promise<AtvRawPackBundle | null>
  readAsset(packId: string, relPath: string): Promise<ArrayBuffer | null>
}

export interface LoadThemeOptions {
  /** Decode PNG bytes to a bitmap. Defaults to createImageBitmap. */
  decode?: (bytes: ArrayBuffer) => Promise<AtvBitmap>
  /** Sink for per-asset load logs. Defaults to silent (tests) — the ATV shell passes the renderer logger. */
  logWarn?: (msg: string, fields?: Record<string, unknown>) => void
}

/** The production asset source, backed by the preload bridge. */
export function ipcAssetSource(): AtvAssetSource {
  return {
    listThemes: () => window.ion.atvListThemes(),
    readBundle: (packId) => window.ion.atvReadThemeBundle(packId),
    readAsset: (packId, relPath) => window.ion.atvReadThemeAsset(packId, relPath),
  }
}

async function defaultDecode(bytes: ArrayBuffer): Promise<AtvBitmap> {
  return createImageBitmap(new Blob([bytes], { type: 'image/png' }))
}

/** Validate one raw bundle into a ValidatedPack, collecting skip reasons. */
export function validateBundle(bundle: AtvRawPackBundle, skipped: string[]): ValidatedPack | null {
  const themeResult = validateThemeManifest(bundle.theme)
  if (!themeResult.ok) {
    skipped.push(`${bundle.packId}/theme.json: ${themeResult.errors.join('; ')}`)
    return null
  }
  const pack: ValidatedPack = {
    packId: bundle.packId,
    theme: themeResult.value,
    characters: new Map(),
    pets: new Map(),
    furniture: new Map(),
    floors: new Map(),
    walls: new Map(),
    bubbles: null,
    dressing: new Map(),
  }

  function take<M extends { id: string }>(
    kind: string,
    raw: Record<string, unknown>,
    validate: (json: unknown) => { ok: true; value: M } | { ok: false; errors: string[] },
    into: Map<string, PackEntry<M>>,
  ): void {
    for (const [dirId, json] of Object.entries(raw)) {
      const result = validate(json)
      if (!result.ok) {
        skipped.push(`${bundle.packId}/${kind}/${dirId}: ${result.errors.join('; ')}`)
        continue
      }
      if (result.value.id !== dirId) {
        skipped.push(`${bundle.packId}/${kind}/${dirId}: manifest id "${result.value.id}" != directory name`)
        continue
      }
      into.set(dirId, { packId: bundle.packId, dir: `${kind}/${dirId}`, manifest: result.value })
    }
  }

  take('characters', bundle.characters, validateCharacterManifest, pack.characters)
  take('pets', bundle.pets, validatePetManifest, pack.pets)
  take('furniture', bundle.furniture, validateFurnitureManifest, pack.furniture)
  take('floors', bundle.floors, validateFloorManifest, pack.floors)
  take('walls', bundle.walls, validateWallManifest, pack.walls)

  if (bundle.bubbles != null) {
    const result = validateBubblesManifest(bundle.bubbles)
    if (result.ok) pack.bubbles = { packId: bundle.packId, manifest: result.value }
    else skipped.push(`${bundle.packId}/bubbles: ${result.errors.join('; ')}`)
  }
  for (const [zone, json] of Object.entries(bundle.dressing)) {
    const result = validateDressingTemplate(json, zone)
    if (result.ok) pack.dressing.set(zone, { packId: bundle.packId, template: result.value })
    else skipped.push(`${bundle.packId}/dressing/${zone}: ${result.errors.join('; ')}`)
  }
  return pack
}

/**
 * Resolve a pack id to a ValidatedPack with extend semantics applied
 * (one level: an extending pack cannot itself be extended).
 */
export async function resolvePack(
  source: AtvAssetSource,
  packId: string,
  skipped: string[],
): Promise<ValidatedPack | null> {
  const bundle = await source.readBundle(packId)
  if (!bundle) {
    skipped.push(`${packId}: pack not found`)
    return null
  }
  const pack = validateBundle(bundle, skipped)
  if (!pack) return null
  if (!pack.theme.extends) return pack

  const baseBundle = await source.readBundle(pack.theme.extends)
  if (!baseBundle) {
    skipped.push(`${packId}: base pack "${pack.theme.extends}" not found`)
    return null
  }
  const base = validateBundle(baseBundle, skipped)
  if (!base) return null
  if (base.theme.extends) {
    skipped.push(`${packId}: base pack "${base.packId}" is itself an extension (one level only)`)
    return null
  }
  if (base.theme.tileSize !== pack.theme.tileSize) {
    skipped.push(`${packId}: tileSize ${pack.theme.tileSize} != base tileSize ${base.theme.tileSize}`)
    return null
  }
  return mergePacks(base, pack)
}

interface FetchedImage {
  bytes: ArrayBuffer
  width: number
  height: number
}

async function fetchImage(
  source: AtvAssetSource,
  packId: string,
  relPath: string,
  skipped: string[],
): Promise<FetchedImage | null> {
  const bytes = await source.readAsset(packId, relPath)
  if (!bytes) {
    skipped.push(`${packId}/${relPath}: missing asset`)
    return null
  }
  const dims = pngDimensions(bytes)
  if (!dims) {
    skipped.push(`${packId}/${relPath}: not a valid png`)
    return null
  }
  return { bytes, ...dims }
}

/**
 * Load the active theme. Skips invalid assets (collected in `skipped`);
 * throws only when the resolved pack fails the minimum-content check.
 */
export async function loadTheme(
  source: AtvAssetSource,
  packId: string,
  options: LoadThemeOptions = {},
): Promise<LoadedTheme> {
  const decode = options.decode ?? defaultDecode
  const warn = options.logWarn ?? (() => {})
  const skipped: string[] = []
  const pack = await resolvePack(source, packId, skipped)
  if (!pack) {
    for (const s of skipped) warn('atv theme skip', { detail: s })
    throw new Error(`ATV theme "${packId}" failed to load: ${skipped.join(' | ') || 'unknown error'}`)
  }
  const tile = pack.theme.tileSize

  const loaded: LoadedTheme = {
    theme: pack.theme,
    tileSize: tile,
    characters: new Map(),
    pets: new Map(),
    furniture: new Map(),
    floors: new Map(),
    walls: new Map(),
    bubbles: { waiting: null, permission: null, error: null, dispatch: null, plan: null, question: null },
    dressing: new Map(),
    skipped,
  }

  async function loadAnimated<M extends { id: string; animations: Record<string, { file: string; frames: number }> }>(
    entry: PackEntry<M>,
  ): Promise<{ manifest: M; animations: Record<string, LoadedStrip> } | null> {
    const animations: Record<string, LoadedStrip> = {}
    for (const [name, spec] of Object.entries(entry.manifest.animations)) {
      const relPath = `${entry.dir}/${spec.file}`
      const img = await fetchImage(source, entry.packId, relPath, skipped)
      if (!img) return null
      const err = checkDims(img, expectedAnimationDims(spec, tile), tile, `${entry.packId}/${relPath}`)
      if (err) {
        skipped.push(err)
        return null
      }
      animations[name] = {
        frames: spec.frames,
        frameW: tile,
        frameH: tile,
        bitmap: await decode(img.bytes),
      }
    }
    return { manifest: entry.manifest, animations }
  }

  for (const entry of pack.characters.values()) {
    const result = await loadAnimated(entry)
    if (result) loaded.characters.set(entry.manifest.id, result)
  }
  for (const entry of pack.pets.values()) {
    const result = await loadAnimated(entry)
    if (result) loaded.pets.set(entry.manifest.id, result)
  }

  for (const entry of pack.furniture.values()) {
    const m = entry.manifest
    const fileMap = (m.images && Object.keys(m.images).length > 0 ? m.images : m.states) ?? {}
    const images: Record<string, LoadedStrip> = {}
    let bad = false
    for (const [key, file] of Object.entries(fileMap)) {
      const relPath = `${entry.dir}/${file}`
      const img = await fetchImage(source, entry.packId, relPath, skipped)
      if (!img) {
        bad = true
        break
      }
      const expected = expectedFurnitureDims(m, key, tile)
      const err = checkDims(img, expected, tile, `${entry.packId}/${relPath}`)
      if (err) {
        skipped.push(err)
        bad = true
        break
      }
      const frames = m.frames ?? 1
      images[key] = {
        frames,
        frameW: img.width / frames,
        frameH: img.height,
        bitmap: await decode(img.bytes),
      }
    }
    if (!bad) loaded.furniture.set(m.id, { manifest: m, images })
  }

  for (const entry of pack.floors.values()) {
    const relPath = `${entry.dir}/${entry.manifest.file}`
    const img = await fetchImage(source, entry.packId, relPath, skipped)
    if (!img) continue
    const err = checkDims(img, { width: tile, height: tile }, tile, `${entry.packId}/${relPath}`)
    if (err) {
      skipped.push(err)
      continue
    }
    loaded.floors.set(entry.manifest.id, { manifest: entry.manifest, bitmap: await decode(img.bytes) })
  }

  for (const entry of pack.walls.values()) {
    const relPath = `${entry.dir}/${entry.manifest.file}`
    const img = await fetchImage(source, entry.packId, relPath, skipped)
    if (!img) continue
    const err = checkDims(img, { width: 16 * tile, height: tile }, tile, `${entry.packId}/${relPath}`)
    if (err) {
      skipped.push(err)
      continue
    }
    loaded.walls.set(entry.manifest.id, { manifest: entry.manifest, bitmap: await decode(img.bytes) })
  }

  if (pack.bubbles) {
    for (const kind of ['waiting', 'permission', 'error', 'dispatch', 'plan', 'question'] as const) {
      const file = pack.bubbles.manifest[kind]
      if (!file) continue // optional attention kinds
      const relPath = `bubbles/${file}`
      const img = await fetchImage(source, pack.bubbles.packId, relPath, skipped)
      if (!img) continue
      const err = checkDims(img, { width: tile, height: tile }, tile, `${pack.bubbles.packId}/${relPath}`)
      if (err) {
        skipped.push(err)
        continue
      }
      loaded.bubbles[kind] = await decode(img.bytes)
    }
  }

  for (const [zone, entry] of pack.dressing) {
    loaded.dressing.set(zone, entry.template)
  }

  // Post-load minimum check runs on what actually LOADED (an invalid manager
  // sprite must fail the pack even when its manifest validated).
  const loadedCheck: ValidatedPack = {
    ...pack,
    characters: new Map([...pack.characters].filter(([id]) => loaded.characters.has(id))),
    furniture: new Map([...pack.furniture].filter(([id]) => loaded.furniture.has(id))),
    floors: new Map([...pack.floors].filter(([id]) => loaded.floors.has(id))),
    walls: new Map([...pack.walls].filter(([id]) => loaded.walls.has(id))),
  }
  const failures = checkPackMinimums(loadedCheck)
  for (const s of skipped) warn('atv theme skip', { detail: s })
  if (failures.length > 0) {
    throw new Error(`ATV theme "${packId}" unusable: ${failures.join('; ')}`)
  }
  return loaded
}
