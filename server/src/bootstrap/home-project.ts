/**
 * Declarative, self-healing home-project provisioning -- see
 * `ServerHomeProjectConfig`'s doc comment in `config/server-config.ts` for
 * why this runs on every boot rather than once.
 *
 * Two independent halves, both idempotent:
 *
 * 1. Clone the owner's ops repo into `directory` -- ONLY if that path does
 *    not exist yet. An existing path, git repo or not, is never touched:
 *    cloning into something a previous boot (or the owner) already put
 *    there would destroy real content for no reason a re-clone could fix.
 * 2. Upsert `settings.json`'s `engineProfiles` (by id=name, the stable
 *    identity this bootstrap owns) and `projects[directory]` (marked the
 *    sole default, with `profileOverride` pointed at that profile) to
 *    match this config -- every boot, so a save from anywhere else that
 *    happens to drop or corrupt either one is corrected within one
 *    restart.
 */
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, join } from 'path'
import type { ServerHomeProjectConfig } from '../config/server-config'
import { readSettings, writeSettings } from '../persistence/settings-store'
import { runGit } from '../git/git-runner'
import { dataDir } from '../paths'
import { log as _log, error as _error } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void { _log('home-project', msg, fields) }
function error(msg: string, fields?: Record<string, unknown>): void { _error('home-project', msg, fields) }

/**
 * The pod-level `GIT_SSH_COMMAND` points `UserKnownHostsFile` at a
 * read-only mounted secret, pre-populated with whatever hosts this
 * instance's OTHER git operations (worktrees, benches) already use. A
 * `homeProject.gitRemote` can name any host -- there is no reason to
 * assume it is already in that file, and no way to add to a read-only
 * mount even if it were.
 *
 * The clone gets its own writable, PVC-backed known_hosts file instead
 * (seeded from the mounted one so already-trusted hosts still verify
 * normally), with `accept-new`: trust a host's key the first time it's
 * seen, then verify strictly against the now-pinned key on every
 * subsequent connection. That is the standard posture for unattended
 * first-contact provisioning -- it is not a StrictHostKeyChecking=no
 * bypass, which never pins anything and never verifies again.
 *
 * Scoped to this one clone's env only: every other git operation in this
 * container keeps using the strict, pre-provisioned known_hosts file
 * unchanged.
 */
function bootstrapGitEnv(): NodeJS.ProcessEnv {
  const knownHosts = join(dataDir(), 'home-project-known-hosts')
  if (!existsSync(knownHosts)) {
    const mounted = '/etc/git-secret/known_hosts'
    mkdirSync(dirname(knownHosts), { recursive: true })
    if (existsSync(mounted)) copyFileSync(mounted, knownHosts)
  }
  // Built fresh rather than appended to process.env.GIT_SSH_COMMAND: OpenSSH
  // takes the FIRST occurrence of a repeated -o option, so appending a
  // second -o UserKnownHostsFile after the pod-level command's own would be
  // silently ignored, not override it.
  const identity = '/etc/git-secret/ssh-key'
  return {
    ...process.env,
    GIT_SSH_COMMAND: `ssh -i ${identity} -o IdentitiesOnly=yes -o UserKnownHostsFile=${knownHosts} -o StrictHostKeyChecking=accept-new`,
  }
}

/** Resolve `directory` against this process's own $HOME when it isn't already absolute. */
function resolveDirectory(directory: string): string {
  return isAbsolute(directory) ? directory : join(homedir(), directory)
}

/**
 * Clone `gitRemote` into `path` if `path` does not exist yet. No-ops
 * (logged) when `path` already exists, whatever it contains -- this
 * function only ever creates, never overwrites or inspects existing
 * content.
 */
async function ensureCloned(path: string, gitRemote: string): Promise<void> {
  if (existsSync(path)) {
    log('home project directory already present; not touching it', { path })
    return
  }
  mkdirSync(homedir(), { recursive: true })
  log('cloning home project repository', { path, git_remote: gitRemote })
  try {
    // Boot time has no connected client/principal to resolve identity from
    // (principalGitEnv needs a request context) -- explicit env bypasses
    // that entirely. See bootstrapGitEnv()'s doc comment for why this
    // clone gets its own known_hosts handling rather than the pod-level
    // GIT_SSH_COMMAND every other git operation in this container uses.
    await runGit(homedir(), ['clone', gitRemote, path], bootstrapGitEnv())
    log('home project repository cloned', { path })
  } catch (err) {
    error('home project clone failed; directory will be absent until next boot', { path, git_remote: gitRemote, error: String(err) })
  }
}

interface ProjectEntryShape {
  addedManually: boolean
  lastUsedAt: number
  isDefault?: boolean
  profileOverride?: { kind: 'profile'; profileId: string }
  [k: string]: unknown
}

/**
 * Upsert `engineProfiles` (by id=name) and `projects[path]` (sole default,
 * profileOverride pointed at that profile) into `settings.json`. Every
 * other engine profile and every other project entry is left exactly as
 * it was; only the one entry this config owns is asserted, and only
 * `isDefault` is cleared on siblings (never their `profileOverride` or any
 * other field).
 */
function ensureRegistered(path: string, profile: ServerHomeProjectConfig['engineProfile']): void {
  const settings = readSettings()
  let changed = false

  // hooks/boot-restore-tabs.ts's "no saved tabs" fallback
  // (useTabRestoration-initial-tab.ts's registerInitialRestoredTab) reads
  // this field FIRST, ahead of raw $HOME, to pick the very first tab's
  // working directory -- it does not consult the project registry's
  // isDefault at all. Setting it here is what makes a brand-new instance's
  // first-ever tab land in the home project instead of $HOME.
  if (settings.defaultBaseDirectory !== path) {
    settings.defaultBaseDirectory = path
    changed = true
    log('home project set as the boot-time default base directory', { path })
  }

  const profiles: Array<{ id: string; name: string; extensions: string[]; defaultMode?: string }> =
    Array.isArray(settings.engineProfiles) ? settings.engineProfiles : []
  const wantedProfile = { id: profile.name, name: profile.name, extensions: profile.extensions, defaultMode: profile.defaultMode }
  const existingProfileIdx = profiles.findIndex((p) => p.id === profile.name)
  if (existingProfileIdx === -1) {
    profiles.push(wantedProfile)
    changed = true
    log('home project engine profile registered', { profile_id: profile.name })
  } else if (JSON.stringify(profiles[existingProfileIdx]) !== JSON.stringify(wantedProfile)) {
    profiles[existingProfileIdx] = wantedProfile
    changed = true
    log('home project engine profile updated to match config', { profile_id: profile.name })
  }

  const projects: Record<string, ProjectEntryShape> =
    settings.projects && typeof settings.projects === 'object' ? settings.projects : {}
  const existing = projects[path]
  const wantedOverride = { kind: 'profile' as const, profileId: profile.name }
  const wantedEntry: ProjectEntryShape = {
    addedManually: existing?.addedManually ?? true,
    lastUsedAt: existing?.lastUsedAt ?? Date.now(),
    isDefault: true,
    profileOverride: wantedOverride,
  }
  if (!existing || existing.isDefault !== true || JSON.stringify(existing.profileOverride) !== JSON.stringify(wantedOverride)) {
    projects[path] = { ...existing, ...wantedEntry }
    changed = true
    log('home project registered as the default project', { path })
  }
  // Exactly one default: clear isDefault on every other entry.
  for (const [dir, entry] of Object.entries(projects)) {
    if (dir !== path && entry.isDefault === true) {
      projects[dir] = { ...entry, isDefault: false }
      changed = true
      log('cleared isDefault on a different project to keep the home project as the sole default', { dir })
    }
  }

  // preferences-persist.ts's loadPersistedSettings() runs
  // migrateProjectRegistry() -- a ONE-TIME upgrade from a retired global
  // default-profile setting -- whenever projectSettingsVersion is absent or
  // below 1, and that migration explicitly strips every project's
  // profileOverride ("the retired global profile is intentionally not
  // copied"). Without setting the version marker here, every client load
  // treated this bootstrap's already-modern, already-correct projects entry
  // as unmigrated legacy data and silently discarded the profileOverride
  // this function had just written moments earlier -- observed live
  // 2026-09-16 as cos2 never appearing as the default engine profile despite
  // settings.json on disk being correct the whole time.
  if (typeof settings.projectSettingsVersion !== 'number' || settings.projectSettingsVersion < 1) {
    settings.projectSettingsVersion = 1
    changed = true
    log('home project marked projectSettingsVersion=1 to skip the legacy profile migration')
  }

  if (!changed) {
    log('home project registration already matches config; nothing to write', { path })
    return
  }
  writeSettings({ ...settings, engineProfiles: profiles, projects })
  log('home project registration written to settings.json', { path, profile_id: profile.name })
}

/** No-op (logged at debug) when `server.json.homeProject` is absent -- a shared/team instance runs this and does nothing. */
export async function ensureHomeProject(config: ServerHomeProjectConfig | null): Promise<void> {
  if (!config) {
    log('no server.json.homeProject configured; skipping')
    return
  }
  const path = resolveDirectory(config.directory)
  await ensureCloned(path, config.gitRemote)
  // Registration runs even when the clone failed or was skipped: a
  // directory that already exists (created some other way) still deserves
  // its project registration, and a failed clone at least gets a correctly
  // pre-registered project waiting for it once cloned by hand.
  ensureRegistered(path, config.engineProfile)
}
