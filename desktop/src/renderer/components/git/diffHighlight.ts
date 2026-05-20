/**
 * Lazy Shiki-based syntax highlighter for diff lines.
 *
 * Loads Shiki + the requested language grammar on demand and caches the
 * resulting highlighter. Returns tokenized lines as an array per source line
 * (one token array per line). Falls back to a single-token plain array on
 * any failure so the caller can render safely.
 */

import type { BundledLanguage, BundledTheme, ThemedToken } from 'shiki'

const EXT_TO_LANG: Record<string, BundledLanguage> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript',
  go: 'go', rs: 'rust', py: 'python', rb: 'ruby', java: 'java', kt: 'kotlin',
  swift: 'swift', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', md: 'markdown',
  html: 'html', css: 'css', scss: 'scss', sql: 'sql', sh: 'shell', bash: 'shell',
  lua: 'lua', php: 'php', pl: 'perl', r: 'r', dart: 'dart',
}

export function languageForFile(fileName: string): BundledLanguage | null {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  return EXT_TO_LANG[ext] ?? null
}

interface Highlighter {
  codeToTokensBase: (code: string, opts: { lang: BundledLanguage; theme: BundledTheme }) => ThemedToken[][]
}

let highlighterPromise: Promise<Highlighter> | null = null
const loadedLangs = new Set<BundledLanguage>()

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then((m) => m.createHighlighter({
      themes: ['github-dark', 'github-light'],
      langs: [],
    }) as unknown as Promise<Highlighter>)
  }
  return highlighterPromise
}

export async function ensureLanguage(lang: BundledLanguage): Promise<void> {
  if (loadedLangs.has(lang)) return
  const hi = await getHighlighter() as unknown as { loadLanguage: (l: BundledLanguage) => Promise<void> }
  await hi.loadLanguage(lang)
  loadedLangs.add(lang)
}

export interface HighlightedToken {
  content: string
  color?: string
}

export async function tokenizeLines(
  source: string,
  lang: BundledLanguage,
  theme: BundledTheme = 'github-dark',
): Promise<HighlightedToken[][]> {
  try {
    await ensureLanguage(lang)
    const hi = await getHighlighter()
    const raw = hi.codeToTokensBase(source, { lang, theme })
    return raw.map((line) => line.map((tok) => ({ content: tok.content, color: tok.color })))
  } catch {
    return source.split('\n').map((line) => [{ content: line }])
  }
}
