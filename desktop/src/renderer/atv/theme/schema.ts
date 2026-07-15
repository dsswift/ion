/**
 * Theme-pack manifest validation. Pure: parsed JSON in, typed result out.
 * No I/O — the loader feeds it manifests and image dimensions; tests feed it
 * fixtures. Contract: docs/design/atv/theme-pack-format.md.
 */
import type {
  AtvAnimationSpec,
  AtvBubblesManifest,
  AtvCharacterManifest,
  AtvDressingTemplate,
  AtvFloorManifest,
  AtvFurnitureManifest,
  AtvPetManifest,
  AtvThemeManifest,
  AtvWallManifest,
} from '../../../shared/types-atv'

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] }

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const REL_FILE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.png$/
const ROLES = new Set(['manager', 'lead', 'specialist'])
const CATEGORIES = new Set(['work', 'mail', 'relax', 'manager', 'decor'])
const ZONES = new Set(['department', 'manager', 'mail', 'break', 'meeting', 'lobby', 'corridor'])
const ROTATIONS = new Set(['none', '2-way', '3-way-mirror'])
const DASHBOARDS = new Set(['kanban', 'sparkline', 'cost-plaque'])
const DIRECTIONS = new Set(['down', 'up', 'left', 'right'])
const BUBBLE_KINDS = ['waiting', 'permission', 'error', 'dispatch'] as const
export const REQUIRED_CHARACTER_ANIMATIONS = [
  'idle',
  'walk-down',
  'walk-up',
  'walk-right',
  'typing',
  'reading',
] as const

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function fail<T>(errors: string[]): ValidationResult<T> {
  return { ok: false, errors }
}

function checkId(v: unknown, errors: string[], field = 'id'): void {
  if (typeof v !== 'string' || !ID_RE.test(v)) errors.push(`${field}: must be kebab-case (got ${JSON.stringify(v)})`)
}

function checkName(v: unknown, errors: string[]): void {
  if (typeof v !== 'string' || v.length === 0 || v.length > 128) errors.push('name: required non-empty string')
}

function checkFile(v: unknown, errors: string[], field: string): void {
  if (typeof v !== 'string' || !REL_FILE_RE.test(v)) {
    errors.push(`${field}: must be a plain relative .png filename (got ${JSON.stringify(v)})`)
  }
}

function checkAnimations(
  v: unknown,
  required: readonly string[],
  errors: string[],
): Record<string, AtvAnimationSpec> {
  const out: Record<string, AtvAnimationSpec> = {}
  if (!isRecord(v)) {
    errors.push('animations: required object')
    return out
  }
  for (const [key, spec] of Object.entries(v)) {
    if (!isRecord(spec)) {
      errors.push(`animations.${key}: must be { file, frames }`)
      continue
    }
    checkFile(spec.file, errors, `animations.${key}.file`)
    if (typeof spec.frames !== 'number' || !Number.isInteger(spec.frames) || spec.frames < 1 || spec.frames > 32) {
      errors.push(`animations.${key}.frames: integer 1..32 required`)
      continue
    }
    if (typeof spec.file === 'string') out[key] = { file: spec.file, frames: spec.frames }
  }
  for (const req of required) {
    if (!out[req]) errors.push(`animations.${req}: required animation missing`)
  }
  return out
}

export function validateThemeManifest(json: unknown): ValidationResult<AtvThemeManifest> {
  if (!isRecord(json)) return fail(['theme.json: not an object'])
  const errors: string[] = []
  checkId(json.id, errors)
  checkName(json.name, errors)
  if (typeof json.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(json.version)) {
    errors.push('version: semver string required')
  }
  if (json.extends != null && (typeof json.extends !== 'string' || !ID_RE.test(json.extends))) {
    errors.push('extends: must be a pack id or null')
  }
  if (typeof json.tileSize !== 'number' || !Number.isInteger(json.tileSize) || json.tileSize < 8 || json.tileSize > 64) {
    errors.push('tileSize: integer 8..64 required')
  }
  if (!Array.isArray(json.palette) || json.palette.some((c) => typeof c !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(c))) {
    errors.push('palette: array of #rrggbb hex strings required')
  }
  if (errors.length > 0) return fail(errors)
  return {
    ok: true,
    value: {
      id: json.id as string,
      name: json.name as string,
      version: json.version as string,
      extends: (json.extends as string | null | undefined) ?? null,
      tileSize: json.tileSize as number,
      palette: json.palette as string[],
      continuity: isRecord(json.continuity) ? json.continuity : undefined,
    },
  }
}

export function validateCharacterManifest(json: unknown): ValidationResult<AtvCharacterManifest> {
  if (!isRecord(json)) return fail(['character manifest: not an object'])
  const errors: string[] = []
  checkId(json.id, errors)
  checkName(json.name, errors)
  if (!Array.isArray(json.roles) || json.roles.length === 0 || json.roles.some((r) => !ROLES.has(r as string))) {
    errors.push('roles: non-empty array of manager|lead|specialist required')
  }
  if (typeof json.tintable !== 'boolean') errors.push('tintable: boolean required')
  const animations = checkAnimations(json.animations, REQUIRED_CHARACTER_ANIMATIONS, errors)
  if (errors.length > 0) return fail(errors)
  return {
    ok: true,
    value: {
      id: json.id as string,
      name: json.name as string,
      roles: json.roles as AtvCharacterManifest['roles'],
      tintable: json.tintable as boolean,
      animations,
    },
  }
}

export function validatePetManifest(json: unknown): ValidationResult<AtvPetManifest> {
  if (!isRecord(json)) return fail(['pet manifest: not an object'])
  const errors: string[] = []
  checkId(json.id, errors)
  checkName(json.name, errors)
  if (json.behavior !== 'wander') errors.push('behavior: only "wander" is defined by this format version')
  const animations = checkAnimations(json.animations, ['idle', 'walk-down', 'walk-up', 'walk-right'], errors)
  if (errors.length > 0) return fail(errors)
  return {
    ok: true,
    value: {
      id: json.id as string,
      name: json.name as string,
      behavior: 'wander',
      animations,
    },
  }
}

export function validateFurnitureManifest(json: unknown): ValidationResult<AtvFurnitureManifest> {
  if (!isRecord(json)) return fail(['furniture manifest: not an object'])
  const errors: string[] = []
  checkId(json.id, errors)
  checkName(json.name, errors)
  if (!CATEGORIES.has(json.category as string)) errors.push('category: work|mail|relax|manager|decor required')
  for (const field of ['footprintW', 'footprintH'] as const) {
    const v = json[field]
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 8) errors.push(`${field}: integer 1..8 required`)
  }
  for (const field of ['width', 'height'] as const) {
    const v = json[field]
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 1024) errors.push(`${field}: integer pixel size required`)
  }
  if (!ROTATIONS.has(json.rotationScheme as string)) errors.push('rotationScheme: none|2-way|3-way-mirror required')
  const frames = json.frames ?? 1
  if (typeof frames !== 'number' || !Number.isInteger(frames) || frames < 1 || frames > 32) {
    errors.push('frames: integer 1..32 required')
  }

  const hasImages = isRecord(json.images) && Object.keys(json.images).length > 0
  const hasStates = isRecord(json.states) && Object.keys(json.states).length > 0
  if (hasImages === hasStates) {
    errors.push('exactly one of images/states must be populated')
  }
  const fileMap = (hasImages ? json.images : json.states) as Record<string, unknown> | undefined
  if (fileMap) {
    for (const [key, file] of Object.entries(fileMap)) checkFile(file, errors, `${hasImages ? 'images' : 'states'}.${key}`)
  }
  if (hasImages) {
    const keys = Object.keys(json.images as Record<string, unknown>).sort()
    const scheme = json.rotationScheme as string
    const expected = scheme === '2-way' ? ['front', 'side'] : scheme === '3-way-mirror' ? ['down', 'right', 'up'] : ['default']
    if (JSON.stringify(keys) !== JSON.stringify(expected)) {
      errors.push(`images: keys must be exactly [${expected.join(', ')}] for scheme ${scheme}`)
    }
  }
  if (json.seatTiles != null) {
    if (!Array.isArray(json.seatTiles)) {
      errors.push('seatTiles: array required')
    } else {
      for (const [i, seat] of (json.seatTiles as unknown[]).entries()) {
        if (!isRecord(seat) || typeof seat.x !== 'number' || typeof seat.y !== 'number' || !DIRECTIONS.has(seat.dir as string)) {
          errors.push(`seatTiles[${i}]: { x, y, dir } required`)
        }
      }
    }
  }
  for (const field of ['isSurface', 'canPlaceOnWalls', 'canPlaceOnSurfaces', 'backgroundTiles', 'tintRegion'] as const) {
    if (json[field] != null && typeof json[field] !== 'boolean') errors.push(`${field}: boolean when present`)
  }
  if (json.dashboard != null && !DASHBOARDS.has(json.dashboard as string)) {
    errors.push('dashboard: kanban|sparkline|cost-plaque when present')
  }
  if (errors.length > 0) return fail(errors)
  return { ok: true, value: json as unknown as AtvFurnitureManifest }
}

export function validateFloorManifest(json: unknown): ValidationResult<AtvFloorManifest> {
  if (!isRecord(json)) return fail(['floor manifest: not an object'])
  const errors: string[] = []
  checkId(json.id, errors)
  checkName(json.name, errors)
  checkFile(json.file, errors, 'file')
  if (json.tintable != null && typeof json.tintable !== 'boolean') errors.push('tintable: boolean when present')
  if (errors.length > 0) return fail(errors)
  return { ok: true, value: json as unknown as AtvFloorManifest }
}

export function validateWallManifest(json: unknown): ValidationResult<AtvWallManifest> {
  if (!isRecord(json)) return fail(['wall manifest: not an object'])
  const errors: string[] = []
  checkId(json.id, errors)
  checkName(json.name, errors)
  checkFile(json.file, errors, 'file')
  if (errors.length > 0) return fail(errors)
  return { ok: true, value: json as unknown as AtvWallManifest }
}

export function validateBubblesManifest(json: unknown): ValidationResult<AtvBubblesManifest> {
  if (!isRecord(json)) return fail(['bubbles manifest: not an object'])
  const errors: string[] = []
  for (const kind of BUBBLE_KINDS) checkFile(json[kind], errors, kind)
  // Attention kinds are optional (older packs lack them; the renderer falls
  // back to the permission bubble) but must be valid files when declared.
  for (const kind of ['plan', 'question'] as const) {
    if (json[kind] != null) checkFile(json[kind], errors, kind)
  }
  if (errors.length > 0) return fail(errors)
  return { ok: true, value: json as unknown as AtvBubblesManifest }
}

export function validateDressingTemplate(json: unknown, expectedZone: string): ValidationResult<AtvDressingTemplate> {
  if (!isRecord(json)) return fail([`dressing/${expectedZone}.json: not an object`])
  const errors: string[] = []
  if (json.zone !== expectedZone) errors.push(`zone: must equal filename zone "${expectedZone}"`)
  if (!ZONES.has(json.zone as string)) errors.push('zone: department|manager|mail|break|corridor required')
  if (json.floor != null) checkId(json.floor, errors, 'floor')
  if (typeof json.density !== 'number' || json.density < 0 || json.density > 1) errors.push('density: number 0..1 required')
  for (const listName of ['required', 'optional'] as const) {
    const list = json[listName]
    if (!Array.isArray(list)) {
      errors.push(`${listName}: array required`)
      continue
    }
    for (const [i, entry] of (list as unknown[]).entries()) {
      if (!isRecord(entry) || (entry.id == null && entry.category == null)) {
        errors.push(`${listName}[${i}]: id or category required`)
        continue
      }
      if (entry.id != null) checkId(entry.id, errors, `${listName}[${i}].id`)
      if (entry.category != null && !CATEGORIES.has(entry.category as string)) {
        errors.push(`${listName}[${i}].category: invalid category`)
      }
      if (listName === 'optional' && (typeof entry.weight !== 'number' || entry.weight <= 0)) {
        errors.push(`optional[${i}].weight: positive number required`)
      }
    }
  }
  if (errors.length > 0) return fail(errors)
  return { ok: true, value: json as unknown as AtvDressingTemplate }
}

// ─── Image geometry ───

/**
 * Parse width/height from a PNG's IHDR chunk. Pure (no canvas), so dimension
 * validation runs identically in the renderer and in node tests.
 * Returns null when the buffer is not a PNG.
 */
export function pngDimensions(buf: ArrayBuffer): { width: number; height: number } | null {
  const bytes = new DataView(buf)
  if (buf.byteLength < 24) return null
  // PNG signature.
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i++) {
    if (bytes.getUint8(i) !== sig[i]) return null
  }
  // First chunk must be IHDR: length(4) type(4) then width, height.
  return { width: bytes.getUint32(16), height: bytes.getUint32(20) }
}

export interface ExpectedDims {
  width: number
  /** Exact height when set. */
  height?: number
  /** Minimum height (tall items overdraw upward); must be a tile multiple. */
  minHeight?: number
}

/** Expected strip dimensions for a character/pet animation. */
export function expectedAnimationDims(spec: AtvAnimationSpec, tileSize: number): ExpectedDims {
  return { width: spec.frames * tileSize, height: tileSize }
}

/**
 * Expected image dimensions for a furniture variant/state file.
 * `key` is the images/states key; rotated variants ('side', 'right') swap the
 * footprint. Heights may exceed the footprint (upward overdraw) but must be
 * tile multiples; widths are exact (times frames for animated strips).
 */
export function expectedFurnitureDims(
  manifest: AtvFurnitureManifest,
  key: string,
  tileSize: number,
): ExpectedDims {
  const rotated = key === 'side' || key === 'right'
  const tilesWide = rotated ? manifest.footprintH : manifest.footprintW
  const frames = manifest.frames ?? 1
  return { width: tilesWide * tileSize * frames, minHeight: tileSize }
}

/** Check decoded dims against expectations; returns an error string or null. */
export function checkDims(actual: { width: number; height: number }, expected: ExpectedDims, tileSize: number, label: string): string | null {
  if (actual.width !== expected.width) {
    return `${label}: width ${actual.width} != expected ${expected.width}`
  }
  if (expected.height != null && actual.height !== expected.height) {
    return `${label}: height ${actual.height} != expected ${expected.height}`
  }
  if (expected.minHeight != null) {
    if (actual.height < expected.minHeight) return `${label}: height ${actual.height} < ${expected.minHeight}`
    if (actual.height % tileSize !== 0) return `${label}: height ${actual.height} not a multiple of tile size ${tileSize}`
  }
  return null
}
