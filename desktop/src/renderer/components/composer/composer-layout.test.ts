import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMPOSER_ROW_EXPAND_HYSTERESIS, resolveComposerRowCollapsed } from './useComposerRowLayout'
import { visibleUserQuickTools } from '@ion/shared/quick-tools-visible'

describe('resolveComposerRowCollapsed', () => {
  it('collapses when the expanded layout does not fit', () => {
    expect(resolveComposerRowCollapsed(false, 400, 520)).toBe(true)
    expect(resolveComposerRowCollapsed(false, 520, 520)).toBe(false)
  })

  it('needs the hysteresis gap before expanding again', () => {
    expect(resolveComposerRowCollapsed(true, 520 + COMPOSER_ROW_EXPAND_HYSTERESIS - 1, 520)).toBe(true)
    expect(resolveComposerRowCollapsed(true, 520 + COMPOSER_ROW_EXPAND_HYSTERESIS, 520)).toBe(false)
  })

  it('keeps the previous answer while nothing is measurable', () => {
    expect(resolveComposerRowCollapsed(true, 0, 520)).toBe(true)
    expect(resolveComposerRowCollapsed(false, 400, 0)).toBe(false)
  })
})

describe('visibleUserQuickTools', () => {
  const tool = (id: string, directories?: string[]) => ({ id, name: id, icon: 'Play', command: 'x', directories })
  it('keeps unscoped tools and tools scoped to the directory or a parent', () => {
    const tools = [tool('all'), tool('in', ['/src/ion']), tool('out', ['/src/other'])]
    expect(visibleUserQuickTools(tools, '/src/ion/desktop').map((t) => t.id)).toEqual(['all', 'in'])
  })
  it('does not match a sibling whose name only starts with the scope', () => {
    expect(visibleUserQuickTools([tool('in', ['/src/ion'])], '/src/ion-other')).toEqual([])
  })
})

describe('the floating composer stack is gone', () => {
  const rendererRoot = resolve(import.meta.dirname, '../..')
  function* sources(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) yield* sources(full)
      else if (/\.(tsx?|css)$/.test(name) && !full.endsWith('composer-layout.test.ts')) yield full
    }
  }
  it('no renderer source names the old stack classes', () => {
    const offenders = [...sources(rendererRoot)].filter((file) => /circles-out|stack-btn|btn-stack/.test(readFileSync(file, 'utf8')))
    expect(offenders).toEqual([])
  })
})
