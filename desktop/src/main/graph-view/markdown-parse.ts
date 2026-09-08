/**
 * Markdown document parser: front matter, wikilinks, Markdown links, and
 * section headings. Pure and failure-tolerant by construction — a document
 * whose front matter does not parse is still emitted, because a corpus's
 * broken files are exactly what an operator opens the graph to find.
 *
 * No opinion about field names lives here: front matter is emitted as a raw
 * bag. Identity, labels, grouping, and edge resolution happen a layer up
 * (child 04's graph model).
 */

import { basename } from 'path'
import YAML from 'yaml'
import { debug as _debug } from '../logger'
import type { CorpusDocument } from '../../shared/graph-corpus-types'

function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('main', msg, fields)
}

interface SplitResult {
  yaml: string | null
  body: string
}

/**
 * Split a leading `---`-fenced front-matter block from the body. The
 * recognised form: the file's first line (after stripping a leading BOM) is
 * exactly `---`, and the block ends at the next line that is exactly `---`
 * or `...`. No fence, or no closing fence, means no front matter.
 */
export function splitFrontMatter(text: string): SplitResult {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const lines = stripped.split('\n')
  if (lines[0]?.trimEnd() !== '---') return { yaml: null, body: stripped }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trimEnd()
    if (line === '---' || line === '...') {
      return {
        yaml: lines.slice(1, i).join('\n'),
        body: lines.slice(i + 1).join('\n'),
      }
    }
  }
  // No closing fence found: treat the whole thing as body, not front matter.
  return { yaml: null, body: stripped }
}

interface ParseResult {
  bag: Record<string, unknown>
  parseError?: string
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Parse a YAML front-matter block into a raw bag. Never throws. */
export function parseFrontMatter(yamlText: string): ParseResult {
  let parsed: unknown
  try {
    parsed = YAML.parse(yamlText)
  } catch (err) {
    return { bag: {}, parseError: err instanceof Error ? err.message : String(err) }
  }
  if (parsed === null || parsed === undefined) return { bag: {} }
  if (!isPlainObject(parsed)) return { bag: {}, parseError: 'front matter is not a mapping' }
  return { bag: parsed }
}

/**
 * Replace the CONTENTS of every fenced code block (``` or ~~~, matched fence
 * length) and every inline code span (`...`) with spaces of equal length, so
 * downstream regex offsets stay meaningful while code-embedded link-like
 * text is never extracted.
 */
export function maskCode(body: string): string {
  const lines = body.split('\n')
  const out: string[] = []
  let fenceChar: string | null = null
  let fenceLen = 0

  for (const line of lines) {
    const fenceMatch = /^(\s*)(`{3,}|~{3,})/.exec(line)
    if (fenceChar === null && fenceMatch) {
      fenceChar = fenceMatch[2][0]
      fenceLen = fenceMatch[2].length
      out.push(line)
      continue
    }
    if (fenceChar !== null) {
      const closeRe = new RegExp(`^\\s*(${fenceChar === '`' ? '`' : '~'}{${fenceLen},})\\s*$`)
      if (closeRe.test(line)) {
        fenceChar = null
        out.push(line)
        continue
      }
      out.push(' '.repeat(line.length))
      continue
    }
    // Mask inline code spans (`...`) outside a fence.
    out.push(line.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length)))
  }
  return out.join('\n')
}

/** Extract `[[target]]` and `[[target|alias]]` wikilinks, alias stripped. */
export function extractWikiLinks(masked: string): string[] {
  const out: string[] = []
  const re = /\[\[([^\]\n]+?)\]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(masked)) !== null) {
    const raw = m[1]
    const pipeIdx = raw.indexOf('|')
    const target = (pipeIdx >= 0 ? raw.slice(0, pipeIdx) : raw).trim()
    if (target) out.push(target)
  }
  return out
}

const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i

/** Extract `[label](target.md)` Markdown links whose target ends in `.md`. */
export function extractMarkdownLinks(masked: string): string[] {
  const out: string[] = []
  const re = /\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(masked)) !== null) {
    let target = m[1]
    if (URL_SCHEME_RE.test(target)) continue
    const hashIdx = target.indexOf('#')
    if (hashIdx >= 0) target = target.slice(0, hashIdx)
    if (!/\.md$/i.test(target)) continue
    out.push(target)
  }
  return out
}

/** Extract ATX heading text of level 2 or deeper, trimmed. */
export function extractSections(masked: string): string[] {
  const out: string[] = []
  const re = /^#{2,6}\s+(.+?)\s*#*\s*$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(masked)) !== null) {
    out.push(m[1].trim())
  }
  return out
}

export interface FileStat {
  size: number
  mtimeMs: number
}

/** Parse one Markdown file's text into a `CorpusDocument`. Never throws. */
export function parseMarkdownDocument(
  text: string,
  path: string,
  rootPath: string,
  stat: FileStat,
): CorpusDocument {
  const { yaml, body } = splitFrontMatter(text)
  const { bag, parseError } = yaml === null ? { bag: {} as Record<string, unknown>, parseError: undefined } : parseFrontMatter(yaml)
  if (parseError) {
    debug('graph_view: front matter parse error', { path, error: parseError })
  }
  const masked = maskCode(body)

  return {
    path,
    rootPath,
    fileName: basename(path).replace(/\.md$/i, ''),
    frontMatter: bag,
    wikiLinks: extractWikiLinks(masked),
    markdownLinks: extractMarkdownLinks(masked),
    sections: extractSections(masked),
    sizeBytes: stat.size,
    modifiedMs: stat.mtimeMs,
    ...(parseError ? { parseError } : {}),
  }
}
