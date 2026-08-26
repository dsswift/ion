import React, { useCallback, useMemo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useColors } from '../theme'
import { useNavigableText, NavigableLink, NavigableCode, remarkNavigableLinks } from '../hooks/useNavigableLinks'
import { rError } from '../rendererLogger'
import type { FileClickModifiers } from '../lib/open-file-intent'

const REMARK_PLUGINS = [remarkGfm, remarkNavigableLinks]

export function ResourceContent({ content }: { content: string }): React.JSX.Element {
  const colors = useColors()
  const { onOpenFile, onOpenUrl } = useNavigableText()
  const handleOpenFile = useCallback((path: string, event?: FileClickModifiers) => {
    void onOpenFile(path, event).catch((err) => rError('resource-viewer', 'open file failed', { error: String(err) }))
  }, [onOpenFile])
  const markdownComponents = useMemo(() => ({
    a: ({ node, href, children }: any) => <NavigableLink node={node} href={href} color={colors.accent} onOpenFile={handleOpenFile} onOpenUrl={onOpenUrl}>{children}</NavigableLink>,
    code: ({ children, className, ...props }: any) => <NavigableCode className={className} onOpenFile={handleOpenFile} onOpenUrl={onOpenUrl} {...props}>{children}</NavigableCode>,
  }), [colors, handleOpenFile, onOpenUrl])

  return (
    <div style={{ overflowY: 'auto', overflowX: 'auto', flex: 1, padding: '12px 16px' }}>
      <div className="leading-[1.6] prose-cloud min-w-0 overflow-hidden" style={{ color: colors.textSecondary, maxWidth: '100%', fontSize: 'var(--ion-data-font-size, 13px)' }}>
        <Markdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>{content}</Markdown>
      </div>
    </div>
  )
}
