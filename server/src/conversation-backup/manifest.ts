// Manifest type and validation for conversation backup zips.
//
// The manifest is metadata for the restore UI — it tells the user when and
// where the backup was created and how many conversations it contains. It
// is NEVER used for safety decisions: file presence in the zip is the
// source of truth for what gets restored, and conflict policy is the
// source of truth for whether a conflicting local file is overwritten.

export const MANIFEST_VERSION = 1

export type ExportScope = 'currently-open' | 'all'

export interface BackupManifest {
  version: number
  createdAt: string
  createdBy: 'ion-desktop'
  ionVersion: string
  scope: ExportScope
  conversationCount: number
  /** Legacy field from the global-backend-mode era. Archives exported by
   *  current builds omit it (there is no mode — routing is credential-derived
   *  per provider); archives from older builds carry 'api' | 'cli' and it is
   *  preserved for display. */
  backendSnapshot?: 'api' | 'cli'
  hostname: string
}

export function buildManifest(args: {
  scope: ExportScope
  conversationCount: number
  ionVersion: string
  hostname: string
}): BackupManifest {
  return {
    version: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    createdBy: 'ion-desktop',
    ionVersion: args.ionVersion,
    scope: args.scope,
    conversationCount: args.conversationCount,
    hostname: args.hostname,
  }
}

/**
 * Validate that a parsed JSON object is a usable BackupManifest.
 *
 * Forward-compat policy: unknown additive fields are allowed (we return
 * `true` even if the manifest has fields we don't recognize). Unknown
 * versions are rejected outright. This matches the contract-stability rule
 * — additive changes are non-breaking, version bumps are breaking.
 *
 * Returns either the validated manifest (with required fields confirmed)
 * or a string describing the failure for the restore UI to display.
 */
export function validateManifest(raw: unknown): BackupManifest | string {
  if (!raw || typeof raw !== 'object') return 'manifest.json is not an object'
  const m = raw as Record<string, unknown>

  if (typeof m.version !== 'number') return 'manifest.version missing or wrong type'
  if (m.version !== MANIFEST_VERSION) {
    return `unsupported manifest.version=${m.version} (this build supports version ${MANIFEST_VERSION})`
  }

  if (typeof m.createdAt !== 'string') return 'manifest.createdAt missing or wrong type'
  if (m.createdBy !== 'ion-desktop') return `unexpected manifest.createdBy=${String(m.createdBy)}`
  if (typeof m.ionVersion !== 'string') return 'manifest.ionVersion missing or wrong type'
  if (m.scope !== 'currently-open' && m.scope !== 'all') return `unexpected manifest.scope=${String(m.scope)}`
  if (typeof m.conversationCount !== 'number') return 'manifest.conversationCount missing or wrong type'
  // backendSnapshot: optional legacy field. Absent in current archives;
  // 'api' | 'cli' in older ones. Any other present value is malformed.
  if (m.backendSnapshot !== undefined && m.backendSnapshot !== 'api' && m.backendSnapshot !== 'cli') {
    return `unexpected manifest.backendSnapshot=${String(m.backendSnapshot)}`
  }
  if (typeof m.hostname !== 'string') return 'manifest.hostname missing or wrong type'

  return {
    version: m.version,
    createdAt: m.createdAt,
    createdBy: 'ion-desktop',
    ionVersion: m.ionVersion,
    scope: m.scope,
    conversationCount: m.conversationCount,
    ...(m.backendSnapshot !== undefined ? { backendSnapshot: m.backendSnapshot } : {}),
    hostname: m.hostname,
  }
}
