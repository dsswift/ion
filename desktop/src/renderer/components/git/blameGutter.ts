import { EditorView, gutter, GutterMarker } from '@codemirror/view'
import { StateField, StateEffect } from '@codemirror/state'

// Types
export interface BlameLine {
  hash: string
  author: string
  date: string
  lineNo: number
  content: string
}

// Effects
const setBlameData = StateEffect.define<BlameLine[]>()
const clearBlameData = StateEffect.define<null>()

// State field holding blame data
const blameField = StateField.define<BlameLine[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setBlameData)) return e.value
      if (e.is(clearBlameData)) return []
    }
    return value
  },
})

// Deterministic color from hash
function hashColor(hash: string): string {
  const colors = [
    '#6b9bd2', '#7aac8c', '#b08fd8', '#d4a843', '#c47060',
    '#8bb5e0', '#93c5a4', '#c4a6e8', '#e0be5c', '#d4887a',
    '#5fa0d6', '#6dbf82', '#a67dd4', '#c9a836', '#b85c4e',
  ]
  let n = 0
  for (let i = 0; i < hash.length; i++) n = (n * 31 + hash.charCodeAt(i)) | 0
  return colors[Math.abs(n) % colors.length]
}

// Author initials
function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

// Relative date
function relDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(months / 12)}y`
}

// Gutter marker
class BlameMarker extends GutterMarker {
  constructor(
    readonly blame: BlameLine,
    readonly prevHash: string | null,
  ) { super() }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-blame-gutter-line'

    // Only show info on the first line of a consecutive block with the same hash
    if (this.blame.hash === this.prevHash) {
      el.textContent = ''
      el.style.cssText = 'display:inline-block;width:120px;'
      return el
    }

    const color = hashColor(this.blame.hash)
    el.style.cssText = `display:inline-flex;align-items:center;gap:4px;width:120px;font-size:10px;padding:0 6px;cursor:pointer;color:${color};`
    el.title = `${this.blame.hash} by ${this.blame.author}\n${new Date(this.blame.date).toLocaleString()}`

    const hashSpan = document.createElement('span')
    hashSpan.textContent = this.blame.hash
    hashSpan.style.cssText = 'font-family:monospace;opacity:0.9;'

    const initSpan = document.createElement('span')
    initSpan.textContent = initials(this.blame.author)
    initSpan.style.cssText = 'font-size:9px;opacity:0.7;'

    const dateSpan = document.createElement('span')
    dateSpan.textContent = relDate(this.blame.date)
    dateSpan.style.cssText = 'font-size:9px;opacity:0.6;margin-left:auto;'

    el.append(hashSpan, initSpan, dateSpan)
    return el
  }
}

const emptyMarker = new class extends GutterMarker {
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.style.cssText = 'display:inline-block;width:120px;'
    return el
  }
}

// Gutter
const blameGutter = gutter({
  class: 'cm-blame-gutter',
  markers: (view) => {
    const data = view.state.field(blameField)
    if (data.length === 0) return []

    // Build a map from line number to blame
    const byLine = new Map<number, BlameLine>()
    for (const b of data) byLine.set(b.lineNo, b)

    // Create marker list
    const markers: Array<{ from: number; marker: GutterMarker }> = []
    for (let i = 1; i <= view.state.doc.lines; i++) {
      const line = view.state.doc.line(i)
      const blame = byLine.get(i)
      if (blame) {
        const prevBlame = byLine.get(i - 1)
        markers.push({ from: line.from, marker: new BlameMarker(blame, prevBlame?.hash ?? null) })
      } else {
        markers.push({ from: line.from, marker: emptyMarker })
      }
    }

    // Return as a RangeSet-compatible object
    return {
      between(from: number, to: number, f: (from: number, to: number, value: GutterMarker) => void | false) {
        for (const m of markers) {
          if (m.from >= from && m.from <= to) {
            if (f(m.from, m.from, m.marker) === false) return
          }
        }
      },
    } as any
  },
})

// Theme for the gutter
const blameTheme = EditorView.theme({
  '.cm-blame-gutter': {
    borderRight: '1px solid var(--cm-blame-border, #333)',
    backgroundColor: 'var(--cm-blame-bg, transparent)',
  },
})

// Public API

/** Dispatch blame data into the editor */
export function dispatchBlame(view: EditorView, lines: BlameLine[]) {
  view.dispatch({ effects: setBlameData.of(lines) })
}

/** Clear blame data from the editor */
export function clearBlame(view: EditorView) {
  view.dispatch({ effects: clearBlameData.of(null) })
}

/** CM6 extension array for blame gutter. Add to editor extensions. */
export function blameExtension(): import('@codemirror/state').Extension {
  return [blameField, blameGutter, blameTheme]
}
