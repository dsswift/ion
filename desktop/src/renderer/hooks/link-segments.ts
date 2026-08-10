/**
 * Text segmentation for navigable links — detect file paths and URLs in plain
 * text. Pure, dependency-free, so both the remark plugin (node-env testable)
 * and the React components can share one detector.
 */

export type TextSegment = { type: 'plain' | 'file' | 'url'; value: string }

// Matches: URLs (https://...), absolute paths (/foo/bar), home-relative paths (~/foo/bar), and relative paths (src/foo/bar.ext)
// Relative paths require a file extension to avoid false positives on plain text with slashes
export const LINK_RE = /(https?:\/\/[^\s<>"')\]]+|~\/(?:[a-zA-Z0-9._~-]+\/)*[a-zA-Z0-9._~-]+|\/(?:[a-zA-Z0-9._~-]+\/)+[a-zA-Z0-9._~-]+|[a-zA-Z0-9._~-]+(?:\/[a-zA-Z0-9._~-]+)+\.[a-zA-Z0-9]+)/g

export function segmentText(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  let last = 0
  for (const match of text.matchAll(LINK_RE)) {
    const start = match.index!
    if (start > last) segments.push({ type: 'plain', value: text.slice(last, start) })
    const raw = match[0]
    // Trim trailing punctuation that's likely not part of the path/url
    const trimmed = raw.replace(/[.,;:!?)]+$/, '')
    const isUrl = trimmed.startsWith('http')
    segments.push({ type: isUrl ? 'url' : 'file', value: trimmed })
    // Anything we trimmed off goes back as plain text
    if (trimmed.length < raw.length) {
      segments.push({ type: 'plain', value: raw.slice(trimmed.length) })
    }
    last = start + raw.length
  }
  if (last < text.length) segments.push({ type: 'plain', value: text.slice(last) })
  return segments
}

/** Extensions that open in Ion's own editor rather than the OS handler. */
export const EDITABLE_EXTS = new Set(['.md', '.txt', '.ts', '.tsx', '.js', '.jsx', '.json', '.yaml', '.yml', '.toml', '.py', '.rs', '.go', '.css', '.html'])
