/**
 * Marketplace Input Validation Tests
 *
 * Tests for security validation in installPlugin and uninstallPlugin
 * that reject malicious plugin names, repo formats, source paths,
 * and directory traversal attempts.
 *
 * Related spec: specs/issue-coda-2-add-marketplace-input-validation.tests.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Module mocks (must be before imports) ───

vi.mock('electron', () => ({
  net: {
    request: vi.fn(() => {
      const handlers: Record<string, Function> = {}
      return {
        on: vi.fn((event: string, cb: Function) => { handlers[event] = cb }),
        end: vi.fn(() => {
          if (handlers['response']) {
            const responseHandlers: Record<string, Function> = {}
            const response = {
              statusCode: 200,
              on: vi.fn((event: string, cb: Function) => {
                responseHandlers[event] = cb
              }),
            }
            handlers['response'](response)
            if (responseHandlers['data']) {
              responseHandlers['data'](Buffer.from('name: test-skill\ndescription: A test skill\n\n# Test'))
            }
            if (responseHandlers['end']) {
              responseHandlers['end']()
            }
          }
        }),
      }
    }),
  },
}))

vi.mock('fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  readFile: vi.fn(async () => '{}'),
  readdir: vi.fn(async () => []),
}))

vi.mock('os', () => ({
  homedir: vi.fn(() => '/mock-home'),
}))

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, '', '')
  }),
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
}))

vi.mock('../cli-env', () => ({
  getCliEnv: vi.fn(() => ({})),
}))

import { installPlugin, uninstallPlugin } from '../marketplace/catalog'
import { mkdir, writeFile, rm } from 'fs/promises'

// ─── Fixtures ───

const VALID_REPO = 'anthropics/skills'
const VALID_PLUGIN_NAME = 'my-skill'
const VALID_MARKETPLACE = 'Agent Skills'
const VALID_SOURCE_PATH = 'skills/my-skill'
const LONG_NAME = 'a'.repeat(129) // exceeds 128-char limit

// ─── Helpers ───

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── TC-001: installPlugin Rejects Invalid pluginName ───

describe('TC-001: installPlugin rejects invalid pluginName', () => {
  it('rejects path traversal (../../etc/passwd)', async () => {
    const result = await installPlugin(VALID_REPO, '../../etc/passwd', VALID_MARKETPLACE, VALID_SOURCE_PATH, true)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Invalid plugin name')
  })

  it('rejects dot-prefixed name (.hidden)', async () => {
    const result = await installPlugin(VALID_REPO, '.hidden', VALID_MARKETPLACE, VALID_SOURCE_PATH, true)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Invalid plugin name')
  })

  it('rejects name containing slash (foo/bar)', async () => {
    const result = await installPlugin(VALID_REPO, 'foo/bar', VALID_MARKETPLACE, VALID_SOURCE_PATH, true)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Invalid plugin name')
  })

  it('rejects name containing null byte (foo\\0bar)', async () => {
    const result = await installPlugin(VALID_REPO, 'foo\0bar', VALID_MARKETPLACE, VALID_SOURCE_PATH, true)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Invalid plugin name')
  })

  it('rejects empty string', async () => {
    const result = await installPlugin(VALID_REPO, '', VALID_MARKETPLACE, VALID_SOURCE_PATH, true)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Invalid plugin name')
  })

  it('rejects name exceeding 128 characters', async () => {
    const result = await installPlugin(VALID_REPO, LONG_NAME, VALID_MARKETPLACE, VALID_SOURCE_PATH, true)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Invalid plugin name')
  })

  it('does not perform filesystem operations for invalid names', async () => {
    await installPlugin(VALID_REPO, '../../etc/passwd', VALID_MARKETPLACE, VALID_SOURCE_PATH, true)
    expect(mkdir).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
  })
})

// ─── TC-002: installPlugin Rejects Invalid Repo Format ───

describe('TC-002: installPlugin rejects invalid repo format', () => {
  it('rejects repo without slash (not-a-repo)', async () => {
    const result = await installPlugin('not-a-repo', VALID_PLUGIN_NAME, VALID_MARKETPLACE, VALID_SOURCE_PATH, true)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Invalid repo format')
  })

  it('rejects repo with extra segments (owner/repo/extra)', async () => {
    const result = await installPlugin('owner/repo/extra', VALID_PLUGIN_NAME, VALID_MARKETPLACE, VALID_SOURCE_PATH, true)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Invalid repo format')
  })

  it('rejects repo with spaces (owner/ repo)', async () => {
    const result = await installPlugin('owner/ repo', VALID_PLUGIN_NAME, VALID_MARKETPLACE, VALID_SOURCE_PATH, true)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Invalid repo format')
  })

  it('accepts valid repo format (anthropics/skills)', async () => {
    const result = await installPlugin(VALID_REPO, VALID_PLUGIN_NAME, VALID_MARKETPLACE, VALID_SOURCE_PATH, true)
    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
  })
})

// ─── TC-003: installPlugin Rejects Invalid sourcePath ───

describe('TC-003: installPlugin rejects invalid sourcePath', () => {
  it('rejects path traversal (../../../etc)', async () => {
    const result = await installPlugin(VALID_REPO, VALID_PLUGIN_NAME, VALID_MARKETPLACE, '../../../etc', true)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Invalid source path')
  })

  it('rejects absolute path (/absolute/path)', async () => {
    const result = await installPlugin(VALID_REPO, VALID_PLUGIN_NAME, VALID_MARKETPLACE, '/absolute/path', true)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Invalid source path')
  })

  it('rejects path containing null byte (skills/foo\\0bar)', async () => {
    const result = await installPlugin(VALID_REPO, VALID_PLUGIN_NAME, VALID_MARKETPLACE, 'skills/foo\0bar', true)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Invalid source path')
  })

  it('rejects path containing backslash (skills\\\\foo)', async () => {
    const result = await installPlugin(VALID_REPO, VALID_PLUGIN_NAME, VALID_MARKETPLACE, 'skills\\foo', true)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Invalid source path')
  })

  it('allows undefined sourcePath (optional parameter)', async () => {
    const result = await installPlugin(VALID_REPO, VALID_PLUGIN_NAME, VALID_MARKETPLACE, undefined, true)
    // Should not fail with source path validation error
    if (result.error) {
      expect(result.error).not.toContain('Invalid source path')
    }
  })

  it('accepts valid sourcePath (skills/my-skill)', async () => {
    const result = await installPlugin(VALID_REPO, VALID_PLUGIN_NAME, VALID_MARKETPLACE, VALID_SOURCE_PATH, true)
    expect(result.ok).toBe(true)
  })
})

// ─── TC-004: assertSkillDirContained Prevents Directory Escape ───

describe('TC-004: directory containment prevents escape', () => {
  it('allows valid contained path through installPlugin', async () => {
    const result = await installPlugin(VALID_REPO, 'valid-plugin', VALID_MARKETPLACE, VALID_SOURCE_PATH, true)
    expect(result.ok).toBe(true)
  })

  it('rejects pluginName with double-dot traversal that would escape base', async () => {
    // Double-dot is caught by pluginName regex, but this tests defense-in-depth
    const result = await installPlugin(VALID_REPO, '..', VALID_MARKETPLACE, VALID_SOURCE_PATH, true)
    expect(result.ok).toBe(false)
    // Caught either by plugin name validation or containment check
    expect(result.error).toBeDefined()
  })
})

// ─── TC-005: uninstallPlugin Rejects Invalid pluginName ───

describe('TC-005: uninstallPlugin rejects invalid pluginName', () => {
  it('rejects path traversal (../../etc)', async () => {
    const result = await uninstallPlugin('../../etc')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Invalid plugin name')
  })

  it('rejects dot-prefixed name (.hidden)', async () => {
    const result = await uninstallPlugin('.hidden')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Invalid plugin name')
  })

  it('rejects name containing null byte', async () => {
    const result = await uninstallPlugin('foo\0bar')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Invalid plugin name')
  })

  it('does not call rm for invalid names', async () => {
    await uninstallPlugin('../../etc')
    await uninstallPlugin('.hidden')
    await uninstallPlugin('foo\0bar')
    expect(rm).not.toHaveBeenCalled()
  })

  it('proceeds to rm for valid pluginName', async () => {
    const result = await uninstallPlugin('my-plugin')
    expect(result.ok).toBe(true)
    expect(rm).toHaveBeenCalled()
  })
})

// ─── TC-006: Valid Inputs Pass Through to Operations ───

describe('TC-006: valid inputs pass through to operations', () => {
  it('installPlugin creates directory and writes SKILL.md', async () => {
    const result = await installPlugin(VALID_REPO, VALID_PLUGIN_NAME, VALID_MARKETPLACE, VALID_SOURCE_PATH, true)
    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
    expect(mkdir).toHaveBeenCalledWith(
      expect.stringContaining(`skills/${VALID_PLUGIN_NAME}`),
      { recursive: true },
    )
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('SKILL.md'),
      expect.any(String),
      'utf-8',
    )
  })

  it('uninstallPlugin calls rm on the skill directory', async () => {
    const result = await uninstallPlugin(VALID_PLUGIN_NAME)
    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
    expect(rm).toHaveBeenCalledWith(
      expect.stringContaining(`skills/${VALID_PLUGIN_NAME}`),
      { recursive: true, force: true },
    )
  })

  it('neither returns a validation error for valid inputs', async () => {
    const installResult = await installPlugin(VALID_REPO, VALID_PLUGIN_NAME, VALID_MARKETPLACE, VALID_SOURCE_PATH, true)
    const uninstallResult = await uninstallPlugin(VALID_PLUGIN_NAME)
    expect(installResult.error).toBeUndefined()
    expect(uninstallResult.error).toBeUndefined()
  })
})
