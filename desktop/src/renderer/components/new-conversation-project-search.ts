import { isAbsolutePath, joinPath, pathDirname } from '@ion/shared/paths'

export interface DirectoryBrowseQuery {
  parentPath: string
  filter: string
  hasTrailingSeparator: boolean
}

/** True when the input explicitly addresses a directory instead of a project. */
export function isDirectoryBrowseQuery(query: string): boolean {
  const value = query.trim()
  return value === '~' || value.startsWith('~/') || isAbsolutePath(value)
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

  const hasTrailingSeparator = /[\\/]$/.test(value)
  const withoutTrailingSeparator = hasTrailingSeparator ? value.slice(0, -1) : value
  const separator = Math.max(withoutTrailingSeparator.lastIndexOf('/'), withoutTrailingSeparator.lastIndexOf('\\'))

  if (hasTrailingSeparator) {
    return { parentPath: withoutTrailingSeparator || '/', filter: '', hasTrailingSeparator: true }
  }
  if (separator === -1) return null
  if (withoutTrailingSeparator === '~') return { parentPath: '~', filter: '', hasTrailingSeparator: false }

  const parentPath = pathDirname(withoutTrailingSeparator)
  return {
    parentPath: parentPath === '' ? '/' : parentPath,
    filter: withoutTrailingSeparator.slice(separator + 1),
    hasTrailingSeparator: false,
  }
}

/** Append one directory name to an engine-returned absolute path. */
export function joinDirectoryPath(parentPath: string, name: string): string {
  return parentPath === '/' ? `/${name}` : joinPath(parentPath.replace(/[\\/]+$/, ''), name)
}

/**
 * Narrow the loaded projects to a search, preserving the caller's order. The
 * picker orders explicitly afterwards (`new-conversation-project-order.ts`),
 * so this never imposes one of its own.
 */
export function filterProjects<T extends { displayName: string; dir: string }>(
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
