// Shared helpers for conversation introspection tools (read-conversation,
// list-conversations). Extracted so both tools share the same validation
// and path-resolution logic without duplication.
//
// Three responsibilities:
//   1. ID validation -- reject traversal, enforce an allow-pattern.
//   2. Path resolution -- `~/.ion/conversations/<id>.<ext>`.
//   3. Filename helpers -- parse epoch from new-style IDs, group files
//      by base conversation ID.

import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ─── Constants ────────────────────────────────────────────────────────────

/** Allow-list for every character permitted in a conversation ID. */
const VALID_ID_RE = /^[a-zA-Z0-9._-]+$/

/**
 * New-format IDs look like `1781440740558-4a286b13f53d`. The leading run
 * of digits is a Unix epoch in milliseconds; we can parse it without
 * opening any file.
 */
const TIMESTAMP_PREFIX_RE = /^(\d+)-/

// ─── Path helpers ─────────────────────────────────────────────────────────

/** Canonical conversations directory. Matches the engine's Go implementation:
 * `os.UserHomeDir() + "/.ion/conversations"`. */
export function conversationsDir(): string {
  return join(homedir(), '.ion', 'conversations')
}

/** The four file variants the engine writes for a single conversation. */
export type ConversationFileKind = 'tree' | 'llm' | 'memory' | 'legacy'

/** Resolve the absolute path for one file variant of a conversation. */
export function conversationFilePath(
  id: string,
  kind: ConversationFileKind,
): string {
  const dir = conversationsDir()
  switch (kind) {
    case 'tree':   return join(dir, `${id}.tree.jsonl`)
    case 'llm':    return join(dir, `${id}.llm.jsonl`)
    case 'memory': return join(dir, `${id}.memory.md`)
    case 'legacy': return join(dir, `${id}.jsonl`)
  }
}

// ─── ID validation ────────────────────────────────────────────────────────

export interface IdValidationResult {
  valid: boolean
  /** Human-readable rejection reason when `valid` is false. */
  error?: string
}

/**
 * Validate a caller-supplied conversation ID.
 *
 * Rejects:
 *   - Empty or non-string values.
 *   - The special names `.` and `..` (directory traversal anchors).
 *   - Any character outside `[a-zA-Z0-9._-]` (this covers `/` and all
 *     shell-special chars in one check; `.` and `..` need explicit handling
 *     because both pass the character allow-list).
 *   - IDs longer than 128 characters (no legitimate ID approaches that).
 */
export function validateConversationId(id: unknown): IdValidationResult {
  if (typeof id !== 'string' || id.length === 0) {
    return { valid: false, error: 'id must be a non-empty string' }
  }
  if (id === '.' || id === '..') {
    return { valid: false, error: `id must not be "." or ".."` }
  }
  if (id.length > 128) {
    return { valid: false, error: 'id too long (max 128 characters)' }
  }
  if (!VALID_ID_RE.test(id)) {
    return {
      valid: false,
      error: `id contains invalid characters. Allowed: letters, digits, dot, hyphen, underscore. Got: ${JSON.stringify(id)}`,
    }
  }
  return { valid: true }
}

// ─── Timestamp extraction ─────────────────────────────────────────────────

/**
 * Extract a Unix epoch (milliseconds) from a conversation ID.
 *
 * New-format IDs (`1781440740558-4a286b13f53d`) embed the epoch as the
 * leading digit run. Legacy UUID IDs (`004eae7c-b726-...`) do not; for
 * those we fall back to the file's mtime.
 *
 * Returns null when the ID has no embedded timestamp.
 */
export function extractTimestampFromId(id: string): number | null {
  const m = TIMESTAMP_PREFIX_RE.exec(id)
  if (!m) return null
  const n = Number(m[1])
  // Sanity-check: a plausible epoch-ms is > 1e12 (after year 2001).
  return n > 1_000_000_000_000 ? n : null
}

/**
 * Resolve a creation timestamp for a conversation ID.
 * Prefers the embedded epoch; falls back to the mtime of the .tree.jsonl
 * (or .jsonl for legacy). Returns null if no file exists and no epoch
 * is embedded.
 */
export function resolveCreatedAt(id: string): number | null {
  const embedded = extractTimestampFromId(id)
  if (embedded !== null) return embedded

  // Fallback: stat the tree file, then the legacy file.
  for (const kind of ['tree', 'legacy'] as ConversationFileKind[]) {
    const p = conversationFilePath(id, kind)
    try {
      if (existsSync(p)) return statSync(p).mtimeMs
    } catch {
      // ignore stat errors
    }
  }
  return null
}

// ─── File grouping ────────────────────────────────────────────────────────

export interface ConversationFiles {
  id: string
  hasTree: boolean
  hasLlm: boolean
  hasMemory: boolean
  hasLegacy: boolean
}

const SUFFIX_RE = /\.(tree\.jsonl|llm\.jsonl|memory\.md|jsonl)$/

/**
 * Group a flat list of filenames from the conversations directory by
 * base conversation ID. Strips the known suffixes and maps each file
 * back to its kind. Unknown suffixes (`.json`, `.bak`, special names)
 * are ignored.
 *
 * Skips dotfiles and the special `test.*` / `tool-results` entries that
 * exist in the directory for fixture / debugging purposes.
 */
export function groupFilesByConversationId(
  entries: string[],
): Map<string, ConversationFiles> {
  const map = new Map<string, ConversationFiles>()

  for (const name of entries) {
    if (name.startsWith('.')) continue

    const suffixMatch = SUFFIX_RE.exec(name)
    if (!suffixMatch) continue

    const suffix = suffixMatch[1]
    const base = name.slice(0, name.length - suffix.length - 1) // strip the leading dot too

    // Validate the base ID before recording it.
    if (!VALID_ID_RE.test(base)) continue

    let entry = map.get(base)
    if (!entry) {
      entry = { id: base, hasTree: false, hasLlm: false, hasMemory: false, hasLegacy: false }
      map.set(base, entry)
    }

    if (suffix === 'tree.jsonl')  entry.hasTree = true
    else if (suffix === 'llm.jsonl')   entry.hasLlm = true
    else if (suffix === 'memory.md')   entry.hasMemory = true
    else if (suffix === 'jsonl')       entry.hasLegacy = true
  }

  return map
}
