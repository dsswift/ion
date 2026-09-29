// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { findTextRanges, FIND_SKIP_ATTR } from '../useDomFind'

function mount(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

afterEach(() => { document.body.innerHTML = '' })

describe('findTextRanges', () => {
  it('finds every case-insensitive occurrence and never rewrites the DOM', () => {
    const root = mount('<p>Grafana principal and GRAFANA again</p>')
    const before = root.innerHTML
    const ranges = findTextRanges(root, 'grafana')
    expect(ranges.map((r) => r.toString())).toEqual(['Grafana', 'GRAFANA'])
    expect(root.innerHTML).toBe(before)
  })

  it('matches across inline runs such as syntax-highlighted tokens', () => {
    const root = mount('<div><span class="tok">cloudops_</span><span class="tok">grafana</span>.id</div>')
    const ranges = findTextRanges(root, 'cloudops_grafana.id')
    expect(ranges).toHaveLength(1)
    expect(ranges[0].toString()).toBe('cloudops_grafana.id')
  })

  it('never joins two blocks into one match', () => {
    const root = mount('<div>foo</div><div>bar</div>')
    expect(findTextRanges(root, 'foobar')).toEqual([])
    expect(findTextRanges(root, 'bar')).toHaveLength(1)
  })

  it('skips hidden content and the find bar itself', () => {
    const root = mount(`<p style="display:none">needle</p><div ${FIND_SKIP_ATTR}><input value="needle">needle</div><p>needle</p>`)
    expect(findTextRanges(root, 'needle')).toHaveLength(1)
  })

  it('returns nothing for an empty query', () => {
    expect(findTextRanges(mount('<p>text</p>'), '')).toEqual([])
  })
})
