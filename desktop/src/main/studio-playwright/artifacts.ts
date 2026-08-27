/**
 * Artifact path resolution for browser tools.
 *
 * Every filename an agent supplies is resolved INSIDE the conversation's
 * working directory. The check is `realpath`-based rather than string-prefix
 * based, because a symlink whose path starts with the root can still point
 * outside it — a string check would pass exactly the case that matters.
 *
 * The parent directory is resolved rather than the target file, since the
 * target usually does not exist yet. That is the deepest existing ancestor,
 * which is what a traversal would have to escape through.
 */
import { mkdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** Generated artifacts land here when the caller names no file. */
export const DEFAULT_ARTIFACT_DIR = '.ion/browser'

export interface ArtifactPath {
  /** Absolute path to write. */
  absolute: string
  /** Conversation-relative path, for the model-visible link. */
  relative: string
}

export interface ArtifactError {
  error: string
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'artifact'
}

/** A timestamped default name, so repeated captures do not overwrite. */
export function defaultArtifactName(kind: string, extension: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${sanitizeSegment(kind)}-${stamp}.${sanitizeSegment(extension)}`
}

/**
 * Resolve a caller filename (or a generated default) under `cwd`.
 *
 * Returns an error rather than throwing so tool handlers can hand the reason
 * straight to the model: a refused path is a normal, correctable mistake.
 */
export async function resolveArtifactPath(
  cwd: string,
  filename: string | undefined,
  fallback: { kind: string; extension: string },
): Promise<ArtifactPath | ArtifactError> {
  if (!cwd || !isAbsolute(cwd)) return { error: 'the conversation has no absolute working directory, so no file can be written' }
  let root: string
  try {
    root = await realpath(cwd)
  } catch (err) {
    return { error: `the conversation working directory is unavailable: ${String(err)}` }
  }

  const requested = typeof filename === 'string' ? filename.trim() : ''
  if (requested.length > 1024) return { error: 'filename is too long' }
  // An absolute path is refused outright rather than reinterpreted: silently
  // relocating it would write somewhere the caller did not ask for.
  if (requested && isAbsolute(requested)) return { error: 'filename must be relative to the conversation working directory' }
  if (requested.split(/[/\\]/).includes('..')) return { error: 'filename must not traverse outside the conversation working directory' }

  const target = requested
    ? resolve(root, requested)
    : join(root, DEFAULT_ARTIFACT_DIR, defaultArtifactName(fallback.kind, fallback.extension))

  const parent = dirname(target)
  try {
    await mkdir(parent, { recursive: true })
  } catch (err) {
    return { error: `cannot create the output directory: ${String(err)}` }
  }

  let realParent: string
  try {
    realParent = await realpath(parent)
  } catch (err) {
    return { error: `cannot resolve the output directory: ${String(err)}` }
  }
  const escape = relative(root, realParent)
  if (escape.startsWith('..') || isAbsolute(escape)) {
    return { error: 'filename resolves outside the conversation working directory' }
  }

  const absolute = join(realParent, target.slice(parent.length + 1) || defaultArtifactName(fallback.kind, fallback.extension))
  return { absolute, relative: relative(root, absolute) }
}

/** Validate caller-supplied input paths (uploads) against the same root. */
export async function resolveInputPaths(cwd: string, paths: readonly unknown[]): Promise<{ resolved: string[] } | ArtifactError> {
  if (!cwd || !isAbsolute(cwd)) return { error: 'the conversation has no absolute working directory' }
  let root: string
  try {
    root = await realpath(cwd)
  } catch (err) {
    return { error: `the conversation working directory is unavailable: ${String(err)}` }
  }
  const resolved: string[] = []
  for (const raw of paths) {
    if (typeof raw !== 'string' || !raw) return { error: 'every upload path must be a non-empty string' }
    if (raw.split(/[/\\]/).includes('..')) return { error: `path "${raw}" must not traverse outside the conversation working directory` }
    const absolute = isAbsolute(raw) ? raw : resolve(root, raw)
    let real: string
    try {
      real = await realpath(absolute)
    } catch (err) {
      return { error: `path "${raw}" cannot be read: ${String(err)}` }
    }
    const escape = relative(root, real)
    if (escape.startsWith('..') || isAbsolute(escape)) return { error: `path "${raw}" is outside the conversation working directory` }
    resolved.push(real)
  }
  return { resolved }
}

/** Narrow any artifact result union to its failure arm. */
export function isArtifactError<T extends object>(value: T | ArtifactError): value is ArtifactError {
  return 'error' in value
}
