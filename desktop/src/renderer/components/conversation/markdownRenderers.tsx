/**
 * Shared react-markdown component factory for conversation prose.
 *
 * One factory serves both message renderers (AssistantMessage, MessageBubble)
 * so the fenced-code pipeline (CodeBlock: syntax highlighting, badge, copy,
 * wrap, diff coloring) and the link treatments (favicons, file-path chips)
 * exist exactly once. Variant differences are cosmetic (table scroll
 * treatment); everything behavioral is identical.
 *
 * Callers must memoize the result (useMemo on colors + handlers) — every
 * component returned here is referenced by react-markdown's reconciliation,
 * and an unstable identity would remount the whole prose subtree per render.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Globe } from '@phosphor-icons/react'
import type { ColorPalette } from '../../theme-tokens'
import { NavigableLink, NavigableCode, readNavigableKind } from '../../hooks/useNavigableLinks'
import { CodeBlock } from './CodeBlock'
import { rWarn } from '../../rendererLogger'

// ─── Table scroll wrapper with fade edges ───

export function TableScrollWrapper({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [fade, setFade] = useState<string | undefined>(undefined)
  const prevFade = useRef<string | undefined>(undefined)

  const update = useCallback(() => {
    const el = ref.current
    if (!el) return
    const { scrollLeft, scrollWidth, clientWidth } = el
    let next: string | undefined
    if (scrollWidth <= clientWidth + 1) {
      next = undefined
    } else {
      const l = scrollLeft > 1
      const r = scrollLeft + clientWidth < scrollWidth - 1
      next = l && r
        ? 'linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)'
        : l
          ? 'linear-gradient(to right, transparent, black 24px)'
          : r
            ? 'linear-gradient(to right, black calc(100% - 24px), transparent)'
            : undefined
    }
    if (next !== prevFade.current) {
      prevFade.current = next
      setFade(next)
    }
  }, [])

  useEffect(() => {
    update()
    const el = ref.current
    if (!el) return
    let rafId = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(update)
    })
    ro.observe(el)
    const table = el.querySelector('table')
    if (table) ro.observe(table)
    return () => { cancelAnimationFrame(rafId); ro.disconnect() }
  }, [update])

  return (
    <div
      ref={ref}
      onScroll={update}
      style={{
        overflowX: 'auto',
        scrollbarWidth: 'thin',
        maskImage: fade,
        WebkitMaskImage: fade,
      }}
    >
      <table>{children}</table>
    </div>
  )
}

// ─── Image card with graceful fallback ───

export function ImageCard({ src, alt, colors }: { src?: string; alt?: string; colors: ColorPalette }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [src])
  const label = alt || 'Image'
  const open = () => { if (src) void window.ion.openExternal(String(src)).catch((err) => rWarn('conversation', 'open image failed', { error: String(err) })) }

  if (failed || !src) {
    return (
      <button
        type="button"
        className="inline-flex items-center gap-1.5 my-1 px-2.5 py-1.5 rounded-md text-[12px] cursor-pointer"
        style={{ background: colors.surfacePrimary, color: colors.accent, border: `1px solid ${colors.toolBorder}` }}
        onClick={open}
        title={src}
      >
        <Globe size={12} />
        Image unavailable{alt ? ` — ${alt}` : ''}
      </button>
    )
  }

  return (
    <button
      type="button"
      className="block my-2 rounded-lg overflow-hidden border text-left cursor-pointer"
      style={{ borderColor: colors.toolBorder, background: colors.surfacePrimary }}
      onClick={open}
      title={src}
    >
      <img
        src={src}
        alt={label}
        className="block w-full max-h-[260px] object-cover"
        loading="lazy"
        onError={() => setFailed(true)}
      />
      {alt && (
        <div className="px-2 py-1 text-[11px]" style={{ color: colors.textTertiary }}>
          {alt}
        </div>
      )}
    </button>
  )
}

// ─── Fence meta parsing ───

export interface FenceMeta {
  fileName?: string
}

/**
 * Parse the fence info-string meta (the part after the language token):
 * `title=src/foo.ts`, `filename="src/foo.ts"`, or a bare dotted token
 * (```ts src/foo.ts). First match wins.
 */
export function parseFenceMeta(meta: string | undefined | null): FenceMeta {
  if (!meta) return {}
  const kv = /(?:title|filename)=(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(meta)
  if (kv) return { fileName: kv[1] ?? kv[2] ?? kv[3] }
  const bare = meta.trim().split(/\s+/).find((tok) => /^[\w./~-]+\.\w+$/.test(tok) && tok.includes('.'))
  return bare ? { fileName: bare } : {}
}

/** Flatten react-markdown children to the raw code string. */
export function extractCodeText(children: unknown): string {
  if (typeof children === 'string') return children
  if (Array.isArray(children)) return children.map(extractCodeText).join('')
  if (React.isValidElement(children)) {
    return extractCodeText((children.props as { children?: unknown }).children)
  }
  return ''
}

// ─── Favicon link ───

/** Session-level miss set: hosts whose favicon fetch already failed render
 * the Globe immediately instead of re-asking main per mount. */
const faviconMisses = new Set<string>()

export function FaviconLink({
  href,
  colors,
  children,
}: {
  href?: string
  colors: ColorPalette
  children: React.ReactNode
}) {
  let host: string | null = null
  try {
    host = href ? new URL(href).hostname : null
  } catch {
    host = null // silent-ok: non-URL href (anchor etc.) simply gets no favicon
  }
  const [icon, setIcon] = useState<string | null>(null)
  const skip = !host || faviconMisses.has(host)

  useEffect(() => {
    if (skip || !host) return
    let alive = true
    void window.ion.getFavicon(host).then((dataUrl) => {
      if (!alive) return
      if (dataUrl) setIcon(dataUrl)
      else faviconMisses.add(host)
    }).catch((err) => {
      faviconMisses.add(host)
      rWarn('conversation', 'favicon ipc failed', { host, error: String(err) })
    })
    return () => { alive = false }
  }, [host, skip])

  return (
    <button
      type="button"
      className="underline decoration-dotted underline-offset-2 cursor-pointer"
      style={{ color: colors.accent }}
      onClick={() => {
        if (href) void window.ion.openExternal(String(href)).catch((err) => rWarn('conversation', 'open link failed', { error: String(err) }))
      }}
    >
      {host && (
        icon ? (
          <img
            src={icon}
            alt=""
            aria-hidden="true"
            data-favicon={host}
            className="inline-block align-[-2px] mr-1 rounded-[3px]"
            style={{ width: 13, height: 13 }}
            onError={() => { faviconMisses.add(host); setIcon(null) }}
          />
        ) : (
          <Globe size={12} className="inline-block align-[-1.5px] mr-1" aria-hidden="true" />
        )
      )}
      {children}
    </button>
  )
}

// ─── Component factory ───

export interface MarkdownComponentsOptions {
  colors: ColorPalette
  onOpenFile: (path: string) => void
  onOpenUrl: (url: string) => void
  variant: 'assistant' | 'user'
}

/* eslint-disable @typescript-eslint/no-explicit-any -- react-markdown's
   component props are untyped hast passthroughs; matching the existing
   convention in AssistantMessage/MessageBubble. */
export function makeMarkdownComponents({ colors, onOpenFile, onOpenUrl, variant }: MarkdownComponentsOptions) {
  return {
    table: ({ children }: any) =>
      variant === 'assistant'
        ? <TableScrollWrapper>{children}</TableScrollWrapper>
        : <div className="overflow-x-auto max-w-full">{children}</div>,
    // A real markdown link gets the favicon treatment; a bare path/URL that
    // `remarkNavigableLinks` detected and rewrote into a `link` node (carrying
    // the NAVIGABLE_DATA_ATTR marker) routes through NavigableLink instead, so
    // it stays text-like until CMD is held (or renders as a file chip).
    a: ({ node, href, children }: any) =>
      readNavigableKind(node)
        ? (
          <NavigableLink node={node} href={href} color={colors.accent} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} chipFiles>
            {children}
          </NavigableLink>
        )
        : (
          <FaviconLink href={href} colors={colors}>{children}</FaviconLink>
        ),
    ...(variant === 'assistant'
      ? { img: ({ src, alt }: any) => <ImageCard src={src} alt={alt} colors={colors} /> }
      : {}),
    // Inline code only — fenced blocks are intercepted by the `pre` override
    // below before this renders with a className.
    code: ({ children, className, ...props }: any) => (
      <NavigableCode className={className} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} chipFiles {...props}>
        {children}
      </NavigableCode>
    ),
    pre: ({ children }: any) => {
      // react-markdown wraps the fenced code in <pre><code className="language-x">.
      const child = React.isValidElement(children) ? children : Array.isArray(children) && React.isValidElement(children[0]) ? children[0] : null
      const childProps: any = child ? child.props : {}
      const className: string = childProps.className ?? ''
      const fenceLang = /language-([\w+-]+)/.exec(className)?.[1]
      const meta: string | undefined = childProps.node?.data?.meta
      const code = extractCodeText(childProps.children)
      const { fileName } = parseFenceMeta(meta)
      return (
        <CodeBlock
          code={code}
          fenceLang={fenceLang}
          fileName={fileName}
          onOpenFile={onOpenFile}
          onOpenUrl={onOpenUrl}
        />
      )
    },
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
