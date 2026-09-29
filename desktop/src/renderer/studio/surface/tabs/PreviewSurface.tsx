/**
 * PreviewSurface — image (and future previewer) surface tab body.
 *
 * Reuses the exported useImageDataUrl hook from ImageViewer (the overlay
 * keeps its FloatingPanel popup). Future previewers branch on extension
 * here.
 */
import React, { useCallback, useRef } from 'react'
import { DownloadSimple, FolderOpen } from '@phosphor-icons/react'
import { useImageDataUrl } from '../../../components/ImageViewer'
import { useColors } from '../../../theme'
import { host } from '../../../host/host-instance'
import { pathBasename } from '@ion/shared/paths'

export function PreviewSurface({ filePath, dataUrl: initialDataUrl }: { filePath: string; dataUrl?: string }): React.JSX.Element {
  const colors = useColors()
  const fileName = pathBasename(filePath)
  const dataUrl = useImageDataUrl(filePath, initialDataUrl)
  const linkRef = useRef<HTMLAnchorElement>(null)

  const handleSaveAs = useCallback(() => {
    if (!dataUrl) return
    const a = linkRef.current
    if (a) {
      a.href = dataUrl
      a.download = fileName
      a.click()
    }
  }, [dataUrl, fileName])

  const handleReveal = useCallback(() => {
    // Reveal needs a Finder/Explorer, not a filesystem: 'nativeShell'. File
    // reads and writes are wire-served on every host; only the OS window is
    // not, so a browser client is the one host that skips this.
    if (!host.capabilities().includes('nativeShell')) return
    void host.shell.fsRevealInFinder(filePath)
  }, [filePath])

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <a ref={linkRef} style={{ display: 'none' }} />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 10px',
          borderBottom: `1px solid ${colors.containerBorder}`,
          fontFamily: 'system-ui, sans-serif',
          fontSize: 11,
          color: colors.textTertiary,
          flexShrink: 0,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fileName}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button
            onClick={handleSaveAs}
            title="Save As"
            style={{ border: 'none', background: 'transparent', color: colors.textTertiary, cursor: 'pointer', display: 'flex' }}
          >
            <DownloadSimple size={13} />
          </button>
          <button
            onClick={handleReveal}
            title="Reveal in Finder"
            style={{ border: 'none', background: 'transparent', color: colors.textTertiary, cursor: 'pointer', display: 'flex' }}
          >
            <FolderOpen size={13} />
          </button>
        </div>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'auto',
          padding: 12,
        }}
      >
        {dataUrl ? (
          <img src={dataUrl} alt={fileName} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
        ) : (
          <span style={{ color: colors.textTertiary, fontSize: 12, fontFamily: 'system-ui, sans-serif' }}>Loading…</span>
        )}
      </div>
    </div>
  )
}
