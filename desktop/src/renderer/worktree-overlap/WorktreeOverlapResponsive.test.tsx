// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeOverlapAnalysis, WorktreeOverlapSolverResult } from '../../shared/types-worktree-overlap'
import { WorktreeOverlapApp } from './WorktreeOverlapApp'
import { TWO_COLUMN_MIN_WIDTH } from './useResponsiveAnalysisLayout'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  readonly observe = vi.fn()
  readonly disconnect = vi.fn()

  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }

  resize(target: Element, width: number): void {
    this.callback([{
      target,
      contentRect: { width } as DOMRectReadOnly,
    } as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
}

const cohort = {
  kind: 'exact' as const,
  orderedPaths: ['/repo/a'],
  alternatives: [],
  blockers: [],
  pairScope: [],
  prediction: 'clean' as const,
  conflictPaths: [],
}
const solver: WorktreeOverlapSolverResult = {
  constrained: cohort,
  hypothetical: cohort,
  current: cohort,
  keptPaths: [],
}
const analysis: WorktreeOverlapAnalysis = {
  repoPath: '/repo',
  sourceBranch: 'main',
  basis: 'live',
  computedAt: 0,
  incompletePaths: [],
  recommendation: cohort,
  footprints: [{
    worktreePath: '/repo/a',
    branchName: 'a',
    sourceBranch: 'main',
    files: [{ path: 'src/a.ts', kind: 'modified', additions: 1, deletions: 0, hunks: [], layers: ['committed'] }],
    enrolled: true,
    landed: false,
  }],
  pairs: [],
}

vi.mock('../theme', () => ({
  useColors: () => ({
    containerBg: 'canvas',
    containerBorder: 'border',
    textPrimary: 'primary',
    textSecondary: 'secondary',
    textTertiary: 'tertiary',
    dangerFg: 'danger',
    warningFg: 'warning',
    accent: 'accent',
    accentLight: 'accent-light',
    surfacePrimary: 'surface',
    surfaceHover: 'hover',
  }),
}))
vi.mock('../components/git/ConfirmDialog', () => ({ ConfirmDialog: () => null }))

function installIonApi(): void {
  Object.defineProperty(window, 'ion', {
    configurable: true,
    value: {
      getWorktreeOverlap: vi.fn().mockResolvedValue({ analysis }),
      solveWorktreeOverlap: vi.fn().mockResolvedValue({ solver }),
      autoOrderWorktreeOverlap: vi.fn(),
      previewWorktreeOverlapApply: vi.fn(),
      applyWorktreeOverlap: vi.fn(),
    },
  })
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

describe('WorktreeOverlapApp responsive layout', () => {
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let originalResizeObserver: typeof ResizeObserver | undefined

  beforeEach(() => {
    originalResizeObserver = globalThis.ResizeObserver
    ;(globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
    FakeResizeObserver.instances = []
    installIonApi()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver
    else Reflect.deleteProperty(globalThis, 'ResizeObserver')
  })

  it('switches between compact and wide layouts from live container width', async () => {
    await act(async () => { root.render(<WorktreeOverlapApp />) })
    await flush()

    const page = host.querySelector<HTMLElement>('[data-testid="worktree-overlap-page"]')!
    const layout = host.querySelector<HTMLElement>('[data-testid="worktree-overlap-analysis"]')!
    const observer = FakeResizeObserver.instances[0]
    expect(layout.dataset.layout).toBe('one-column')

    act(() => observer.resize(page, TWO_COLUMN_MIN_WIDTH))
    expect(layout.dataset.layout).toBe('two-column')

    act(() => observer.resize(page, TWO_COLUMN_MIN_WIDTH - 1))
    expect(layout.dataset.layout).toBe('one-column')
  })

  it('wraps controls and keeps scrolling inside the page', async () => {
    await act(async () => { root.render(<WorktreeOverlapApp />) })
    await flush()

    const page = host.querySelector<HTMLElement>('[data-testid="worktree-overlap-page"]')!
    const header = host.querySelector<HTMLElement>('[data-testid="worktree-overlap-header"]')!
    const scrollRegion = host.querySelector<HTMLElement>('[data-testid="worktree-overlap-scroll-region"]')!

    expect(header.style.flexWrap).toBe('wrap')
    expect(page.style.overflow).toBe('hidden')
    expect(page.style.maxWidth).toBe('100vw')
    expect(scrollRegion.style.overflowX).toBe('hidden')
    expect(scrollRegion.style.overflowY).toBe('auto')
  })
})
