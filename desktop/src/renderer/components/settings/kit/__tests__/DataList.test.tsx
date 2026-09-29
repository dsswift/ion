// @vitest-environment jsdom
/**
 * DataList — every Settings list. A short list is plain rows; a long one
 * gains a filter and draws only the rows on screen, so a machine with
 * hundreds of projects costs what one with twenty does.
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../../theme', () => ({ useColors: () => new Proxy({}, { get: () => '#000000' }) }))

import { DataList } from '../DataList'

let root: Root | null = null
let host: HTMLDivElement
afterEach(() => { act(() => root?.unmount()); root = null; host?.remove() })

function render(count: number, onRowClick?: (n: string) => void): HTMLDivElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const items = Array.from({ length: count }, (_, i) => `project-${i}`)
  act(() => root!.render(
    <DataList label="Projects" items={items} getKey={(i) => i} noun={['project', 'projects']} filter={(i, q) => i.includes(q)} onRowClick={onRowClick} columns={[{ id: 'name', render: (i) => i }]} />,
  ))
  return host
}

const rows = (el: HTMLElement) => el.querySelectorAll('[role="listitem"]')

describe('DataList', () => {
  it('shows every row of a short list, a count, and no filter', () => {
    const el = render(3)
    expect(rows(el)).toHaveLength(3)
    expect(el.textContent).toContain('3 projects')
    expect(el.querySelector('input[aria-label="Filter Projects"]')).toBeNull()
  })

  it('offers a filter once the list is long, and counts what matches', () => {
    const el = render(20)
    const input = el.querySelector<HTMLInputElement>('input[aria-label="Filter Projects"]')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'project-1')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(rows(el)).toHaveLength(11)
    expect(el.textContent).toContain('11 of 20 projects')
  })

  it('draws only the rows on screen for a very long list', () => {
    const el = render(500)
    expect(rows(el).length).toBeLessThan(100)
    expect(el.textContent).toContain('500 projects')
  })

  it('opens an item on click and on Enter', () => {
    const opened: string[] = []
    const el = render(2, (i) => opened.push(i))
    const [first, second] = Array.from(rows(el)) as HTMLElement[]
    act(() => first.click())
    act(() => { second.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(opened).toEqual(['project-0', 'project-1'])
  })
})
