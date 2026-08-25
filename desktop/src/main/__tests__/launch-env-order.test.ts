/**
 * The launch-environment repair must run before any other main-process module.
 *
 * THE DEFECT THIS PINS:
 * `sanitizeLaunchEnvironment()` repairs `process.env`. Everything that spawns a
 * shell inherits `process.env` — `cli-env.ts` probes PATH with `execFileSync`,
 * and `terminal-manager.ts` builds every PTY environment from it. If the repair
 * runs after those modules have already been evaluated and cached a result, the
 * repair is too late to matter: `getCliPath()` memoizes the stripped PATH it
 * discovered while the privilege marker was still set, and every pane for the
 * rest of the process lifetime gets that PATH.
 *
 * The ordering cannot be expressed as a plain call in index.ts, because ES
 * import declarations are HOISTED: a call written between two imports still
 * runs after all of them. It is a side-effect import for that reason, and a
 * refactor that "tidies" it into a function call inside setup would silently
 * reintroduce the bug with every test still green. This file is what fails
 * instead.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mainDir = join(__dirname, '..')
const indexSource = readFileSync(join(mainDir, 'index.ts'), 'utf8')
const initSource = readFileSync(join(mainDir, 'launch-env-init.ts'), 'utf8')

/** Module specifiers of every static import in a source file, in source order. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const pattern = /^import\s+(?:[^'"]*?\bfrom\s+)?['"]([^'"]+)['"]/gm
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) specifiers.push(match[1])
  return specifiers
}

describe('main entry point launch order', () => {
  it('imports the launch-environment repair before any other module', () => {
    const specifiers = importSpecifiers(indexSource)

    expect(specifiers.length).toBeGreaterThan(1)
    // First, with nothing before it. A module imported earlier could spawn a
    // shell — or memoize a PATH — while the environment is still contaminated.
    expect(specifiers[0]).toBe('./launch-env-init')
  })

  it('performs the repair as an import side effect, not a hoisted-away call', () => {
    // A bare `sanitizeLaunchEnvironment()` written among the imports in
    // index.ts would compile, read correctly, and run too late.
    expect(indexSource).not.toMatch(/^\s*sanitizeLaunchEnvironment\(\)/m)
    expect(initSource).toMatch(/^sanitizeLaunchEnvironment\(\)/m)
  })
})
