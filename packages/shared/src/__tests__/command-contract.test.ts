/**
 * Source-contract tests for .ion/commands/*.md files.
 *
 * These tests pin structural invariants of slash-command files that the
 * engine's command loader and the desktop's slash-parse layer depend on.
 * When a command file drifts from these invariants, CI catches it here
 * rather than at runtime.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { resolve } from 'path'

const COMMANDS_DIR = resolve(__dirname, '../../../../.ion/commands')

function readCommand(name: string): string {
  return readFileSync(resolve(COMMANDS_DIR, name), 'utf-8')
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const fields: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const sep = line.indexOf(':')
    if (sep > 0) {
      fields[line.slice(0, sep).trim()] = line.slice(sep + 1).trim()
    }
  }
  return fields
}

describe('command file structural invariants', () => {
  it('every .md file in .ion/commands has frontmatter with description', () => {
    const files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const content = readCommand(file)
      expect(content).toMatch(/^---\n/)
      const fm = parseFrontmatter(content)
      expect(fm.description, `${file} missing description`).toBeTruthy()
    }
  })
})

/**
 * Model-tier placement. A command's `model:` tier is only honored by the engine
 * at a fresh conversation boundary, because switching models mid-conversation
 * re-sends the whole history as cache-creation input (the provider cache is
 * keyed per exact model). So a tier belongs ONLY on a command that starts a
 * phase, and a command that starts a phase from an existing conversation must
 * also declare `clears-conversation` — the clear is what makes the boundary
 * fresh, which is what makes its tier apply.
 */
describe('command model-tier placement', () => {
  it('a command declaring a tier also declares clears-conversation', () => {
    const files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.md'))
    for (const file of files) {
      const fm = parseFrontmatter(readCommand(file))
      if (!fm.model) continue
      expect(
        fm['clears-conversation'],
        `${file} pins model="${fm.model}" but does not clear the conversation, so the tier is ignored whenever the command runs mid-conversation`,
      ).toBe('true')
    }
  })

  it('squash pins a tier and clears the conversation', () => {
    const fm = parseFrontmatter(readCommand('squash.md'))
    expect(fm.model).toBeTruthy()
    expect(fm['clears-conversation']).toBe('true')
  })
})

describe('squash.md lifecycle invariants', () => {
  const content = readCommand('squash.md')

  it('accepts one source commit for scope correction', () => {
    expect(content).toContain('[ "$COUNT" -gt 0 ]')
    expect(content).not.toContain('[ "$COUNT" -gt 1 ]')
    expect(content).toContain('A single source commit is valid input.')
  })
})

describe('align.md lifecycle invariants', () => {
  const content = readCommand('align.md')
  const fm = parseFrontmatter(content)

  // align runs INSIDE an existing conversation, at the end of a working
  // session. A pinned tier there would switch models mid-conversation, which
  // cannot reuse the provider prompt cache (it is keyed per exact model) and so
  // re-sends the entire conversation to serve one turn. align must inherit
  // whatever model the conversation is already using.
  it('declares no model tier so it inherits the conversation model', () => {
    expect(fm.model).toBeUndefined()
  })

  it('description uses definitive "implements" not permissive "may implement"', () => {
    expect(fm.description).not.toContain('may implement')
    expect(fm.description).toContain('implements the fixes and commits them')
  })

  it('Mode A completion invariant is present', () => {
    expect(content).toContain('Mode A completion invariant')
    expect(content).toContain(
      'Mode A never edits source, never commits, never implements',
    )
  })

  it('Mode B pre-approval completion invariant is present', () => {
    expect(content).toContain(
      'Mode B completion invariant (pre-approval)',
    )
  })

  it('Mode B post-approval completion invariant is present', () => {
    expect(content).toContain(
      'Mode B completion invariant (post-approval)',
    )
  })

  it('B-Step 6 requires operator approval', () => {
    expect(content).toContain(
      'only after the operator approves the fix plan',
    )
  })
})
