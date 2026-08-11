/**
 * Worktree provisioning manifest — the project's declaration of what a working
 * copy needs beyond what git tracks.
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 * A fresh worktree is a bare checkout. Everything gitignored but required to
 * actually build is absent: `node_modules`, git hooks, generated config, build
 * caches. The operator gets a directory that looks like the repo and cannot run
 * a single gate.
 *
 * ── Why a manifest rather than built-in knowledge ───────────────────────────
 * Ion must not know what npm is. The same gap exists for `vendor/` (Go),
 * `.venv/` (Python), `target/` (Rust), `Pods/` (CocoaPods), and every future
 * ecosystem. So the project declares WHAT it needs and HOW to rebuild it, and
 * Ion decides only the fastest safe way to materialise it. The four fields
 * below carry no knowledge of any language.
 *
 * ── Fail open, always ───────────────────────────────────────────────────────
 * No manifest, an unreadable manifest, or a malformed one all yield an EMPTY
 * plan, never a throw. Worktree creation then behaves exactly as it does today.
 * That keeps this feature strictly additive: a repo that has never heard of it
 * is unaffected, and a typo in the JSON degrades to "no provisioning" rather
 * than to "cannot create a worktree".
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'worktree.provision'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** Manifest location, relative to the repo root. */
export const MANIFEST_RELATIVE_PATH = join('.ion', 'worktree.json')

/**
 * One gitignored path the worktree needs that git will not provide.
 *
 * `path` is repo-relative and must be gitignored — seeding a tracked path would
 * dirty `git status`, which the seeder refuses (see provision-seed.ts).
 */
export interface SeedEntry {
  /** Repo-relative path to materialise, e.g. `node_modules`. */
  path: string
  /**
   * Link one regular source file from the primary checkout rather than creating
   * an independent directory seed. Explicit opt-in only: shared mutable trees
   * such as `node_modules` must always use the clone/build/copy ladder.
   */
  link?: boolean
  /**
   * Command that rebuilds this directory from scratch, e.g. `npm ci`. Used when
   * no copy-on-write clone is available, and by the staleness reconciler.
   * Absent means "this directory can only be copied, never rebuilt".
   */
  build?: string
  /** Repo-relative directory to run `build` in. Defaults to the repo root. */
  cwd?: string
  /**
   * Repo-relative files whose content decides whether a seeded directory is
   * still valid — lockfiles, normally. When the worktree's copy differs from
   * the source's, the seed predates the worktree's own dependencies and `build`
   * is run to reconcile.
   */
  staleWhen?: string[]
}

/** A project's full provisioning declaration. */
export interface BenchVerifySpec {
  verify: string
  verifyTimeoutMs?: number
}

export interface ProvisionPlan {
  seed: SeedEntry[]
  /**
   * The project's own idempotent setup recipe, run after seeding — hooks,
   * symlinks, generated config. Ion invokes the project's command rather than
   * embedding its own notion of "set up a clone".
   */
  setup?: string
}

/** The empty plan. Returned for every failure mode; provisioning becomes a no-op. */
const EMPTY_PLAN: ProvisionPlan = { seed: [] }

function readManifestRoot(repoPath: string): { root?: Record<string, unknown>; file: string } {
  const file = join(repoPath, MANIFEST_RELATIVE_PATH)
  if (!existsSync(file)) {
    log('no worktree manifest found', { repo_path: repoPath })
    return { file }
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as unknown
    if (!parsed || typeof parsed !== 'object') {
      warn('manifest root is not an object', { path: file })
      return { file }
    }
    const root = parsed as Record<string, unknown>
    if (root.version !== undefined && root.version !== 1) {
      warn('unsupported manifest version', { path: file, version: String(root.version) })
      return { file }
    }
    return { root, file }
  } catch (err) {
    warn('manifest is not valid JSON', { path: file, error: String(err) })
    return { file }
  }
}

/** Read optional project verification for recorded bench resolutions. */
export function readBenchVerify(repoPath: string): BenchVerifySpec | undefined {
  const { root, file } = readManifestRoot(repoPath)
  if (!root) return undefined
  const bench = root.bench
  if (bench === undefined) {
    log('manifest has no bench verification block', { path: file })
    return undefined
  }
  if (!bench || typeof bench !== 'object') {
    warn('manifest bench block is not an object', { path: file })
    return undefined
  }
  const raw = bench as { verify?: unknown; verifyTimeoutMs?: unknown }
  if (typeof raw.verify !== 'string' || !raw.verify.trim()) {
    warn('manifest bench verify command is not a non-empty string', { path: file })
    return undefined
  }
  const timeout = raw.verifyTimeoutMs
  const verifyTimeoutMs = typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
    ? timeout
    : undefined
  if (timeout !== undefined && verifyTimeoutMs === undefined) {
    warn('manifest bench verify timeout is invalid; using default', { path: file, verify_timeout_ms: timeout })
  }
  log('bench verification manifest loaded', {
    path: file,
    has_custom_timeout: verifyTimeoutMs !== undefined,
  })
  return { verify: raw.verify.trim(), verifyTimeoutMs }
}

/**
 * Read and validate `<repoPath>/.ion/worktree.json`.
 *
 * Every rejection is logged with the reason, because a manifest that is present
 * but silently ignored is worse than no manifest: the operator would see an
 * unprovisioned worktree with no explanation.
 */
export function readProvisionManifest(repoPath: string): ProvisionPlan {
  const file = join(repoPath, MANIFEST_RELATIVE_PATH)
  if (!existsSync(file)) {
    log('no provisioning manifest; worktree creation unchanged', { repo_path: repoPath })
    return EMPTY_PLAN
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'))
  } catch (err) {
    warn('manifest is not valid JSON; skipping provisioning', { path: file, error: String(err) })
    return EMPTY_PLAN
  }

  const root = parsed as { version?: unknown; worktree?: unknown }
  // Version is advisory today but validated so a future format change can be
  // rejected loudly here rather than misread silently.
  if (root?.version !== undefined && root.version !== 1) {
    warn('unsupported manifest version; skipping provisioning', { path: file, version: String(root.version) })
    return EMPTY_PLAN
  }

  const wt = root?.worktree as { seed?: unknown; setup?: unknown } | undefined
  if (!wt || typeof wt !== 'object') {
    warn('manifest has no `worktree` block; skipping provisioning', { path: file })
    return EMPTY_PLAN
  }

  const seed: SeedEntry[] = []
  if (Array.isArray(wt.seed)) {
    for (const raw of wt.seed) {
      const entry = normalizeSeedEntry(raw, file)
      if (entry) seed.push(entry)
    }
  } else if (wt.seed !== undefined) {
    warn('manifest `seed` is not an array; ignoring it', { path: file })
  }

  const setup = typeof wt.setup === 'string' && wt.setup.trim() ? wt.setup.trim() : undefined

  log('manifest loaded', { path: file, seed_count: seed.length, has_setup: !!setup })
  return { seed, setup }
}

/**
 * Validate one seed entry, or return null with a reason logged.
 *
 * An absolute path or one escaping the repo is rejected outright: seeding must
 * only ever write inside the destination worktree, and a `../` in the manifest
 * is the one way that invariant could be subverted by data rather than by code.
 */
function normalizeSeedEntry(raw: unknown, file: string): SeedEntry | null {
  const e = raw as { path?: unknown; link?: unknown; build?: unknown; cwd?: unknown; staleWhen?: unknown }
  if (!e || typeof e.path !== 'string' || !e.path.trim()) {
    warn('seed entry has no usable `path`; ignoring it', { path: file })
    return null
  }
  const p = e.path.trim()
  if (!isRepoRelative(p)) {
    warn('seed `path` must be repo-relative and inside the repo; ignoring it', { path: file, seed_path: p })
    return null
  }

  const cwd = typeof e.cwd === 'string' && e.cwd.trim() ? e.cwd.trim() : undefined
  if (cwd && !isRepoRelative(cwd)) {
    warn('seed `cwd` must be repo-relative and inside the repo; ignoring the entry', { path: file, cwd })
    return null
  }

  const staleWhen = Array.isArray(e.staleWhen)
    ? e.staleWhen.filter((s): s is string => typeof s === 'string' && !!s.trim() && isRepoRelative(s.trim())).map((s) => s.trim())
    : []
  const link = e.link === true
  const build = typeof e.build === 'string' && e.build.trim() ? e.build.trim() : undefined

  // Linking aliases a primary-owned regular file. It has no local build or
  // staleness semantics, so accepting either would hide a malformed manifest.
  if (link && (build || cwd || staleWhen.length > 0)) {
    warn('linked seed cannot declare build, cwd, or staleWhen; ignoring the entry', {
      path: file, seed_path: p,
    })
    return null
  }

  return { path: p, link: link || undefined, build, cwd, staleWhen }
}

/**
 * True when `p` is a relative path that stays inside the repo.
 *
 * Rejects absolute paths, Windows drive-qualified paths, and any `..` segment.
 * Checked on the raw string rather than after resolution so the rejection is
 * about what the manifest DECLARED, which is what gets logged.
 */
function isRepoRelative(p: string): boolean {
  if (p.startsWith('/') || p.startsWith('\\')) return false
  if (/^[a-zA-Z]:/.test(p)) return false
  return !p.split(/[/\\]/).includes('..')
}
