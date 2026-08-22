/**
 * useStackedDiffs — lazy per-file diff text for the Diff surface tab.
 *
 * Every job captures its repository and binding generation. A late response from
 * another conversation or revision is ignored, and an old completion can never
 * drain new work through an obsolete repository closure.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { rDebug } from '../../../rendererLogger'

interface DiffEntry {
  state: 'loading' | 'ready' | 'error'
  isBinary: boolean
  diff: string
}

interface DiffJob {
  key: string
  filePath: string
  staged: boolean
  repoDir: string
  bindingKey: string
  generation: number
}

interface Binding {
  key: string
  generation: number
}

const MAX_CONCURRENT = 4

export function useStackedDiffs(repoDir: string, revision: number): {
  diffs: Map<string, DiffEntry>
  /** Request a file's diff (idempotent within current repository revision). */
  fetchDiff: (filePath: string, staged: boolean) => void
} {
  const [diffs, setDiffs] = useState<Map<string, DiffEntry>>(new Map())
  const cacheRef = useRef<Map<string, DiffEntry>>(new Map())
  const queueRef = useRef<DiffJob[]>([])
  const inFlightRef = useRef(0)
  const bindingRef = useRef<Binding>({ key: '', generation: 0 })
  const bindingKey = `${repoDir}:${revision}`

  const pumpRef = useRef<() => void>(() => undefined)
  pumpRef.current = () => {
    while (inFlightRef.current < MAX_CONCURRENT && queueRef.current.length > 0) {
      const job = queueRef.current.shift()!
      const activeBinding = bindingRef.current
      if (job.generation !== activeBinding.generation || job.bindingKey !== activeBinding.key) {
        rDebug('studio.diff', 'discarded queued diff from stale binding', {
          file_path: job.filePath,
          generation: job.generation,
          repo_directory: job.repoDir,
        })
        continue
      }

      inFlightRef.current++
      rDebug('studio.diff', 'requested file diff', {
        file_path: job.filePath,
        generation: job.generation,
        repo_directory: job.repoDir,
        staged: job.staged,
      })
      window.ion
        .gitDiff(job.repoDir, job.filePath, job.staged)
        .then((data) => {
          const current = bindingRef.current
          if (job.generation !== current.generation || job.bindingKey !== current.key) {
            rDebug('studio.diff', 'discarded stale diff response', {
              file_path: job.filePath,
              generation: job.generation,
              repo_directory: job.repoDir,
              staged: job.staged,
            })
            return
          }
          const entry: DiffEntry = { state: 'ready', diff: data.diff, isBinary: data.isBinary }
          cacheRef.current.set(job.key, entry)
          setDiffs(new Map(cacheRef.current))
          rDebug('studio.diff', 'received file diff', {
            file_path: job.filePath,
            generation: job.generation,
            repo_directory: job.repoDir,
            staged: job.staged,
          })
        })
        .catch((err) => {
          const current = bindingRef.current
          if (job.generation !== current.generation || job.bindingKey !== current.key) {
            rDebug('studio.diff', 'discarded stale diff failure', {
              error: String(err),
              file_path: job.filePath,
              generation: job.generation,
              repo_directory: job.repoDir,
              staged: job.staged,
            })
            return
          }
          rDebug('studio.diff', 'gitDiff fetch failed', {
            error: String(err),
            file_path: job.filePath,
            generation: job.generation,
            repo_directory: job.repoDir,
            staged: job.staged,
          })
          cacheRef.current.set(job.key, { state: 'error', diff: '', isBinary: false })
          setDiffs(new Map(cacheRef.current))
        })
        .finally(() => {
          inFlightRef.current--
          pumpRef.current()
        })
    }
  }

  useEffect(() => {
    const previous = bindingRef.current
    if (previous.key === bindingKey) return
    const next: Binding = { key: bindingKey, generation: previous.generation + 1 }
    bindingRef.current = next
    cacheRef.current = new Map()
    queueRef.current = []
    setDiffs(new Map())
    rDebug('studio.diff', 'changed diff binding', {
      generation: next.generation,
      repo_directory: repoDir,
      revision,
    })
  }, [bindingKey, repoDir, revision])

  const fetchDiff = useCallback((filePath: string, staged: boolean) => {
    const binding = bindingRef.current
    if (binding.key !== bindingKey) {
      rDebug('studio.diff', 'ignored diff request before binding update', {
        file_path: filePath,
        repo_directory: repoDir,
        staged,
      })
      return
    }
    const key = `${filePath}:${staged}`
    if (cacheRef.current.has(key)) return
    cacheRef.current.set(key, { state: 'loading', diff: '', isBinary: false })
    setDiffs(new Map(cacheRef.current))
    queueRef.current.push({ key, filePath, staged, repoDir, bindingKey, generation: binding.generation })
    pumpRef.current()
  }, [bindingKey, repoDir])

  return { diffs, fetchDiff }
}
