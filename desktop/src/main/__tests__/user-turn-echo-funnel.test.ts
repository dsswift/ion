/**
 * Structural gate: every user-turn echo goes through the ONE funnel.
 *
 * ── What this protects ──────────────────────────────────────────────────────
 *
 * A user turn does not ride engine events, so each surface that did not
 * perform the optimistic insert has to be told separately — the Studio mirror
 * via `notifyStudioUserMessageEcho`, iOS via `desktop_message_added`. That
 * makes every echo call site an independent path to the transcript, and any
 * rule about whether a turn should be VISIBLE has to hold at all of them.
 *
 * This is not hypothetical. A Guided Questions submission was correctly
 * suppressed in the owner store and correctly classified on the engine's
 * persisted row, and the message still appeared — because the Studio mirror
 * echo is a separate source that never consulted the classification. The
 * Overlay hid it; the Studio presentation showed it. Fixing that one site
 * would have left five others and the next author to rediscover the rule.
 *
 * So the rule lives in `main/user-turn-echo.ts`, and this test fails the
 * build when a new direct echo appears outside it. The next person who needs
 * a hidden message class classifies the kind in the engine and gets every
 * surface at once — no archaeology, no per-site patch.
 *
 * ── If this test fails ──────────────────────────────────────────────────────
 *
 * Do not add a suppression check to your call site. Call `echoUserTurn`
 * instead. If your case genuinely cannot use the funnel, tag the line
 * `// user-turn-echo-ok: <reason>` and state what applies the classification.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAIN_DIR = join(__dirname, '..')
/** The funnel itself, and the low-level pusher it is built on. */
const ALLOWED_FILES = new Set(['user-turn-echo.ts', 'studio-window-manager.ts'])

function collectTs(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue
      out.push(...collectTs(full))
    } else if (full.endsWith('.ts') && !full.includes('.test.')) {
      out.push(full)
    }
  }
  return out
}

/** Lines of code (comments stripped) with their 1-based numbers. */
function codeLines(src: string): Array<{ n: number; text: string }> {
  return src.split('\n').map((text, i) => ({ n: i + 1, text })).filter(({ text }) => {
    const t = text.trim()
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
  })
}

describe('user-turn echo funnel', () => {
  it('no direct notifyStudioUserMessageEcho call outside the funnel', () => {
    const offenders: string[] = []
    for (const file of collectTs(MAIN_DIR)) {
      const name = file.slice(MAIN_DIR.length + 1)
      if (ALLOWED_FILES.has(name)) continue
      const src = readFileSync(file, 'utf8')
      for (const { n, text } of codeLines(src)) {
        if (text.includes('user-turn-echo-ok:')) continue
        // A call, not the import that makes the funnel work.
        if (/notifyStudioUserMessageEcho\s*\(/.test(text)) {
          offenders.push(`${name}:${n}: ${text.trim()}`)
        }
      }
    }
    expect(offenders, 'call echoUserTurn (main/user-turn-echo.ts) instead').toEqual([])
  })

  it("no direct desktop_message_added send with role 'user' outside the funnel", () => {
    const offenders: string[] = []
    for (const file of collectTs(MAIN_DIR)) {
      const name = file.slice(MAIN_DIR.length + 1)
      if (ALLOWED_FILES.has(name)) continue
      const src = readFileSync(file, 'utf8')
      const lines = src.split('\n')
      lines.forEach((line, idx) => {
        if (!line.includes("'desktop_message_added'") && !line.includes('"desktop_message_added"')) return
        // Read the following window for a user role — the payload is a
        // multi-line object literal, so a single-line regex cannot see it.
        const window = lines.slice(idx, idx + 12).join('\n')
        if (window.includes('user-turn-echo-ok:')) return
        if (/role:\s*['"]user['"]/.test(window)) {
          offenders.push(`${name}:${idx + 1}`)
        }
      })
    }
    expect(offenders, 'call echoUserTurn (main/user-turn-echo.ts) instead').toEqual([])
  })

  it('the funnel is the only place suppressesInjection gates an echo', () => {
    // A call site that re-applies the rule locally is the drift this funnel
    // removes: two places to update, and no failure when one is missed. The
    // renderer store and history mapper legitimately read the policy for
    // their own inserts; main's ECHO path reads it exactly once.
    //
    // questions-rehydrate.ts is an allowed non-echo reader: it SCANS a
    // persisted transcript to decide whether a machine-authored turn counts
    // as the operator having answered. That is a question about history, not
    // a decision about publishing a turn to a surface, so it cannot drift
    // with the echo path.
    const users: string[] = []
    for (const file of collectTs(MAIN_DIR)) {
      const name = file.slice(MAIN_DIR.length + 1)
      const src = readFileSync(file, 'utf8')
      // Comment lines are excluded: several files legitimately explain the
      // policy in prose, and flagging prose would train the next author to
      // stop writing it.
      const called = codeLines(src).some(({ text }) => /suppressesInjection\s*\(/.test(text))
      if (called) users.push(name)
    }
    expect(users.sort()).toEqual(['questions/questions-rehydrate.ts', 'user-turn-echo.ts'])
  })
})
