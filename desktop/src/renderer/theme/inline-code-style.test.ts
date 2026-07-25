import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Regression guard for "inline code should not be accent-colored" (the
 * too-much-blue prose fix). Inline `code` spans in assistant/prose markdown
 * must render as a neutral chip — the accent color is reserved for genuine
 * accents (links, focus), not smattered across every backticked token.
 *
 * We assert on the actual CSS rule text because that rule (`.prose-cloud code`)
 * is where the color is decided; a unit render test can't observe the
 * stylesheet-driven color in jsdom.
 */

const CSS = readFileSync(join(__dirname, '..', 'index.css'), 'utf8')

/** Extract the declaration body of a single CSS rule by exact selector. */
function ruleBody(selector: string): string {
  const start = CSS.indexOf(`${selector} {`)
  expect(start, `rule "${selector}" must exist`).toBeGreaterThanOrEqual(0)
  const open = CSS.indexOf('{', start)
  const close = CSS.indexOf('}', open)
  return CSS.slice(open + 1, close)
}

describe('inline code prose styling', () => {
  it('uses the neutral inline-code chip token, not the accent tint', () => {
    const body = ruleBody('.prose-cloud code')
    expect(body).toContain('var(--ion-inline-code-bg)')
    // The accent tokens must NOT appear — that was the too-much-blue bug.
    expect(body).not.toContain('--ion-accent')
  })

  it('renders inline code in the primary text color (neutral), not accent', () => {
    const body = ruleBody('.prose-cloud code')
    expect(body).toContain('color: var(--ion-text-primary)')
  })
})
