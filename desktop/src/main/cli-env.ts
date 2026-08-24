import { execFileSync } from 'child_process'
import { accessSync, constants, statSync } from 'fs'
import { log as _log, warn as _warn } from './logger'
import { stripPrivilegeEscalation, PRIVILEGE_ESCALATION_VAR } from './launch-env'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('cli-env', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('cli-env', msg, fields)
}

let cachedPath: string | null = null

function appendPathEntries(target: string[], seen: Set<string>, rawPath: string | undefined): void {
  if (!rawPath) return
  for (const entry of rawPath.split(':')) {
    const p = entry.trim()
    if (!p || seen.has(p)) continue
    seen.add(p)
    target.push(p)
  }
}

/**
 * One PATH-discovery attempt.
 *
 * `args` is an ARGV array, never a command string.
 */
interface PathProbe {
  shell: string
  args: string[]
  label: string
}

/**
 * PATH-discovery probes, in priority order.
 *
 * The configured login shell goes first. People often install tools through that
 * shell's startup files, so guessing zsh before consulting `$SHELL` can produce
 * a valid but incomplete PATH. zsh and bash remain portable fallbacks when the
 * configured shell cannot start non-interactively.
 *
 * `args` stays an argv array. `execFileSync` invokes the target shell directly,
 * leaving `$PATH` unexpanded until that shell evaluates `echo $PATH`.
 */
function pathProbes(shell = process.env.SHELL): PathProbe[] {
  const shells = [shell, '/bin/zsh', '/bin/bash'].filter(
    (candidate): candidate is string => Boolean(candidate),
  )
  const probes: PathProbe[] = []
  const seen = new Set<string>()

  for (const candidate of shells) {
    if (seen.has(candidate)) continue
    seen.add(candidate)
    const label = candidate === shell ? 'user-shell' : candidate.slice(candidate.lastIndexOf('/') + 1)
    probes.push(
      { shell: candidate, args: ['-ilc', 'echo $PATH'], label: `${label}-interactive-login` },
      { shell: candidate, args: ['-lc', 'echo $PATH'], label: `${label}-login` },
    )
  }

  return probes
}

/** Split a PATH string into a set of its non-empty entries. */
function pathEntrySet(raw: string): Set<string> {
  const set = new Set<string>()
  for (const entry of raw.split(':')) {
    const p = entry.trim()
    if (p) set.add(p)
  }
  return set
}

/**
 * Whether `discovered` contains at least one entry `current` lacks.
 *
 * A probe's exit code is not evidence that it worked: the quoting bug above
 * produced exit 0 and well-formed output on every attempt while discovering
 * nothing. Requiring a genuinely new entry is what makes that failure visible
 * instead of silent.
 */
function discoveredNewEntries(current: string, discovered: string): boolean {
  const currentSet = pathEntrySet(current)
  for (const entry of pathEntrySet(discovered)) {
    if (!currentSet.has(entry)) return true
  }
  return false
}

export function getCliPath(): string {
  if (cachedPath) return cachedPath

  const ordered: string[] = []
  const seen = new Set<string>()

  // Start from current process PATH.
  appendPathEntries(ordered, seen, process.env.PATH)

  // Add common binary locations used on macOS (Homebrew + system).
  appendPathEntries(ordered, seen, '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin')

  const baseline = ordered.join(':')

  const probes = pathProbes()

  for (const probe of probes) {
    let discovered: string
    try {
      discovered = execFileSync(probe.shell, probe.args, {
        encoding: 'utf-8',
        timeout: 5000,
        // Probe stderr is discarded on purpose. An interactive shell routinely
        // writes rc diagnostics, prompt-framework output, and completion
        // warnings there; none of it says anything about whether the PATH on
        // stdout is good.
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch (err) {
      warn('PATH probe failed, trying next', { probe: probe.label, error: String(err) })
      continue
    }

    if (!discoveredNewEntries(baseline, discovered)) {
      warn('PATH probe discovered nothing new, trying next', {
        probe: probe.label,
        entries_discovered: pathEntrySet(discovered).size,
      })
      continue
    }

    const existing = ordered.join(':')
    ordered.length = 0
    seen.clear()
    appendPathEntries(ordered, seen, discovered)
    appendPathEntries(ordered, seen, existing)
    cachedPath = ordered.join(':')
    log('PATH discovered', {
      probe: probe.label,
      entries_added: ordered.length - pathEntrySet(existing).size,
      entries_total: ordered.length,
    })
    return cachedPath
  }

  // Every probe failed or added nothing. The process PATH plus the macOS
  // defaults above is still a usable PATH, so fall back to it rather than
  // failing — but say so, because this is the state in which "command not
  // found" reports become likely.
  cachedPath = ordered.join(':')
  warn('every PATH probe failed or discovered nothing; using process PATH', {
    probes: probes.length,
    entries_total: ordered.length,
  })
  return cachedPath
}

export function getCliEnv(extraEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extraEnv,
    PATH: getCliPath(),
  }
  delete env.CLAUDECODE
  // Last line of defence for the spawn environment itself. Startup already
  // clears this from process.env, so normally there is nothing to strip. It is
  // repeated here because THIS function, not the startup path, is what every
  // spawned shell's environment is built from: a future entry point that
  // forgets the startup repair still cannot start a privileged shell that
  // silently skips the operator's zsh startup files. See launch-env.ts.
  if (stripPrivilegeEscalation(env)) {
    warn('stripped a privileged-shell marker from a spawn environment', {
      variable: PRIVILEGE_ESCALATION_VAR,
      note: 'startup repair did not run or the marker was reintroduced',
    })
  }

  // Installer launches can leave the desktop with TMPDIR inside a transient
  // PKInstallSandbox. macOS removes that sandbox after installation, and tools
  // such as Electron's npm installer then fail when they call mkdtemp(). Keep a
  // valid custom path, but let libc/Node select the per-user temp directory when
  // the inherited path is missing, is not a directory, or is not writable.
  if (env.TMPDIR) {
    try {
      if (!statSync(env.TMPDIR).isDirectory()) throw new Error('not a directory')
      accessSync(env.TMPDIR, constants.W_OK | constants.X_OK)
    } catch (err) {
      warn('discarding unusable TMPDIR from subprocess environment', {
        tmpdir: env.TMPDIR,
        error: String(err),
      })
      delete env.TMPDIR
    }
  }
  return env
}

/** Test seam: drop the memoized PATH so a test can exercise discovery again. */
export function resetCliPathCacheForTests(): void {
  cachedPath = null
}
