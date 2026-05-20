/**
 * Git domain layer — main process.
 *
 * Pure parsers, caching, operation queue, repository management, and file watching.
 */
export { parseUnifiedDiff, diffStats, parseGitStatus } from './diffs'
export type { DiffLine, StatusEntry } from './diffs'
export { parseLogLine, parseGitLog, parseCommitStats, parseCommitFiles, parseBranches, LOG_FORMAT } from './refs'
export type { GitRef, GitCommitRaw, CommitFileEntry, BranchEntry } from './refs'
export { LruCache } from './cache'
export { OperationQueue } from './operationQueue'
export type { OperationKind } from './operationQueue'
export { GitRepository } from './repository'
export type { RepoSnapshot } from '../../shared/types-git-events'
export { RepositoryManager, repositoryManager } from './repositoryManager'
export { createGitWatcher } from './watcher'
export type { GitWatcher, GitWatchEvent } from './watcher'
export { focusState } from './focus-state'
