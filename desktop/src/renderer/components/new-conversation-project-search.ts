import type { EffectiveProjectEntry, ProjectDisplayEntry } from '../../shared/project-registry'

export interface DirectoryBrowseQuery {
  parentPath: string
  filter: string
  hasTrailingSeparator: boolean
}

/** True when the input explicitly addresses a directory instead of a project. */
export function isDirectoryBrowseQuery(query: string): boolean {
  const value = query.trim()
  return value === '~' || value.startsWith('~/') || value.startsWith('/')
}

/**
 * Split an absolute or home-relative directory search into the parent to list
 * and the final segment used to filter its directory entries.
 */
export function parseDirectoryBrowseQuery(query: string): DirectoryBrowseQuery | null {
  const value = query.trim()
  if (!isDirectoryBrowseQuery(value)) return null

  if (value === '~') return { parentPath: '~', filter: '', hasTrailingSeparator: false }
  if (value === '/') return { parentPath: '/', filter: '', hasTrailingSeparator: true }

  const hasTrailingSeparator = value.endsWith('/')
  const withoutTrailingSeparator = hasTrailingSeparator ? value.slice(0, -1) : value
  const separator = withoutTrailingSeparator.lastIndexOf('/')

  if (hasTrailingSeparator) {
    return { parentPath: withoutTrailingSeparator || '/', filter: '', hasTrailingSeparator: true }
  }
  if (separator === -1) return null
  if (withoutTrailingSeparator === '~') return { parentPath: '~', filter: '', hasTrailingSeparator: false }

  const parentPath = separator === 0 ? '/' : withoutTrailingSeparator.slice(0, separator)
  return {
    parentPath: parentPath === '' ? '/' : parentPath,
    filter: withoutTrailingSeparator.slice(separator + 1),
    hasTrailingSeparator: false,
  }
}

/** Append one directory name to an engine-returned absolute path. */
export function joinDirectoryPath(parentPath: string, name: string): string {
  return parentPath === '/' ? `/${name}` : `${parentPath.replace(/\/+$/, '')}/${name}`
}

/** Keep matching loaded projects in their supplied (normally recency) order. */
export function filterProjects<T extends ProjectDisplayEntry | EffectiveProjectEntry>(
  projects: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return [...projects]
  return projects.filter((project) =>
    project.displayName.toLocaleLowerCase().includes(needle) ||
    project.dir.toLocaleLowerCase().includes(needle),
  )
}

/** Directory names are prefix-filtered because the query describes one path segment. */
export function filterDirectoryNames(names: readonly string[], query: string): string[] {
  const needle = query.toLocaleLowerCase()
  return names.filter((name) => name.toLocaleLowerCase().startsWith(needle))
}
