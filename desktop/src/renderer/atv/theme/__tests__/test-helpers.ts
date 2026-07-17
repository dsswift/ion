/**
 * In-memory theme-pack fixtures for loader/schema/merge tests. Real PNG bytes
 * are generated with node's zlib so pngDimensions() exercises the same parse
 * path production uses — no binary fixtures in the repo.
 */
import { deflateSync } from 'zlib'
import type { AtvRawPackBundle, AtvThemeListEntry } from '../../../../shared/types-atv'
import type { AtvAssetSource } from '../loader'

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length)
  return out
}

/** Encode a flat gray RGBA PNG of the given size. */
export function pngBytes(width: number, height: number): ArrayBuffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((width * 4 + 1) * height, 0x55)
  for (let y = 0; y < height; y++) raw[y * (width * 4 + 1)] = 0
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength)
}

export const TILE = 16

export function minimalCharacterManifest(id = 'hero'): Record<string, unknown> {
  return {
    id,
    name: 'Hero',
    roles: ['manager', 'lead', 'specialist'],
    tintable: true,
    animations: {
      idle: { file: 'idle.png', frames: 1 },
      'walk-down': { file: 'walk-down.png', frames: 4 },
      'walk-up': { file: 'walk-up.png', frames: 4 },
      'walk-right': { file: 'walk-right.png', frames: 4 },
      typing: { file: 'typing.png', frames: 2 },
      reading: { file: 'reading.png', frames: 2 },
    },
  }
}

function characterAssets(dir: string): Record<string, ArrayBuffer> {
  return {
    [`${dir}/idle.png`]: pngBytes(TILE, TILE),
    [`${dir}/walk-down.png`]: pngBytes(4 * TILE, TILE),
    [`${dir}/walk-up.png`]: pngBytes(4 * TILE, TILE),
    [`${dir}/walk-right.png`]: pngBytes(4 * TILE, TILE),
    [`${dir}/typing.png`]: pngBytes(2 * TILE, TILE),
    [`${dir}/reading.png`]: pngBytes(2 * TILE, TILE),
  }
}

export interface FixturePack {
  bundle: AtvRawPackBundle
  assets: Record<string, ArrayBuffer>
}

/** A minimal pack that passes the active-theme minimum-content check. */
export function minimalPack(packId = 'test-pack', extendsId: string | null = null): FixturePack {
  const bundle: AtvRawPackBundle = {
    packId,
    builtin: false,
    theme: {
      id: packId,
      name: 'Test Pack',
      version: '1.0.0',
      extends: extendsId,
      tileSize: TILE,
      palette: ['#101010', '#f2f5fa'],
    },
    characters: { hero: minimalCharacterManifest('hero') },
    pets: {},
    furniture: {
      chair: {
        id: 'chair',
        name: 'Chair',
        category: 'work',
        footprintW: 1,
        footprintH: 1,
        width: TILE,
        height: TILE,
        rotationScheme: 'none',
        images: { default: 'default.png' },
        seatTiles: [{ x: 0, y: 0, dir: 'down' }],
      },
    },
    floors: { floor: { id: 'floor', name: 'Floor', file: 'floor.png' } },
    walls: { wall: { id: 'wall', name: 'Wall', file: 'tiles.png' } },
    bubbles: {
      waiting: 'waiting.png',
      permission: 'permission.png',
      error: 'error.png',
      dispatch: 'dispatch.png',
    },
    dressing: {
      department: {
        zone: 'department',
        floor: 'floor',
        required: [{ id: 'chair', perSeat: true }],
        optional: [],
        density: 0.1,
      },
    },
  }
  const assets: Record<string, ArrayBuffer> = {
    ...characterAssets('characters/hero'),
    'furniture/chair/default.png': pngBytes(TILE, TILE),
    'floors/floor/floor.png': pngBytes(TILE, TILE),
    'walls/wall/tiles.png': pngBytes(16 * TILE, TILE),
    'bubbles/waiting.png': pngBytes(TILE, TILE),
    'bubbles/permission.png': pngBytes(TILE, TILE),
    'bubbles/error.png': pngBytes(TILE, TILE),
    'bubbles/dispatch.png': pngBytes(TILE, TILE),
  }
  return { bundle, assets }
}

/** An in-memory AtvAssetSource over fixture packs. */
export function memorySource(packs: FixturePack[]): AtvAssetSource {
  const byId = new Map(packs.map((p) => [p.bundle.packId, p]))
  return {
    listThemes: async (): Promise<AtvThemeListEntry[]> =>
      packs.map((p) => ({
        id: p.bundle.packId,
        name: String((p.bundle.theme as Record<string, unknown>).name ?? p.bundle.packId),
        version: '1.0.0',
        builtin: false,
      })),
    readBundle: async (packId) => byId.get(packId)?.bundle ?? null,
    readAsset: async (packId, relPath) => byId.get(packId)?.assets[relPath] ?? null,
  }
}

/** Decode stub for node tests (no canvas): geometry checks still run. */
export async function nullDecode(): Promise<null> {
  return null
}
