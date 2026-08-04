import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowsLeftRight, TextAlignLeft } from '@phosphor-icons/react'
import type { BundledLanguage } from 'shiki'
import { useColors } from '../../theme'
import { usePreferencesStore } from '../../preferences'
import { getTheme, themeScheme } from '../../theme-tokens'
import { getFileIcon } from '../FileExplorerIcons'
import { CopyButton } from './CopyButton'
import { LinkSegment, segmentText } from '../../hooks/useNavigableLinks'
import {
  getCachedHighlight, highlightToTokens, langFromFence, languageForFile,
  plaintextTokens, type CodeToken,
} from './codeHighlight'

/** Human labels for the badge; fence tokens not listed render as-is. */
const LANG_LABELS: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', typescript: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript', javascript: 'JavaScript',
  go: 'Go', golang: 'Go', rs: 'Rust', rust: 'Rust', py: 'Python',
  python: 'Python', rb: 'Ruby', ruby: 'Ruby', swift: 'Swift',
  kt: 'Kotlin', kotlin: 'Kotlin', java: 'Java', c: 'C', cpp: 'C++',
  cs: 'C#', csharp: 'C#', sh: 'Shell', bash: 'Shell', shell: 'Shell',
  zsh: 'Shell', json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML',
  md: 'Markdown', markdown: 'Markdown', html: 'HTML', css: 'CSS',
  scss: 'SCSS', sql: 'SQL', diff: 'Diff', docker: 'Docker',
  dockerfile: 'Docker', makefile: 'Make', make: 'Make', graphql: 'GraphQL',
  xml: 'XML', lua: 'Lua', php: 'PHP', perl: 'Perl', r: 'R', dart: 'Dart',
}

export interface CodeBlockProps {
  code: string
  /** Raw fence token (```ts → "ts"). */
  fenceLang?: string
  /** Filename from fence meta (```ts title=src/foo.ts). Wins over fenceLang
   * for both the badge and language resolution. */
  fileName?: string
  onOpenFile?: (path: string) => void
  onOpenUrl?: (url: string) => void
}

/** Diff-line classification for `diff` fences — no grammar needed. */
function diffLineKind(line: string): 'add' | 'remove' | 'hunk' | 'plain' {
  if (line.startsWith('+++') || line.startsWith('---')) return 'plain'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'remove'
  if (line.startsWith('@@')) return 'hunk'
  return 'plain'
}

/**
 * Syntax-highlighted fenced code block with language badge, copy and wrap
 * controls. Palette-derived colors (theme switch recolors); file paths in
 * code are cmd-clickable via LinkSegment.
 *
 * No-flash contract: the first render seeds from the synchronous highlight
 * cache when this exact block was tokenized before; otherwise it renders
 * plaintext immediately and swaps in tokens when the async highlight lands.
 * A stale-key ref discards late resolutions after the code changed (a
 * streaming block appends content faster than tokenization resolves).
 */
export function CodeBlock({ code, fenceLang, fileName, onOpenFile, onOpenUrl }: CodeBlockProps) {
  const colors = useColors()
  const selectedTheme = usePreferencesStore((s) => s.selectedTheme)
  const scheme = themeScheme(getTheme(selectedTheme))
  const [wrap, setWrap] = useState(false)

  const trimmed = useMemo(() => code.replace(/\n$/, ''), [code])
  const fence = (fenceLang ?? '').trim().toLowerCase()
  const isDiff = fence === 'diff' || fence === 'patch'
  const lang: BundledLanguage | null = isDiff
    ? null
    : (fileName ? languageForFile(fileName) : null) ?? langFromFence(fence)

  const [rows, setRows] = useState<CodeToken[][]>(() =>
    getCachedHighlight(trimmed, lang, colors) ?? plaintextTokens(trimmed))
  // Identity of the highlight request the current async task serves; a
  // resolution whose key no longer matches is stale and dropped.
  const requestKey = `${lang ?? ''}\u0001${selectedTheme}\u0001${trimmed}`
  const requestKeyRef = useRef(requestKey)
  requestKeyRef.current = requestKey

  useEffect(() => {
    if (isDiff || !lang) {
      setRows(plaintextTokens(trimmed))
      return
    }
    const cached = getCachedHighlight(trimmed, lang, colors)
    if (cached) {
      setRows(cached)
      return
    }
    setRows(plaintextTokens(trimmed))
    const key = requestKey
    void highlightToTokens(trimmed, lang, colors, scheme).then((tokens) => {
      if (requestKeyRef.current === key) setRows(tokens)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requestKey subsumes trimmed/lang/theme identity
  }, [requestKey, isDiff, colors, scheme])

  const badgeText = fileName ?? (fence ? (LANG_LABELS[fence] ?? fence) : 'text')
  const iconInfo = getFileIcon(fileName ?? `x.${fence || 'txt'}`)
  const Icon = iconInfo.icon

  const preStyle: React.CSSProperties = {
    margin: 0,
    padding: '0.65em 1em',
    fontSize: 12,
    lineHeight: 1.55,
    overflowX: wrap ? 'hidden' : 'auto',
    whiteSpace: wrap ? 'pre-wrap' : 'pre',
    wordBreak: wrap ? 'break-all' : 'normal',
    background: 'none',
    border: 'none',
    borderRadius: 0,
  }

  return (
    <div
      className="my-2 rounded-[10px] overflow-hidden"
      style={{ background: colors.codeBg, border: `1px solid ${colors.containerBorder}` }}
    >
      <div
        className="flex items-center gap-1.5 px-2.5 py-1 select-none"
        style={{ borderBottom: `1px solid ${colors.containerBorder}` }}
      >
        <Icon size={12} color={colors[iconInfo.colorKey]} />
        <span className="text-[11px] font-medium" style={{ color: colors.textSecondary }}>
          {badgeText}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          aria-pressed={wrap}
          onClick={() => setWrap((w) => !w)}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] cursor-pointer"
          style={{ color: wrap ? colors.accent : colors.textTertiary, background: 'transparent', border: 'none' }}
          title={wrap ? 'Disable line wrap' : 'Wrap long lines'}
        >
          {wrap ? <TextAlignLeft size={11} /> : <ArrowsLeftRight size={11} />}
          <span>Wrap</span>
        </button>
        <CopyButton text={trimmed} />
      </div>
      <pre style={preStyle} data-code-lang={fence || undefined}>
        <code style={{ background: 'none', border: 'none', padding: 0, fontSize: 'inherit' }}>
          {isDiff
            ? trimmed.split('\n').map((line, i) => <DiffLine key={i} line={line} colors={colors} />)
            : rows.map((line, i) => (
              <CodeLine key={i} tokens={line} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} />
            ))}
        </code>
      </pre>
    </div>
  )
}

function DiffLine({ line, colors }: { line: string; colors: ReturnType<typeof useColors> }) {
  const kind = diffLineKind(line)
  const style: React.CSSProperties =
    kind === 'add'
      ? { color: colors.diffAddText, background: colors.diffAddBg }
      : kind === 'remove'
        ? { color: colors.diffRemoveText, background: colors.diffRemoveBg }
        : kind === 'hunk'
          ? { color: colors.textTertiary }
          : {}
  return (
    <span data-diff-kind={kind} style={{ display: 'block', ...style }}>
      {line || '\u00A0'}
    </span>
  )
}

/** One highlighted line. File paths / URLs inside tokens stay cmd-clickable. */
const CodeLine = React.memo(function CodeLine({
  tokens,
  onOpenFile,
  onOpenUrl,
}: {
  tokens: CodeToken[]
  onOpenFile?: (path: string) => void
  onOpenUrl?: (url: string) => void
}) {
  return (
    <span style={{ display: 'block' }}>
      {tokens.length === 0
        ? '\u00A0'
        : tokens.map((tok, i) => (
          <TokenSpan key={i} token={tok} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} />
        ))}
    </span>
  )
})

function TokenSpan({
  token,
  onOpenFile,
  onOpenUrl,
}: {
  token: CodeToken
  onOpenFile?: (path: string) => void
  onOpenUrl?: (url: string) => void
}) {
  // Linkify only when openers exist and the token plausibly contains a path
  // (cheap precheck before the regex segmentation).
  const canLink = !!(onOpenFile && onOpenUrl) && (token.content.includes('/') || token.content.includes('~'))
  const segments = useMemo(
    () => (canLink ? segmentText(token.content) : null),
    [canLink, token.content],
  )
  const style = token.color ? { color: token.color } : undefined
  if (!segments || (segments.length === 1 && segments[0].type === 'plain')) {
    return <span style={style}>{token.content}</span>
  }
  return (
    <span style={style}>
      {segments.map((seg, i) => (
        <LinkSegment key={i} segment={seg} onOpenFile={onOpenFile!} onOpenUrl={onOpenUrl!} />
      ))}
    </span>
  )
}
