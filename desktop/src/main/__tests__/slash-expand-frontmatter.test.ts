/**
 * parseFrontmatter Tests
 *
 * Split out of slash-expand.test.ts to keep that file under the TS
 * 600-line cap after the js-yaml swap added six robustness cases.
 * parseFrontmatter has no filesystem-fixture dependencies — the
 * function operates on string content directly — so the sibling test
 * doesn't need the homedir() mock or the writeCommand() fixture
 * helpers that the rest of slash-expand.test.ts uses.
 */

import { describe, it, expect, vi } from 'vitest'

// Mock the logger so importing slash-expand.ts does not call homedir()
// at module-load time to compute the log file path.
vi.mock('../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

import { parseFrontmatter } from '../cli-compat/slash-expand'

describe('parseFrontmatter', () => {
  it('returns empty meta and full body when no frontmatter', () => {
    const { body, meta } = parseFrontmatter('hello\nworld')
    expect(body).toBe('hello\nworld')
    expect(meta).toEqual({})
  })

  it('parses description field', () => {
    const content = '---\ndescription: My command\n---\nbody text'
    const { body, meta } = parseFrontmatter(content)
    expect(body).toBe('body text')
    expect(meta.description).toBe('My command')
  })

  it('strips quotes from description', () => {
    const content = '---\ndescription: "Quoted desc"\n---\nbody'
    const { meta } = parseFrontmatter(content)
    expect(meta.description).toBe('Quoted desc')
  })

  it('parses inline allowed_bash_commands', () => {
    const content = '---\nallowed_bash_commands: [gh, git log, git diff]\n---\nbody'
    const { body, meta } = parseFrontmatter(content)
    expect(body).toBe('body')
    expect(meta.allowedBashCommands).toEqual(['gh', 'git log', 'git diff'])
  })

  it('parses YAML list allowed_bash_commands', () => {
    const content = '---\nallowed_bash_commands:\n  - gh\n  - git log\n  - git diff\n---\nbody'
    const { body, meta } = parseFrontmatter(content)
    expect(body).toBe('body')
    expect(meta.allowedBashCommands).toEqual(['gh', 'git log', 'git diff'])
  })

  it('parses both description and allowed_bash_commands', () => {
    const content = '---\ndescription: Review PR\nallowed_bash_commands: [gh]\n---\nbody'
    const { meta } = parseFrontmatter(content)
    expect(meta.description).toBe('Review PR')
    expect(meta.allowedBashCommands).toEqual(['gh'])
  })

  it('returns empty meta when no closing ---', () => {
    const content = '---\nallowed_bash_commands: [gh]\nbody text'
    const { body, meta } = parseFrontmatter(content)
    expect(body).toBe(content)
    expect(meta).toEqual({})
  })

  it('filters empty entries from inline list', () => {
    // With well-formed YAML 1.2 inline lists, the previous hand-rolled
    // regex parser was lenient with consecutive commas; the js-yaml
    // parser correctly rejects them as a syntax error. Use a well-
    // formed inline list with quoted empty strings to exercise the
    // "filter empty entries" branch of parseFrontmatter (the
    // .filter(Boolean) pass after the typeof-string narrowing).
    const content = '---\nallowed_bash_commands: ["gh", "", "git log", ""]\n---\nbody'
    const { meta } = parseFrontmatter(content)
    expect(meta.allowedBashCommands).toEqual(['gh', 'git log'])
  })

  it('rejects malformed YAML inline lists with empty positional entries', () => {
    // [gh, , git log, ] is not valid YAML 1.2 (consecutive commas
    // produce an "expected node content" syntax error). The previous
    // hand-rolled regex parser was lenient about this; the js-yaml
    // swap restores strict YAML 1.2 semantics. The whole frontmatter
    // block is treated as malformed and meta returns empty (the body
    // is still extracted).
    const content = '---\nallowed_bash_commands: [gh, , git log, ]\n---\nbody'
    const { body, meta } = parseFrontmatter(content)
    expect(body).toBe('body')
    expect(meta).toEqual({})
  })

  it('round-trips quoted scalars correctly', () => {
    // The previous regex stripped only outermost single/double quotes
    // (no escape handling); js-yaml handles the full YAML 1.2 quoted-
    // scalar surface including embedded commas, escape sequences, and
    // unicode.
    const content = '---\ndescription: "Hello, world (with embedded \\"quoted\\" punctuation)"\n---\nbody'
    const { meta } = parseFrontmatter(content)
    expect(meta.description).toBe('Hello, world (with embedded "quoted" punctuation)')
  })

  it('handles YAML block-scalar (|) multiline description', () => {
    // The previous regex matched on `description:\s*(.+)$` and so
    // only captured the first line of any multi-line value. js-yaml
    // handles block scalars (| literal, > folded) per the YAML 1.2 spec.
    const content = ['---', 'description: |', '  hello', '  world', '---', 'body'].join('\n')
    const { meta } = parseFrontmatter(content)
    expect(meta.description).toBe('hello\nworld\n')
  })

  it('ignores nested mappings without crashing', () => {
    // Nested mappings (`metadata: { author: foo }`) were impossible to
    // parse with the regex cluster; js-yaml decodes them as a nested
    // object. parseFrontmatter narrows to {description, allowed_bash_commands}
    // and silently ignores other keys, so nested mappings on unknown
    // keys are no-ops rather than crashes.
    const content = ['---', 'description: hi', 'metadata:', '  author: jdoe', '  version: 1', '---', 'body'].join('\n')
    const { meta } = parseFrontmatter(content)
    expect(meta.description).toBe('hi')
    expect(meta.allowedBashCommands).toBeUndefined()
  })

  it('returns empty meta on syntactically malformed YAML', () => {
    // Hard YAML syntax error — duplicate colons. The previous regex
    // would have silently matched some of the lines; js-yaml rejects
    // the whole document and parseFrontmatter falls back to empty meta
    // while still returning the body.
    const content = '---\ndescription: : :\n---\nbody'
    const { body, meta } = parseFrontmatter(content)
    expect(body).toBe('body')
    expect(meta).toEqual({})
  })

  it('handles YAML anchors and references without crashing', () => {
    // YAML 1.2 anchor / reference syntax was impossible with the regex
    // parser; js-yaml decodes &anchor / *ref correctly. parseFrontmatter
    // narrows the result so unknown shapes are no-ops; we just need to
    // confirm no exception escapes.
    const content = ['---', 'description: &d "with anchor"', 'other: *d', '---', 'body'].join('\n')
    const { meta } = parseFrontmatter(content)
    expect(meta.description).toBe('with anchor')
  })

  // ── model frontmatter field ───────────────────────────────────────
  // The `model:` key is forwarded verbatim onto `RunOptions.Model`
  // and the engine resolves it through tier → literal → defaultModel.
  // parseFrontmatter's job is only to extract a non-empty trimmed
  // string; non-string values are rejected to keep the contract
  // ("a tier alias or a model id") clean.

  it('parses model field as a string', () => {
    const content = '---\nmodel: smart\n---\nbody'
    const { body, meta } = parseFrontmatter(content)
    expect(body).toBe('body')
    expect(meta.model).toBe('smart')
  })

  it('leaves meta.model undefined when frontmatter has no model key', () => {
    const content = '---\ndescription: hi\n---\nbody'
    const { meta } = parseFrontmatter(content)
    expect(meta.model).toBeUndefined()
  })

  it('ignores non-string model values', () => {
    // YAML `model: 123` decodes to a number, not a string. The type
    // guard in parseFrontmatter rejects it so meta.model stays
    // undefined. This pins the guard against future refactors that
    // might forget the `typeof === 'string'` check.
    const content = '---\nmodel: 123\n---\nbody'
    const { meta } = parseFrontmatter(content)
    expect(meta.model).toBeUndefined()
  })

  it('trims whitespace from model value', () => {
    // Quoted scalar preserves the leading/trailing spaces; the parser
    // must trim them so downstream code never sees a padded value.
    const content = '---\nmodel: "  smart  "\n---\nbody'
    const { meta } = parseFrontmatter(content)
    expect(meta.model).toBe('smart')
  })

  it('treats whitespace-only model value as absent', () => {
    // After trim, an empty string is meaningless as a model hint;
    // collapsing it to undefined keeps the field semantics binary
    // (present-and-useful, or absent) so downstream pipeline logs
    // don't show spurious-looking blank hints.
    const content = '---\nmodel: "   "\n---\nbody'
    const { meta } = parseFrontmatter(content)
    expect(meta.model).toBeUndefined()
  })

  it('parses model alongside description and allowed_bash_commands', () => {
    // Integration case: a real-world frontmatter block carrying all
    // three currently-parsed keys. Confirms parseFrontmatter doesn't
    // drop the model field when the surrounding fields are present.
    const content = [
      '---',
      'description: Open a GitHub issue',
      'allowed_bash_commands:',
      '  - gh issue create',
      'model: smart',
      '---',
      'body',
    ].join('\n')
    const { meta } = parseFrontmatter(content)
    expect(meta.description).toBe('Open a GitHub issue')
    expect(meta.allowedBashCommands).toEqual(['gh issue create'])
    expect(meta.model).toBe('smart')
  })
})
