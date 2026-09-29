/**
 * Composer prompt stash — the persisted shape and its one parser.
 *
 * A stash entry is a prompt the operator set aside to come back to: its text
 * and the attachments staged with it. Entries are keyed by source project so a
 * stash made in one worktree is there in every other worktree of the same
 * project, the way Scratch Documents are.
 *
 * `parseComposerStash` is both the renderer's restore path and the server's
 * settings validator, so the two can never disagree about what is valid.
 */
export const COMPOSER_STASH_VERSION = 1
export const COMPOSER_STASH_MAX_ENTRIES_PER_PROJECT = 50
export const COMPOSER_STASH_MAX_TEXT_LENGTH = 200_000
const MAX_ATTACHMENTS_PER_ENTRY = 50
const MAX_FIELD_LENGTH = 4096

/** The part of an attachment that survives a stash: enough to stage it again. */
export interface StashedAttachment {
  id: string
  type: 'image' | 'file'
  name: string
  path: string
  mimeType?: string
}

export interface ComposerStashEntry {
  id: string
  text: string
  attachments: StashedAttachment[]
  createdAt: number
}

export interface ComposerStash {
  version: typeof COMPOSER_STASH_VERSION
  projects: Record<string, ComposerStashEntry[]>
}

export const EMPTY_COMPOSER_STASH: ComposerStash = { version: COMPOSER_STASH_VERSION, projects: {} }

const isShortString = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_FIELD_LENGTH

function parseAttachment(raw: unknown): StashedAttachment | null {
  const a = raw as Partial<StashedAttachment> | null
  if (!a || !isShortString(a.id) || !isShortString(a.name) || !isShortString(a.path)) return null
  if (a.type !== 'image' && a.type !== 'file') return null
  if (a.mimeType !== undefined && !isShortString(a.mimeType)) return null
  return { id: a.id, type: a.type, name: a.name, path: a.path, ...(a.mimeType ? { mimeType: a.mimeType } : {}) }
}

function parseEntry(raw: unknown): ComposerStashEntry | null {
  const e = raw as Partial<ComposerStashEntry> | null
  if (!e || !isShortString(e.id) || typeof e.text !== 'string' || e.text.length > COMPOSER_STASH_MAX_TEXT_LENGTH) return null
  if (typeof e.createdAt !== 'number' || !Number.isFinite(e.createdAt)) return null
  if (!Array.isArray(e.attachments) || e.attachments.length > MAX_ATTACHMENTS_PER_ENTRY) return null
  const attachments = e.attachments.map(parseAttachment)
  if (attachments.some((a) => a === null)) return null
  return { id: e.id, text: e.text, attachments: attachments as StashedAttachment[], createdAt: e.createdAt }
}

/** Strict parse: null when any part of `value` is not a valid stash. */
export function parseComposerStash(value: unknown): ComposerStash | null {
  const raw = value as Partial<ComposerStash> | null
  if (!raw || typeof raw !== 'object' || raw.version !== COMPOSER_STASH_VERSION) return null
  if (!raw.projects || typeof raw.projects !== 'object' || Array.isArray(raw.projects)) return null
  const projects: Record<string, ComposerStashEntry[]> = {}
  for (const [key, list] of Object.entries(raw.projects)) {
    if (!isShortString(key) || !Array.isArray(list) || list.length > COMPOSER_STASH_MAX_ENTRIES_PER_PROJECT) return null
    const entries = list.map(parseEntry)
    if (entries.some((e) => e === null)) return null
    projects[key] = entries as ComposerStashEntry[]
  }
  return { version: COMPOSER_STASH_VERSION, projects }
}

/** Newest first. Adding past the cap drops the oldest. */
export function pushStashEntry(stash: ComposerStash, projectKey: string, entry: ComposerStashEntry): ComposerStash {
  const next = [entry, ...(stash.projects[projectKey] ?? [])].slice(0, COMPOSER_STASH_MAX_ENTRIES_PER_PROJECT)
  return { ...stash, projects: { ...stash.projects, [projectKey]: next } }
}

export function removeStashEntry(stash: ComposerStash, projectKey: string, entryId: string): ComposerStash {
  const remaining = (stash.projects[projectKey] ?? []).filter((e) => e.id !== entryId)
  const projects = { ...stash.projects }
  if (remaining.length > 0) projects[projectKey] = remaining
  else delete projects[projectKey]
  return { ...stash, projects }
}
