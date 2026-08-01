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

describe('align.md lifecycle invariants', () => {
  const content = readCommand('align.md')
  const fm = parseFrontmatter(content)

  it('model is set to standard', () => {
    expect(fm.model).toBe('standard')
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
