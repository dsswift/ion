/**
 * Regression tests for React rules-of-hooks violations in the terminal +
 * conversation split/resize render path.
 *
 * Background (React error #310): commit 326eae9e fixed FileEditor.tsx where
 * three `useSessionStore` calls appeared AFTER an early-return guard, causing
 * a hook-count mismatch that tore the renderer. The crash repro for the
 * broader path was: open terminal panel, resize conversation pane.
 *
 * This test suite performs a static audit of each component in the render
 * path, asserting that no `use*(` call site appears after any component-level
 * early return. It covers:
 *
 *   - TerminalPanel.tsx         (terminal panel wrapper)
 *   - TerminalInstance.tsx      (xterm instance, resize observer)
 *   - TerminalBigScreen.tsx     (big-screen overlay, portal)
 *   - TerminalTabStrip.tsx      (tab strip + resize/tall controls)
 *   - ConversationView.tsx      (scrollable message list)
 *   - ConversationView.tsx       (unified conversation + agent panels)
 *   - StudioCenter.tsx          (split layout, resize container)
 *
 * The tests read source files as text and find the first component-level
 * early return (lines matching `return null`, `return (`, or `return <`)
 * that are NOT inside a hook callback body (i.e., not inside `useEffect`,
 * `useCallback`, `useMemo` argument bodies). Any `use*(` call site found
 * AFTER that line is a React #310 violation.
 *
 * Methodology:
 *   1. Split source into lines.
 *   2. Skip lines that are import statements or comment-only.
 *   3. Find the first line matching EARLY_RETURN_RE outside a hook callback.
 *      We detect hook-callback context by tracking how many `useEffect(/
 *      useCallback(/useMemo(` opens precede an unclosed `)` on the same
 *      nesting level — using a simple "open paren count" heuristic that is
 *      conservative (false negatives are acceptable; false positives are not).
 *   4. From that line onward, assert no line matches HOOK_CALL_RE.
 *
 * Static analysis is chosen over runtime rendering because:
 *   - The violation can exist on a render path that requires specific props
 *     (e.g., a null tab), making runtime detection fragile.
 *   - The test runs in < 1ms with no DOM/React setup needed.
 *   - It will catch regressions immediately when the component is edited.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Matches any React hook call site. Covers useState, useEffect, useCallback,
// useRef, useMemo, useSessionStore, useColors, usePreferencesStore, and any
// custom hook following the use<UpperCase> convention.
const HOOK_CALL_RE = /\buse[A-Z][A-Za-z]*\s*\(/

// Matches component-level early returns (guard patterns that appear at the
// top level of a function body, not inside a nested scope).
//   return null
//   return (<JSX>
//   return <ComponentName>
// Explicitly excludes cleanup-function returns (`return () =>`) that appear
// inside useEffect/useCallback bodies, and `return [...].find(...)` patterns.
const EARLY_RETURN_RE = /\breturn\s+(null\b|<[A-Z]|\((?!\s*\)))/

// Lines that should never be counted as hook call sites.
const IMPORT_RE = /^\s*import\b/
const COMMENT_RE = /^\s*(\/\/|\/\*|\*)/

/**
 * Find the index of the first component-level early return in `lines`.
 * Returns -1 if none found.
 *
 * Strategy: track curly-brace depth across all characters in the file.
 * A line is "at component body level" when the brace depth at the START
 * of that line equals 1 (inside exactly the function body, no nesting).
 * Depth 0 = module scope, depth 1 = inside the component function body
 * directly, depth >= 2 = inside a nested block (if body, callback, etc.).
 *
 * We scan for the first exported uppercase function to locate the
 * component body, reset depth to 0 at that point, then count braces from
 * the opening `{` onward.
 */
function findFirstComponentEarlyReturn(lines: string[]): number {
  let braceDepth = 0
  let componentBodyStarted = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    // Detect the exported React component function body start.
    if (!componentBodyStarted) {
      const isComponentLine =
        /^export\s+(default\s+)?function\s+[A-Z]/.test(trimmed) ||
        /^export\s+const\s+[A-Z][A-Za-z]*\s*[:(]/.test(trimmed) ||
        /^export\s+const\s+[A-Z][A-Za-z]*\s*=\s*(function|\()/.test(trimmed)

      if (isComponentLine) {
        // Count braces on this line. The `{` that opens the body
        // takes depth from 0 to 1.
        braceDepth = 0
        componentBodyStarted = true
      }
    }

    if (!componentBodyStarted) continue

    const depthAtLineStart = braceDepth
    // Count all { and } on this line (ignoring strings/comments for simplicity;
    // this is accurate enough for real React component source files).
    for (const ch of line) {
      if (ch === '{') braceDepth++
      else if (ch === '}') braceDepth--
    }

    // A component-level line has depthAtLineStart === 1:
    // depth 0 = before function opens, depth 1 = inside function body directly.
    if (depthAtLineStart === 1 && !IMPORT_RE.test(line) && !COMMENT_RE.test(trimmed)) {
      if (EARLY_RETURN_RE.test(line)) {
        return i
      }
    }
  }
  return -1
}

/**
 * Find all hook call-site line numbers after `startIndex` in `lines`.
 * Skips import lines and comment lines.
 */
function findHookCallsAfter(lines: string[], startIndex: number): Array<{ lineNumber: number; text: string }> {
  const violations: Array<{ lineNumber: number; text: string }> = []
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (IMPORT_RE.test(line) || COMMENT_RE.test(line.trim())) continue
    if (HOOK_CALL_RE.test(line)) {
      violations.push({ lineNumber: i + 1, text: line.trim() })
    }
  }
  return violations
}

/**
 * Assert a single component file has no hook calls after its first
 * component-level early return.
 */
function assertNoHooksAfterEarlyReturn(sourcePath: string, componentName: string): void {
  const source = readFileSync(sourcePath, 'utf8')
  const lines = source.split('\n')

  const earlyReturnIndex = findFirstComponentEarlyReturn(lines)

  it(`${componentName}: has a component-level early return to guard against`, () => {
    // This assertion documents that the component HAS guards we are protecting.
    // If the guard is removed, the test should be updated (no guard = always clean,
    // but updating keeps the test intentional rather than vacuously passing).
    expect(earlyReturnIndex).toBeGreaterThan(-1)
  })

  it(`${componentName}: no hook calls appear after the first early return (React #310)`, () => {
    if (earlyReturnIndex === -1) {
      // No early return found — component is trivially clean.
      expect(true).toBe(true)
      return
    }

    const violations = findHookCallsAfter(lines, earlyReturnIndex)

    if (violations.length > 0) {
      const detail = violations
        .map((v) => `  line ${v.lineNumber}: ${v.text}`)
        .join('\n')
      const guardLine = `  early return at line ${earlyReturnIndex + 1}: ${lines[earlyReturnIndex].trim()}`
      throw new Error(
        `React #310: hook call(s) found after component-level early return in ${componentName}:\n` +
        `${guardLine}\n` +
        `violations:\n${detail}\n\n` +
        `Fix: move all hook calls above every early return in the component function body.`,
      )
    }

    expect(violations).toHaveLength(0)
  })
}

// ─── Component sources ────────────────────────────────────────────────────────

// All paths resolve relative to this test file:
//   src/renderer/components/__tests__/terminal-split-hooks-order.test.ts
//   → src/renderer/components/TerminalPanel.tsx  etc.

const COMPONENTS_DIR = resolve(__dirname, '..')
const APP_DIR = resolve(__dirname, '..', '..')

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Terminal + conversation split/resize path: React hooks order (React #310)', () => {
  // TerminalPanel: wraps TerminalTabStrip + TerminalInstanceView.
  // Has a `return (...)` as its only return — all hooks must be before it.
  assertNoHooksAfterEarlyReturn(
    resolve(COMPONENTS_DIR, 'TerminalPanel.tsx'),
    'TerminalPanel',
  )

  // TerminalInstanceView: xterm-js singleton pool, ResizeObserver.
  // Has a single `return (...)` — hooks (useRef, useColors, usePreferencesStore)
  // must appear before it.
  assertNoHooksAfterEarlyReturn(
    resolve(COMPONENTS_DIR, 'TerminalInstance.tsx'),
    'TerminalInstanceView',
  )

  // TerminalBigScreen: portal overlay. Has `if (!popoverLayer) return null`
  // followed by `return createPortal(...)`. All hooks must precede the guard.
  assertNoHooksAfterEarlyReturn(
    resolve(COMPONENTS_DIR, 'TerminalBigScreen.tsx'),
    'TerminalBigScreen',
  )

  // TerminalTabStrip: tab strip with scroll + rename state.
  // Has a single `return (...)` — all useState/useCallback/useEffect/useRef
  // must precede it.
  assertNoHooksAfterEarlyReturn(
    resolve(COMPONENTS_DIR, 'TerminalTabStrip.tsx'),
    'TerminalTabStrip',
  )

  // ConversationView: scrollable message list. Has TWO early returns:
  //   1. `if (!tab) return null`          (line ~142)
  //   2. `if (inst.messages.length === 0) return <EmptyState />`  (line ~168)
  // All hooks (useSessionStore, useCallback, useEffect, useMemo,
  // useDomFind) must precede the FIRST guard.
  assertNoHooksAfterEarlyReturn(
    resolve(COMPONENTS_DIR, 'ConversationView.tsx'),
    'ConversationView',
  )

  // ConversationView: the unified conversation view (formerly EngineView) —
  // conversation + agent panels for every tab type. Has an explicit comment at
  // the guard ("all hooks MUST be declared above this point") before the
  // `if (!pane || pane.instances.length === 0) return (...)` guard.
  assertNoHooksAfterEarlyReturn(
    resolve(COMPONENTS_DIR, 'ConversationView.tsx'),
    'ConversationView',
  )

  // StudioCenter (Studio's root split layout, formerly App.tsx before spec 17
  // deleted the Overlay presentation): split pane, resize container,
  // terminal+conversation render branches. Has a single `return (...)` with
  // all hooks before it.
  assertNoHooksAfterEarlyReturn(
    resolve(APP_DIR, 'studio', 'StudioCenter.tsx'),
    'StudioCenter',
  )
})
