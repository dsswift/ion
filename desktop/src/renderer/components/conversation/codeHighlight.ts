/**
 * Full-token Shiki highlighter for conversation code blocks.
 *
 * Mirrors the lazy-singleton pattern of components/git/diffHighlight.ts but
 * highlights against the palette-derived Ion theme (ionShikiTheme.ts) instead
 * of the canned github themes, and adds:
 *
 *   - fence-token → language resolution (`langFromFence`)
 *   - per-palette theme registration (bounded — one per distinct palette)
 *   - an LRU memo over (lang, theme, code) so a streaming transcript never
 *     re-tokenizes an unchanged block (t3code's highlightedCodeCache role)
 *   - a synchronous cache probe (`getCachedHighlight`) so CodeBlock can seed
 *     its first render without a flash of unstyled text
 *
 * Never throws: any failure (unknown grammar, loader error) degrades to
 * single-token plaintext lines, logged at debug.
 */

import type { BundledLanguage } from 'shiki'
import type { ColorPalette } from '../../theme-tokens'
import { EXT_TO_LANG, languageForFile } from '../git/diffHighlight'
import { buildIonShikiTheme, ionThemeName } from './ionShikiTheme'
import { rDebug } from '../../rendererLogger'

export interface CodeToken {
  content: string
  color?: string
}

// ─── Language resolution ───

/** Fence-token aliases beyond the extension map (```typescript, ```golang…). */
const FENCE_ALIASES: Record<string, BundledLanguage> = {
  typescript: 'typescript', javascript: 'javascript', golang: 'go',
  python: 'python', ruby: 'ruby', rust: 'rust', kotlin: 'kotlin',
  csharp: 'csharp', shell: 'shell', zsh: 'shell', console: 'shell',
  yml: 'yaml', dockerfile: 'docker', docker: 'docker', makefile: 'make',
  make: 'make', proto: 'proto', graphql: 'graphql', xml: 'xml',
  vue: 'vue', svelte: 'svelte', tex: 'latex', latex: 'latex',
}

/** Resolve a markdown fence token (```ts, ```typescript, ```golang) to a
 * Shiki language id. Returns null for unknown/absent tokens (→ plaintext). */
export function langFromFence(fence: string | undefined | null): BundledLanguage | null {
  if (!fence) return null
  const token = fence.trim().toLowerCase()
  if (!token) return null
  return EXT_TO_LANG[token] ?? FENCE_ALIASES[token] ?? null
}

export { languageForFile }

// ─── Highlighter singleton ───

interface IonHighlighter {
  codeToTokensBase: (
    code: string,
    opts: { lang: BundledLanguage; theme: string },
  ) => Array<Array<{ content: string; color?: string }>>
  loadLanguage: (lang: BundledLanguage) => Promise<void>
  loadTheme: (theme: unknown) => Promise<void>
}

let highlighterPromise: Promise<IonHighlighter> | null = null
const loadedLangs = new Set<BundledLanguage>()
const loadedThemes = new Set<string>()

async function getHighlighter(): Promise<IonHighlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki').then((m) =>
      m.createHighlighter({ themes: [], langs: [] }) as unknown as Promise<IonHighlighter>)
  }
  return highlighterPromise
}

async function ensureLanguage(hi: IonHighlighter, lang: BundledLanguage): Promise<void> {
  if (loadedLangs.has(lang)) return
  await hi.loadLanguage(lang)
  loadedLangs.add(lang)
}

async function ensureTheme(
  hi: IonHighlighter,
  colors: ColorPalette,
  scheme: 'dark' | 'light',
): Promise<string> {
  const name = ionThemeName(colors)
  if (!loadedThemes.has(name)) {
    await hi.loadTheme(buildIonShikiTheme(colors, scheme))
    loadedThemes.add(name)
  }
  return name
}

// ─── LRU memo (t3code highlightedCodeCache role) ───

const CACHE_MAX = 200
const cache = new Map<string, CodeToken[][]>()

function cacheKey(lang: string, themeName: string, code: string): string {
  return `${lang}\u0001${themeName}\u0001${code.length}\u0001${code}`
}

function cacheGet(key: string): CodeToken[][] | undefined {
  const hit = cache.get(key)
  if (hit) {
    // Refresh recency (Map preserves insertion order).
    cache.delete(key)
    cache.set(key, hit)
  }
  return hit
}

function cacheSet(key: string, value: CodeToken[][]): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, value)
}

/** Test-only: reset module state between cases. */
export function __resetForTests(): void {
  cache.clear()
  loadedLangs.clear()
  loadedThemes.clear()
  highlighterPromise = null
}

// ─── Public API ───

export function plaintextTokens(code: string): CodeToken[][] {
  return code.split('\n').map((line) => [{ content: line }])
}

/**
 * Synchronous cache probe. Returns the highlighted rows when this exact
 * (code, lang, palette) was already tokenized — lets CodeBlock render fully
 * highlighted on first paint (no flash) for remounts and history loads.
 */
export function getCachedHighlight(
  code: string,
  lang: BundledLanguage | null,
  colors: ColorPalette,
): CodeToken[][] | undefined {
  if (!lang) return undefined
  return cacheGet(cacheKey(lang, ionThemeName(colors), code))
}

/**
 * Tokenize a block against the palette-derived theme. Resolves to plaintext
 * rows on any failure — callers never need a catch.
 */
export async function highlightToTokens(
  code: string,
  lang: BundledLanguage | null,
  colors: ColorPalette,
  scheme: 'dark' | 'light',
): Promise<CodeToken[][]> {
  if (!lang) return plaintextTokens(code)
  const key = cacheKey(lang, ionThemeName(colors), code)
  const hit = cacheGet(key)
  if (hit) return hit
  try {
    const hi = await getHighlighter()
    await ensureLanguage(hi, lang)
    const themeName = await ensureTheme(hi, colors, scheme)
    const raw = hi.codeToTokensBase(code, { lang, theme: themeName })
    const rows = raw.map((line) => line.map((tok) => ({ content: tok.content, color: tok.color })))
    cacheSet(key, rows)
    return rows
  } catch (err) {
    // Unknown grammar / loader failure — degrade to plaintext, visibly.
    rDebug('code-highlight', 'highlight failed, falling back to plaintext', {
      lang, error: String(err),
    })
    return plaintextTokens(code)
  }
}
