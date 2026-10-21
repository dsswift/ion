import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * docs-hook-names.test.ts — prose parity for hook names.
 *
 * The SDK parity machinery pins the REGISTRATION surface: engine constants,
 * the TS HookPayloadMap keys, the Go SDK constants, and the generated
 * contract manifest all agree, byte for byte. Doc-comment prose and markdown
 * examples are its designed blind spot — which is exactly where a fictional
 * hook name survived for months: `before_tool_call` appeared in the traceId
 * JSDoc example, the TS SDK guide, and the hooks reference, teaching a name
 * that never existed anywhere. TypeScript's typed on() saved anyone who
 * copied the example with a compile error, but Go's untyped On() escape
 * hatch and every non-compiled surface (markdown, comments) have no such
 * guard.
 *
 * This test closes the class, not just the instance: every string that LOOKS
 * like a hook name in the SDK sources and the extension/hook docs must BE a
 * hook name in the contract manifest (engine/internal/extension/testdata/
 * sdk_contract.json — generated from the engine's registry, the same golden
 * the TS and Go SDK parity tests pin against).
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..')

const MANIFEST = join(REPO_ROOT, 'engine', 'internal', 'extension', 'testdata', 'sdk_contract.json')

/** Files and directories whose prose must only name real hooks. */
const PROSE_SURFACES = [
  join(REPO_ROOT, 'engine', 'extensions', 'sdk', 'ion-sdk'),
  join(REPO_ROOT, 'sdk', 'go'),
  join(REPO_ROOT, 'docs', 'hooks'),
  join(REPO_ROOT, 'docs', 'extensions'),
]

const SCANNED_EXTENSIONS = new Set(['.ts', '.go', '.md'])

/**
 * Two capture strategies:
 *
 * 1. Registration calls in example code — ion.on('name'), sdk.On("name"),
 *    ion.OnHook(sdk, "name"). These are unambiguous hook claims wherever
 *    they appear.
 * 2. Backticked snake_case identifiers on any LINE whose prose mentions
 *    "hook". Line-scoped rather than adjacency-scoped because the original
 *    escapee sat mid-list — "(`before_prompt`, `before_tool_call`, ...)" —
 *    where an adjacency pattern catches only the first name. Lines about
 *    hooks routinely also name events, fields, and functions in backticks,
 *    so matches are filtered to underscore-bearing identifiers and checked
 *    against the manifest's hooks plus NON_HOOK_TERMS.
 */
const REGISTRATION_PATTERNS: RegExp[] = [
  /\bon\(\s*['"]([a-z][a-z0-9_]*)['"]/g,
  /\bOn(?:Hook)?\(\s*(?:sdk\s*,\s*)?"([a-z][a-z0-9_]*)"/g,
]

/**
 * A hook CLAIM in prose, as opposed to a hook-adjacent mention. Two shapes:
 *
 *   `name` hook / `name` hooks     — "the `tool_call` hook fires..."
 *   hooks ... (`a`, `b`, ...)      — "Hooks that fire during a run
 *                                     (`before_prompt`, `tool_call`, ...)"
 *
 * The parenthetical shape is what the original escapee hid in: an adjacency
 * pattern catches only the identifier touching the word "hook", and
 * `before_tool_call` sat mid-list. The paren must OPEN with a backtick so
 * ordinary call signatures — callTool(name, input) — and prose parentheticals
 * that merely contain the word never match.
 */
const HOOK_ADJACENT = /`([a-z][a-z0-9_]*_[a-z0-9_]*)`\s+hooks?\b/g
const HOOK_LIST_PAREN = /\bhooks?\b[^()\n]{0,60}\((`[^)\n]*)\)/gi
const BACKTICKED_IDENT = /`([a-z][a-z0-9_]*_[a-z0-9_]*)`/g

/**
 * Identifiers the adjacency patterns catch that are legitimately not hook
 * names (generic prose like "the `session_start` hook fires" is a hook, but
 * "veto-capable `*_registered` hooks" carries a glob). Keep this list empty
 * unless a false positive genuinely cannot be rephrased; every entry must
 * cite the file that needs it.
 */
const ALLOWLIST = new Set<string>([
  // docs/extensions/sdk-go.md § untyped On(): a deliberately-fictional name
  // illustrating the escape hatch for hooks a compiled SDK version predates.
  // The surrounding prose marks it as hypothetical.
  'some_future_hook',
])

function collectFiles(root: string): string[] {
  const out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'testdata' || entry.startsWith('.')) continue
    const full = join(root, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...collectFiles(full))
    } else {
      const dot = entry.lastIndexOf('.')
      if (dot >= 0 && SCANNED_EXTENSIONS.has(entry.slice(dot))) out.push(full)
    }
  }
  return out
}

describe('hook names in docs and SDK prose exist in the contract manifest', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8')) as { hooks: Record<string, unknown> }
  const realHooks = new Set(Object.keys(manifest.hooks))

  it('manifest sanity: the registry is present and non-trivial', () => {
    expect(realHooks.size).toBeGreaterThan(10)
    expect(realHooks.has('tool_call')).toBe(true)
  })

  const files = PROSE_SURFACES.flatMap(collectFiles)

  it('found the surfaces to scan', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it('every hook-shaped usage names a real hook', () => {
    const violations: string[] = []
    const flag = (file: string, lineNo: number, name: string, line: string): void => {
      violations.push(
        `${relative(REPO_ROOT, file)}:${lineNo} names non-existent hook '${name}' ` +
          `(line: ${line.trim().slice(0, 100)})`,
      )
    }
    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      const lines = content.split('\n')

      // Strategy 1: registration calls anywhere in the file.
      for (const re of REGISTRATION_PATTERNS) {
        re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(content)) !== null) {
          const name = m[1]
          if (realHooks.has(name) || ALLOWLIST.has(name)) continue
          // Bare words like on('line') in transport code are stream events,
          // not hook claims; only underscore-bearing names are flagged.
          if (!name.includes('_')) continue
          const lineNo = content.slice(0, m.index).split('\n').length
          flag(file, lineNo, name, lines[lineNo - 1] ?? '')
        }
      }

      // Strategy 2: prose hook claims, line by line.
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (!/\bhooks?\b/i.test(line)) continue

        HOOK_ADJACENT.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = HOOK_ADJACENT.exec(line)) !== null) {
          const name = m[1]
          if (realHooks.has(name) || ALLOWLIST.has(name)) continue
          flag(file, i + 1, name, line)
        }

        HOOK_LIST_PAREN.lastIndex = 0
        let p: RegExpExecArray | null
        while ((p = HOOK_LIST_PAREN.exec(line)) !== null) {
          BACKTICKED_IDENT.lastIndex = 0
          let ident: RegExpExecArray | null
          while ((ident = BACKTICKED_IDENT.exec(p[1])) !== null) {
            const name = ident[1]
            if (realHooks.has(name) || ALLOWLIST.has(name)) continue
            flag(file, i + 1, name, line)
          }
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([])
  })
})
