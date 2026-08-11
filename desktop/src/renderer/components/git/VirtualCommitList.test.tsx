// @vitest-environment jsdom
import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const scrollToIndex = vi.fn()
let virtualized = false

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 4096,
    getVirtualItems: () => virtualized ? [{ index: 0, start: 0 }] : [],
    measureElement: vi.fn(),
    scrollToIndex,
  }),
}))
vi.mock('../../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))
vi.mock('../../GitGraphRow', () => ({
  ROW_HEIGHT: 32,
  GraphRow: ({ node }: { node: { commit: { hash: string } } }) => <div>{node.commit.hash}</div>,
}))
vi.mock('../CommitDetailsPane', () => ({ CommitDetailsPane: () => null }))

import { VirtualCommitList } from './VirtualCommitList'
import type { GitGraphNode } from '../../utils/gitGraphLayout'

const node = (index: number): GitGraphNode => ({
  commit: {
    hash: `short-${index}`,
    fullHash: `commit-${index}`,
    parents: [],
    authorName: '',
    authorDate: '2026-01-01T00:00:00Z',
    subject: `commit ${index}`,
    refs: [],
  },
  lane: 0,
  color: '#000000',
  hasIncoming: false,
  connections: [],
  passThroughLanes: [],
})

let container: HTMLDivElement
let root: Root
let scrollElement: HTMLDivElement

beforeEach(() => {
  vi.clearAllMocks()
  virtualized = false
  scrollElement = document.createElement('div')
  container = scrollElement
  Object.defineProperties(scrollElement, {
    scrollTop: { value: 20, writable: true },
    scrollTo: { value: vi.fn(({ top }: ScrollToOptions) => { scrollElement.scrollTop = top ?? 0 }) },
  })
  vi.spyOn(scrollElement, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 10, 300, 200))
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(nodes: GitGraphNode[], focusKey?: string): void {
  act(() => {
    root.render(
      <VirtualCommitList
        graphNodes={nodes}
        expandedHash={null}
        commitDetail={null}
        commitFiles={[]}
        scrollRef={{ current: scrollElement }}
        focusRequest={focusKey ? { key: focusKey, index: 1 } : null}
        onHover={() => {}}
        onLeave={() => {}}
        onContextMenu={() => {}}
        onClick={() => {}}
        onFileClick={() => {}}
      />,
    )
  })
}

describe('VirtualCommitList focus requests', () => {
  it('centers a rendered row from measured geometry', () => {
    render([node(0), node(1), node(2)])
    const target = container.querySelector('[data-git-graph-index="1"]') as HTMLElement
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 80, 300, 32))

    render([node(0), node(1), node(2)], 'base-conversation')

    expect(scrollElement.scrollTo).toHaveBeenCalledWith({ top: 6, behavior: 'smooth' })
  })

  it('focuses again for a different active conversation request', () => {
    render([node(0), node(1), node(2)])
    const target = container.querySelector('[data-git-graph-index="1"]') as HTMLElement
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 120, 300, 32))

    render([node(0), node(1), node(2)], 'conversation-a')
    render([node(0), node(1), node(2)], 'conversation-b')

    expect(scrollElement.scrollTo).toHaveBeenCalledTimes(2)
  })

  it('uses virtualizer centering for long graphs', () => {
    virtualized = true
    render(Array.from({ length: 80 }, (_, index) => node(index)), 'worktree-conversation')

    expect(scrollToIndex).toHaveBeenCalledWith(1, { align: 'center' })
  })
})
