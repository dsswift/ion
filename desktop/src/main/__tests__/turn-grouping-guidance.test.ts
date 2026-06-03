/**
 * Pin test for the turn-grouping guidance constant.
 *
 * The constant is injected into the system prompt of every LLM call from
 * the desktop harness. Three invariants matter, none of them caught by
 * the type system:
 *
 *   1. **Cacheability** — the export must be a plain string constant
 *      (not a function, not a template), because any per-call variation
 *      would defeat the prompt-cache prefix and turn a free addendum
 *      into a per-turn billed one.
 *
 *   2. **Core point is intact** — a future refactor that "improves" the
 *      wording must not accidentally drop the central claim ("tool calls
 *      aren't rendered inline"). We pin "colons" and "rendered inline"
 *      as load-bearing substrings.
 *
 *   3. **Terminal punctuation** — the guidance ends a paragraph and is
 *      concatenated after upstream content with `\n\n`. A trailing
 *      colon would itself violate the guidance the constant gives; a
 *      missing terminator would corrupt the next concatenation step.
 *
 * If you intentionally rewrite the guidance (model behavior changed,
 * better wording found, etc.), update the pin substrings here at the
 * same time. The point of the test is to force that intentional
 * coupling — not to lock the prose forever.
 */

import { describe, it, expect } from 'vitest'
import { TURN_GROUPING_GUIDANCE } from '../turn-grouping-guidance'

describe('TURN_GROUPING_GUIDANCE', () => {
  it('is a non-empty plain string (cacheable, not a function or template)', () => {
    expect(typeof TURN_GROUPING_GUIDANCE).toBe('string')
    expect(TURN_GROUPING_GUIDANCE.length).toBeGreaterThan(0)
  })

  it('mentions the core point: colons + inline rendering', () => {
    // The two load-bearing substrings the guidance must keep. A
    // refactor that drops either has lost the meaning of the
    // addendum and the test catches that before it ships.
    expect(TURN_GROUPING_GUIDANCE.toLowerCase()).toContain('colons')
    expect(TURN_GROUPING_GUIDANCE.toLowerCase()).toContain('inline')
  })

  it('ends with normal terminal punctuation (period), not a colon', () => {
    // The last character must be `.` / `!` / `?` — never `:` (the
    // very habit the guidance warns the model against) and never a
    // whitespace character (which would corrupt the `\n\n` join the
    // pipeline performs when concatenating onto upstream content).
    const last = TURN_GROUPING_GUIDANCE.trim().slice(-1)
    expect(['.', '!', '?']).toContain(last)
  })

  it('does not contain wire-control characters', () => {
    // The string lives inside a JSON-encoded NDJSON line. CR / null /
    // backspace would not be silently mangled (JSON.stringify
    // escapes them), but their presence is almost always an
    // editor-paste accident. Catch it at the source.
    expect(TURN_GROUPING_GUIDANCE).not.toMatch(/[\x00\r\x08]/)
  })
})
