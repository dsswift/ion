/**
 * UserMarkdown — the one renderer for user-authored message content.
 *
 * Shared by the sent bubble (MessageBubble) and the queued bubble
 * (QueuedMessage) so the two cannot drift: a queued message previously rendered
 * as raw text in a plain div, so its formatting visibly changed the moment the
 * turn flushed and the same string came back through markdown.
 *
 * User content is markdown (a pasted table renders as a table, a fence renders
 * as a code card) but its WHITESPACE is verbatim — see
 * remarkPreserveUserWhitespace for why that needs both an AST pass and
 * element-scoped CSS rather than a `white-space` rule on the container.
 */
import React, { useMemo, useCallback } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useColors } from '../../theme'
import { useNavigableText, NavigableLink, NavigableCode } from '../../hooks/useNavigableLinks'
import { remarkNavigableLinks } from '../../hooks/remarkNavigableLinks'
import {
  remarkPreserveUserWhitespace,
  isVerbatimNode,
  blankLineCount,
} from './remarkPreserveUserWhitespace'
import { TableScrollWrapper } from './markdownRenderers'
import { rWarn } from '../../rendererLogger'
import type { FileClickModifiers } from '../../lib/open-file-intent'

// Order matters: gfm first (its autolink runs before link detection), then the
// navigable-link rewrite, then the whitespace restoration, which reads node
// positions against the original source and so must see the tree last.
const REMARK_PLUGINS = [remarkGfm, remarkNavigableLinks, remarkPreserveUserWhitespace]

export function UserMarkdown({ content }: { content: string }): React.JSX.Element | null {
  const colors = useColors()
  const { onOpenFile, onOpenUrl } = useNavigableText()
  const onOpenFileVoid = useCallback((path: string, event?: FileClickModifiers) => {
    void onOpenFile(path, event).catch((err) => rWarn('conversation', 'open file failed', { error: String(err) }))
  }, [onOpenFile])

  const components = useMemo(() => ({
    // TableScrollWrapper, not a bare scroll div: the `table` override REPLACES
    // the <table> element, so wrapping the children in a plain div left <thead>
    // and <tr> with no table parent and a pasted markdown table rendered as
    // unstyled orphan rows. The shared wrapper re-emits the <table> inside its
    // scroller, which is also what assistant messages use.
    table: ({ children }: any) => <TableScrollWrapper>{children}</TableScrollWrapper>,
    a: ({ node, href, children }: any) => (
      <NavigableLink node={node} href={href} color={colors.accent} onOpenFile={onOpenFileVoid} onOpenUrl={onOpenUrl}>
        {children}
      </NavigableLink>
    ),
    code: ({ children, className, ...props }: any) => (
      <NavigableCode className={className} onOpenFile={onOpenFileVoid} onOpenUrl={onOpenUrl} {...props}>
        {children}
      </NavigableCode>
    ),
    // `pre-wrap` is applied HERE, per paragraph, and only to paragraphs the
    // whitespace plugin marked. A rule on the shared prose container would also
    // catch the structural newline text nodes that remark-rehype emits between
    // blocks, between list items, and after every <br>, turning each into a
    // visible blank line.
    p: ({ node, children, ...props }: any) => {
      const blankLines = blankLineCount(node)
      if (blankLines > 0) {
        return (
          <span
            {...props}
            data-ion-blank-lines={blankLines}
            aria-hidden="true"
            style={{ display: 'block', height: `${blankLines}lh`, lineHeight: 1, margin: 0 }}
          />
        )
      }
      return (
        <p {...props} style={isVerbatimNode(node) ? { whiteSpace: 'pre-wrap' } : undefined}>
          {children}
        </p>
      )
    },
  }), [colors, onOpenFileVoid, onOpenUrl])

  if (!content) return null

  return (
    <div className="prose-cloud prose-cloud-user min-w-0 overflow-hidden">
      <Markdown remarkPlugins={REMARK_PLUGINS} components={components}>
        {content}
      </Markdown>
    </div>
  )
}
