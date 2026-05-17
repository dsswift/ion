/**
 * RepositoryManager — per-repo registry with refcounting and lifecycle.
 *
 * - `get(path)` returns a GitRepository, creating one if needed.
 * - `retain(path)` / `release(path)` manage the refcount.
 * - When refcount drops to zero, the repository is disposed and removed.
 */

import { GitRepository } from './repository'
import { log as _log } from '../logger'

function log(msg: string): void {
  _log('main', msg)
}

export class RepositoryManager {
  private readonly repos = new Map<string, GitRepository>()

  /** Get or create a repository for the given path. Does NOT auto-retain. */
  get(path: string): GitRepository {
    let repo = this.repos.get(path)
    if (!repo) {
      repo = new GitRepository(path)
      this.repos.set(path, repo)
      log(`Repository created: ${path}`)
    }
    return repo
  }

  /** Retain a repository (increment refcount). Creates if needed. */
  retain(path: string): GitRepository {
    const repo = this.get(path)
    repo.retain()
    log(`Repository retained: ${path} (refCount=${repo.refCount})`)
    return repo
  }

  /** Release a repository. Disposes when refcount reaches zero. */
  release(path: string): void {
    const repo = this.repos.get(path)
    if (!repo) return
    const shouldDispose = repo.release()
    if (shouldDispose) {
      repo.dispose()
      this.repos.delete(path)
      log(`Repository disposed: ${path}`)
    } else {
      log(`Repository released: ${path} (refCount=${repo.refCount})`)
    }
  }

  /** Check if a repository exists for the given path. */
  has(path: string): boolean {
    return this.repos.has(path)
  }

  /** Dispose all repositories. */
  disposeAll(): void {
    for (const [path, repo] of this.repos) {
      repo.dispose()
      log(`Repository disposed (shutdown): ${path}`)
    }
    this.repos.clear()
  }

  /** Get all managed repository paths. */
  get paths(): string[] {
    return [...this.repos.keys()]
  }
}

/** Singleton instance. */
export const repositoryManager = new RepositoryManager()
