/**
 * BrowserSurface — a `browser:` surface tab body: hardened <webview> +
 * BrowserChrome (URL bar, back/forward/reload, D6 preview shield).
 *
 * D6 two modes, one component:
 *   preview — file:// HTML preview on an ephemeral studio-preview-<id>
 *   partition whose session blocks network (file:/data:/blob: only). The
 *   shield click confirms and lifts the block for THIS tab's partition.
 *   browse — persistent persist:studio-browser partition, full network.
 *
 * The webview element stays mounted across tab switches (SurfacePanel
 * hides with display:none) so sessions and history survive.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ArrowsClockwise, ShieldWarning, ShieldCheck } from '@phosphor-icons/react'
import { useColors } from '../../../theme'
import { useSurfaceStore } from '../surface-store'
import { rDebug, rWarn } from '../../../rendererLogger'

/** Electron webview element surface used here (typed narrowly). */
interface WebviewElement extends HTMLElement {
  src: string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  getURL(): string
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '') return ''
  if (/^(https?|file):\/\//i.test(trimmed)) return trimmed
  if (trimmed === 'about:blank') return trimmed
  // Scheme fixup: bare host → https.
  return `https://${trimmed}`
}

export function BrowserSurface({
  tabId,
  instanceId,
  url,
  mode,
}: {
  tabId: string
  instanceId: string
  url: string
  mode: 'preview' | 'browse'
}): React.JSX.Element {
  const colors = useColors()
  const webviewRef = useRef<WebviewElement | null>(null)
  const [urlInput, setUrlInput] = useState(url)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [networkUnlocked, setNetworkUnlocked] = useState(false)
  const [confirmingUnlock, setConfirmingUnlock] = useState(false)
  const updateBrowserTab = useSurfaceStore((s) => s.updateBrowserTab)

  const partition = mode === 'preview' ? `studio-preview-${instanceId}` : 'persist:studio-browser'

  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    const onNavigate = (): void => {
      const current = wv.getURL()
      setUrlInput(current)
      setCanGoBack(wv.canGoBack())
      setCanGoForward(wv.canGoForward())
      updateBrowserTab(tabId, { url: current })
      rDebug('studio.browser', 'navigated', { url: current.slice(0, 120) })
    }
    const onTitle = (e: Event): void => {
      const title = (e as unknown as { title?: string }).title
      if (title) updateBrowserTab(tabId, { title })
    }
    wv.addEventListener('did-navigate', onNavigate)
    wv.addEventListener('did-navigate-in-page', onNavigate)
    wv.addEventListener('page-title-updated', onTitle)
    return () => {
      wv.removeEventListener('did-navigate', onNavigate)
      wv.removeEventListener('did-navigate-in-page', onNavigate)
      wv.removeEventListener('page-title-updated', onTitle)
    }
  }, [tabId, updateBrowserTab])

  const navigate = useCallback(
    (raw: string) => {
      const target = normalizeUrl(raw)
      if (!target) return
      const wv = webviewRef.current
      if (wv) wv.src = target
      updateBrowserTab(tabId, { url: target })
    },
    [tabId, updateBrowserTab],
  )

  const unlockNetwork = useCallback(() => {
    void window.ion
      .studioPreviewAllowNetwork(partition)
      .then((ok) => {
        if (ok) {
          setNetworkUnlocked(true)
          setConfirmingUnlock(false)
          webviewRef.current?.reload()
        } else {
          rWarn('studio.browser', 'preview unlock rejected', { partition })
        }
      })
      .catch((err) => rWarn('studio.browser', 'preview unlock failed', { partition, error: String(err) }))
  }, [partition])

  const iconButton = (disabled: boolean): React.CSSProperties => ({
    border: 'none',
    background: 'transparent',
    color: disabled ? colors.textMuted : colors.textTertiary,
    cursor: disabled ? 'default' : 'pointer',
    display: 'flex',
    alignItems: 'center',
    padding: 2,
  })

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Chrome */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px',
          borderBottom: `1px solid ${colors.containerBorder}`,
          flexShrink: 0,
        }}
      >
        <button style={iconButton(!canGoBack)} disabled={!canGoBack} onClick={() => webviewRef.current?.goBack()} aria-label="Back">
          <ArrowLeft size={13} />
        </button>
        <button style={iconButton(!canGoForward)} disabled={!canGoForward} onClick={() => webviewRef.current?.goForward()} aria-label="Forward">
          <ArrowRight size={13} />
        </button>
        <button style={iconButton(false)} onClick={() => webviewRef.current?.reload()} aria-label="Reload">
          <ArrowsClockwise size={13} />
        </button>
        {mode === 'preview' && (
          <button
            onClick={() => (networkUnlocked ? undefined : setConfirmingUnlock(true))}
            title={networkUnlocked ? 'Network enabled for this preview' : 'Offline preview — click to allow network'}
            style={{ ...iconButton(false), color: networkUnlocked ? colors.warningFg : colors.accent }}
            aria-label="Preview network shield"
          >
            {networkUnlocked ? <ShieldWarning size={13} /> : <ShieldCheck size={13} />}
          </button>
        )}
        <input
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') navigate(urlInput)
          }}
          placeholder="Enter URL"
          spellCheck={false}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 11,
            fontFamily: 'monospace',
            padding: '3px 8px',
            borderRadius: 6,
            border: `1px solid ${colors.containerBorder}`,
            background: colors.inputPillBg,
            color: colors.textPrimary,
            outline: 'none',
          }}
        />
      </div>
      {confirmingUnlock && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '5px 10px',
            fontSize: 11,
            fontFamily: 'system-ui, sans-serif',
            color: colors.textSecondary,
            background: colors.surfacePrimary,
            borderBottom: `1px solid ${colors.containerBorder}`,
            flexShrink: 0,
          }}
        >
          Allow this preview to load network resources? Offline by default so local HTML can’t phone home.
          <button
            onClick={unlockNetwork}
            style={{ border: `1px solid ${colors.containerBorder}`, borderRadius: 4, background: 'transparent', color: colors.accent, cursor: 'pointer', fontSize: 10, padding: '1px 8px' }}
          >
            Allow network
          </button>
          <button
            onClick={() => setConfirmingUnlock(false)}
            style={{ border: 'none', background: 'transparent', color: colors.textTertiary, cursor: 'pointer', fontSize: 10 }}
          >
            Keep offline
          </button>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        <webview
          ref={(node: HTMLElement | null) => {
            webviewRef.current = node as WebviewElement | null
          }}
          src={url || 'about:blank'}
          partition={partition}
          style={{ width: '100%', height: '100%' }}
        />
      </div>
    </div>
  )
}
