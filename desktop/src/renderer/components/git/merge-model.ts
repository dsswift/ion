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
 *     auto-applied, the same resolution `git merge` itself would produce;
 *   - both sides made the IDENTICAL change — not a conflict;
 *   - both sides changed the region differently — a conflict the operator
 *     must decide.
 *
 * ── Per-SIDE decisions, not per-chunk choices ───────────────────────────────
 * Matching the JetBrains merge window: each side of a chunk is independently
 * ACCEPTED (its change joins the result) or EXCLUDED (dropped). A one-sided
 * chunk starts accepted and can be excluded (the ×); a conflict starts with
 * both sides pending and resolves once BOTH have a decision — accept one,
 * accept both (ours-then-theirs), or exclude both (the base survives). The
 * composed result updates as decisions land, and every composed line carries
 * its PROVENANCE (base / ours / theirs) so the UI can color where each line
 * came from.
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

/** One side's standing within a chunk. */
export type SideDecision = 'pending' | 'accepted' | 'excluded'

/** Where a composed line came from, for provenance coloring. */
export type LineSource = 'base' | 'ours' | 'theirs'

export interface ComposedLine {
  text: string
  source: LineSource
}

export interface MergeChunk {
  kind: ChunkKind
  /** Base lines this chunk covers (empty for pure insertions or add/add). */
  base: string[]
  /** What ours has for this span. Equals `base` when ours did not change it. */
  ours: string[]
  /** What theirs has for this span. Equals `base` when theirs did not change it. */
  theirs: string[]
  /**
   * Whether ours' change is in the result. `accepted` from birth for a
   * one-sided ours chunk (auto-apply); `pending` for a conflict until the
   * operator decides. Meaningless on `same`/`theirs` chunks.
   */
  oursDecision: SideDecision
  /** Symmetric to `oursDecision`. */
  theirsDecision: SideDecision
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
        oursDecision: 'pending',
        theirsDecision: 'pending',
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
      chunks.push({
        kind: 'same', base: span, ours: span, theirs: span,
        oursDecision: 'accepted', theirsDecision: 'accepted',
      })
    }
    const baseSpan = baseLines.slice(g.start, g.end)
    const oursSpan = composeSide(baseLines, g.ours, g.start, g.end)
    const theirsSpan = composeSide(baseLines, g.theirs, g.start, g.end)

    if (g.ours.length > 0 && g.theirs.length > 0) {
      if (sameLines(oursSpan, theirsSpan)) {
        // Both sides made the identical change — not a conflict. Rendered as
        // an agreed change (ours-sourced) rather than untouched base.
        chunks.push({
          kind: 'ours', base: baseSpan, ours: oursSpan, theirs: theirsSpan,
          oursDecision: 'accepted', theirsDecision: 'accepted',
        })
      } else {
        chunks.push({
          kind: 'conflict', base: baseSpan, ours: oursSpan, theirs: theirsSpan,
          oursDecision: 'pending', theirsDecision: 'pending',
        })
      }
    } else if (g.ours.length > 0) {
      // One-sided: auto-applied, exactly as `git merge` would resolve it. The
      // operator can still exclude it (the ×), reverting the span to base.
      chunks.push({
        kind: 'ours', base: baseSpan, ours: oursSpan, theirs: baseSpan,
        oursDecision: 'accepted', theirsDecision: 'excluded',
      })
    } else {
      chunks.push({
        kind: 'theirs', base: baseSpan, ours: baseSpan, theirs: theirsSpan,
        oursDecision: 'excluded', theirsDecision: 'accepted',
      })
    }
    cursor = Math.max(cursor, g.end)
  }
  // Trailing unchanged run.
  if (cursor < baseLines.length) {
    const span = baseLines.slice(cursor)
    chunks.push({
      kind: 'same', base: span, ours: span, theirs: span,
      oursDecision: 'accepted', theirsDecision: 'accepted',
    })
  }

  return { chunks, degradedNoBase: false }
}

/**
 * Set one side's decision on one chunk — the primitive behind every gutter
 * control. Returns a new model; chunks are never mutated in place.
 */
export function setSideDecision(
  model: MergeModel,
  index: number,
  side: 'ours' | 'theirs',
  decision: SideDecision,
): MergeModel {
  const chunks = model.chunks.map((c, i) => {
    if (i !== index) return c
    return side === 'ours' ? { ...c, oursDecision: decision } : { ...c, theirsDecision: decision }
  })
  return { ...model, chunks }
}

/**
 * Resolve one conflict chunk with a whole-chunk verdict. A convenience over
 * setSideDecision for the bulk actions ("all ours", "all theirs"):
 * `ours` accepts ours and excludes theirs, `both` accepts both
 * (ours-then-theirs), `skip` excludes both (the base survives).
 */
export function applyChunk(
  model: MergeModel,
  index: number,
  choice: 'ours' | 'theirs' | 'both' | 'skip',
): MergeModel {
  const chunks = model.chunks.map((c, i) => {
    if (i !== index) return c
    const [oursDecision, theirsDecision]: [SideDecision, SideDecision] =
      choice === 'ours' ? ['accepted', 'excluded']
        : choice === 'theirs' ? ['excluded', 'accepted']
          : choice === 'both' ? ['accepted', 'accepted']
            : ['excluded', 'excluded']
    return { ...c, oursDecision, theirsDecision }
  })
  return { ...model, chunks }
}

/** True when a conflict chunk still has an undecided side. */
export function isUnresolved(chunk: MergeChunk): boolean {
  return chunk.kind === 'conflict' &&
    (chunk.oursDecision === 'pending' || chunk.theirsDecision === 'pending')
}

/** Count of conflict chunks with any undecided side. */
export function unresolvedCount(model: MergeModel): number {
  return model.chunks.filter(isUnresolved).length
}

/**
 * Compose one chunk into provenance-tagged lines, or null while a conflict
 * side is still pending.
 */
export function composeChunk(chunk: MergeChunk): ComposedLine[] | null {
  if (isUnresolved(chunk)) return null
  switch (chunk.kind) {
    case 'same':
      return chunk.base.map((text) => ({ text, source: 'base' as const }))
    case 'ours':
      return chunk.oursDecision === 'accepted'
        ? chunk.ours.map((text) => ({ text, source: 'ours' as const }))
        : chunk.base.map((text) => ({ text, source: 'base' as const }))
    case 'theirs':
      return chunk.theirsDecision === 'accepted'
        ? chunk.theirs.map((text) => ({ text, source: 'theirs' as const }))
        : chunk.base.map((text) => ({ text, source: 'base' as const }))
    case 'conflict': {
      const lines: ComposedLine[] = []
      if (chunk.oursDecision === 'accepted') {
        lines.push(...chunk.ours.map((text) => ({ text, source: 'ours' as const })))
      }
      if (chunk.theirsDecision === 'accepted') {
        lines.push(...chunk.theirs.map((text) => ({ text, source: 'theirs' as const })))
      }
      if (chunk.oursDecision === 'excluded' && chunk.theirsDecision === 'excluded') {
        lines.push(...chunk.base.map((text) => ({ text, source: 'base' as const })))
      }
      return lines
    }
  }
}

/**
 * The composed result with per-line provenance, or null while any conflict is
 * unresolved. This is what the result pane renders — the coloring IS the
 * provenance.
 */
export function composeLines(model: MergeModel): ComposedLine[] | null {
  const out: ComposedLine[] = []
  for (const chunk of model.chunks) {
    const lines = composeChunk(chunk)
    if (lines === null) return null
    out.push(...lines)
  }
  return out
}

/**
 * The composed result as text, or null while any conflict is unresolved.
 * Joined with a trailing newline, matching how git stores text stages.
 */
export function composeResult(model: MergeModel): string | null {
  const lines = composeLines(model)
  if (lines === null) return null
  return lines.length > 0 ? `${lines.map((l) => l.text).join('\n')}\n` : ''
}
