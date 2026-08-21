/**
 * useWorkspaceRepos — which workspace roots are git repos.
 *
 * gitIsRepo per candidate dir, module-level cache (a dir's repo-ness
 * changes rarely; manual refresh re-checks), re-check on workspace-set
 * change. Non-repos are silently omitted — a notes folder in the
 * workspace is normal, not an error.
 */
import { useEffect, useMemo, useState } from 'react'
import { rDebug } from '../rendererLogger'

/** dir → isRepo. Module-level: survives remounts, shared across hosts. */
const repoCache = new Map<string, boolean>()

/** Test hook / manual refresh: forget everything and re-probe. */
export function clearWorkspaceRepoCache(): void {
  repoCache.clear()
}

export function useWorkspaceRepos(dirs: readonly string[]): { repos: string[]; ready: boolean } {
  const key = dirs.join('\n')
  const [probed, setProbed] = useState<Map<string, boolean>>(() => new Map(repoCache))

  useEffect(() => {
    let alive = true
    const missing = dirs.filter((d) => !repoCache.has(d))
    if (missing.length === 0) {
      setProbed(new Map(repoCache))
      return
    }
    void Promise.all(
      missing.map(async (dir) => {
        try {
          const { isRepo } = await window.ion.gitIsRepo(dir)
          repoCache.set(dir, isRepo)
        } catch (err) {
          rDebug('git', 'gitIsRepo probe failed', { dir, error: String(err) })
          repoCache.set(dir, false)
        }
      }),
    ).then(() => {
      if (alive) setProbed(new Map(repoCache))
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key encodes dirs
  }, [key])

  return useMemo(() => {
    const ready = dirs.every((d) => probed.has(d))
    return { repos: dirs.filter((d) => probed.get(d) === true), ready }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key encodes dirs
  }, [key, probed])
}
