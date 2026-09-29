/**
 * transfer/manifest — `transfer.json`, the manifest at the root of a
 * transfer archive (spec 10 manifest contract C8).
 *
 * Distinct from `conversation-backup/manifest.ts`'s `BackupManifest`: that
 * one describes a user-triggered multi-conversation zip export with its own
 * scope/version lineage. `TransferManifest` describes ONE conversation
 * family moving between two Ion server environments and carries the tab
 * record + tab content + optional worktree identity needed to reconstruct
 * the tab on the other side — a backup archive carries none of that.
 */
import type { PersistedTab, ExternalInstanceContent } from '@ion/shared/types-persistence'
import type { ResourceItem } from '@ion/shared/types-resource'

/**
 * 2 added `files`: the sha256 of every entry in the archive. A transfer now
 * deletes its source once the destination verifies what it received, so an
 * archive that cannot be verified cannot be accepted — a version-1 archive
 * is refused rather than trusted.
 *
 * 3 added what a conversation's files need on another machine: the files
 * outside its own folders it points at (`attachments`), the source's roots so
 * every stored path can be rewritten on arrival (`sourceRoots`), and its
 * resources' read and deleted marks (`resourceState`). A version-2 archive
 * would arrive with paths that point at the machine it left, so it is
 * refused too. It also carries the conversations' extension resources
 * (`extensionResources`), which their producers hand over and take in.
 */
export const TRANSFER_MANIFEST_VERSION = 3

/** A file outside the family's own folders that its history names. */
export interface TransferAttachment {
  /** Archive entry, `attachments/<n>`. */
  entry: string
  /** Where it was on the source; every stored copy of this path is rewritten on arrival. */
  sourcePath: string
  kind: 'plan' | 'file' | 'image' | 'tool-result'
  /** The family member whose history named it; it lands in that conversation's folder. */
  ownerId: string
}

/** Where the source kept things, so each stored path can be mapped to this machine. */
export interface TransferSourceRoots {
  conversationsDir: string
  dataDir: string
  /** The conversation's working directory on the source. */
  workingDirectory: string
  /** The source's path separator. */
  separator: string
}

/** Read and deleted marks for the resources that move (identity strings, `resource-identity.ts`). */
export interface TransferResourceState {
  read: string[]
  deleted: string[]
}

export interface TransferWorktreeManifest {
  repoRemote: string
  branch: string
  sourceBranch: string
  /** Path within the archive to the `git bundle create` output. */
  bundlePath: string
  /** True when the bundle also carries `sourceBranch` (built for a destination that lacked it). Absent on archives from before this existed: thin bundle. */
  bundleIncludesSourceBranch?: boolean
}

export interface TransferManifest {
  version: number
  rootConversationId: string
  conversationIds: string[]
  sourceEnvironmentId: string
  exportedAt: number
  tabRecord: PersistedTab
  tabContent: ExternalInstanceContent | null
  worktree: TransferWorktreeManifest | null
  /** sha256 of every archive entry except `transfer.json`, keyed by archive-relative name. */
  files: Record<string, string>
  attachments: TransferAttachment[]
  /** Paths the history names that no longer existed on the source; left as they are. */
  missingAttachments: string[]
  sourceRoots: TransferSourceRoots
  resourceState: TransferResourceState
  /** Items extensions hold for the moving conversations, each with its own kind and producer. */
  extensionResources: ResourceItem[]
}

export function buildTransferManifest(args: {
  rootConversationId: string
  conversationIds: string[]
  sourceEnvironmentId: string
  exportedAt: number
  tabRecord: PersistedTab
  tabContent: ExternalInstanceContent | null
  worktree: TransferWorktreeManifest | null
  files: Record<string, string>
  attachments: TransferAttachment[]
  missingAttachments: string[]
  sourceRoots: TransferSourceRoots
  resourceState: TransferResourceState
  extensionResources: ResourceItem[]
}): TransferManifest {
  return {
    version: TRANSFER_MANIFEST_VERSION,
    rootConversationId: args.rootConversationId,
    conversationIds: args.conversationIds,
    sourceEnvironmentId: args.sourceEnvironmentId,
    exportedAt: args.exportedAt,
    tabRecord: args.tabRecord,
    tabContent: args.tabContent,
    worktree: args.worktree,
    files: args.files,
    attachments: args.attachments,
    missingAttachments: args.missingAttachments,
    sourceRoots: args.sourceRoots,
    resourceState: args.resourceState,
    extensionResources: args.extensionResources,
  }
}

export type TransferManifestValidation =
  | { ok: true; manifest: TransferManifest }
  | { ok: false; code: 'invalid_manifest' | 'version_mismatch'; message: string }

/**
 * Validate a parsed `transfer.json`. Unlike `BackupManifest`'s
 * forward-compat allowance, this manifest's `version` gates whether the
 * REST of the fields (tabRecord shape, worktree shape) are even trustworthy
 * to read — so an unsupported version is refused before any other field is
 * inspected: any version other than TRANSFER_MANIFEST_VERSION is refused.
 */
export function validateTransferManifest(raw: unknown): TransferManifestValidation {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, code: 'invalid_manifest', message: 'transfer.json is not an object' }
  }
  const m = raw as Record<string, unknown>

  if (typeof m.version !== 'number') {
    return { ok: false, code: 'invalid_manifest', message: 'transfer.json.version missing or wrong type' }
  }
  if (m.version !== TRANSFER_MANIFEST_VERSION) {
    return {
      ok: false,
      code: 'version_mismatch',
      message: `unsupported transfer.json.version=${m.version} (this build supports version ${TRANSFER_MANIFEST_VERSION})`,
    }
  }
  if (typeof m.rootConversationId !== 'string' || !m.rootConversationId) {
    return { ok: false, code: 'invalid_manifest', message: 'transfer.json.rootConversationId missing or wrong type' }
  }
  if (!Array.isArray(m.conversationIds) || !m.conversationIds.every((id) => typeof id === 'string')) {
    return { ok: false, code: 'invalid_manifest', message: 'transfer.json.conversationIds missing or wrong type' }
  }
  if (typeof m.sourceEnvironmentId !== 'string' || !m.sourceEnvironmentId) {
    return { ok: false, code: 'invalid_manifest', message: 'transfer.json.sourceEnvironmentId missing or wrong type' }
  }
  if (!m.files || typeof m.files !== 'object' || Object.values(m.files as Record<string, unknown>).some((v) => typeof v !== 'string')) {
    return { ok: false, code: 'invalid_manifest', message: 'transfer.json.files missing or wrong type' }
  }
  if (typeof m.exportedAt !== 'number') {
    return { ok: false, code: 'invalid_manifest', message: 'transfer.json.exportedAt missing or wrong type' }
  }
  if (!m.tabRecord || typeof m.tabRecord !== 'object') {
    return { ok: false, code: 'invalid_manifest', message: 'transfer.json.tabRecord missing or wrong type' }
  }
  if (m.tabContent !== null && typeof m.tabContent !== 'object') {
    return { ok: false, code: 'invalid_manifest', message: 'transfer.json.tabContent must be an object or null' }
  }
  if (!Array.isArray(m.attachments) || !m.attachments.every(isAttachment)) {
    return { ok: false, code: 'invalid_manifest', message: 'transfer.json.attachments missing or wrong type' }
  }
  if (!Array.isArray(m.missingAttachments) || !m.missingAttachments.every((p) => typeof p === 'string')) {
    return { ok: false, code: 'invalid_manifest', message: 'transfer.json.missingAttachments missing or wrong type' }
  }
  const roots = m.sourceRoots as Record<string, unknown> | undefined
  if (!roots || typeof roots !== 'object' || !['conversationsDir', 'dataDir', 'workingDirectory', 'separator'].every((k) => typeof roots[k] === 'string')) {
    return { ok: false, code: 'invalid_manifest', message: 'transfer.json.sourceRoots missing or wrong type' }
  }
  const state = m.resourceState as Record<string, unknown> | undefined
  if (!state || typeof state !== 'object' || !isStringArray(state.read) || !isStringArray(state.deleted)) {
    return { ok: false, code: 'invalid_manifest', message: 'transfer.json.resourceState missing or wrong type' }
  }
  if (!Array.isArray(m.extensionResources) || !m.extensionResources.every((i) => i && typeof i === 'object' && typeof (i as Record<string, unknown>).id === 'string' && typeof (i as Record<string, unknown>).kind === 'string')) {
    return { ok: false, code: 'invalid_manifest', message: 'transfer.json.extensionResources missing or wrong type' }
  }
  if (m.worktree !== null) {
    if (typeof m.worktree !== 'object') {
      return { ok: false, code: 'invalid_manifest', message: 'transfer.json.worktree must be an object or null' }
    }
    const w = m.worktree as Record<string, unknown>
    if (typeof w.repoRemote !== 'string' || typeof w.branch !== 'string' || typeof w.sourceBranch !== 'string' || typeof w.bundlePath !== 'string') {
      return { ok: false, code: 'invalid_manifest', message: 'transfer.json.worktree missing a required field' }
    }
  }

  return {
    ok: true,
    manifest: {
      version: m.version,
      rootConversationId: m.rootConversationId,
      conversationIds: m.conversationIds as string[],
      sourceEnvironmentId: m.sourceEnvironmentId,
      exportedAt: m.exportedAt,
      tabRecord: m.tabRecord as PersistedTab,
      tabContent: m.tabContent as ExternalInstanceContent | null,
      files: m.files as Record<string, string>,
      worktree: m.worktree as TransferWorktreeManifest | null,
      attachments: m.attachments as TransferAttachment[],
      missingAttachments: m.missingAttachments as string[],
      sourceRoots: m.sourceRoots as TransferSourceRoots,
      resourceState: m.resourceState as TransferResourceState,
      extensionResources: m.extensionResources as ResourceItem[],
    },
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

const ATTACHMENT_KINDS = new Set(['plan', 'file', 'image', 'tool-result'])

function isAttachment(value: unknown): value is TransferAttachment {
  if (!value || typeof value !== 'object') return false
  const a = value as Record<string, unknown>
  return typeof a.entry === 'string' && a.entry.startsWith('attachments/') && !a.entry.includes('..') &&
    typeof a.sourcePath === 'string' && typeof a.ownerId === 'string' && typeof a.kind === 'string' && ATTACHMENT_KINDS.has(a.kind)
}
