/**
 * Pure parsing + patch-construction helpers for the DiffPane.
 *
 * `parseDiffWithHunks` extracts file header, per-hunk header, and per-line
 * structure. `buildHunkPatch(raw, hunkIdx)` reassembles a single-hunk patch
 * suitable for `git apply` (optionally `--cached` / `-R`).
 *
 * `buildPartialLinePatch(raw, hunkIdx, selectedLineKeys)` constructs a patch
 * containing only the selected `+/-` lines from a hunk; non-selected `+`
 * lines collapse to nothing, non-selected `-` lines collapse to context.
 */

export interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'hunk'
  content: string
  raw: string
  oldLine: number | null
  newLine: number | null
  hunkIndex: number
  /** Position within the original raw diff (0-based line index). */
  rawIndex: number
}

export interface DiffHunk {
  header: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  /** Body lines with original prefix (+ / - / space). */
  body: string[]
}

export interface ParsedDiff {
  fileHeader: string[]
  hunks: DiffHunk[]
  lines: DiffLine[]
}

const HUNK_HEADER_RE = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

function isFileHeaderLine(line: string): boolean {
  return line.startsWith('diff --git') || line.startsWith('index ') ||
         line.startsWith('--- ') || line.startsWith('+++ ') ||
         line.startsWith('new file') || line.startsWith('deleted file') ||
         line.startsWith('old mode') || line.startsWith('new mode') ||
         line.startsWith('similarity') || line.startsWith('rename') ||
         line.startsWith('Binary')
}

export function parseDiffWithHunks(raw: string): ParsedDiff {
  const rawLines = raw.split('\n')
  const fileHeader: string[] = []
  const hunks: DiffHunk[] = []
  const lines: DiffLine[] = []
  let oldLine = 0
  let newLine = 0
  let inHeader = true
  let hunkIndex = -1
  let currentHunk: DiffHunk | null = null

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i]
    if (inHeader) {
      if (isFileHeaderLine(line)) { fileHeader.push(line); continue }
      inHeader = false
    }

    if (line.startsWith('@@')) {
      hunkIndex++
      const match = line.match(HUNK_HEADER_RE)
      if (match) {
        oldLine = parseInt(match[1], 10)
        newLine = parseInt(match[3], 10)
        currentHunk = {
          header: line,
          oldStart: oldLine,
          oldCount: match[2] ? parseInt(match[2], 10) : 1,
          newStart: newLine,
          newCount: match[4] ? parseInt(match[4], 10) : 1,
          body: [],
        }
        hunks.push(currentHunk)
      }
      lines.push({ type: 'hunk', content: line, raw: line, oldLine: null, newLine: null, hunkIndex, rawIndex: i })
    } else if (line.startsWith('+')) {
      currentHunk?.body.push(line)
      lines.push({ type: 'add', content: line.substring(1), raw: line, oldLine: null, newLine: newLine++, hunkIndex, rawIndex: i })
    } else if (line.startsWith('-')) {
      currentHunk?.body.push(line)
      lines.push({ type: 'remove', content: line.substring(1), raw: line, oldLine: oldLine++, newLine: null, hunkIndex, rawIndex: i })
    } else {
      const content = line.startsWith(' ') ? line.substring(1) : line
      if (line.trim() === '' && lines.length === 0) continue
      currentHunk?.body.push(line)
      lines.push({ type: 'context', content, raw: line, oldLine: oldLine++, newLine: newLine++, hunkIndex, rawIndex: i })
    }
  }

  return { fileHeader, hunks, lines }
}

function recomputeHunkHeader(body: string[], oldStart: number, newStart: number): string {
  let oldCount = 0
  let newCount = 0
  for (const line of body) {
    if (line.startsWith('+')) newCount++
    else if (line.startsWith('-')) oldCount++
    else { oldCount++; newCount++ }
  }
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`
}

export function buildHunkPatch(parsed: ParsedDiff, hunkIdx: number): string | null {
  const hunk = parsed.hunks[hunkIdx]
  if (!hunk) return null
  const headerNoCount = recomputeHunkHeader(hunk.body, hunk.oldStart, hunk.newStart)
  const out = [...parsed.fileHeader, headerNoCount, ...hunk.body, ''].join('\n')
  return out
}

/**
 * Build a patch containing only the selected `+/-` lines from a hunk.
 * `selectedRawIndices` is a Set of rawIndex values from `parsed.lines`.
 *
 * Lines in the hunk that are NOT selected behave as:
 * - `+` not selected → omitted from new side (collapses to nothing)
 * - `-` not selected → kept as context (collapses to context line)
 * - context → kept as context
 */
export function buildPartialLinePatch(
  parsed: ParsedDiff,
  hunkIdx: number,
  selectedRawIndices: Set<number>,
): string | null {
  const hunk = parsed.hunks[hunkIdx]
  if (!hunk) return null

  const body: string[] = []
  for (const l of parsed.lines) {
    if (l.hunkIndex !== hunkIdx) continue
    if (l.type === 'hunk') continue
    if (l.type === 'context') { body.push(l.raw); continue }
    const selected = selectedRawIndices.has(l.rawIndex)
    if (l.type === 'add') {
      if (selected) body.push(l.raw)
      // Else: omit the new-side line entirely.
    } else if (l.type === 'remove') {
      if (selected) body.push(l.raw)
      else body.push(' ' + l.content) // demote unselected remove to context
    }
  }

  if (body.length === 0) return null
  const header = recomputeHunkHeader(body, hunk.oldStart, hunk.newStart)
  return [...parsed.fileHeader, header, ...body, ''].join('\n')
}
