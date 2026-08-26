/**
 * Element target resolution.
 *
 * Agents address elements three ways, and all three must work:
 *
 *   1. A snapshot ref (`e12`) taken from the last `browser_snapshot`. This is
 *      the primary path and the reason snapshots carry refs at all: it names
 *      one exact node with no selector guessing.
 *   2. A Playwright selector with an explicit engine (`text=Sign in`,
 *      `role=button[name="Save"]`, `internal:testid=...`).
 *   3. A bare CSS selector.
 *
 * Refs are resolved through Playwright's `aria-ref` engine, which is the same
 * mechanism the MCP server uses and is valid only for the document the snapshot
 * came from. That scoping is deliberate: after a navigation an old ref would
 * otherwise silently match a different node, and a wrong click is worse than a
 * clear failure telling the agent to take a fresh snapshot.
 */
import type { Locator, Page } from 'playwright-core'

/**
 * A snapshot element reference.
 *
 * Playwright's AI snapshots emit two forms: `e12`, and `f2e12` when the
 * element's frame carries a sequence number. A long-lived connection — which
 * is exactly what the Studio browser runtime holds — produces the prefixed
 * form, so refs taken from a snapshot were rejected here before Playwright
 * ever saw them, and every ref-targeted click, type, and screenshot failed
 * with "no element matched".
 *
 * Playwright resolves the prefix itself (`_jumpToAriaRefFrameIfNeeded` maps
 * `fN` to the frame with that seq), so the fix is simply to stop filtering it
 * out.
 */
const REF_PATTERN = /^(f\d+)?e\d+$/
/** Selector strings that already name a Playwright engine. */
const ENGINE_PREFIX = /^(css|xpath|text|role|id|data-testid|internal:[a-z-]+|aria-ref)\s*=/i

export interface TargetResolution {
  locator: Locator
  /** How the target was interpreted, for the Playwright-code echo. */
  expression: string
}

/**
 * Turn a caller target into a locator.
 *
 * Returns a string on failure so the handler can hand the reason to the model:
 * an unresolvable target is a normal, correctable mistake, not an exception.
 */
export function resolveTarget(page: Page, target: string): TargetResolution | string {
  const trimmed = target.trim()
  if (!trimmed) return 'target must not be empty'

  if (REF_PATTERN.test(trimmed)) {
    // aria-ref is snapshot-scoped. A stale ref fails loudly at action time
    // rather than matching whatever now occupies that position.
    return { locator: page.locator(`aria-ref=${trimmed}`), expression: `page.locator('aria-ref=${trimmed}')` }
  }

  if (ENGINE_PREFIX.test(trimmed)) {
    return { locator: page.locator(trimmed), expression: `page.locator(${quote(trimmed)})` }
  }

  // Bare strings are CSS. Playwright would also accept them, but being
  // explicit keeps the echoed code unambiguous for the reader.
  return { locator: page.locator(trimmed), expression: `page.locator(${quote(trimmed)})` }
}

/**
 * Resolve to exactly one element.
 *
 * A target that matches several nodes is refused rather than silently acting on
 * the first: "click the Delete button" hitting the wrong row is precisely the
 * failure this prevents. The message names the count so the agent can add an
 * index or use a snapshot ref.
 */
export async function resolveUnique(page: Page, target: string, timeoutMs: number): Promise<{ locator: Locator; expression: string } | string> {
  const resolved = resolveTarget(page, target)
  if (typeof resolved === 'string') return resolved
  const count = await resolved.locator.count().catch(() => -1)
  if (count === 0) {
    // Not necessarily an error yet: the element may still be arriving, so let
    // Playwright's own actionability wait decide.
    await resolved.locator.first().waitFor({ state: 'attached', timeout: timeoutMs }).catch(() => undefined) // silent-ok: the recount below decides and reports the real miss
    const recount = await resolved.locator.count().catch(() => 0)
    if (recount === 0) return `no element matched ${target}. Take a fresh browser_snapshot and use a ref such as e12.`
  }
  if (count > 1) {
    return `${count} elements matched ${target}. Use a snapshot ref (for example e12) or a more specific selector.`
  }
  return { locator: resolved.locator.first(), expression: resolved.expression }
}

function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}
