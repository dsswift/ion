/**
 * transfer/path-rewrite — point every path a moved conversation names at
 * where its file now lives.
 *
 * A conversation's files store absolute paths: the plan it is writing, the
 * files attached to it, its spilled tool output. On another machine the data
 * folder, the conversations folder, and the working directory can all differ,
 * so every such path is rewritten on arrival.
 *
 * The rewrite works on the stored JSON text, byte for byte, never on a
 * re-serialized copy: everything that is not a mapped path keeps its exact
 * bytes. Each path is matched in its JSON-escaped form, so a Windows path's
 * backslashes match as they are stored. A file path matches only when the
 * next character cannot continue a file name, so `/a/plan.md` never rewrites
 * `/a/plan.md.bak`. A directory prefix ends in a separator and needs no such
 * check. The longest match wins, and one left-to-right pass means a
 * replacement is never itself rewritten.
 */

/** Source path to destination path. Directory keys end in a separator. */
export interface PathMap {
  files: Map<string, string>
  dirs: Map<string, string>
}

interface Pair { from: string; to: string; dir: boolean }

function jsonEscaped(s: string): string {
  return JSON.stringify(s).slice(1, -1)
}

/** The escaped pairs, longest source first. */
function pairsOf(map: PathMap): Pair[] {
  const pairs: Pair[] = []
  for (const [from, to] of map.files) if (from !== to) pairs.push({ from: jsonEscaped(from), to: jsonEscaped(to), dir: false })
  for (const [from, to] of map.dirs) if (from !== to) pairs.push({ from: jsonEscaped(from), to: jsonEscaped(to), dir: true })
  return pairs.sort((a, b) => b.from.length - a.from.length)
}

function continuesName(ch: string): boolean {
  return /[A-Za-z0-9._-]/.test(ch)
}

/** Rewrites every mapped path in JSON text. Returns the text unchanged when nothing matched. */
export function rewriteJsonText(text: string, map: PathMap): { text: string; replaced: number } {
  const pairs = pairsOf(map)
  if (pairs.length === 0) return { text, replaced: 0 }
  // Only positions where some pair can start are worth testing.
  const firstChars = new Set(pairs.map((p) => p.from[0]))
  let out = ''
  let replaced = 0
  let i = 0
  let copiedFrom = 0
  while (i < text.length) {
    if (!firstChars.has(text[i])) { i++; continue }
    let matched: Pair | null = null
    for (const pair of pairs) {
      if (!text.startsWith(pair.from, i)) continue
      const end = i + pair.from.length
      if (!pair.dir && end < text.length && continuesName(text[end])) continue
      matched = pair
      break
    }
    if (!matched) { i++; continue }
    out += text.slice(copiedFrom, i) + matched.to
    i += matched.from.length
    copiedFrom = i
    replaced++
  }
  if (replaced === 0) return { text, replaced: 0 }
  return { text: out + text.slice(copiedFrom), replaced }
}

/** Rewrites every mapped path in a JSON-serializable value. */
export function rewriteJsonValue<T>(value: T, map: PathMap): { value: T; replaced: number } {
  if (value === null || value === undefined) return { value, replaced: 0 }
  const { text, replaced } = rewriteJsonText(JSON.stringify(value), map)
  return { value: replaced === 0 ? value : (JSON.parse(text) as T), replaced }
}

/** Where `path` lands under `map`, or `path` itself when nothing maps it. */
export function mapPath(path: string, map: PathMap): string {
  const exact = map.files.get(path)
  if (exact !== undefined) return exact
  let best = ''
  for (const from of map.dirs.keys()) if (path.startsWith(from) && from.length > best.length) best = from
  return best ? map.dirs.get(best)! + path.slice(best.length) : path
}
