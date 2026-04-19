/**
 * IPC input validation utilities.
 *
 * Pure functions used by IPC handlers to validate untrusted input
 * from the renderer process before any side effects.
 */

/** UUID v4 pattern -- only accepts canonical lowercase/uppercase hex UUIDs */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Validate a projectPath for use in filesystem operations.
 * Rejects null bytes, carriage returns, newlines, and non-absolute paths.
 */
export function isValidProjectPath(path: string): boolean {
  if (/[\0\r\n]/.test(path)) return false
  if (!path.startsWith('/')) return false
  return true
}

/**
 * Validate a sessionId as a strict UUID v4 string.
 * Prevents path traversal via crafted session IDs like `../../etc/passwd`.
 */
export function isValidSessionId(sessionId: string): boolean {
  return UUID_RE.test(sessionId)
}

/**
 * Validate and normalize a URL for external opening.
 * Uses the URL constructor for strict parsing, then checks protocol and hostname.
 *
 * Returns the normalized href if valid, or null if the URL should be rejected.
 */
export function validateExternalUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (!parsed.hostname) return null
    return parsed.href
  } catch {
    return null
  }
}

/**
 * Escape a string for safe embedding inside single quotes in a shell command.
 *
 * Single-quoted strings in POSIX shells do not expand variables ($), backticks,
 * or backslashes. The only character that needs escaping is the single quote
 * itself, done by ending the quoted string, adding an escaped literal quote,
 * and reopening the quoted string: ' -> '\''
 */
export function shellSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/**
 * Escape a string for embedding inside an AppleScript double-quoted string.
 * Doubles backslashes and escapes double quotes.
 */
export function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Build the AppleScript-safe shell command for opening a terminal session.
 *
 * Combines single-quote shell escaping with AppleScript string escaping
 * to prevent injection in both layers.
 */
export function buildTerminalCommand(
  projectPath: string,
  claudeBin: string,
  sessionId: string | null,
): string {
  const safeDir = escapeAppleScript(shellSingleQuote(projectPath))
  if (sessionId) {
    return `cd ${safeDir} && ${claudeBin} --resume ${sessionId}`
  }
  return `cd ${safeDir} && ${claudeBin}`
}
