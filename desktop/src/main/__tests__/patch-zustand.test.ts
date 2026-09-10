import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { patchZustand } from '../../../scripts/patch-zustand.js'

// The unpatched header line patchZustand looks for (the pre-patch zustand
// 5.x shape): a bare inline selector passed to React.useCallback.
const UNPATCHED_HEADER = `import React from 'react';\nfunction useStore(api, selector = api.getState) {\n  const slice = React.useCallback((state) => selector(state), [api, selector]);\n  return slice;\n}\n`

describe('patchZustand', () => {
  let dir: string
  let target: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-zustand-test-'))
    target = join(dir, 'react.mjs')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('patches an unpatched file once', () => {
    writeFileSync(target, UNPATCHED_HEADER)
    patchZustand(target)
    const patched = readFileSync(target, 'utf8')
    expect(patched).toContain('useRef')
    expect(patched).not.toContain('React.useCallback((state) => selector(state)')
  })

  it('a second run prints already-patched and leaves the file byte-identical', () => {
    writeFileSync(target, UNPATCHED_HEADER)
    patchZustand(target)
    const afterFirst = readFileSync(target, 'utf8')
    patchZustand(target)
    const afterSecond = readFileSync(target, 'utf8')
    expect(afterSecond).toBe(afterFirst)
  })

  it('a missing file is a silent no-op', () => {
    expect(() => patchZustand(join(dir, 'does-not-exist.mjs'))).not.toThrow()
  })
})
