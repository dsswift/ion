/**
 * Pins the list markers in rendered markdown.
 *
 * Tailwind's preflight sets `list-style: none` on every ul and ol. Every
 * markdown surface renders inside `.prose-cloud`, so that class must restore
 * bullets and numbers or lists show as bare indented text. This test reads the
 * shared stylesheet the same way the idle-animation test does.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

const raw = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8')
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')
  const match = css.match(new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^}]*)\\}`))
  expect(match, `${selector} rule must exist`).not.toBeNull()
  return match![1]
}

describe('index.css prose lists', () => {
  it('restores bullets on unordered lists at each nesting level', () => {
    expect(ruleBody('.prose-cloud ul')).toMatch(/list-style-type:\s*disc/)
    expect(ruleBody('.prose-cloud ul ul')).toMatch(/list-style-type:\s*circle/)
    expect(ruleBody('.prose-cloud ul ul ul')).toMatch(/list-style-type:\s*square/)
  })

  it('restores numbers on ordered lists', () => {
    expect(ruleBody('.prose-cloud ol')).toMatch(/list-style-type:\s*decimal/)
  })

  it('keeps GFM task lists free of bullets', () => {
    expect(ruleBody('.prose-cloud ul.contains-task-list')).toMatch(/list-style-type:\s*none/)
  })

  it('sizes h5 and h6, which preflight resets to body text', () => {
    expect(ruleBody('.prose-cloud h5')).toMatch(/font-size:/)
    expect(ruleBody('.prose-cloud h6')).toMatch(/font-size:/)
  })
})
