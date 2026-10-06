/**
 * A fleet command the desktop runs on this device for the Fleet page: the
 * bundled `ion fleet`, which holds the fleet's one implementation of
 * deploying. Each line it prints reaches the page as it is printed.
 */

/** What to run. */
export type FleetRunRequest =
  /**
   * Deploy to the servers named by environment id. `source` is `dev`,
   * `release`, or a path to an Ion checkout. `releaseFor` names servers that
   * install the newest release while the others take the build. `dryRun`
   * stops after the plan: it is how the page checks what a deploy would do.
   */
  | { kind: 'deploy'; environmentIds: string[]; source: string; overSsh?: boolean; allowDowngrade?: boolean; releaseFor?: string[]; dryRun?: boolean }
  /** Move hosts an earlier fleet file listed into this device's server list. */
  | { kind: 'migrate' }
  /** Make a host able to build: install the build tools it lacks, exclude its build folder from Microsoft Defender, or both. `source` is the checkout whose setup and tool versions are used. */
  | { kind: 'builder'; host: string; installTools?: boolean; excludeBuildDir?: boolean; source?: string }
  /** Set the folder a host builds in. */
  | { kind: 'set-build-dir'; host: string; buildDir: string }

/** One host of a deploy's plan. */
export interface FleetPlanTarget {
  /** The host's fleet name, which `stage`, `log`, and `result` events use. */
  host: string
  label: string
  environmentId?: string
  component: string
  goos: string
  goarch: string
  /** The host installs on itself, told over its Studio connection. */
  self: boolean
  /** `dev` or `release`: what this host installs. */
  source: string
  /** Why the host cannot be deployed; empty when it can. */
  refusal: string
}

/** One thing that stops a machine building. */
export interface FleetBuildProblem {
  /** `wrong_platform`, `no_ssh`, `unreachable`, `missing_tools`, or `defender`. */
  code: string
  tools?: string[]
  dir?: string
  /** A `builder` run can fix it. */
  fixable: boolean
  /** The problem in a sentence that starts with the machine's name. */
  message: string
}

/** Whether one machine can build, and what stops it. `host` is empty for this device. */
export interface FleetBuilderCheck {
  host: string
  environmentId?: string
  problems: FleetBuildProblem[]
}

/** Where one artifact of a deploy is built. */
export interface FleetPlanBuild {
  key: string
  component: string
  goos: string
  goarch: string
  /** The host that builds; empty builds on this device. */
  builder: string
  hosts: string[]
  /** Why nothing can build it; empty when something can. */
  refusal: string
  /** Each machine asked to build an artifact nothing can build. */
  candidates: FleetBuilderCheck[]
}

/** One line of a `ion fleet deploy --events` or `ion fleet builder --events` run. */
export type FleetDeployEvent =
  | { event: 'plan'; runId?: string; lines: string[]; blocked: boolean; targets?: FleetPlanTarget[]; builds?: FleetPlanBuild[] }
  | { event: 'stage'; host: string; stage: string; detail?: string }
  /** One line of a build or install log, with the hosts it is about. */
  | { event: 'log'; hosts: string[]; line: string }
  | { event: 'result'; host: string; ok: boolean; error?: string; logPath?: string; problems?: FleetBuildProblem[] }

/** What a running fleet command reports. */
export type FleetRunProgress =
  /** A line of the command's output: a `FleetDeployEvent` as JSON for a deploy, plain text otherwise. */
  | { runId: string; type: 'line'; stream: 'stdout' | 'stderr'; line: string }
  | { runId: string; type: 'exit'; code: number | null; error?: string }

export type FleetRunStart = { ok: true; runId: string } | { ok: false; error: string }

/**
 * An integration bench named by its repository and the source branch it
 * integrates into, instead of by its folder. A bench is removed when its last
 * worktree lands, and what it held is then on `branch`, so a bench remembered
 * this way still names the same work after its folder is gone.
 */
export interface FleetBenchSource {
  repoPath: string
  branch: string
}

/** What `fleet.deploy.source` is asked about: a folder by its path, or a bench by its branch. */
export type FleetSourceQuery = string | FleetBenchSource

/**
 * The checkout a deploy builds from, as `fleet.deploy.source` found it.
 * `via` says how: `folder` was named by its path, `bench` is the bench of a
 * branch, and `branch` is the checkout that has the branch because its bench
 * is gone. `bench` names the bench the folder is, or stands in for; absent
 * for any other folder.
 */
export interface FleetCheckout {
  path: string
  via: 'folder' | 'bench' | 'branch'
  bench?: FleetBenchSource
}

/** Reads a `fleet.deploy.source` argument; null for anything that is neither a folder nor a bench. */
export function parseFleetSourceQuery(value: unknown): FleetSourceQuery | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim()
  if (typeof value !== 'object' || value === null) return null
  const { repoPath, branch } = value as Record<string, unknown>
  return typeof repoPath === 'string' && repoPath !== '' && typeof branch === 'string' && branch !== '' ? { repoPath, branch } : null
}

/**
 * A deploy this device started, as the main process remembers it: whether it
 * still runs, and the log lines of its builds and installs. The page asks for
 * it when it opens, so a deploy started before the page was closed is shown
 * with its log. A run's id is its deploy's id (`FleetDeployRecord.id`).
 */
export interface FleetRunSnapshot {
  runId: string
  running: boolean
  /** Null while it runs, and for a run that could not start. */
  exitCode: number | null
  error?: string
  /** The newest log lines, oldest first. */
  log: Array<{ hosts: string[]; line: string }>
}

/** How many log lines of a deploy the main process keeps. */
export const FLEET_RUN_LOG_KEPT = 4_000

/** Reads one stdout line of a deploy run as an event; null for anything else. */
export function parseFleetDeployEvent(line: string): FleetDeployEvent | null {
  if (!line.startsWith('{')) return null
  try {
    const parsed = JSON.parse(line) as { event?: unknown }
    return parsed.event === 'plan' || parsed.event === 'stage' || parsed.event === 'result' || parsed.event === 'log' ? (parsed as FleetDeployEvent) : null
  } catch {
    return null // silent-ok: a line that is not an event is shown as text
  }
}
