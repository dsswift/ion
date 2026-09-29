/**
 * plain-destination — where a conversation with no worktree lands on the
 * machine it is moving to.
 *
 * A conversation's working directory is a path on the machine it is
 * leaving. Carrying it across produced a conversation filed under a
 * directory that does not exist on the destination: the Inbox files a
 * conversation under its checkout path, so it became its own project named
 * for someone else's filesystem, and it could not be found.
 *
 * So the destination resolves the directory, by repository identity, and
 * the operator sees which one before anything moves. What cannot be
 * resolved is asked, never guessed: two checkouts of one repository is a
 * question, and a conversation whose directory belongs to no project at all
 * is a question.
 */
import type { EnvironmentProject, TransferDescription, TransferPreflight } from '@ion/shared/types-environment-admin'
import type { TransferCheck, TransferFix } from './useTransferPreflight'
import { pathBasename, pathDirname } from '@ion/shared/paths'

/** What the destination needs to know about the project a plain conversation lives in. */
export type PlainProject = NonNullable<TransferDescription['project']>

/**
 * The project a conversation's directory belongs to, read from its own
 * environment's project list — longest matching project wins, so a project
 * nested inside another resolves to the inner one.
 *
 * This desktop already holds every connected environment's project list,
 * so it does not need the source to say which repository a conversation is
 * in. The source's own answer is preferred when it gives one; this is what
 * lets the destination still match when the source runs a build that
 * predates reporting it — which is exactly how a transfer landed on an
 * empty picker when the matching project was sitting right there.
 */
export function sourceProjectFor(workingDirectory: string, projects: readonly EnvironmentProject[]): PlainProject | null {
  if (!workingDirectory) return null
  const owner = projects
    .filter((p) => workingDirectory === p.dir || workingDirectory.startsWith(`${p.dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length)[0]
  if (!owner?.entry.repoRemote) return null
  return {
    workingDirectory,
    repoRemote: owner.entry.repoRemote,
    originUrl: owner.originUrl ?? '',
    suggestedParentDir: homeRelativeParent(owner.dir),
  }
}

/**
 * Where a clone of `projectDir` belongs on another machine: the same place
 * relative to home, when it lives under a home directory. The source
 * computes this itself from its real home; this reads it off the path's
 * shape, which is how home directories are laid out on the platforms Ion
 * runs on, for a source too old to say.
 */
export function homeRelativeParent(projectDir: string): string {
  const parent = pathDirname(projectDir) || '/'
  const home = /^\/(?:Users|home)\/([^/]+)(\/.*)?$/.exec(parent)
  // `/Users/Shared` is macOS's folder for every account, not anyone's home:
  // a project there belongs in the same absolute place on another Mac.
  if (!home || home[1] === 'Shared') return parent
  return home[2] ? `~${home[2]}` : '~'
}

/**
 * The project to act on: the source's own report when it made one, else
 * what this desktop resolved from the source's project list.
 */
export function effectiveProject(reported: PlainProject | null | undefined, resolvedHere: PlainProject | null): PlainProject | null {
  if (reported?.repoRemote) return reported
  if (resolvedHere) return { ...resolvedHere, workingDirectory: reported?.workingDirectory || resolvedHere.workingDirectory }
  return reported ?? null
}

/** A directory's display name on its own environment: the project's name, else the last path segment. */
export function projectNameFor(dir: string, projects: readonly EnvironmentProject[]): string {
  const match = projects.find((p) => p.dir === dir)
  if (match) return match.displayName
  return pathBasename(dir)
}

export interface DestinationChoice {
  /** The destination's checkouts of this conversation's repository, listed first. */
  matches: string[]
  /** Every other project on the destination, listed after the matches. */
  others: string[]
  /**
   * The one to preselect, or empty when the operator must choose. Empty
   * whenever picking for them would be a guess: several checkouts of the
   * same repository, or no repository to resolve by at all.
   */
  auto: string
}

/**
 * What the destination offers a conversation that travels without a
 * worktree, and what it may preselect. A match narrows the default, never
 * the menu: a conversation that belongs somewhere else can always be put
 * there.
 */
export function destinationChoices(preflight: TransferPreflight | null): DestinationChoice {
  if (!preflight) return { matches: [], others: [], auto: '' }
  const matched = new Set(preflight.projectDirs)
  const others = preflight.allProjectDirs.filter((dir) => !matched.has(dir))
  return { matches: preflight.projectDirs, others, auto: preflight.projectDirs.length === 1 ? preflight.projectDirs[0] : '' }
}

/**
 * The checklist rows for a plain conversation. `chosen` is the directory
 * the dialog currently has selected — the resolved one, or the operator's
 * pick.
 */
export function plainChecks(
  project: PlainProject | null,
  preflight: TransferPreflight | null,
  chosen: string,
  targetLabel: string,
  /** The verbs that clone the repository there; empty when it has no origin to clone from. */
  cloneThere: TransferFix[],
  /** What trusting the clone would run, said on the row when the repository declares any. */
  trustDetail = '',
): TransferCheck[] {
  if (!preflight) return []
  // A source too old to describe the conversation, and a directory this
  // desktop could not resolve either: still a plain conversation, still
  // needs somewhere to land.
  const known = project ?? { workingDirectory: '', repoRemote: '', originUrl: '', suggestedParentDir: '' }
  const out: TransferCheck[] = []

  if (preflight.projectDirs.length > 0) {
    out.push(preflight.projectDirs.length > 1
      ? { id: 'repo', state: 'info', label: `${targetLabel} has this repository in more than one place`, detail: 'Choose which checkout the conversation lands in.' }
      : { id: 'repo', state: 'ok', label: `Repository is on ${targetLabel}`, detail: preflight.projectDirs[0] })
  } else if (known.repoRemote) {
    out.push({
      id: 'repo',
      state: 'fixable',
      label: `${known.repoRemote} is not on ${targetLabel}`,
      detail: trustDetail ? `The conversation lands in the clone. ${trustDetail}` : 'Clone it there and the conversation lands in it.',
      ...(cloneThere.length > 0 ? { fixes: cloneThere } : {}),
    })
    return out
  } else {
    out.push({
      id: 'repo',
      state: 'info',
      label: 'This conversation belongs to no registered project',
      detail: known.workingDirectory
        ? `${known.workingDirectory} is not in a project with an origin, so there is nothing to resolve it by on ${targetLabel}.`
        : `There is nothing to resolve it by on ${targetLabel}.`,
    })
  }

  out.push(chosen
    ? { id: 'lands', state: 'ok', label: 'Lands in', detail: chosen }
    : { id: 'lands', state: 'blocked', label: `Choose where it lands on ${targetLabel}`, detail: 'A conversation is filed under its directory, so it needs one that exists there.' })
  return out
}
