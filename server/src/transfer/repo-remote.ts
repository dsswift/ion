/**
 * transfer/repo-remote — collapses a git remote URL onto one canonical
 * `host/org/repo` identity, and lazily resolves + persists it per project
 * (spec 10 Technical Approach).
 *
 * This is how `transfer.import` matches an incoming archive's worktree
 * against a LOCAL project directory hosting the SAME repository, even when
 * the two environments cloned it over different protocols
 * (`git@host:org/repo.git` vs `https://host/org/repo.git`) or one has since
 * dropped the `.git` suffix or an embedded user.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname } from 'path'
import { runGit } from '../git/git-runner'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'transfer.repo-remote'
function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn(TAG, msg, fields)
}

/**
 * Collapse an ssh, scp-like, or https remote URL onto `host/org/repo`:
 * lowercase host, no `.git` suffix, no embedded user, no scheme.
 *
 *   git@github.com:org/repo.git        -> github.com/org/repo
 *   ssh://git@github.com/org/repo.git  -> github.com/org/repo
 *   https://github.com/org/repo.git    -> github.com/org/repo
 *   https://user@github.com/org/repo   -> github.com/org/repo
 *
 * Returns null when the input does not parse as one of these shapes.
 */
export function normalizeRemote(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return null

  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
  // scp-like shorthand: [user@]host:path — no scheme, and a colon precedes
  // any slash (an https/ssh URL's colon is always inside the scheme, which
  // hasScheme already caught, so this only matches the shorthand form).
  const scpMatch = !hasScheme ? /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(trimmed) : null

  let host: string
  let path: string
  if (scpMatch) {
    host = scpMatch[1]
    path = scpMatch[2]
  } else {
    try {
      const withScheme = hasScheme ? trimmed : `ssh://${trimmed}`
      const parsed = new URL(withScheme)
      host = parsed.hostname
      path = parsed.pathname
    } catch (err) {
      warn('normalizeRemote: url did not parse', { url: trimmed, error: String(err) })
      return null
    }
  }

  host = host.toLowerCase()
  path = path.replace(/\.git$/i, '').replace(/^\/+/, '').replace(/\/+$/, '')
  if (!host || !path) return null
  return `${host}/${path}`
}

/** The narrow project shape this module reads and writes on `settings.json`. */
export interface RepoRemoteProject {
  repoRemote?: string
  [key: string]: unknown
}

export interface EnsureRepoRemoteDeps {
  readProjects: () => Record<string, RepoRemoteProject>
  writeProjects: (projects: Record<string, RepoRemoteProject>) => void
  /** Defaults to `runGit(repoPath, ['remote', 'get-url', 'origin'])`. Injectable for tests. */
  remoteUrl?: (repoPath: string) => Promise<string>
}

/**
 * Resolve `repoPath`'s `repoRemote`, filling and persisting it on
 * `settings.projects[repoPath]` when absent. Returns undefined when the
 * project has no `origin` remote or the remote does not normalize (a local-
 * only repo, or a URL shape this function does not recognize).
 */
export async function ensureRepoRemote(repoPath: string, deps: EnsureRepoRemoteDeps): Promise<string | undefined> {
  const projects = deps.readProjects()
  const existing = projects[repoPath]?.repoRemote
  if (existing) return existing

  const readRemote = deps.remoteUrl ?? ((p: string) => runGit(p, ['remote', 'get-url', 'origin']))
  let remoteUrl: string
  try {
    remoteUrl = (await readRemote(repoPath)).trim()
  } catch (err) {
    warn('ensureRepoRemote: git remote get-url failed', { repo_path: repoPath, error: String(err) })
    return undefined
  }

  const normalized = normalizeRemote(remoteUrl)
  if (!normalized) {
    warn('ensureRepoRemote: remote url did not normalize', { repo_path: repoPath, remote_url: remoteUrl })
    return undefined
  }

  projects[repoPath] = { ...(projects[repoPath] ?? {}), repoRemote: normalized }
  deps.writeProjects(projects)
  log('ensureRepoRemote: resolved and persisted', { repo_path: repoPath, repo_remote: normalized })
  return normalized
}

/**
 * `readProjects`/`writeProjects` against a specific `settings.json` path
 * (a `TransferPaths.settingsFile`). This is intentionally NOT `readSettings`/
 * `writeSettings` from `persistence/settings-store.ts` — those are pinned to
 * the real `SETTINGS_FILE` constant, which is exactly what transfer's DI
 * paths exist to let a caller override. Only the `projects` key is read and
 * merged back onto the raw parsed object, so every other settings key
 * round-trips untouched.
 */
export function projectsIoFor(settingsFile: string): Pick<EnsureRepoRemoteDeps, 'readProjects' | 'writeProjects'> {
  return {
    readProjects: () => {
      if (!existsSync(settingsFile)) return {}
      try {
        const raw = JSON.parse(readFileSync(settingsFile, 'utf-8'))
        return (raw?.projects && typeof raw.projects === 'object') ? raw.projects : {}
      } catch (err) {
        warn('projectsIoFor: settings file unreadable', { settings_file: settingsFile, error: String(err) })
        return {}
      }
    },
    writeProjects: (projects) => {
      let raw: Record<string, unknown> = {}
      if (existsSync(settingsFile)) {
        try {
          raw = JSON.parse(readFileSync(settingsFile, 'utf-8'))
        } catch (err) {
          warn('projectsIoFor: settings file unreadable on write, replacing', { settings_file: settingsFile, error: String(err) })
        }
      } else {
        mkdirSync(dirname(settingsFile), { recursive: true })
      }
      atomicWriteFileSync(settingsFile, JSON.stringify({ ...raw, projects }, null, 2), 0o600)
    },
  }
}

/** The local project path whose `repoRemote` matches, or undefined when none does. */
export function projectPathByRepoRemote(
  repoRemote: string,
  readProjects: () => Record<string, RepoRemoteProject>,
): string | undefined {
  return projectPathsByRepoRemote(repoRemote, readProjects)[0]
}

/**
 * Every registered project for `repoRemote`. A machine can hold two
 * checkouts of one repository, and a transfer that picked one silently
 * would land the conversation somewhere the operator did not choose.
 */
export function projectPathsByRepoRemote(
  repoRemote: string,
  readProjects: () => Record<string, RepoRemoteProject>,
): string[] {
  const projects = readProjects()
  const out: string[] = []
  for (const [path, project] of Object.entries(projects)) {
    if (project?.repoRemote === repoRemote) out.push(path)
  }
  return out.sort()
}
