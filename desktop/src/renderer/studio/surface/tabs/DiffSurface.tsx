/**
 * DiffSurface — Diff singleton: stacked all-file diffs for current
 * conversation checkout, with reveal-and-scroll from active-repo git clicks.
 *
 * Repository binding never enters surface state. `workingDirectory` from active
 * conversation is sole checkout identity, so a workspace-repo click cannot
 * leave the singleton rendering another conversation's changes.
 */
import React, { useEffect, useMemo, useRef } from 'react'
import { useSessionStore } from '../../../stores/sessionStore'
import { useGitRepo } from '../../../hooks/useGitRepo'
import { useRepoState } from '../../../stores/git'
import { useSurfaceStore } from '../surface-store'
import { useStackedDiffs } from './useStackedDiffs'
import { StackedDiffFile } from './StackedDiffFile'
import { useColors } from '../../../theme'
import { rDebug } from '../../../rendererLogger'
import type { GitChangedFile } from '../../../../shared/types'

export function DiffSurface(): React.JSX.Element {
  const colors = useColors()
  const activeDir = useSessionStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    const dir = tab?.workingDirectory
    return dir && dir !== '~' ? dir : null
  })
  const reveal = useSurfaceStore((s) => s.diffReveal)
  const repoDir = activeDir

  useGitRepo(repoDir ?? undefined, repoDir != null)
  const repoState = useRepoState(repoDir ?? undefined)
  const revision = repoState?.revision ?? 0
  const { diffs, fetchDiff } = useStackedDiffs(repoDir ?? '', revision)

  const files = useMemo<GitChangedFile[]>(() => {
    const groups = repoState?.groups
    if (!groups) return []
    return [...groups.index, ...groups.workingTree, ...groups.merge, ...groups.untracked]
  }, [repoState?.groups])

  const containerRef = useRef<HTMLDivElement | null>(null)
  const revealedNonceRef = useRef<number | null>(null)
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const el = entry.target as HTMLElement
          const path = el.dataset.diffPath
          const staged = el.dataset.diffStaged === '1'
          if (path) fetchDiff(path, staged)
        }
      },
      { root: container, rootMargin: '200px' },
    )
    for (const section of container.querySelectorAll('section[data-diff-path]')) observer.observe(section)
    return () => observer.disconnect()
  }, [files, fetchDiff])

  useEffect(() => {
    if (!reveal || revealedNonceRef.current === reveal.nonce) return
    revealedNonceRef.current = reveal.nonce
    const scroll = (): boolean => {
      const escaped = reveal.filePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const selector = `section[data-diff-path="${escaped}"][data-diff-staged="${reveal.staged ? '1' : '0'}"]`
      const el = containerRef.current?.querySelector(selector)
      if (el) {
        el.scrollIntoView({ block: 'start', behavior: 'smooth' })
        return true
      }
      return false
    }
    fetchDiff(reveal.filePath, reveal.staged)
    if (!scroll()) {
      const timer = setTimeout(() => {
        if (!scroll()) rDebug('studio.diff', 'reveal target never rendered', { path: reveal.filePath, staged: reveal.staged })
      }, 400)
      return () => clearTimeout(timer)
    }
  }, [reveal, fetchDiff])

  const refresh = (): void => {
    if (repoDir) {
      window.ion.gitRefresh(repoDir).catch((err) => rDebug('git', 'gitRefresh failed', { directory: repoDir, error: String(err) }))
    }
  }

  if (!repoDir) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.textTertiary, fontSize: 12, fontFamily: 'system-ui, sans-serif' }}>
        No repository for the active conversation.
      </div>
    )
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 10px',
          borderBottom: `1px solid ${colors.containerBorder}`,
          fontSize: 11,
          fontFamily: 'system-ui, sans-serif',
          color: colors.textTertiary,
          flexShrink: 0,
        }}
      >
        <span style={{ fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {repoDir.split('/').pop()}
        </span>
        <span>{files.length} changed {files.length === 1 ? 'file' : 'files'}</span>
      </div>
      <div ref={containerRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {files.length === 0 ? (
          <div style={{ padding: 16, color: colors.textTertiary, fontSize: 12, fontFamily: 'system-ui, sans-serif' }}>
            Working tree clean.
          </div>
        ) : (
          files.map((file) => {
            const entry = diffs.get(`${file.path}:${file.staged}`)
            return (
              <StackedDiffFile
                key={`${file.path}:${file.staged ? 's' : 'u'}`}
                repoDir={repoDir}
                file={file}
                diff={entry?.diff ?? ''}
                diffState={entry?.state ?? 'loading'}
                isBinary={entry?.isBinary ?? false}
                onRefresh={refresh}
              />
            )
          })
        )}
      </div>
    </div>
  )
}
