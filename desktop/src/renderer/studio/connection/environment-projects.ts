/**
 * environment-projects — the union of every connected environment's project
 * registry, for the new-conversation picker (ADR-033 union store). One
 * `environment.projects.list` per environment, re-listed when that
 * environment announces `ion:projects-changed`, and the pure grouping that
 * turns the union into picker rows: the same repository on several
 * machines is one row with a chip per machine that has it.
 */
import { useEffect, useState } from 'react'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import type { EnvironmentProject } from '@ion/shared/types-environment-admin'
import { PROJECTS_CHANGED_CHANNEL } from '@ion/shared/types-environment-admin'
import type { EnvironmentCatalogEntry } from '@ion/shared/types-environments'
import type { EffectiveProjectEntry } from '@ion/shared/project-registry'
import { environmentClient, onEnvironmentEvent } from '../../components/settings/environment/environment-client'
import { rDebug, rWarn } from '../../rendererLogger'

export type ProjectsByEnvironment = Record<string, EnvironmentProject[]>

/** Lists projects on every catalog environment; an unreachable one contributes an empty list and is logged. */
export function useProjectsByEnvironment(catalog: EnvironmentCatalogEntry[]): ProjectsByEnvironment {
  const [byEnv, setByEnv] = useState<ProjectsByEnvironment>({})
  const ids = catalog.map((e) => e.id).join('|')
  useEffect(() => {
    if (!ids) return
    let cancelled = false
    const offs: Array<() => void> = []
    const load = (env: string): void => {
      environmentClient.listProjects(env).then((list) => { if (!cancelled) setByEnv((prev) => ({ ...prev, [env]: list })) }).catch((err: unknown) => {
        rWarn('environment-projects', 'list failed', { environment_id: env, error: String(err) })
        if (!cancelled) setByEnv((prev) => ({ ...prev, [env]: prev[env] ?? [] }))
      })
    }
    for (const env of ids.split('|')) {
      load(env)
      offs.push(onEnvironmentEvent(env, PROJECTS_CHANGED_CHANNEL, () => load(env)))
    }
    return () => { cancelled = true; for (const off of offs) off() }
  }, [ids])
  return byEnv
}

/** One place a repository is checked out: an environment and the project entry there (local rows keep their preference-derived profile fields). */
export interface ProjectHolder {
  environmentId: string
  label: string
  entry: EffectiveProjectEntry
  /**
   * How often work has started in this checkout, as recorded by the machine
   * that holds it (`directoryUsageCounts` there). Zero when that machine has
   * never recorded one -- never a guess, so a picker ordering by it is
   * ordering by real use.
   */
  usageCount: number
}

/**
 * One picker row per repository across every environment. `holders` are
 * the machines that have it, in catalog order, and they are the only
 * machines a conversation for it can be opened on: a machine that lacks the
 * repository is not offered, because the project has to be established
 * there first (Settings, Environments). A project with no repository
 * identity (no origin) is one row per machine.
 */
export interface MergedProjectRow {
  key: string
  displayName: string
  /** The first holder's directory: what the search matches beside the name. */
  dir: string
  repoRemote?: string
  holders: ProjectHolder[]
}

function groupKey(environmentId: string, repoRemote: string | undefined, dir: string): string {
  return repoRemote ? `remote:${repoRemote}` : `path:${environmentId}:${dir}`
}

/**
 * Merges every environment's projects into one list of repositories.
 *
 * `local` is the local environment's rows as the picker renders them (the
 * preference-derived `effectiveProjects`, which carry the default-project
 * star and profile routing). That copy can lack the repository identity the
 * server stamps lazily on its own listing, so the identity is backfilled by
 * directory from `byEnvironment.local` before grouping -- without it the
 * same repository on two machines grouped under two keys and showed twice.
 * Local rows come first in their own order; other environments' repositories
 * follow in catalog order.
 */
export function buildMergedProjects(args: {
  local: EffectiveProjectEntry[]
  byEnvironment: ProjectsByEnvironment
  catalog: Array<{ id: string; label: string }>
  /** This machine's own `directoryUsageCounts`; a remote row reads its count off the listing instead. */
  localUsage?: Readonly<Record<string, number>>
}): MergedProjectRow[] {
  const { local, byEnvironment, catalog, localUsage = {} } = args
  const labelOf = (id: string): string => catalog.find((e) => e.id === id)?.label ?? id
  const rows = new Map<string, MergedProjectRow>()
  const add = (environmentId: string, entry: EffectiveProjectEntry, usageCount: number): void => {
    const key = groupKey(environmentId, entry.entry.repoRemote, entry.dir)
    const row = rows.get(key) ?? { key, displayName: entry.displayName, dir: entry.dir, repoRemote: entry.entry.repoRemote, holders: [] }
    if (!row.holders.some((h) => h.environmentId === environmentId)) row.holders.push({ environmentId, label: labelOf(environmentId), entry, usageCount })
    rows.set(key, row)
  }

  const localListing = new Map((byEnvironment[LOCAL_ENVIRONMENT_ID] ?? []).map((p) => [p.dir, p]))
  for (const entry of local) {
    const listed = localListing.get(entry.dir)
    const backfilled = !entry.entry.repoRemote && listed?.entry.repoRemote ? { ...entry, entry: { ...entry.entry, repoRemote: listed.entry.repoRemote } } : entry
    if (backfilled !== entry) rDebug('environment-projects', 'repo identity backfilled from the local listing', { dir: entry.dir, repo_remote: listed?.entry.repoRemote ?? '' })
    add(LOCAL_ENVIRONMENT_ID, backfilled, localUsage[entry.dir] ?? 0)
  }
  for (const env of catalog) {
    if (env.id === LOCAL_ENVIRONMENT_ID) continue
    for (const project of byEnvironment[env.id] ?? []) {
      add(env.id, { dir: project.dir, displayName: project.displayName, entry: project.entry, managed: false, profileAction: 'ask' }, project.usageCount ?? 0)
    }
  }

  const out = [...rows.values()]
  for (const row of out) row.holders.sort((a, b) => catalog.findIndex((e) => e.id === a.environmentId) - catalog.findIndex((e) => e.id === b.environmentId))
  rDebug('environment-projects', 'projects merged across environments', { environments: catalog.length, rows: out.length, shared: out.filter((r) => r.holders.length > 1).length })
  return out
}

/**
 * The machine a plain click on a row opens the conversation on: this
 * machine when it has the repository, else the first machine that does.
 * Deliberately independent of the active tab, so looking at a conversation
 * on another machine never moves where new work starts.
 */
export function defaultRowEnvironment(row: MergedProjectRow): string {
  if (row.holders.some((h) => h.environmentId === LOCAL_ENVIRONMENT_ID)) return LOCAL_ENVIRONMENT_ID
  return row.holders[0]?.environmentId ?? LOCAL_ENVIRONMENT_ID
}

/** The machines a row can be opened on, in catalog order. */
export function rowEnvironments(row: MergedProjectRow): string[] {
  return row.holders.map((h) => h.environmentId)
}
