/**
 * The server's Format Versions registry is complete: every version constant in
 * the server and shared sources is registered, or named here as not a format
 * with the reason. A new format cannot ship without `ion fleet` knowing it.
 */
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import { describe, expect, it } from 'vitest'
import { SERVER_FORMAT_REGISTRY, serverFormats } from '../registry'

const REPO = join(__dirname, '..', '..', '..', '..')
const ROOTS = [join(REPO, 'server', 'src'), join(REPO, 'packages', 'shared', 'src')]

/** Version constants that are not a format two builds exchange or store. */
const NOT_FORMATS: Record<string, string> = {
  // Device-local composer drafts; never leave the device that wrote them.
  COMPOSER_STASH_VERSION: 'device-local UI state',
}

const VERSION_CONST = /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*_VERSION)\s*=/gm

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === '__fixtures__' || name === 'node_modules') continue
      out.push(...sourceFiles(path))
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
      out.push(path)
    }
  }
  return out
}

function versionConstants(): Map<string, string> {
  const found = new Map<string, string>()
  for (const root of ROOTS) {
    for (const file of sourceFiles(root)) {
      for (const m of readFileSync(file, 'utf-8').matchAll(VERSION_CONST)) found.set(m[1], relative(REPO, file))
    }
  }
  return found
}

describe('server format registry', () => {
  it('registers every version constant or names why it is not a format', () => {
    const found = versionConstants()
    expect(found.size).toBeGreaterThan(0)
    const registered = new Set(SERVER_FORMAT_REGISTRY.map((f) => f.constant))
    const unregistered = [...found.keys()].filter((c) => !registered.has(c) && !NOT_FORMATS[c]).map((c) => `${c} (${found.get(c)})`)
    expect(unregistered).toEqual([])
    const stale = [...registered, ...Object.keys(NOT_FORMATS)].filter((c) => !found.has(c))
    expect(stale).toEqual([])
  })

  it('publishes complete, unique entries without their source constants', () => {
    const formats = serverFormats()
    expect(new Set(formats.map((f) => f.id)).size).toBe(formats.length)
    for (const f of formats) {
      expect(f.owner).toBe('server')
      expect(f.version).not.toBe('')
      expect(f.meaning).not.toBe('')
      expect(['exact', 'accepts-previous', 'reader-at-least', 'host-storage', 'external']).toContain(f.rule)
      expect(Object.keys(f).sort()).toEqual(['id', 'meaning', 'owner', 'rule', 'version'])
    }
    expect(formats.find((f) => f.id === 'transfer-archive')?.rule).toBe('exact')
  })
})
