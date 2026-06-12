// Shared types for the Backup & Restore settings UI.
//
// Lives in its own file so the export and restore modal sub-components
// can each be small enough to fit under the 600-line cap while still
// referencing a single source of truth for the wire shapes.
//
// These mirror the IPC return types in src/main/ipc/conversation-backup.ts
// and the preload interface in src/preload/index.ts. If those change,
// update this file in lockstep — there is no contract test here because
// the renderer is a single consumer.

export type ExportScope = 'currently-open' | 'all'
export type ConflictPolicy = 'skip' | 'overwrite' | 'rename'

export interface ExportPreview {
  conversationCount: number
  totalUncompressedBytes: number
  estimatedCompressedBytes: number
  /**
   * Tab count from the desktop's tabs files (both backends combined).
   * Only populated for scope='currently-open'; undefined for scope='all'
   * because the all-archive path doesn't consult tabs files. The summary
   * card uses the presence/absence of this field to choose between
   * "N tabs across M conversation sessions" and "M conversation sessions".
   */
  tabCount?: number
}

export interface ExportResult {
  ok: boolean
  error?: string
  destinationPath?: string
  conversationCount?: number
  bytesWritten?: number
}

export interface RestoreManifest {
  version: number
  createdAt: string
  ionVersion: string
  scope: ExportScope
  conversationCount: number
  backendSnapshot: 'api' | 'cli'
  hostname: string
}

export interface RestoreResult {
  ok: boolean
  error?: string
  restored: number
  skipped: number
  overwritten: number
  renamed: number
  errors: string[]
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
