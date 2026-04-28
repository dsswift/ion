/**
 * IPC Input Validation Tests
 *
 * Tests for the security validation functions used by IPC handlers
 * to reject malicious input from the renderer process.
 *
 * Related spec: specs/issue-ion-1-harden-ipc-input-validation.tests.md
 */

import { describe, it, expect } from 'vitest'
import {
  isValidProjectPath,
  isValidSessionId,
  validateExternalUrl,
  shellSingleQuote,
  escapeAppleScript,
} from '../ipc-validation'

// ─── Fixtures ───

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'

// ─── TC-001: LIST_SESSIONS Rejects Invalid projectPath ───

describe('TC-001: projectPath validation (LIST_SESSIONS)', () => {
  it('rejects path containing null byte', () => {
    expect(isValidProjectPath('/tmp/test\0injected')).toBe(false)
  })

  it('rejects path containing newline', () => {
    expect(isValidProjectPath('/tmp/test\ninjected')).toBe(false)
  })

  it('rejects relative path', () => {
    expect(isValidProjectPath('../etc/passwd')).toBe(false)
  })

  it('accepts valid absolute path', () => {
    expect(isValidProjectPath('/tmp/test')).toBe(true)
  })

  it('rejects path containing carriage return', () => {
    expect(isValidProjectPath('/tmp/test\rinjected')).toBe(false)
  })

  it('rejects path containing CRLF', () => {
    expect(isValidProjectPath('/tmp/test\r\ninjected')).toBe(false)
  })

  it('accepts root path', () => {
    expect(isValidProjectPath('/')).toBe(true)
  })

  it('accepts path with spaces', () => {
    expect(isValidProjectPath('/Users/test/my project')).toBe(true)
  })
})

// ─── TC-002: LOAD_SESSION Rejects Non-UUID sessionId ───

describe('TC-002: sessionId UUID validation (LOAD_SESSION)', () => {
  it('rejects path traversal sessionId', () => {
    expect(isValidSessionId('../../etc/passwd')).toBe(false)
  })

  it('rejects shell injection sessionId', () => {
    expect(isValidSessionId('; rm -rf /')).toBe(false)
  })

  it('rejects sessionId containing path separator', () => {
    expect(isValidSessionId('abc/def')).toBe(false)
  })

  it('accepts valid UUID sessionId', () => {
    expect(isValidSessionId(VALID_UUID)).toBe(true)
  })

  it('rejects empty string', () => {
    expect(isValidSessionId('')).toBe(false)
  })

  it('accepts engine-generated session IDs', () => {
    expect(isValidSessionId('1776636257802')).toBe(true)
    expect(isValidSessionId(VALID_UUID + '-extra')).toBe(true)
  })

  it('accepts uppercase UUID', () => {
    expect(isValidSessionId(VALID_UUID.toUpperCase())).toBe(true)
  })
})

// ─── TC-003: LOAD_SESSION Rejects Invalid projectPath ───

describe('TC-003: projectPath validation (LOAD_SESSION)', () => {
  it('rejects path with null byte', () => {
    expect(isValidProjectPath('/tmp/test\0inject')).toBe(false)
  })

  it('rejects path with CRLF', () => {
    expect(isValidProjectPath('/tmp/test\r\ninject')).toBe(false)
  })

  it('rejects relative path', () => {
    expect(isValidProjectPath('../etc')).toBe(false)
  })

  it('rejects bare filename', () => {
    expect(isValidProjectPath('passwd')).toBe(false)
  })
})

// ─── TC-004: OPEN_EXTERNAL URL Constructor Validation ───

describe('TC-004: URL validation (OPEN_EXTERNAL)', () => {
  it('rejects javascript: protocol', () => {
    expect(validateExternalUrl('javascript:alert(1)')).toBeNull()
  })

  it('rejects file: protocol', () => {
    expect(validateExternalUrl('file:///etc/passwd')).toBeNull()
  })

  it('rejects http:// with empty hostname', () => {
    // The URL constructor parses "http://" as having an empty hostname
    expect(validateExternalUrl('http://')).toBeNull()
  })

  it('rejects unparseable string', () => {
    expect(validateExternalUrl('not-a-url')).toBeNull()
  })

  it('accepts valid https URL', () => {
    const result = validateExternalUrl('https://example.com')
    expect(result).not.toBeNull()
    expect(result).toBe('https://example.com/')
  })

  it('accepts valid http URL', () => {
    const result = validateExternalUrl('http://example.com/path?q=1')
    expect(result).not.toBeNull()
    expect(result).toContain('http://example.com/path')
  })

  it('rejects data: URI', () => {
    expect(validateExternalUrl('data:text/html,<script>alert(1)</script>')).toBeNull()
  })

  it('rejects ftp: protocol', () => {
    expect(validateExternalUrl('ftp://evil.com/payload')).toBeNull()
  })

  it('normalizes URL via constructor (returns parsed.href)', () => {
    const result = validateExternalUrl('https://EXAMPLE.COM/Path')
    expect(result).toBe('https://example.com/Path')
  })
})

// ─── TC-005: Shell Escaping Utilities ───

describe('TC-005: shell escaping utilities', () => {
  it('wraps path in single quotes', () => {
    const result = shellSingleQuote('/Users/test/my project')
    expect(result).toBe("'/Users/test/my project'")
  })

  it('escapes single quote as end-quote + escaped-literal + reopen-quote', () => {
    const result = shellSingleQuote("/Users/test/it's a path")
    expect(result).toBe("'/Users/test/it'\\''s a path'")
  })

  it('does not expand $() inside single quotes', () => {
    const result = shellSingleQuote('/Users/$(whoami)/project')
    expect(result).toBe("'/Users/$(whoami)/project'")
    expect(result).not.toContain('"')
  })

  it('does not expand backticks inside single quotes', () => {
    const result = shellSingleQuote('/Users/`whoami`/project')
    expect(result).toBe("'/Users/`whoami`/project'")
  })

  describe('escapeAppleScript', () => {
    it('escapes double quotes', () => {
      expect(escapeAppleScript('say "hello"')).toBe('say \\"hello\\"')
    })

    it('doubles backslashes', () => {
      expect(escapeAppleScript('path\\to\\file')).toBe('path\\\\to\\\\file')
    })
  })
})
