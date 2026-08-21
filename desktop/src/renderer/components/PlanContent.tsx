/**
 * PlanContent — the markdown body of a plan document, extracted from
 * PlanViewer so two hosts can render one implementation: the overlay's
 * floating PlanViewer (FloatingPanel chrome) and the Studio surface's
 * PlanSurface tab (pane chrome).
 *
 * Memoized for the same reason PlanViewer is: react-markdown re-parses
 * `content` on every render and the navigable-link segmentation walks every
 * text node — an ancestor re-render must not force a re-parse.
 */
import React, { useCallback, useMemo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useColors } from '../theme'
import { useNavigableText, NavigableLink, NavigableCode, remarkNavigableLinks } from '../hooks/useNavigableLinks'
import { rError } from '../rendererLogger'

const REMARK_PLUGINS = [remarkGfm, remarkNavigableLinks]

export const PlanContent = React.memo(function PlanContent({ content }: { content: string }): React.JSX.Element {
  const colors = useColors()
  const { onOpenFile, onOpenUrl } = useNavigableText()
  const handleOpenFile = useCallback(
    (path: string) => {
      void onOpenFile(path).catch((err) => rError('plan-content', 'open file failed', { error: String(err) }))
    },
    [onOpenFile],
  )

  const markdownComponents = useMemo(
    () => ({
      a: ({ node, href, children }: any) => (
        <NavigableLink node={node} href={href} color={colors.accent} onOpenFile={handleOpenFile} onOpenUrl={onOpenUrl}>
          {children}
        </NavigableLink>
      ),
      code: ({ children, className, ...props }: any) => (
        <NavigableCode className={className} onOpenFile={handleOpenFile} onOpenUrl={onOpenUrl} {...props}>
          {children}
        </NavigableCode>
      ),
    }),
    [colors, handleOpenFile, onOpenUrl],
  )

  return (
    <div
      style={{
        overflowY: 'auto',
        overflowX: 'auto',
        flex: 1,
        padding: '12px 16px',
      }}
    >
      <div
        className="leading-[1.6] prose-cloud min-w-0 overflow-hidden"
        style={{ color: colors.textSecondary, maxWidth: '100%', fontSize: 'var(--ion-data-font-size, 13px)' }}
      >
        <Markdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>
          {content}
        </Markdown>
      </div>
    </div>
  )
})
