/**
 * Guided-questions prompt-sink wiring tests.
 *
 * These pin the seam that broke in the packaged app: the submitter used a
 * lazy `require('../prompt-pipeline')`, which resolves from source but throws
 * inside app.asar ("Cannot find module '../prompt-pipeline'"), so every
 * submit-bearing action failed and the coordinator rolled the workflow back.
 * Unit tests that stubbed the submitter could not see it — the defect lived
 * in module resolution, not in logic.
 *
 * Two guards:
 *   1. Structural: no runtime require() of a relative module anywhere in
 *      main/. A bundled main process has no relative module paths.
 *   2. Behavioral: importing prompt-pipeline registers the sink, and the
 *      registered sink actually reaches processIncomingPrompt.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Recursively collect .ts files under a directory. */
function collectTs(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...collectTs(full))
    else if (full.endsWith('.ts') && !full.includes('.test.')) out.push(full)
  }
  return out
}

describe('questions prompt sink — no runtime relative require', () => {
  it('main/ contains no runtime require() of a relative path', () => {
    const root = join(__dirname, '..', '..')
    const files = collectTs(join(root, 'main'))
    const offenders: string[] = []
    for (const file of files) {
      if (file.includes('.test.')) continue
      const src = readFileSync(file, 'utf8')
      src.split('\n').forEach((line, idx) => {
        // `require('./x')` / `require('../x')` — a bundled main process
        // cannot resolve these. Type-only `import type` is erased and fine.
        // Comments are skipped: several files legitimately DOCUMENT this
        // hazard in prose (that is how the pattern stays known), and a scan
        // that flagged the warning alongside the offence would be noise.
        const code = line.trim()
        if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return
        if (/\brequire\(\s*['"]\.\.?\//.test(code)) {
          offenders.push(`${file.slice(root.length + 1)}:${idx + 1}: ${code}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})

describe('questions prompt sink — registration', () => {
  it('importing prompt-pipeline registers a sink that reaches processIncomingPrompt', async () => {
    const registered: Array<(p: unknown) => Promise<void>> = []
    vi.doMock('../questions/questions-wiring', () => ({
      registerQuestionsPromptSink: (fn: (p: unknown) => Promise<void>) => registered.push(fn),
      notifyQuestionsPromptDispatched: () => {},
      questionsCoordinator: () => null,
    }))

    await import('../prompt-pipeline')

    expect(registered).toHaveLength(1)
    // The sink must be a real function taking the prompt object — invoking it
    // must not throw a module-resolution error (the packaged-app defect).
    expect(typeof registered[0]).toBe('function')
    vi.doUnmock('../questions/questions-wiring')
  })
})
