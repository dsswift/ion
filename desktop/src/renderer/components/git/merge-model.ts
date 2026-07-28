/**
 * 3-way merge model — the pure logic behind the MergeEditor.
 *
 * ── The shape of the problem ────────────────────────────────────────────────
 * A conflicted file has three versions: BASE (the common ancestor, index stage
 * 1), OURS (stage 2) and THEIRS (stage 3). The editor's job is to compose a
 * RESULT from them. This is the classic diff3 alignment: express each side as
 * a list of hunks over the base (base-line range → replacement lines), then
 * group hunks that overlap on the base. Each group is exactly one of:
 *
 *   - one-sided: only ours (or only theirs) changed that region —
 *     auto-appliable, the same resolution `git merge` itself would produce;
 *   - both sides made the IDENTICAL change — not a conflict;
 *   - both sides changed the region differently — a conflict the operator (or
 *     the editor's controls) must decide.
 *
 * This mirrors what a 3-way tool like the JetBrains merge window shows: the
 * non-conflicting majority applies automatically, and attention goes to the
 * genuinely contested chunks.
 *
 * ── Degraded shapes ─────────────────────────────────────────────────────────
 * add/add (no base) and delete/modify (a side missing) are real conflict
 * shapes. A missing base degrades to one whole-file conflict chunk between the
 * two sides; a missing side is represented as that side deleting everything —
 * accepting it composes an empty result, which the caller maps to "remove
 * file".
 *
 * Pure functions, no I/O, no Electron — unit-testable in isolation.
 */
import { diffLines } from 'diff'

export type ChunkKind = 'same' | 'ours' | 'theirs' | 'conflict'

export interface MergeChunk {
  kind: ChunkKind
  /** Base lines this chunk covers (empty for pure insertions or add/add). */
  base: string[]
  /** What ours has for this span. Equals `base` when ours did not change it. */
  ours: string[]
  /** What theirs has for this span. Equals `base` when theirs did not change it. */
  theirs: string[]
  /**
   * The chosen content, or null while an operator decision is pending.
   * Non-conflict chunks are born resolved; conflicts start null.
   */
  resolution: string[] | null
}

export interface MergeModel {
  chunks: MergeChunk[]
  /** True when the file had no base stage (add/add) — one big conflict. */
  degradedNoBase: boolean
}

/** One side's edit over the base: replace base[start, end) with `lines`. */
interface Hunk {
  start: number
  end: number
  lines: string[]
}

function splitLines(text: string): string[] {
  // Normalise the trailing newline so a final "\n" does not create a phantom
  // empty last line that then conflicts.
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Express one side's changes as hunks over the base.
 *
 * `diffLines` emits an alternating stream of unchanged / removed / added
 * parts. A removal (optionally followed by an addition) replaces those base
 * lines; a bare addition inserts at the current base position (a zero-width
 * hunk).
 */
function sideHunks(base: string, side: string): Hunk[] {
  const hunks: Hunk[] = []
  const parts = diffLines(base, side)
  let baseIdx = 0
  let i = 0
  while (i < parts.length) {
    const part = parts[i]
    if (part.removed) {
      const removedCount = splitLines(part.value).length
      let added: string[] = []
      if (i + 1 < parts.length && parts[i + 1].added) {
        added = splitLines(parts[i + 1].value)
        i++
      }
      hunks.push({ start: baseIdx, end: baseIdx + removedCount, lines: added })
      baseIdx += removedCount
    } else if (part.added) {
      hunks.push({ start: baseIdx, end: baseIdx, lines: splitLines(part.value) })
    } else {
      baseIdx += splitLines(part.value).length
    }
    i++
  }
  return hunks
}

/** Compose what one side has for base span [from, to), given its hunks. */
function composeSide(baseLines: string[], hunks: Hunk[], from: number, to: number): string[] {
  const out: string[] = []
  let cursor = from
  for (const h of hunks) {
    if (h.end < from || h.start > to) continue
    // Base lines before this hunk flow through unchanged.
    for (let k = cursor; k < Math.max(h.start, from); k++) out.push(baseLines[k])
    out.push(...h.lines)
    cursor = Math.max(cursor, h.end)
  }
  for (let k = Math.max(cursor, from); k < to; k++) out.push(baseLines[k])
  return out
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((l, i) => l === b[i])
}

/**
 * Build the merge model for one conflicted file.
 *
 * `ours` / `theirs` may be null for delete-conflicts (that side removed the
 * file); `base` may be null for add/add.
 */
export function buildMergeModel(
  base: string | null,
  ours: string | null,
  theirs: string | null,
): MergeModel {
  // add/add: no common ancestor to align on. One whole-file conflict.
  if (base === null) {
    return {
      degradedNoBase: true,
      chunks: [{
        kind: 'conflict',
        base: [],
        ours: ours !== null ? splitLines(ours) : [],
        theirs: theirs !== null ? splitLines(theirs) : [],
        resolution: null,
      }],
    }
  }

  const baseLines = splitLines(base)
  // A deleted side is "that side removed every line".
  const oursHunks = sideHunks(base, ours ?? '')
  const theirsHunks = sideHunks(base, theirs ?? '')

  // Merge both hunk lists into overlap groups. Two hunks overlap when their
  // base ranges intersect — including a zero-width insertion sitting at a
  // position the other side's hunk covers or touches.
  interface Group { start: number; end: number; ours: Hunk[]; theirs: Hunk[] }
  const tagged = [
    ...oursHunks.map((h) => ({ h, side: 'ours' as const })),
    ...theirsHunks.map((h) => ({ h, side: 'theirs' as const })),
  ].sort((a, b) => a.h.start - b.h.start || a.h.end - b.h.end)

  const groups: Group[] = []
  for (const t of tagged) {
    const last = groups[groups.length - 1]
    // Touching counts as overlap for zero-width hunks: an insertion at the
    // boundary of the other side's replacement is contested territory.
    if (last && t.h.start <= last.end && (t.h.start < last.end || t.h.end === t.h.start || last.end === last.start)) {
      last.end = Math.max(last.end, t.h.end)
      last[t.side].push(t.h)
    } else if (last && t.h.start < last.end) {
      last.end = Math.max(last.end, t.h.end)
      last[t.side].push(t.h)
    } else {
      groups.push({
        start: t.h.start,
        end: t.h.end,
        ours: t.side === 'ours' ? [t.h] : [],
        theirs: t.side === 'theirs' ? [t.h] : [],
      })
    }
  }

  const chunks: MergeChunk[] = []
  let cursor = 0
  for (const g of groups) {
    // Unchanged base run before this group.
    if (g.start > cursor) {
      const span = baseLines.slice(cursor, g.start)
      chunks.push({ kind: 'same', base: span, ours: span, theirs: span, resolution: span })
    }
    const baseSpan = baseLines.slice(g.start, g.end)
    const oursSpan = composeSide(baseLines, g.ours, g.start, g.end)
    const theirsSpan = composeSide(baseLines, g.theirs, g.start, g.end)

    if (g.ours.length > 0 && g.theirs.length > 0) {
      if (sameLines(oursSpan, theirsSpan)) {
        // Both sides made the identical change — not a conflict.
        chunks.push({ kind: 'same', base: baseSpan, ours: oursSpan, theirs: theirsSpan, resolution: oursSpan })
      } else {
        chunks.push({ kind: 'conflict', base: baseSpan, ours: oursSpan, theirs: theirsSpan, resolution: null })
      }
    } else if (g.ours.length > 0) {
      chunks.push({ kind: 'ours', base: baseSpan, ours: oursSpan, theirs: baseSpan, resolution: oursSpan })
    } else {
      chunks.push({ kind: 'theirs', base: baseSpan, ours: baseSpan, theirs: theirsSpan, resolution: theirsSpan })
    }
    cursor = Math.max(cursor, g.end)
  }
  // Trailing unchanged run.
  if (cursor < baseLines.length) {
    const span = baseLines.slice(cursor)
    chunks.push({ kind: 'same', base: span, ours: span, theirs: span, resolution: span })
  }

  return { chunks, degradedNoBase: false }
}

/** Resolve one conflict chunk. `skip` composes the base lines (change dropped). */
export function applyChunk(
  model: MergeModel,
  index: number,
  choice: 'ours' | 'theirs' | 'both' | 'skip',
): MergeModel {
  const chunks = model.chunks.map((c, i) => {
    if (i !== index) return c
    const resolution =
      choice === 'ours' ? c.ours
        : choice === 'theirs' ? c.theirs
          : choice === 'both' ? [...c.ours, ...c.theirs]
            : c.base
    return { ...c, resolution }
  })
  return { ...model, chunks }
}

/** Count of conflict chunks still unresolved. */
export function unresolvedCount(model: MergeModel): number {
  return model.chunks.filter((c) => c.kind === 'conflict' && c.resolution === null).length
}

/**
 * The composed result, or null while any conflict is unresolved. Joined with
 * a trailing newline, matching how git stores text stages.
 */
export function composeResult(model: MergeModel): string | null {
  if (unresolvedCount(model) > 0) return null
  const lines = model.chunks.flatMap((c) => c.resolution ?? [])
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}
