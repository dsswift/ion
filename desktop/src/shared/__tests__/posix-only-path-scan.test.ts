import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Structural gate against POSIX-frozen path checks.
 *
 * The defect class: a path test written as `startsWith('/')`, which is correct
 * on the machine it was written on and rejects every Windows path everywhere
 * else. It fails silently — a validator returns false, the caller returns its
 * empty shape, and nothing logs. Five instances shipped before Ion ran on
 * Windows for the first time:
 *
 *   - ipc-validation.isValidProjectPath  (twelve IPC surfaces went empty)
 *   - explorer-state.isUsablePath        (persisted Windows roots dropped)
 *   - project-workspace.resolveProjectDir (worktree resolution skipped)
 *   - workspace-folder-migration          (mounted folders discarded)
 *   - repo-containment.isWithinRepo       (C:\repo\sub not inside C:\repo)
 *
 * A path check must go through `isAbsolutePath` from shared/paths, or accept
 * both separators explicitly. Anything else carries
 * `// posix-ok: <reason>` naming why the string is not a filesystem path —
 * a slash command, a URL path, an engine socket address.
 */
const ALLOW_MARKER = 'posix-ok:'

// Not filesystem paths, and the reason is stable enough to encode here rather
// than tagging every line: these files parse slash COMMANDS and URLs.
const EXEMPT_FILES = new Set([
  'src/main/slash-parse.ts',
  'src/shared/fuzzy-match.ts',
])

// Same walker shape as theme/hardcoded-colors-scan.test.ts, which is the
// established pattern for a structural scan in this codebase.
function collectSources(path: string): string[] {
  const st = statSync(path)
  if (st.isFile()) {
    return /\.(ts|tsx)$/.test(path) && !/\.test\./.test(path) ? [path] : []
  }
  if (path.includes('__tests__') || path.includes('node_modules')) return []
  return readdirSync(path).flatMap((entry) => collectSources(join(path, entry))).sort()
}

describe('no POSIX-only absolute-path checks', () => {
  it('every startsWith slash test is Windows-aware or tagged', () => {
    const offenders: string[] = []

    for (const file of collectSources('src')) {
      const rel = file.replace(/\\/g, '/')
      if ([...EXEMPT_FILES].some((e) => rel.endsWith(e))) continue
      const lines = readFileSync(file, 'utf-8').split('\n')

      lines.forEach((line, i) => {
        // The literal check, in either quote style.
        if (!/startsWith\((['"])\/\1\)/.test(line)) return
        // A comment describing the defect is not the defect.
        if (line.trim().startsWith('*') || line.trim().startsWith('//')) return
        // Accepting both separators on the same line is correct by itself.
        if (line.includes("'\\\\'") || line.includes('\\\\\\\\')) return
        // The tag may sit on the line itself or in the comment immediately
        // above it, because the explanation is usually too long to trail a
        // line of real code.
        if (line.includes(ALLOW_MARKER)) return
        if (lines.slice(Math.max(0, i - 3), i).some((l) => l.includes(ALLOW_MARKER))) return
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
      })
    }

    expect(offenders, [
      'POSIX-only path checks found. Use isAbsolutePath from shared/paths,',
      'or tag the line `// posix-ok: <reason>` when the string is not a',
      'filesystem path (a slash command, a URL, a socket address).',
      ...offenders,
    ].join('\n')).toEqual([])
  })
})
