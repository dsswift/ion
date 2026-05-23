/**
 * Slash Command Expansion Tests
 *
 * Validates that filesystem-based slash commands (~/.claude/commands,
 * {project}/.claude/commands, ~/.claude/skills) are correctly resolved,
 * frontmatter-stripped, $ARGUMENTS-replaced, and returned as system prompts.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Mock homedir so tests don't depend on the real ~/.claude directory
let fakeHome: string

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => fakeHome,
  }
})

// Mock the logger so importing slash-expand.ts (which imports ../logger) does
// not call homedir() at module-load time to compute the log file path — that
// would fire before fakeHome is initialised and produce a ReferenceError.
vi.mock('../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

import { expandSlashCommand, stripFrontmatter } from '../cli-compat/slash-expand'

// ─── Fixtures ───

function writeCommand(base: string, name: string, content: string): void {
  const dir = join(base, '.claude', 'commands')
  const filePath = name.replace(/:/g, '/') + '.md'
  const fullPath = join(dir, filePath)
  const parentDir = fullPath.substring(0, fullPath.lastIndexOf('/'))
  mkdirSync(parentDir, { recursive: true })
  writeFileSync(fullPath, content)
}

function writeSkill(base: string, name: string, content: string): void {
  const dir = join(base, '.claude', 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), content)
}

let projectDir: string

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'slash-test-home-'))
  projectDir = mkdtempSync(join(tmpdir(), 'slash-test-project-'))
})

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true })
  rmSync(projectDir, { recursive: true, force: true })
})

// ─── Tests ───

describe('expandSlashCommand', () => {
  // TC-SE-001
  it('passes through non-slash prompts', async () => {
    const result = await expandSlashCommand('hello world', projectDir)
    expect(result).toEqual({ expanded: false })
  })

  // TC-SE-002
  it('returns not-expanded for unknown commands', async () => {
    const result = await expandSlashCommand('/nonexistent some args', projectDir)
    expect(result).toEqual({ expanded: false })
  })

  // TC-SE-003
  it('expands user command with $ARGUMENTS', async () => {
    writeCommand(fakeHome, 'spec-issue', [
      '---',
      'description: Create a spec from a GitHub issue',
      '---',
      'Analyze the following GitHub issue and create a spec:',
      '',
      'Issue URL: $ARGUMENTS',
      '',
      'Write the spec to a file.',
    ].join('\n'))

    const result = await expandSlashCommand(
      '/spec-issue https://github.com/org/repo/issues/37',
      projectDir,
    )

    expect(result.expanded).toBe(true)
    if (!result.expanded) return

    expect(result.userPrompt).toContain('Analyze the following GitHub issue')
    expect(result.userPrompt).toContain('https://github.com/org/repo/issues/37')
    expect(result.userPrompt).not.toContain('$ARGUMENTS')
    expect(result.userPrompt).not.toContain('---')
    expect(result.userPrompt).not.toContain('description:')
    expect(result.systemPrompt).toBe('')
  })

  // TC-SE-004
  it('project commands take priority over user commands', async () => {
    writeCommand(fakeHome, 'deploy', 'USER deploy: $ARGUMENTS')
    writeCommand(projectDir, 'deploy', 'PROJECT deploy: $ARGUMENTS')

    const result = await expandSlashCommand('/deploy staging', projectDir)

    expect(result.expanded).toBe(true)
    if (!result.expanded) return

    expect(result.userPrompt).toBe('PROJECT deploy: staging')
  })

  // TC-SE-005
  it('resolves colon-delimited names to subdirectory paths', async () => {
    writeCommand(fakeHome, 'e2e:setup', 'Setup e2e tests for: $ARGUMENTS')

    const result = await expandSlashCommand('/e2e:setup my-feature', projectDir)

    expect(result.expanded).toBe(true)
    if (!result.expanded) return

    expect(result.userPrompt).toBe('Setup e2e tests for: my-feature')
    expect(result.systemPrompt).toBe('')
  })

  // TC-SE-006
  it('resolves skills from ~/.claude/skills/{name}/SKILL.md', async () => {
    writeSkill(fakeHome, 'my-skill', [
      '---',
      'description: A custom skill',
      '---',
      'You are a specialist. Apply skill to: $ARGUMENTS',
    ].join('\n'))

    const result = await expandSlashCommand('/my-skill fix the bug', projectDir)

    expect(result.expanded).toBe(true)
    if (!result.expanded) return

    expect(result.userPrompt).toContain('You are a specialist')
    expect(result.userPrompt).toContain('fix the bug')
    expect(result.userPrompt).not.toContain('---')
  })

  // TC-SE-007
  it('strips YAML frontmatter correctly', async () => {
    writeCommand(fakeHome, 'fm-test', [
      '---',
      'description: Test frontmatter',
      'allowed-tools: Read, Write',
      '---',
      'The actual command content.',
    ].join('\n'))

    const result = await expandSlashCommand('/fm-test', projectDir)

    expect(result.expanded).toBe(true)
    if (!result.expanded) return

    // No args: content goes into userPrompt, systemPrompt is empty
    expect(result.userPrompt).toBe('The actual command content.')
    expect(result.systemPrompt).toBe('')
    expect(result.userPrompt).not.toContain('description:')
    expect(result.userPrompt).not.toContain('allowed-tools:')
  })

  // TC-SE-008
  it('replaces all $ARGUMENTS occurrences', async () => {
    writeCommand(fakeHome, 'multi', 'First: $ARGUMENTS\nSecond: $ARGUMENTS')

    const result = await expandSlashCommand('/multi hello', projectDir)

    expect(result.expanded).toBe(true)
    if (!result.expanded) return

    expect(result.userPrompt).toBe('First: hello\nSecond: hello')
  })

  // TC-SE-009
  it('replaces $ARGUMENTS with empty string when no args given', async () => {
    writeCommand(fakeHome, 'spec', 'Create a spec for: $ARGUMENTS')

    const result = await expandSlashCommand('/spec', projectDir)

    expect(result.expanded).toBe(true)
    if (!result.expanded) return

    // No args: expanded content becomes user prompt, system prompt empty
    expect(result.systemPrompt).toBe('')
    expect(result.userPrompt).toBe('Create a spec for: ')
  })

  // TC-SE-010
  it('project commands override user commands with same name', async () => {
    writeCommand(fakeHome, 'review', 'USER review for: $ARGUMENTS')
    writeCommand(projectDir, 'review', 'PROJECT review for: $ARGUMENTS')

    const result = await expandSlashCommand('/review PR #42', projectDir)

    expect(result.expanded).toBe(true)
    if (!result.expanded) return

    expect(result.userPrompt).toBe('PROJECT review for: PR #42')
  })

  // TC-SE-011: ad-hoc slash-style strings should NOT be expanded when no
  // matching .md file exists on disk. `/clear` is the only renderer-side
  // builtin today (intercepted by InputBar before reaching this path); the
  // others (/cost, /model, /mcp, /skills, /help) were removed but are kept
  // in this list because they are realistic "user types something that
  // looks like a slash command, no file exists" inputs. The expansion
  // function must not match any of them.
  it('does not expand slash-style names when no .md file exists', async () => {
    for (const cmd of ['/model sonnet', '/clear', '/cost', '/mcp', '/skills', '/help']) {
      const result = await expandSlashCommand(cmd, projectDir)
      expect(result.expanded).toBe(false)
    }
  })

  it('handles command without projectPath', async () => {
    writeCommand(fakeHome, 'global', 'Global command: $ARGUMENTS')

    const result = await expandSlashCommand('/global test')

    expect(result.expanded).toBe(true)
    if (!result.expanded) return

    expect(result.userPrompt).toBe('Global command: test')
  })

  it('handles .md file without frontmatter', async () => {
    writeCommand(fakeHome, 'plain', 'Just plain content with $ARGUMENTS')

    const result = await expandSlashCommand('/plain stuff', projectDir)

    expect(result.expanded).toBe(true)
    if (!result.expanded) return

    expect(result.userPrompt).toBe('Just plain content with stuff')
  })

  // TC-SE-012: Claude Code parity — when a skill template has no $ARGUMENTS
  // placeholder and the user supplies args, append them as a trailing block.
  // This is the primary bug fix: /ilograph <instructions> previously dropped
  // <instructions> because ilograph's SKILL.md has no $ARGUMENTS token.
  it('appends ARGUMENTS suffix when skill template has no placeholder', async () => {
    writeSkill(fakeHome, 'ilograph', 'You are an Ilograph diagram expert.\n\nAnalyze the architecture.')

    const result = await expandSlashCommand(
      '/ilograph Please review these diagrams and improve them.',
      projectDir,
    )

    expect(result.expanded).toBe(true)
    if (!result.expanded) return

    expect(result.userPrompt).toContain('You are an Ilograph diagram expert.')
    const expectedSuffix = '\n\nARGUMENTS: Please review these diagrams and improve them.'
    expect(result.userPrompt.endsWith(expectedSuffix)).toBe(true)
    // No double-append: the literal prefix must appear exactly once
    expect(result.userPrompt.split('\n\nARGUMENTS:').length).toBe(2)
  })

  // TC-SE-013: when the template DOES have $ARGUMENTS, the placeholder is
  // substituted as normal — the trailing ARGUMENTS block must NOT appear.
  it('does not append ARGUMENTS block when template has placeholder', async () => {
    writeCommand(fakeHome, 'with-placeholder', 'Spec for: $ARGUMENTS\n\nDo the work.')

    const result = await expandSlashCommand('/with-placeholder foo bar baz', projectDir)

    expect(result.expanded).toBe(true)
    if (!result.expanded) return

    expect(result.userPrompt).toBe('Spec for: foo bar baz\n\nDo the work.')
    expect(result.userPrompt).not.toContain('\n\nARGUMENTS:')
  })

  // TC-SE-014: no args supplied and no placeholder → body returned unchanged,
  // no trailing ARGUMENTS block. Matches Claude Code's `args` non-empty guard.
  it('does not append ARGUMENTS block when args is empty', async () => {
    writeSkill(fakeHome, 'no-args-skill', 'Generic skill prose. No placeholder here.')

    const result = await expandSlashCommand('/no-args-skill', projectDir)

    expect(result.expanded).toBe(true)
    if (!result.expanded) return

    expect(result.userPrompt).toBe('Generic skill prose. No placeholder here.')
    expect(result.userPrompt).not.toContain('ARGUMENTS:')
  })

  // TC-SE-015: same append behaviour applies to plain commands/ files, not
  // just skills — the fix lives in expandSlashCommand, not skill-specific logic.
  it('appends ARGUMENTS suffix for command file without placeholder', async () => {
    writeCommand(fakeHome, 'no-placeholder-cmd', 'Run the analysis.\n\nBe thorough.')

    const result = await expandSlashCommand('/no-placeholder-cmd check everything', projectDir)

    expect(result.expanded).toBe(true)
    if (!result.expanded) return

    expect(result.userPrompt).toContain('Run the analysis.')
    const expectedSuffix = '\n\nARGUMENTS: check everything'
    expect(result.userPrompt.endsWith(expectedSuffix)).toBe(true)
    expect(result.userPrompt).not.toContain('$ARGUMENTS')
  })
})

describe('stripFrontmatter', () => {
  it('returns content unchanged when no frontmatter present', () => {
    expect(stripFrontmatter('hello\nworld')).toBe('hello\nworld')
  })

  it('strips frontmatter block', () => {
    const content = '---\ndescription: test\n---\nbody content'
    expect(stripFrontmatter(content)).toBe('body content')
  })

  it('returns content as-is when opening --- has no closing ---', () => {
    const content = '---\ndescription: test\nbody without closing'
    expect(stripFrontmatter(content)).toBe(content)
  })

  it('handles empty content after frontmatter', () => {
    const content = '---\nkey: value\n---\n'
    expect(stripFrontmatter(content)).toBe('')
  })
})
