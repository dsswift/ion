/**
 * Single canonical parser for slash-command text.
 *
 * Historically there were three independent regexes scattered across the
 * codebase: `^\/(\S+)\s*(.*)$` in InputBar.tsx, `^\/([a-zA-Z0-9_:-]+)...$`
 * in remote/handlers/slash-intercept.ts, and a permissive read-everything
 * variant elsewhere. The renderer and remote handler could disagree on
 * what counted as a slash command. After the Phase 0 unification, every
 * caller goes through this parser — there is no other slash regex in the
 * codebase.
 *
 * Grammar:
 *
 *   `/` <name> [ <ws> <args> ]
 *
 * Where:
 *   - `<name>` is one or more of `[a-zA-Z0-9_:-]`. The character class is
 *     intentionally conservative so paste-style text like `/path/to/file`
 *     does NOT match — slash commands have identifier-shaped names.
 *   - `<args>` is everything after the first whitespace, verbatim. We do
 *     not parse args; downstream code passes them through to either the
 *     extension's `Execute(args, ctx)` callback or the `.md` template's
 *     `$ARGUMENTS` substitution.
 *
 * Returns `null` when the text is not a slash command. Whitespace-only
 * input and bare `/` (no name) are non-matches.
 */

/** Parsed slash-command components. */
export interface ParsedSlash {
  /** The bare name without the leading `/`. Always non-empty. */
  command: string
  /** Everything after the first whitespace separator. May be empty string. */
  args: string
}

const SLASH_RE = /^\/([a-zA-Z0-9_:-]+)(?:\s+([\s\S]*))?$/

/**
 * Parse free-form text as a slash command.
 *
 * Returns null when the text is not a slash command or the name is not a
 * valid identifier shape. Whitespace surrounding the text is NOT trimmed
 * here — callers are expected to trim once at the entry point. This keeps
 * the parser pure and lets us assert on exact prefix shape in tests.
 *
 * Examples:
 *   parseSlash("/clear")              → { command: "clear", args: "" }
 *   parseSlash("/foo bar baz")        → { command: "foo", args: "bar baz" }
 *   parseSlash("/ion--review 1, 2")   → { command: "ion--review", args: "1, 2" }
 *   parseSlash("hello /clear")        → null  (doesn't start with /)
 *   parseSlash("/path/to/file")       → null  (name char class rejects `/`)
 *   parseSlash("/  ")                 → null  (empty name)
 *   parseSlash("/")                   → null  (bare slash, no name)
 */
export function parseSlash(text: string): ParsedSlash | null {
  if (!text.startsWith('/')) return null
  const m = text.match(SLASH_RE)
  if (!m) return null
  return { command: m[1], args: m[2] ?? '' }
}

/**
 * Test predicate used by debug-only assertions: same shape as parseSlash but
 * returns a boolean. Slightly cheaper because we don't allocate the result
 * object. Kept here so test code doesn't have to import the regex directly.
 */
export function isSlashCommand(text: string): boolean {
  return text.startsWith('/') && SLASH_RE.test(text)
}
