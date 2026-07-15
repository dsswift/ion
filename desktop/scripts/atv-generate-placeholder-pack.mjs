#!/usr/bin/env node
/**
 * One-shot generator for the ATV placeholder theme pack.
 *
 * Emits flat-shaded placeholder PNGs plus fully valid manifests to
 * desktop/resources/atv/themes/ion-works/ in the exact Pass-1 MVP-kit shape,
 * so the loader, generator, renderer, packaging, and the shipped-pack test
 * exercise the real pack path before final art lands. Final sprites replace
 * these bytes in place with zero code changes.
 *
 * Run manually (output is committed): node scripts/atv-generate-placeholder-pack.mjs
 * No dependencies: PNG encoding is done inline with node's zlib.
 */
import { deflateSync } from 'zlib'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'atv', 'themes', 'ion-works')
const TILE = 16

// Master palette (docs/design/atv/asset-design.md)
const PALETTE = [
  '#1a1d24', '#14161c', '#232733', '#2e3442', '#3d4557', '#566073', '#6f7a90', '#97a1b5', '#c3cbdb',
  '#5c4530', '#7a5a3a', '#a97e52', '#cfa877', '#e8cfa4', '#d9cfc0',
  '#57e6ff', '#2bb8e6', '#3d7bff', '#6a5cff', '#9a4dff', '#c96bff',
  '#3ecf6e', '#ffb340', '#ff5252', '#f2f5fa',
  '#2e6b3a', '#4a9950', '#7cc46a', '#3e5a8c', '#8c3e4a', '#4a505e', '#8b93a6',
]
const C = {
  outline: '#1a1d24', wood: '#a97e52', woodLight: '#cfa877', woodDark: '#7a5a3a',
  graphite: '#2e3442', slate: '#566073', slateLight: '#97a1b5', screen: '#2bb8e6',
  screenBright: '#57e6ff', glow: '#9a4dff', green: '#3ecf6e', amber: '#ffb340',
  red: '#ff5252', paper: '#f2f5fa', leaf: '#4a9950', leafDark: '#2e6b3a',
  fabric: '#3e5a8c', pot: '#b06a45', metal: '#4a505e', dark: '#14161c',
}

// ── Tiny PNG encoder (RGBA, no interlace) ──

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length)
  return out
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── Pixel canvas helpers ──

function canvas(w, h) {
  return { w, h, data: Buffer.alloc(w * h * 4) }
}

function hex(colorStr) {
  return [parseInt(colorStr.slice(1, 3), 16), parseInt(colorStr.slice(3, 5), 16), parseInt(colorStr.slice(5, 7), 16)]
}

function px(cv, x, y, color) {
  if (x < 0 || y < 0 || x >= cv.w || y >= cv.h) return
  const [r, g, b] = hex(color)
  const i = (y * cv.w + x) * 4
  cv.data[i] = r
  cv.data[i + 1] = g
  cv.data[i + 2] = b
  cv.data[i + 3] = 255
}

function rect(cv, x, y, w, h, color) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) px(cv, xx, yy, color)
}

function outlineRect(cv, x, y, w, h, fill, outline = C.outline) {
  rect(cv, x, y, w, h, outline)
  rect(cv, x + 1, y + 1, w - 2, h - 2, fill)
}

function save(relPath, cv) {
  const abs = join(ROOT, relPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, encodePng(cv.w, cv.h, cv.data))
}

function saveJson(relPath, obj) {
  const abs = join(ROOT, relPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, JSON.stringify(obj, null, 2) + '\n')
}

// ── Character frames ──
// Simple readable placeholder figure: head circle-ish block, tinted torso
// (slate tones = runtime tint layer), legs alternating by frame.

function drawFigure(cv, ox, frame, facing, pose) {
  // head
  rect(cv, ox + 5, 2, 6, 5, '#e8cfa4')
  rect(cv, ox + 5, 2, 6, 2, C.graphite) // hair
  if (facing !== 'up') {
    px(cv, ox + 6, 5, C.outline)
    px(cv, ox + 9, 5, C.outline) // eyes
  }
  // torso (tint layer: slate)
  rect(cv, ox + 4, 7, 8, 5, '#566073')
  rect(cv, ox + 4, 7, 8, 1, '#6f7a90')
  if (pose === 'slump') {
    rect(cv, ox + 4, 7, 8, 5, '#3d4557')
  }
  // arms
  if (pose === 'typing') {
    rect(cv, ox + 3, 9 + (frame % 2), 2, 2, '#e8cfa4')
    rect(cv, ox + 11, 10 - (frame % 2), 2, 2, '#e8cfa4')
  } else if (pose === 'stretch') {
    rect(cv, ox + 3, 5 - (frame % 2), 2, 3, '#e8cfa4')
    rect(cv, ox + 11, 5 - (frame % 2), 2, 3, '#e8cfa4')
  } else if (pose === 'reading') {
    rect(cv, ox + 5, 9, 6, 3, C.paper)
    px(cv, ox + 7 + (frame % 2), 10, C.slate)
  }
  // legs (walk cycle: alternate)
  const stride = pose === 'walk' ? frame % 2 : 0
  rect(cv, ox + 5, 12, 2, 3 - stride, C.graphite)
  rect(cv, ox + 9, 12, 2, 2 + stride, C.graphite)
  // facing marker
  if (facing === 'right') px(cv, ox + 11, 4, '#57e6ff')
  if (facing === 'up') rect(cv, ox + 5, 4, 6, 3, C.graphite)
}

function characterStrip(frames, facing, pose) {
  const cv = canvas(frames * TILE, TILE)
  for (let f = 0; f < frames; f++) drawFigure(cv, f * TILE, f, facing, pose)
  return cv
}

function writeCharacter() {
  const dir = 'characters/mgr-blazer'
  save(`${dir}/idle.png`, characterStrip(1, 'down', 'idle'))
  save(`${dir}/walk-down.png`, characterStrip(4, 'down', 'walk'))
  save(`${dir}/walk-up.png`, characterStrip(4, 'up', 'walk'))
  save(`${dir}/walk-right.png`, characterStrip(4, 'right', 'walk'))
  save(`${dir}/typing.png`, characterStrip(2, 'down', 'typing'))
  save(`${dir}/reading.png`, characterStrip(2, 'down', 'reading'))
  save(`${dir}/stretch.png`, characterStrip(2, 'down', 'stretch'))
  save(`${dir}/slump.png`, characterStrip(1, 'down', 'slump'))
  saveJson(`${dir}/manifest.json`, {
    id: 'mgr-blazer',
    name: 'Manager',
    roles: ['manager', 'lead', 'specialist'],
    tintable: true,
    animations: {
      idle: { file: 'idle.png', frames: 1 },
      'walk-down': { file: 'walk-down.png', frames: 4 },
      'walk-up': { file: 'walk-up.png', frames: 4 },
      'walk-right': { file: 'walk-right.png', frames: 4 },
      typing: { file: 'typing.png', frames: 2 },
      reading: { file: 'reading.png', frames: 2 },
      stretch: { file: 'stretch.png', frames: 2 },
      slump: { file: 'slump.png', frames: 1 },
    },
  })
}

function petStrip(frames, facing) {
  const cv = canvas(frames * TILE, TILE)
  for (let f = 0; f < frames; f++) {
    const ox = f * TILE
    rect(cv, ox + 4, 8, 8, 5, C.graphite) // body
    rect(cv, ox + 10, 5, 4, 4, C.graphite) // head
    px(cv, ox + 11, 6, '#57e6ff')
    px(cv, ox + 13, 6, '#57e6ff') // glowing eyes
    px(cv, ox + 3, 7 + (f % 2), '#57e6ff') // glowing tail tip
    rect(cv, ox + 5, 13, 1, 2 - (f % 2), C.dark)
    rect(cv, ox + 10, 13, 1, 1 + (f % 2), C.dark)
    if (facing === 'up') rect(cv, ox + 10, 5, 4, 4, '#3d4557')
  }
  return cv
}

function writePet() {
  const dir = 'pets/volt-cat'
  save(`${dir}/idle.png`, petStrip(1, 'down'))
  save(`${dir}/walk-down.png`, petStrip(2, 'down'))
  save(`${dir}/walk-up.png`, petStrip(2, 'up'))
  save(`${dir}/walk-right.png`, petStrip(2, 'right'))
  saveJson(`${dir}/manifest.json`, {
    id: 'volt-cat',
    name: 'Volt',
    behavior: 'wander',
    animations: {
      idle: { file: 'idle.png', frames: 1 },
      'walk-down': { file: 'walk-down.png', frames: 2 },
      'walk-up': { file: 'walk-up.png', frames: 2 },
      'walk-right': { file: 'walk-right.png', frames: 2 },
    },
  })
}

// ── Furniture ──

function furnitureCanvas(wTiles, hPx, draw) {
  const cv = canvas(wTiles * TILE, hPx)
  draw(cv)
  return cv
}

function writeFurniture() {
  // desk 2x1, 2-way
  save('furniture/desk/front.png', furnitureCanvas(2, 16, (cv) => {
    outlineRect(cv, 0, 4, 32, 8, C.wood)
    rect(cv, 1, 5, 30, 1, C.woodLight)
    rect(cv, 2, 12, 2, 4, C.woodDark)
    rect(cv, 28, 12, 2, 4, C.woodDark)
  }))
  save('furniture/desk/side.png', furnitureCanvas(1, 32, (cv) => {
    outlineRect(cv, 2, 4, 12, 24, C.wood)
    rect(cv, 3, 5, 10, 1, C.woodLight)
  }))
  saveJson('furniture/desk/manifest.json', {
    id: 'desk', name: 'Desk', category: 'work', footprintW: 2, footprintH: 1,
    width: 32, height: 16, rotationScheme: '2-way',
    images: { front: 'front.png', side: 'side.png' }, isSurface: true,
  })

  // chair-ergo 1x1, 3-way-mirror, seat
  const chair = (back) => furnitureCanvas(1, 16, (cv) => {
    outlineRect(cv, 3, 6, 10, 7, C.fabric)
    if (back === 'down') outlineRect(cv, 3, 1, 10, 5, C.graphite)
    if (back === 'up') outlineRect(cv, 3, 11, 10, 5, C.graphite)
    if (back === 'right') outlineRect(cv, 1, 3, 4, 10, C.graphite)
  })
  save('furniture/chair-ergo/down.png', chair('down'))
  save('furniture/chair-ergo/up.png', chair('up'))
  save('furniture/chair-ergo/right.png', chair('right'))
  saveJson('furniture/chair-ergo/manifest.json', {
    id: 'chair-ergo', name: 'Ergonomic Chair', category: 'work', footprintW: 1, footprintH: 1,
    width: 16, height: 16, rotationScheme: '3-way-mirror',
    images: { down: 'down.png', up: 'up.png', right: 'right.png' },
    seatTiles: [{ x: 0, y: 0, dir: 'down' }],
  })

  // pc: states on/off, sits on surfaces
  save('furniture/pc/on.png', furnitureCanvas(1, 16, (cv) => {
    outlineRect(cv, 2, 2, 12, 10, C.graphite)
    rect(cv, 4, 4, 8, 6, C.screen)
    rect(cv, 5, 5, 3, 1, C.screenBright)
    rect(cv, 6, 12, 4, 3, C.metal)
  }))
  save('furniture/pc/off.png', furnitureCanvas(1, 16, (cv) => {
    outlineRect(cv, 2, 2, 12, 10, C.graphite)
    rect(cv, 4, 4, 8, 6, C.dark)
    rect(cv, 6, 12, 4, 3, C.metal)
  }))
  saveJson('furniture/pc/manifest.json', {
    id: 'pc', name: 'Workstation', category: 'work', footprintW: 1, footprintH: 1,
    width: 16, height: 16, rotationScheme: 'none',
    states: { on: 'on.png', off: 'off.png' }, canPlaceOnSurfaces: true,
  })

  // server-rack: tall, animated (2 frames), LEDs alternate
  save('furniture/server-rack/default.png', furnitureCanvas(2, 32, (cv) => {
    for (let f = 0; f < 2; f++) {
      const ox = f * TILE
      outlineRect(cv, ox + 2, 2, 12, 28, C.graphite)
      for (let row = 0; row < 5; row++) {
        rect(cv, ox + 4, 5 + row * 5, 8, 3, '#3d4557')
        px(cv, ox + 5, 6 + row * 5, (row + f) % 2 === 0 ? '#2bb8e6' : C.green)
        px(cv, ox + 10, 6 + row * 5, (row + f) % 2 === 0 ? C.dark : '#2bb8e6')
      }
    }
  }))
  saveJson('furniture/server-rack/manifest.json', {
    id: 'server-rack', name: 'Server Rack', category: 'work', footprintW: 1, footprintH: 1,
    width: 16, height: 32, rotationScheme: 'none',
    images: { default: 'default.png' }, frames: 2,
  })

  // whiteboard: wall 2x1
  save('furniture/whiteboard/default.png', furnitureCanvas(2, 16, (cv) => {
    outlineRect(cv, 1, 2, 30, 12, C.paper)
    rect(cv, 4, 5, 8, 1, C.screen)
    rect(cv, 4, 8, 12, 1, C.glow)
    rect(cv, 20, 5, 6, 5, '#3d7bff')
  }))
  saveJson('furniture/whiteboard/manifest.json', {
    id: 'whiteboard', name: 'Whiteboard', category: 'work', footprintW: 2, footprintH: 1,
    width: 32, height: 16, rotationScheme: 'none',
    images: { default: 'default.png' }, canPlaceOnWalls: true,
  })

  // plant-small 1x1 decor
  save('furniture/plant-small/default.png', furnitureCanvas(1, 16, (cv) => {
    outlineRect(cv, 5, 10, 6, 5, C.pot)
    rect(cv, 6, 5, 4, 5, C.leaf)
    px(cv, 5, 6, C.leafDark)
    px(cv, 10, 6, C.leafDark)
    px(cv, 7, 4, '#7cc46a')
  }))
  saveJson('furniture/plant-small/manifest.json', {
    id: 'plant-small', name: 'Potted Plant', category: 'decor', footprintW: 1, footprintH: 1,
    width: 16, height: 16, rotationScheme: 'none', images: { default: 'default.png' },
  })

  // sofa 2x1, 3-way-mirror, two seats
  const sofa = (orient) => {
    if (orient === 'right') {
      return furnitureCanvas(1, 32, (cv) => {
        outlineRect(cv, 2, 2, 12, 28, C.fabric)
        rect(cv, 3, 3, 3, 26, '#2e3442')
      })
    }
    return furnitureCanvas(2, 16, (cv) => {
      outlineRect(cv, 1, 4, 30, 10, C.fabric)
      rect(cv, 2, orient === 'down' ? 5 : 11, 28, 3, '#2e3442')
      px(cv, 16, 8, C.outline)
    })
  }
  save('furniture/sofa/down.png', sofa('down'))
  save('furniture/sofa/up.png', sofa('up'))
  save('furniture/sofa/right.png', sofa('right'))
  saveJson('furniture/sofa/manifest.json', {
    id: 'sofa', name: 'Sofa', category: 'relax', footprintW: 2, footprintH: 1,
    width: 32, height: 16, rotationScheme: '3-way-mirror',
    images: { down: 'down.png', up: 'up.png', right: 'right.png' },
    seatTiles: [{ x: 0, y: 0, dir: 'down' }, { x: 1, y: 0, dir: 'down' }],
  })

  // mail-station: 2x1 tall
  save('furniture/mail-station/default.png', furnitureCanvas(2, 32, (cv) => {
    outlineRect(cv, 1, 2, 30, 28, C.wood)
    for (let r = 0; r < 3; r++) {
      for (let col = 0; col < 4; col++) {
        rect(cv, 3 + col * 7, 4 + r * 7, 6, 6, C.woodDark)
        if ((r + col) % 2 === 0) rect(cv, 4 + col * 7, 6 + r * 7, 4, 3, C.paper)
      }
    }
  }))
  saveJson('furniture/mail-station/manifest.json', {
    id: 'mail-station', name: 'Mail Station', category: 'mail', footprintW: 2, footprintH: 1,
    width: 32, height: 32, rotationScheme: 'none', images: { default: 'default.png' },
  })

  // exec-desk: 3x1, 2-way, surface
  save('furniture/exec-desk/front.png', furnitureCanvas(3, 16, (cv) => {
    outlineRect(cv, 0, 3, 48, 10, C.woodDark)
    rect(cv, 1, 4, 46, 1, C.wood)
    rect(cv, 18, 6, 12, 4, '#5c4530')
    rect(cv, 2, 13, 3, 3, C.outline)
    rect(cv, 43, 13, 3, 3, C.outline)
  }))
  save('furniture/exec-desk/side.png', furnitureCanvas(1, 48, (cv) => {
    outlineRect(cv, 2, 2, 12, 44, C.woodDark)
    rect(cv, 3, 3, 10, 1, C.wood)
  }))
  saveJson('furniture/exec-desk/manifest.json', {
    id: 'exec-desk', name: 'Executive Desk', category: 'manager', footprintW: 3, footprintH: 1,
    width: 48, height: 16, rotationScheme: '2-way',
    images: { front: 'front.png', side: 'side.png' }, isSurface: true,
  })
}

// ── Floors, walls, bubbles ──

function writeFloors() {
  const plank = canvas(TILE, TILE)
  rect(plank, 0, 0, 16, 16, C.wood)
  rect(plank, 0, 7, 16, 1, C.woodDark)
  rect(plank, 0, 15, 16, 1, C.woodDark)
  rect(plank, 5, 0, 1, 7, C.woodDark)
  rect(plank, 11, 8, 1, 8, C.woodDark)
  rect(plank, 0, 0, 16, 1, C.woodLight)
  save('floors/plank-birch/plank-birch.png', plank)
  saveJson('floors/plank-birch/manifest.json', {
    id: 'plank-birch', name: 'Birch Plank', file: 'plank-birch.png',
  })

  const carpet = canvas(TILE, TILE)
  rect(carpet, 0, 0, 16, 16, '#566073')
  for (let y = 0; y < 16; y += 2) {
    for (let x = y % 4 === 0 ? 0 : 2; x < 16; x += 4) px(carpet, x, y, '#6f7a90')
  }
  save('floors/carpet-neutral/carpet-neutral.png', carpet)
  saveJson('floors/carpet-neutral/manifest.json', {
    id: 'carpet-neutral', name: 'Neutral Carpet', file: 'carpet-neutral.png', tintable: true,
  })
}

function writeWalls() {
  // 16-tile autotile strip indexed by NESW bitmask.
  const cv = canvas(16 * TILE, TILE)
  for (let mask = 0; mask < 16; mask++) {
    const ox = mask * TILE
    rect(cv, ox, 0, 16, 16, C.graphite)
    rect(cv, ox, 0, 16, 2, '#3d4557')
    rect(cv, ox, 10, 16, 1, '#2bb8e6') // ion trim line
    // connection hints: darker joints toward connected neighbors
    if (mask & 1) rect(cv, ox + 7, 0, 2, 4, '#232733') // N
    if (mask & 2) rect(cv, ox + 12, 7, 4, 2, '#232733') // E
    if (mask & 4) rect(cv, ox + 7, 12, 2, 4, '#232733') // S
    if (mask & 8) rect(cv, ox, 7, 4, 2, '#232733') // W
    rect(cv, ox, 15, 16, 1, C.outline)
  }
  save('walls/graphite-panel/tiles.png', cv)
  saveJson('walls/graphite-panel/manifest.json', {
    id: 'graphite-panel', name: 'Graphite Panel', file: 'tiles.png',
  })
}

function bubble(draw) {
  const cv = canvas(TILE, TILE)
  outlineRect(cv, 1, 1, 14, 11, C.paper)
  px(cv, 3, 12, C.outline)
  px(cv, 3, 13, C.outline) // tail
  draw(cv)
  return cv
}

function writeBubbles() {
  save('bubbles/waiting.png', bubble((cv) => {
    px(cv, 5, 6, C.green)
    px(cv, 6, 7, C.green)
    px(cv, 7, 8, C.green)
    px(cv, 8, 7, C.green)
    px(cv, 9, 6, C.green)
    px(cv, 10, 5, C.green)
  }))
  save('bubbles/permission.png', bubble((cv) => {
    rect(cv, 4, 6, 2, 2, C.amber)
    rect(cv, 7, 6, 2, 2, C.amber)
    rect(cv, 10, 6, 2, 2, C.amber)
  }))
  save('bubbles/error.png', bubble((cv) => {
    rect(cv, 7, 3, 2, 5, C.red)
    rect(cv, 7, 9, 2, 2, C.red)
  }))
  save('bubbles/dispatch.png', bubble((cv) => {
    outlineRect(cv, 3, 4, 10, 6, '#e8cfa4')
    px(cv, 5, 5, C.graphite)
    px(cv, 7, 6, C.graphite)
    px(cv, 8, 6, C.graphite)
    px(cv, 10, 5, C.graphite)
  }))
  saveJson('bubbles/manifest.json', {
    waiting: 'waiting.png',
    permission: 'permission.png',
    error: 'error.png',
    dispatch: 'dispatch.png',
  })
}

// ── Dressing templates + theme.json ──

function writeDressing() {
  saveJson('dressing/department.json', {
    zone: 'department',
    floor: 'carpet-neutral',
    required: [
      { id: 'desk', perSeat: true },
      { id: 'chair-ergo', perSeat: true },
      { id: 'pc', perSeat: true },
      { category: 'work', wallItem: true, count: 1 },
    ],
    optional: [
      { id: 'server-rack', weight: 2, max: 1 },
      { id: 'plant-small', weight: 3, max: 2 },
      { category: 'decor', weight: 1, max: 2 },
    ],
    density: 0.15,
  })
  saveJson('dressing/manager.json', {
    zone: 'manager',
    floor: 'plank-birch',
    required: [
      { id: 'exec-desk', count: 1 },
      { id: 'chair-ergo', count: 1 },
      { id: 'pc', count: 1 },
    ],
    optional: [
      { id: 'plant-small', weight: 2, max: 2 },
      { category: 'decor', weight: 1, max: 2 },
    ],
    density: 0.12,
  })
  saveJson('dressing/mail.json', {
    zone: 'mail',
    floor: 'plank-birch',
    required: [{ id: 'mail-station', count: 1 }],
    optional: [{ id: 'plant-small', weight: 1, max: 1 }],
    density: 0.1,
  })
  saveJson('dressing/break.json', {
    zone: 'break',
    floor: 'plank-birch',
    required: [{ id: 'sofa', count: 1 }],
    optional: [
      { id: 'plant-small', weight: 2, max: 2 },
      { category: 'relax', weight: 2, max: 3 },
    ],
    density: 0.18,
  })
  saveJson('dressing/meeting.json', {
    zone: 'meeting',
    floor: 'carpet-neutral',
    required: [
      { id: 'small-table', count: 2 },
      { id: 'chair-wood', count: 2 },
      { id: 'whiteboard', wallItem: true, count: 1 },
    ],
    optional: [
      { id: 'plant-small', weight: 2, max: 1 },
      { id: 'wall-clock', weight: 1, max: 1 },
    ],
    density: 0.1,
  })
  saveJson('dressing/lobby.json', {
    zone: 'lobby',
    floor: 'tile-slate',
    required: [],
    optional: [
      { id: 'plant-large', weight: 2, max: 1 },
      { id: 'plant-small', weight: 1, max: 2 },
    ],
    density: 0.08,
  })
  // Corridor floor applies to hallway tiles; keep it distinct from every
  // room floor so hallways read as hallways.
  saveJson('dressing/corridor.json', {
    zone: 'corridor',
    floor: 'concrete',
    required: [],
    optional: [{ id: 'plant-small', weight: 1, max: 3 }],
    density: 0.04,
  })
}

function writeTheme() {
  saveJson('theme.json', {
    id: 'ion-works',
    name: 'Ion Works',
    version: '0.1.0',
    extends: null,
    tileSize: TILE,
    palette: PALETTE,
    continuity: { lightSource: 'top-left', outline: '#1a1d24', dither: 'low' },
  })
}

rmSync(ROOT, { recursive: true, force: true })
writeTheme()
writeCharacter()
writePet()
writeFurniture()
writeFloors()
writeWalls()
writeBubbles()
writeDressing()
console.log(`placeholder pack written to ${ROOT}`)
