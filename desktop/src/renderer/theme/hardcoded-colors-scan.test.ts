import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Structural gate for the "never hardcode color values" renderer rule
 * (CLAUDE.md): every color literal in component code must come from the
 * theme palette via useColors() / --ion-* CSS vars.
 *
 * A literal that is genuinely theme-neutral (pure-black scrim, provider
 * brand color, value computed from runtime data) may stay, but only with
 * an explicit same-line escape hatch:
 *
 *   // hardcoded-ok: <reason>       (or the block-comment form in JSX)
 *
 * mirroring the repo's nolint / silent-ok conventions: the exception is
 * visible, reasoned, and reviewed.
 */

const RENDERER_ROOT = join(__dirname, '..')
const SCAN_ROOTS = [join(RENDERER_ROOT, 'components'), join(RENDERER_ROOT, 'App.tsx')]

// Hex colors (#fff, #ffffff, #ffffff80) and functional notations.
// Word-boundary keeps css-id-like strings ('#root') from matching; 3-4 digit
// sequences must contain a hex letter so issue references (#256, #4538) in
// comments don't false-positive. All-digit 6+ hex colors still match.
const COLOR_LITERAL = /#[0-9a-fA-F]{6,8}\b|#(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{3,4}\b|\brgba?\(|\bhsla?\(/

const ESCAPE_TAG = 'hardcoded-ok:'

function collectSources(path: string): string[] {
  const st = statSync(path)
  if (st.isFile()) return /\.(ts|tsx)$/.test(path) && !/\.test\./.test(path) ? [path] : []
  return readdirSync(path)
    .flatMap((entry) => collectSources(join(path, entry)))
    .sort()
}

describe('hardcoded color scan (components + App)', () => {
  it('finds no untagged color literals', () => {
    const violations: string[] = []
    for (const root of SCAN_ROOTS) {
      for (const file of collectSources(root)) {
        const lines = readFileSync(file, 'utf8').split('\n')
        lines.forEach((line, i) => {
          if (COLOR_LITERAL.test(line) && !line.includes(ESCAPE_TAG)) {
            violations.push(`${relative(RENDERER_ROOT, file)}:${i + 1}  ${line.trim().slice(0, 120)}`)
          }
        })
      }
    }
    expect(
      violations,
      `Color literals must come from useColors() tokens, or carry a same-line ` +
        `"// ${ESCAPE_TAG} <reason>" tag when genuinely theme-neutral:\n` +
        violations.join('\n'),
    ).toEqual([])
  })
})
