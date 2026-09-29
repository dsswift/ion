/**
 * The Environment page's wire shapes (ADR-033): what one Studio server
 * reports about itself and its host, and the verbs a paired admin runs
 * against it. Every action here is an `environment.*` `studio_action`
 * (`server/src/environment/actions.ts`); progress rides the
 * `ion:project-job` event channel and registry changes ride
 * `ion:projects-changed`, so a phone or a browser Studio sees the same
 * state as the desktop that started the work.
 */
import type { ProjectEntry } from './project-registry'
import type { FormatVersion, HostApp } from './format-versions'

/** One registered project on an Environment, as the page lists it. */
export interface EnvironmentProject {
  /** Absolute path on the Environment's host: the registry key. */
  dir: string
  /** The entry as persisted in that host's settings.json. */
  entry: ProjectEntry
  /** Display name: the entry's name, else the directory's basename. */
  displayName: string
  /** Whether the directory currently exists on the host. */
  exists: boolean
  /** Whether it is a git checkout (has `.git`). */
  isGitRepo: boolean
  /** The current branch when it is a git checkout and one is checked out. */
  branch?: string
  /** The `origin` remote URL when it is a git checkout with one: what another environment clones to get a copy. */
  originUrl?: string
  /**
   * How many times work has been started in this directory on THIS host,
   * from its own `directoryUsageCounts`. Each host counts its own projects,
   * so a picker that merges several hosts can order a row by the machine it
   * would actually open on. Absent when the host has never recorded one.
   */
  usageCount?: number
  /** Last setup outcome, when a setup job has run this server lifetime. */
  setup?: { state: 'running' | 'ready' | 'failed' | 'none'; detail?: string; at: number }
  /** The setup command the project declares in `.ion/worktree.json`, when it declares one. */
  setupCommand?: string
  /**
   * False when Ion may not run the project's own code yet (`ProjectEntry.trusted`).
   * Absent means trusted, as it does in the registry: a server that predates
   * trust reports no untrusted projects.
   */
  trusted?: boolean
}

/** `environment.fs.browse` result: the directories under `path`. */
export interface EnvironmentFsBrowse {
  /** The absolute path that was listed (a `~` request is resolved to the home directory). */
  path: string
  /** The parent directory, or null at the filesystem root. */
  parentPath: string | null
  /** Whether the listed directory itself is a git checkout. */
  pathIsGitRepo: boolean
  home: string
  entries: Array<{ name: string; fullPath: string; isGitRepo: boolean }>
}

/** `environment.host.toolchains`: which developer tools the host has. */
export interface EnvironmentToolchains {
  tools: Array<{ name: 'git' | 'go' | 'node' | 'npm' | 'gh'; path: string | null; version: string | null }>
}

/** `environment.server.info`: the server, engine, and host behind an Environment. */
export interface EnvironmentServerInfo {
  serverVersion: string
  engineVersion: string | null
  hostname: string
  platform: NodeJS.Platform
  arch: string
  home: string
  dataDir: string
  /**
   * The installed Studio Server bundle (`~/.ion/studio-server/current`),
   * when this server was installed that way. Null for a server launched by
   * a desktop or from a checkout, where Update and Uninstall do not apply.
   */
  bundle: { root: string; version: { server: string; engine: string; node: string } } | null
  uptimeSeconds: number
  // The fields below are absent from a server that predates them; a client
  // connected to an older Environment renders their absence, not a default.
  /** `server.json`'s `engine.minVersion`. */
  engineMinVersion?: string
  /** Whether the running engine meets `engineMinVersion`; null when the engine did not answer. */
  engineMeetsMin?: boolean | null
  /** The app running this server as its child (a desktop), or null for a standalone server. */
  hostApp?: HostApp | null
  /** Engine sessions with an agent running now; null when the engine did not answer. */
  runningConversations?: number | null
  /** The server's Format Versions, then the running engine's. */
  formats?: FormatVersion[]
}

export type EnvironmentLogFile = 'engine' | 'server'

/** A background job the Environment runs on a project: a clone, a setup, or a purge. */
export interface EnvironmentJob {
  id: string
  kind: 'clone' | 'setup' | 'purge'
  /** The project directory the job produces or acts on. */
  dir: string
  phase: 'running' | 'done' | 'failed' | 'cancelled'
  /** Short human stage: `receiving objects`, `running setup`, `removing clones`. */
  stage: string
  /** 0..100 when the stage reports progress, else absent. */
  percent?: number
  /** The most recent output line, for the toast. */
  detail?: string
  error?: string
  startedAt: number
  endedAt?: number
  /** For a clone: the URL it clones. */
  url?: string
}

/** `environment.git.test` result for one URL. */
export interface EnvironmentGitTest {
  url: string
  ok: boolean
  /** The remote's HEAD branch when the test succeeded. */
  defaultBranch?: string
  error?: string
  durationMs: number
}

/** `environment.git.author.get` / `.set`: the host's global git author identity. */
export interface EnvironmentGitAuthor {
  name: string
  email: string
}

/** What a purge would remove, so the dialog can show sizes and counts before anyone ticks a box. */
export interface EnvironmentPurgeAppraisal {
  conversations: number
  dataBytes: number
  clonedProjects: Array<{ dir: string; dirty: boolean; bytes: number }>
  /** Git credentials this principal stored on the host (minted keys, pasted keys, tokens). */
  gitCredentialHosts: string[]
  bundle: { root: string; version: string } | null
}

/** The degrees of removal, from "just the services" to "every trace". `studio` is always on. */
export interface EnvironmentPurgeLevels {
  studio: true
  gitCredentials: boolean
  clones: boolean
  data: boolean
  /** Delete a dirty clone anyway. Off by default; the appraisal names which are dirty. */
  force?: boolean
}

export interface EnvironmentPurgeResult {
  removedClones: string[]
  keptDirtyClones: string[]
  removedGitCredentialHosts: string[]
  /** True when `ion studio uninstall` was scheduled on the host; the server exits shortly after. */
  uninstallScheduled: boolean
  /** Set when the services could not be scheduled for removal (no bundle on the host). */
  uninstallError?: string
}

/** `transfer.describe` on the SOURCE: what a transfer of one tab would carry. */
/**
 * The commands a repository's `.ion/worktree.json` declares, read from the
 * source's own checkout. A clone of it on another machine runs none of them
 * until that machine trusts the project, so the dialog names them when it
 * asks. Absent when the repository declares nothing to run.
 */
export interface DeclaredProvisioning {
  /** The project's setup command. */
  setup?: string
  /** Each seed entry's build command, in manifest order. */
  builds: string[]
}

export interface TransferDescription {
  status: string
  worktree: {
    /** Null when the checkout has no resolvable origin; the destination cannot match it then. */
    repoRemote: string | null
    branch: string
    sourceBranch: string
    repoPath: string
    originUrl: string
    dirty: boolean
    /** `~/src` style parent folder a clone on another host should land under. */
    suggestedParentDir: string
    /**
     * The other open conversations in this worktree. A worktree has one
     * home at a time, so a move takes every conversation in it along; the
     * dialog names them before the operator confirms.
     */
    siblings: Array<{ tabId: string; title: string }>
    provisioning?: DeclaredProvisioning
  } | null
  /**
   * Which repository the conversation belongs to, and where it lives on the
   * source. Set for a worktree conversation too: it can move on its own,
   * leaving the worktree behind, and then resolves its destination exactly
   * like a plain conversation does.
   *
   * A conversation's working directory is a path on the machine it is
   * leaving, so it means nothing on the destination. `repoRemote` is what
   * survives the move: the destination resolves its own checkout of the
   * same repository and the conversation lands there. Empty when the
   * directory belongs to no registered project with an origin — then there
   * is nothing to resolve by, and the operator picks the destination.
   */
  project: {
    workingDirectory: string
    repoRemote: string
    originUrl: string
    /** `~/src` style parent folder a clone on another host should land under. */
    suggestedParentDir: string
    provisioning?: DeclaredProvisioning
  } | null
  /**
   * The transfer archive format this server writes and reads. The two ends
   * must match, and the dialog checks before anything is exported. Absent
   * from a server older than this field, which writes format 1.
   */
  archiveVersion?: number
}

/** `transfer.preflight` on the DESTINATION: whether it can take a conversation from `repoRemote`/`sourceBranch`. */
export interface TransferPreflight {
  /** The destination project directory hosting the same repo, when one is registered. The first of `projectDirs`. */
  projectDir: string | null
  /**
   * Every registered project on the destination for the same repository.
   * More than one means the destination has two checkouts of it and the
   * dialog asks which one the conversation should land in rather than
   * guessing.
   */
  projectDirs: string[]
  /** The destination's whole project list, for a conversation with no repository to resolve by. */
  allProjectDirs: string[]
  /** Whether the source's own working directory happens to exist on the destination. */
  sourceDirectoryExists: boolean
  hasSourceBranch: boolean
  /** Commit shas the destination already has (branch tips), so the source can bundle only what is missing. */
  knownTips: string[]
  /**
   * The destination's existing checkout of the worktree branch, when it has
   * one. A transfer moves a worktree and deletes the copy it came from, so
   * a checkout here means the branch is already home on the destination --
   * a conflict the source dialog explains rather than overwrites. Null when
   * the destination has no checkout of the branch.
   */
  worktreeCopy: { worktreePath: string; dirty: boolean } | null
  /**
   * The transfer archive format this server writes and reads. The two ends
   * must match, and the dialog checks before anything is exported. Absent
   * from a server older than this field, which writes format 1.
   */
  archiveVersion?: number
}

/**
 * `environment.devices`: one device paired to this environment for the
 * calling person, and whether it is connected right now.
 */
export interface PairedDevice {
  clientId: string
  /** The label the device gave at pairing; null on records from before labels were stored. */
  label: string | null
  kind: 'desktop' | 'mobile'
  /** Unix ms the pairing was made. */
  pairedAt: number
  /** Unix ms the device last connected. */
  lastSeen: number
  /** Whether a connection from this device is open now, over any transport. */
  connected: boolean
  /** Unix ms the device's longest-open live connection opened; null when it is not connected. */
  connectedAt: number | null
  /** Whether the pairing holds the admin scope. */
  admin: boolean
  /** Whether this is the pairing the caller is connected through. */
  self: boolean
}

/** `environment.discovery.status`: whether the environment announces itself on its LAN. `code` is only ever populated for an admin caller. */
export interface EnvironmentDiscoveryStatus {
  mode: 'off' | 'window' | 'persistent' | 'sealed'
  advertising: boolean
  /** Unix ms a timed window closes itself; null outside one. */
  until: number | null
  /** The live one-time pairing code, `XXXX-XXXX`, or null. */
  code: string | null
}

/** Carries `{mode, advertising, until}` on every discovery change. Never the code: a channel reaches every connected client. */
export const DISCOVERY_CHANNEL = 'ion:discovery'
/**
 * A bare signal that the paired clients of this environment changed: one was
 * added by a completed pairing, revoked, or rebound to another subject. It
 * carries nothing, because a channel reaches every connected client; whoever
 * may read the list re-reads it: `auth.listClients` for an admin,
 * `environment.devices` for anyone's own devices.
 */
export const CLIENTS_CHANGED_CHANNEL = 'ion:clients-changed'
export const PROJECT_JOB_CHANNEL = 'ion:project-job'
export const PROJECTS_CHANGED_CHANNEL = 'ion:projects-changed'
