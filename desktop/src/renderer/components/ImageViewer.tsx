import React, { useState, useEffect, useCallback, useRef } from 'react'
import { DownloadSimple, FolderOpen } from '@phosphor-icons/react'
import { FloatingPanel } from './FloatingPanel'
import { useColors } from '../theme'
import { useSessionStore } from '../stores/sessionStore'
import { rError } from '../rendererLogger'

/** Module-level cache so the same image isn't re-read from disk per render. */
const dataUrlCache = new Map<string, string>()

/**
 * Resolve a data URL for the image at `path`.
 *
 * `initialDataUrl` is an optional pre-seeded data URL (e.g. from a persisted
 * `FileAttachment.dataUrl`). When provided it is written into the cache
 * immediately so the image renders without waiting for the IPC round-trip.
 * The IPC call still fires; if the file exists on disk the result overwrites
 * the cache entry (idempotent). If the file is gone (e.g. a pre-fix tmpdir
 * paste from a prior session), the seeded value persists and the image renders
 * from the stored base64.
 */
function useImageDataUrl(path: string, initialDataUrl?: string): string | null {
  // Seed the module-level cache eagerly from initialDataUrl so sibling
  // components referencing the same path share it without an IPC round-trip.
  if (initialDataUrl && !dataUrlCache.has(path)) {
    dataUrlCache.set(path, initialDataUrl)
  }

  const [dataUrl, setDataUrl] = useState<string | null>(() => dataUrlCache.get(path) ?? null)

  useEffect(() => {
    if (dataUrlCache.has(path)) {
      setDataUrl(dataUrlCache.get(path) ?? null)
      return
    }
    let cancelled = false
    window.ion.readImageDataUrl(path).then((res) => {
      if (cancelled) return
      if (res.dataUrl) {
        dataUrlCache.set(path, res.dataUrl)
        setDataUrl(res.dataUrl)
      }
    }).catch((err) => rError('ImageViewer', 'readImageDataUrl failed', { path, error: String(err) }))
    return () => { cancelled = true }
  }, [path])

  return dataUrl
}

/** Export the hook so InlineMessageImages can share the cache. */
export { useImageDataUrl }

interface ImageViewerProps {
  filePath: string
  fileName: string
  onClose: () => void
}

export function ImageViewer({ filePath, fileName, onClose }: ImageViewerProps) {
  const colors = useColors()
  const dataUrl = useImageDataUrl(filePath)
  const linkRef = useRef<HTMLAnchorElement>(null)
  const imageGeometry = useSessionStore((s) => s.planGeometry)
  const setImageGeometry = useSessionStore((s) => s.setPlanGeometry)
  const workingDir = useSessionStore((s) => { const tab = s.tabs.find(t => t.id === s.activeTabId); return tab?.workingDirectory || '' })
  const handleGeometryChange = useCallback(
    (geo: { x: number; y: number; w: number; h: number }) => setImageGeometry(geo),
    [setImageGeometry],
  )

  const handleSaveAs = useCallback(async () => {
    if (!dataUrl) return
    // Use the hidden anchor to trigger a download with the original filename
    const a = linkRef.current
    if (a) {
      a.href = dataUrl
      a.download = fileName
      a.click()
    }
  }, [dataUrl, fileName])

  const handleReveal = useCallback(() => {
    void window.ion.fsRevealInFinder(filePath)
  }, [filePath])

  return (
    <FloatingPanel
      title={fileName}
      onClose={onClose}
      defaultWidth={600}
      defaultHeight={500}
      initialPos={{ x: imageGeometry.x, y: imageGeometry.y }}
      initialSize={{ w: imageGeometry.w, h: imageGeometry.h }}
      onGeometryChange={handleGeometryChange}
      filePath={filePath}
      workingDir={workingDir}
    >
      {/* Hidden download anchor */}
      <a ref={linkRef} style={{ display: 'none' }} />

      {/* Toolbar */}
      <div
        className="flex items-center gap-1 px-3 py-1"
        style={{
          borderBottom: `1px solid ${colors.containerBorder}`,
          background: colors.surfacePrimary,
          flexShrink: 0,
        }}
      >
        <button
          onClick={() => { void handleSaveAs() }}
          className="flex items-center gap-1 px-2 py-0.5 rounded transition-colors text-[10px]"
          style={{ color: colors.textTertiary, cursor: 'pointer' }}
          onMouseEnter={(e) => { e.currentTarget.style.color = colors.accent }}
          onMouseLeave={(e) => { e.currentTarget.style.color = colors.textTertiary }}
          title="Save image as…"
        >
          <DownloadSimple size={12} />
          <span>Save As</span>
        </button>
        <button
          onClick={handleReveal}
          className="flex items-center gap-1 px-2 py-0.5 rounded transition-colors text-[10px]"
          style={{ color: colors.textTertiary, cursor: 'pointer' }}
          onMouseEnter={(e) => { e.currentTarget.style.color = colors.accent }}
          onMouseLeave={(e) => { e.currentTarget.style.color = colors.textTertiary }}
          title="Reveal in Finder"
        >
          <FolderOpen size={12} />
          <span>Reveal</span>
        </button>
      </div>

      {/* Image display */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'auto',
          background: colors.surfacePrimary,
          padding: 8,
        }}
      >
        {dataUrl ? (
          <img
            src={dataUrl}
            alt={fileName}
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              objectFit: 'contain',
              borderRadius: 4,
            }}
            draggable={false}
          />
        ) : (
          <div
            className="text-[12px]"
            style={{ color: colors.textTertiary }}
          >
            Loading…
          </div>
        )}
      </div>
    </FloatingPanel>
  )
}
