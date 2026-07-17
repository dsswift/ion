/**
 * Theme-pack merge semantics (extend vs replace). Pure — operates on
 * validated pack structures; asset bytes are fetched later by the loader
 * using each entry's source packId.
 */
import type {
  AtvBubblesManifest,
  AtvCharacterManifest,
  AtvDressingTemplate,
  AtvFloorManifest,
  AtvFurnitureManifest,
  AtvPetManifest,
  AtvThemeManifest,
  AtvWallManifest,
} from '../../../shared/types-atv'

/** One validated asset entry with its source pack (for asset byte reads). */
export interface PackEntry<M> {
  packId: string
  /** Directory of the manifest inside the pack, e.g. `characters/mgr-blazer`. */
  dir: string
  manifest: M
}

export interface ValidatedPack {
  packId: string
  theme: AtvThemeManifest
  characters: Map<string, PackEntry<AtvCharacterManifest>>
  pets: Map<string, PackEntry<AtvPetManifest>>
  furniture: Map<string, PackEntry<AtvFurnitureManifest>>
  floors: Map<string, PackEntry<AtvFloorManifest>>
  walls: Map<string, PackEntry<AtvWallManifest>>
  bubbles: { packId: string; manifest: AtvBubblesManifest } | null
  dressing: Map<string, { packId: string; template: AtvDressingTemplate }>
}

function mergeMap<M>(base: Map<string, PackEntry<M>>, ext: Map<string, PackEntry<M>>): Map<string, PackEntry<M>> {
  const out = new Map(base)
  // Id collision overrides the base entry; new ids are added.
  for (const [id, entry] of ext) out.set(id, entry)
  return out
}

/**
 * Merge an extending pack onto its base. The merged pack keeps the base
 * theme's tile size and palette (extension packs must match tileSize — the
 * loader enforces this before merging) and identifies as the extending pack.
 * Dressing templates replace per zone file; the bubbles set replaces whole
 * when the extension ships one.
 */
export function mergePacks(base: ValidatedPack, ext: ValidatedPack): ValidatedPack {
  return {
    packId: ext.packId,
    theme: {
      ...base.theme,
      id: ext.theme.id,
      name: ext.theme.name,
      version: ext.theme.version,
      extends: base.theme.id,
    },
    characters: mergeMap(base.characters, ext.characters),
    pets: mergeMap(base.pets, ext.pets),
    furniture: mergeMap(base.furniture, ext.furniture),
    floors: mergeMap(base.floors, ext.floors),
    walls: mergeMap(base.walls, ext.walls),
    bubbles: ext.bubbles ?? base.bubbles,
    dressing: new Map([...base.dressing, ...ext.dressing]),
  }
}

/**
 * Minimum content for a pack to serve as the ACTIVE theme (replace mode, or
 * the result of a merge). Returns the list of failures (empty = usable).
 */
export function checkPackMinimums(pack: ValidatedPack): string[] {
  const failures: string[] = []
  const hasManager = [...pack.characters.values()].some((c) => c.manifest.roles.includes('manager'))
  if (!hasManager) failures.push('no character with the manager role')
  if (pack.floors.size === 0) failures.push('no floors')
  if (pack.walls.size === 0) failures.push('no wall sets')
  if (!pack.bubbles) failures.push('no bubbles manifest')
  const hasSeat = [...pack.furniture.values()].some((f) => (f.manifest.seatTiles?.length ?? 0) > 0)
  if (!hasSeat) failures.push('no seat-capable furniture')
  if (!pack.dressing.has('department')) failures.push('no department dressing template')
  return failures
}
