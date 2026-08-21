import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Structural gate for the "every popover lands inside the window" rule
 * (desktop/AGENTS.md § "Popover positioning").
 *
 * A `position: 'fixed'` element is placed in viewport coordinates, so nothing
 * in the layout stops it from rendering past the window edge. The reported
 * defect was exactly that: a worktree row's context menu opened at the raw
 * right-click point, and a row near the bottom of the git panel produced a
 * menu whose lower half was off-screen with its destructive verbs unreachable.
 *
 * Fixing the one menu does not stop the next one, because the failure is
 * invisible until someone right-clicks near an edge on a small window. So
 * every fixed-position element must resolve to one of four answers:
 *
 *   1. It fills the viewport (`inset: 0`) — a backdrop or a full-screen layer.
 *   2. It is placed by `useAnchoredPopover`, which measures and flips.
 *   3. It is corrected by `useViewportClamp` on a ref this file passes.
 *   4. It carries a `// viewport-ok: <reason>` tag, on the same line or the
 *      line directly above it (these reasons cite the clamp that already
 *      covers the element, so they run long and read better on their own line).
 *
 * mirroring the repo's nolint / silent-ok / hardcoded-ok conventions: the
 * exception is visible, reasoned, and reviewed.
 */

const RENDERER_ROOT = join(__dirname, '..', '..')
const SCAN_ROOTS = [join(RENDERER_ROOT, 'components'), join(RENDERER_ROOT, 'studio')]

const FIXED = /position:\s*'fixed'/
const ESCAPE_TAG = 'viewport-ok:'

/** How far past the `position: 'fixed'` line the style object can run. A style
 *  block longer than this is unusual; the window only has to be big enough to
 *  contain the sibling properties that resolve the placement. */
const STYLE_BLOCK_LINES = 26

function collectSources(path: string): string[] {
  const st = statSync(path)
  if (st.isFile()) return /\.(ts|tsx)$/.test(path) && !/\.test\./.test(path) ? [path] : []
  return readdirSync(path)
    .flatMap((entry) => collectSources(join(path, entry)))
    .sort()
}

/**
 * The refs this file hands to `useViewportClamp`, e.g. `popoverRef` from
 * `useViewportClamp(popoverRef, open)`. An element carrying one of these on
 * its `ref=` is corrected after layout, wherever its style puts it.
 */
function clampedRefs(source: string): string[] {
  return [...source.matchAll(/useViewportClamp\(\s*([A-Za-z0-9_]+)\s*,/g)].map((m) => m[1])
}

/**
 * Walk backwards from the `position: 'fixed'` line to the element's opening
 * tag and return the `ref={...}` expression on it, if any. The ref sits above
 * the style prop, so a forward-only window would miss it.
 */
function refExpressionAbove(lines: string[], fixedLine: number): string {
  for (let i = fixedLine; i >= 0 && fixedLine - i < STYLE_BLOCK_LINES; i--) {
    const line = lines[i]
    const match = /ref=\{([^}]*)\}/.exec(line)
    if (match) return match[1]
    // Stop at the opening `<` of the element so we never read a SIBLING
    // element's ref as though it belonged to this one.
    if (/^\s*<[A-Za-z]/.test(line)) return ''
  }
  return ''
}

describe('popover viewport-bounds scan (components + studio)', () => {
  it('every fixed-position element resolves its placement', () => {
    const violations: string[] = []
    for (const root of SCAN_ROOTS) {
      for (const file of collectSources(root)) {
        const source = readFileSync(file, 'utf8')
        if (!FIXED.test(source)) continue
        const lines = source.split('\n')
        const refs = clampedRefs(source)

        lines.forEach((line, i) => {
          if (!FIXED.test(line)) return
          // The tag may sit on the property line or immediately above it.
          if (line.includes(ESCAPE_TAG)) return
          if (i > 0 && lines[i - 1].includes(ESCAPE_TAG)) return

          const block = lines.slice(i, i + STYLE_BLOCK_LINES).join('\n')
          // (1) Fills the viewport.
          if (/inset:\s*0/.test(block)) return
          // (2) Placed by the anchored positioner. Callers name the result
          // `pos` / `outerPos` / `titleMenuPos` and spend `.left` / `.top`.
          if (/(?:left|top):\s*[A-Za-z0-9_]*[Pp]os\.(?:left|top)/.test(block)) return
          // (3) Corrected by the clamp, via a ref this file clamps.
          const refExpr = refExpressionAbove(lines, i)
          if (refs.some((r) => refExpr.includes(r))) return

          violations.push(`${relative(RENDERER_ROOT, file)}:${i + 1}  ${line.trim().slice(0, 100)}`)
        })
      }
    }
    expect(
      violations,
      `A position:'fixed' element is placed in viewport coordinates, so it can ` +
        `render off-screen. Each of these must either fill the viewport ` +
        `(inset: 0), be placed by useAnchoredPopover (pos.left / pos.top), be ` +
        `corrected by useViewportClamp on its ref, or carry a ` +
        `"// ${ESCAPE_TAG} <reason>" tag on that line or the one above it:\n` +
        violations.join('\n'),
    ).toEqual([])
  })
})
