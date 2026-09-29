import { readFileSync, statSync } from 'fs'

/** Maximum bytes returned as the legacy string content (readPlanContentCached). */
const PLAN_CONTENT_CAP_BYTES = 256 * 1024

/** Maximum number of distinct paths kept in the cache (FIFO eviction). */
const CACHE_MAX_ENTRIES = 8

interface CacheEntry {
  mtimeMs: number
  /**
   * Cap-bounded UTF-8 string — used by readPlanContentCached (legacy path).
   * Truncated with a marker when the raw file exceeds PLAN_CONTENT_CAP_BYTES.
   */
  content: string
  /**
   * Full raw bytes of the file — used by readPlanRangeCached and
   * readPlanPreviewCached for exact byte-range math. Uncapped.
   */
  raw: Buffer
}

/**
 * Module-level mtime-keyed cache. Bounded to CACHE_MAX_ENTRIES paths.
 * Oldest path is evicted when the 9th distinct path is inserted (FIFO
 * via Map insertion order).
 */
const planCache = new Map<string, CacheEntry>()

/**
 * Fill the cache for `planFilePath` when the stored mtime differs from the
 * current mtime (or there is no entry). Returns the entry for the current
 * state of the file.
 *
 * Throws from statSync / readFileSync — callers keep their own try/catch.
 */
function ensureCached(planFilePath: string): CacheEntry {
  const st = statSync(planFilePath)
  const { mtimeMs } = st

  const cached = planCache.get(planFilePath)
  if (cached !== undefined && cached.mtimeMs === mtimeMs) {
    return cached
  }

  const raw = readFileSync(planFilePath)
  const byteLength = raw.length

  let content: string
  if (byteLength > PLAN_CONTENT_CAP_BYTES) {
    const truncated = raw.subarray(0, PLAN_CONTENT_CAP_BYTES).toString('utf-8')
    const overKb = Math.round(byteLength / 1024)
    content = `${truncated}\n\n\u2026[plan truncated: ${overKb} KB over 256 KB cap]`
  } else {
    content = raw.toString('utf-8')
  }

  // Evict oldest entry when at capacity and this is a new path.
  if (!planCache.has(planFilePath) && planCache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = planCache.keys().next().value as string
    planCache.delete(oldestKey)
  }

  const entry: CacheEntry = { mtimeMs, content, raw }
  planCache.set(planFilePath, entry)
  return entry
}

/**
 * Read the plan file at `planFilePath`, returning a cached copy when the
 * file's mtime has not changed since the last read. Content exceeding
 * PLAN_CONTENT_CAP_BYTES is truncated and a marker is appended.
 *
 * The function intentionally does NOT swallow errors from statSync or
 * readFileSync — the caller keeps its own try/catch for graceful degradation.
 */
export function readPlanContentCached(planFilePath: string): string {
  return ensureCached(planFilePath).content
}

/**
 * Read a bounded byte-range window from the plan file at `planFilePath`.
 * The file is cached by mtime; successive window requests for the same
 * unchanged file share the same cached Buffer without re-reading the disk.
 *
 * Returns `{ window, totalBytes }` where:
 *   - `window` is a Buffer slice from byte `offset` for up to `length` bytes
 *   - `totalBytes` is the full file size in bytes
 *
 * The caller is responsible for calling `window.toString('utf-8')` to get
 * the string and for bounding `length` to a sane page size.
 *
 * Throws from statSync / readFileSync — the caller keeps its own try/catch.
 */
export function readPlanRangeCached(
  planFilePath: string,
  offset: number,
  length: number,
): { window: Buffer; totalBytes: number } {
  const entry = ensureCached(planFilePath)
  const { raw } = entry
  const totalBytes = raw.length
  const safeOffset = Math.max(0, Math.min(offset, totalBytes))
  const safeEnd = Math.min(safeOffset + Math.max(0, length), totalBytes)
  return { window: raw.subarray(safeOffset, safeEnd), totalBytes }
}

/**
 * Read a bounded preview prefix (first `previewBytes` bytes) from the plan
 * file at `planFilePath` for inline display in the snapshot.
 *
 * Returns:
 *   - `preview`    — UTF-8 string of the first `previewBytes` bytes
 *   - `totalBytes` — full file size in bytes
 *   - `truncated`  — true when `totalBytes > previewBytes`
 *
 * Throws from statSync / readFileSync — the caller keeps its own try/catch.
 */
export function readPlanPreviewCached(
  planFilePath: string,
  previewBytes: number,
): { preview: string; totalBytes: number; truncated: boolean } {
  const entry = ensureCached(planFilePath)
  const { raw } = entry
  const totalBytes = raw.length
  const truncated = totalBytes > previewBytes
  const sliceEnd = Math.min(previewBytes, totalBytes)
  const preview = raw.subarray(0, sliceEnd).toString('utf-8')
  return { preview, totalBytes, truncated }
}

/**
 * Resolve a bounded plan preview for an ExitPlanMode permission entry, from the
 * strongest available source:
 *   1. The plan file on disk at `planFilePath` (preferred — `readPlanPreviewCached`).
 *   2. The inline `planContent` carried on the entry's toolInput, when the file
 *      is absent/unreadable. Two card-source paths (snapshot-promoted denial
 *      backfilled from history; restored-synthesis cards) deliver the body inline
 *      and have no readable file; without this fallback the snapshot emitted no
 *      `planContentPreview` and the iOS card rendered blank.
 *
 * Returns the same `{ preview, totalBytes, truncated }` shape as
 * `readPlanPreviewCached`, or `null` when neither a readable file nor an inline
 * body exists (the caller logs the omission — no silent blind spot).
 *
 * Pure except for the disk read inside `readPlanPreviewCached`; the inline
 * branch is fully pure and is the unit-tested regression seam.
 */
export function resolvePlanPreview(
  toolInput: { planFilePath?: unknown; planContent?: unknown } | undefined,
  previewBytes: number,
): { preview: string; totalBytes: number; truncated: boolean } | null {
  // 1. Disk first (bounded, mtime-cached).
  const planFilePath = typeof toolInput?.planFilePath === 'string' ? toolInput.planFilePath : ''
  if (planFilePath) {
    try {
      return readPlanPreviewCached(planFilePath, previewBytes)
    } catch {
      // File missing/unreadable — fall through to the inline body.
    }
  }
  // 2. Inline planContent fallback (mirrors readPlanPreviewCached's slice +
  //    truncated semantics, on the byte length of the inline string).
  const inline = typeof toolInput?.planContent === 'string' ? toolInput.planContent : ''
  if (inline) {
    const raw = Buffer.from(inline, 'utf-8')
    const totalBytes = raw.length
    const truncated = totalBytes > previewBytes
    const preview = raw.subarray(0, Math.min(previewBytes, totalBytes)).toString('utf-8')
    return { preview, totalBytes, truncated }
  }
  // 3. Nothing renderable.
  return null
}

// ── Test-only surface ────────────────────────────────────────────────────────
// Used exclusively by plan-content-cache.test.ts to assert cache bounds.
// Do not call from production code.
export function __planCacheSize(): number {
  return planCache.size
}

/** Clears the cache; only for use in tests between cases. */
export function __clearPlanCache(): void {
  planCache.clear()
}
