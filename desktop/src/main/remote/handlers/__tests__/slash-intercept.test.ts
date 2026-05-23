/**
 * Tests for the slash-command parser exported from
 * `desktop/src/main/remote/handlers/slash-intercept.ts`.
 *
 * Historical scope (pre-unified-pipeline): this file also covered
 * `interceptCliSlash` / `interceptEngineSlash`, the slash-routing functions
 * that lived in slash-intercept.ts. Those functions were absorbed into
 * `desktop/src/main/prompt-pipeline.ts` along with the rest of slash
 * routing. The parser remains here as a thin wrapper over
 * `desktop/src/main/slash-parse.ts:parseSlash` and retains its existing
 * API contract (returns `{command, args}` or null).
 *
 * Pipeline behaviour is exercised by `prompt-pipeline.test.ts` (sibling
 * test file under `desktop/src/main/__tests__/`).
 */

import { describe, it, expect } from 'vitest'
import { parseSlashCommand } from '../slash-intercept'

describe('parseSlashCommand', () => {
  it('parses simple command with no args', () => {
    expect(parseSlashCommand('/clear')).toEqual({ command: 'clear', args: '' })
  })

  it('parses command with args', () => {
    expect(parseSlashCommand('/model claude-sonnet-4-6')).toEqual({
      command: 'model',
      args: 'claude-sonnet-4-6',
    })
  })

  it('trims leading/trailing whitespace before parsing', () => {
    expect(parseSlashCommand('   /clear   ')).toEqual({ command: 'clear', args: '' })
  })

  it('accepts hyphens and colons in command names', () => {
    expect(parseSlashCommand('/agents-team cloudops')).toEqual({
      command: 'agents-team',
      args: 'cloudops',
    })
    expect(parseSlashCommand('/foo_bar')).toEqual({ command: 'foo_bar', args: '' })
    expect(parseSlashCommand('/foo:bar')).toEqual({ command: 'foo:bar', args: '' })
  })

  it('returns null for non-slash text', () => {
    expect(parseSlashCommand('hello')).toBeNull()
    expect(parseSlashCommand('')).toBeNull()
  })

  it('returns null for bare slash', () => {
    expect(parseSlashCommand('/')).toBeNull()
  })

  it('returns null for path-like leading-slash text', () => {
    // We don't want to intercept paste-style text such as `/path/to/file`
    // as a slash command — the second `/` is not in [a-zA-Z0-9_:-].
    expect(parseSlashCommand('/path/to/file')).toBeNull()
  })

  it('captures multi-line args as a single args string', () => {
    const out = parseSlashCommand('/cmd line1\nline2')
    expect(out).toEqual({ command: 'cmd', args: 'line1\nline2' })
  })
})
