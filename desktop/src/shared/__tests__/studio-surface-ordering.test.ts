import { describe, expect, it } from 'vitest'
import { closeOthersTargets, closeToRightTargets, composeTabs, nextActiveAfterClose, nextTerminalTitle, normalizeTabs } from '../studio-surface-ordering'
import type { SurfaceTab } from '../studio-surface-types'

const diff: SurfaceTab = { kind: 'singleton', id: 'diff' }
const plan: SurfaceTab = { kind: 'singleton', id: 'plan' }
const viz: SurfaceTab = { kind: 'singleton', id: 'visualizer' }
const fileA: SurfaceTab = { kind: 'file', id: 'file:/a.ts', filePath: '/a.ts', dir: '/repo' }
const fileB: SurfaceTab = { kind: 'file', id: 'file:/b.ts', filePath: '/b.ts', dir: '/repo' }
const term: SurfaceTab = { kind: 'terminal', id: 'terminal:t1', instanceId: 't1', cwd: '/', title: 'Terminal 1' }

describe('surface ordering', () => {
  it('orders local singletons before dynamic tabs', () => {
    expect(normalizeTabs([fileA, viz, term, diff, plan]).map((tab) => tab.id)).toEqual(['diff', 'plan', 'visualizer', 'file:/a.ts', 'terminal:t1'])
  })

  it('composes global pins before conversation-local descriptors and deduplicates them', () => {
    expect(composeTabs(['plan', 'visualizer'], [plan, diff, fileA]).map((tab) => tab.id)).toEqual(['plan', 'visualizer', 'diff', 'file:/a.ts'])
  })

  it('only protects true global pins when closing', () => {
    const tabs = composeTabs(['plan'], [diff, fileA, fileB, term])
    expect(closeOthersTargets(tabs, 'file:/a.ts', ['plan']).map((tab) => tab.id)).toEqual(['diff', 'file:/b.ts', 'terminal:t1'])
    expect(closeToRightTargets(tabs, 'diff', ['plan']).map((tab) => tab.id)).toEqual(['file:/a.ts', 'file:/b.ts', 'terminal:t1'])
  })

  it('chooses right then left after close', () => {
    expect(nextActiveAfterClose([diff, fileA, fileB], 'file:/a.ts')).toBe('file:/b.ts')
    expect(nextActiveAfterClose([diff, fileA], 'file:/a.ts')).toBe('diff')
  })

  it('numbers terminals after the current highest live suffix', () => {
    expect(nextTerminalTitle([term, { ...term, id: 'terminal:t5', title: 'Terminal 5' }])).toBe('Terminal 6')
  })
})
