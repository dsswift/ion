// @vitest-environment jsdom
/**
 * Pins the live-updates notice: absent while every root is watched, the
 * point-in-time text when the watcher module is missing, and the per-root
 * count when only some roots failed.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GraphWatchChip, watchChipText } from './GraphWatchChip'
import { useGraphStore } from './graph-store'
import type { CorpusRootStatus, CorpusSnapshot, CorpusWatchState } from '../../../shared/graph-corpus-types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function snapshot(roots: CorpusRootStatus[], watchState?: CorpusWatchState): CorpusSnapshot {
  return { revision: 1, roots, documents: [], ...(watchState ? { watchState } : {}) }
}

function mount(): void {
  act(() => {
    root.render(<GraphWatchChip />)
  })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useGraphStore.setState({ watchState: null, snapshot: null })
})

describe('GraphWatchChip', () => {
  it('renders nothing while every root is watched', () => {
    useGraphStore.setState({ watchState: 'watching', snapshot: snapshot([{ path: '/a', exists: true, documentCount: 1, watch: 'watching' }], 'watching') })
    mount()
    expect(host.textContent).toBe('')
  })

  it('names the point-in-time read when the watcher module is unavailable', () => {
    useGraphStore.setState({ watchState: 'unavailable', snapshot: snapshot([{ path: '/a', exists: true, documentCount: 1 }], 'unavailable') })
    mount()
    expect(host.textContent).toContain('Live updates off — point-in-time read')
  })

  it('counts the failed roots when the watch is partial', () => {
    const roots: CorpusRootStatus[] = [
      { path: '/a', exists: true, documentCount: 1, watch: 'watching' },
      { path: '/b', exists: true, documentCount: 1, watch: 'failed', label: 'Bundles' },
      { path: '/c', exists: true, documentCount: 1, watch: 'failed' },
    ]
    useGraphStore.setState({ watchState: 'partial', snapshot: snapshot(roots, 'partial') })
    mount()
    expect(host.textContent).toContain('Live updates off for 2 of 3 roots')
  })

  it('watchChipText lists failed roots by label, falling back to path', () => {
    const { detail } = watchChipText('partial', [
      { path: '/a', exists: true, documentCount: 0, watch: 'watching' },
      { path: '/b', exists: true, documentCount: 0, watch: 'failed', label: 'Bundles' },
      { path: '/c', exists: true, documentCount: 0, watch: 'failed' },
    ])
    expect(detail).toBe('Bundles, /c')
  })
})
