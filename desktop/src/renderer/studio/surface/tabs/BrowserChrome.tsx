/**
 * BrowserChrome — the toolbar above a browser document's body.
 *
 * Back, forward, reload, favicon and loading state, the URL bar, the zoom
 * pill, the preview network shield, the emulation pill, and the session-mode
 * toggle. Everything it shows about the page comes from main over view state,
 * because the page is a main-process view with no element to read.
 *
 * `BrowserSurface` owns the view; this owns the controls. The split keeps each
 * file under the size cap and lets the toolbar be tested without a view.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, ArrowsClockwise, DeviceMobile, Globe, MagnifyingGlass, ShieldWarning, ShieldCheck, X } from '@phosphor-icons/react'
import { Tooltip } from '../../../components/git/Tooltip'
import { useColors } from '../../../theme'
import { usePreferencesStore } from '../../../preferences'
import { useSurfaceStore } from '../surface-store'
import type { BrowserSessionMode } from '@ion/shared/studio-surface-types'
import type { BrowserEmulationState, StudioBrowserZoomRequest } from '@ion/shared/studio-browser-types'
import { rInfo, rWarn } from '../../../rendererLogger'
import { host } from '../../../host/host-instance'

export function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '') return ''
  if (/^(https?|file):\/\//i.test(trimmed)) return trimmed
  if (trimmed === 'about:blank') return trimmed
  // Scheme fixup: bare host → https.
  return `https://${trimmed}`
}

/** Chromium zoom level to the percentage a person reads. */
export function zoomPercent(level: number): number {
  return Math.round(Math.pow(1.2, level) * 100)
}

export interface BrowserChromeProps {
  conversationId: string
  tabId: string
  instanceId: string
  partition: string
  mode: 'preview' | 'browse'
  sessionMode: BrowserSessionMode
  emulation: BrowserEmulationState | null
  url: string
  faviconUrl: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  zoomLevel: number
  /** Focus target for the Mod+L shortcut, which arrives from main. */
  urlInputRef: React.RefObject<HTMLInputElement | null>
  onNavigate(url: string): void
  onAction(action: 'back' | 'forward' | 'reload'): void
  onZoom(request: StudioBrowserZoomRequest): void
  onOpenFind(): void
}

export function BrowserChrome(props: BrowserChromeProps): React.JSX.Element {
  const { conversationId, tabId, instanceId, partition, mode, sessionMode, emulation, url, faviconUrl, loading, canGoBack, canGoForward, zoomLevel, urlInputRef, onNavigate, onAction, onZoom, onOpenFind } = props
  const colors = useColors()
  const previewNetworkShield = usePreferencesStore((s) => s.browserPreviewNetworkShield)
  const updateBrowserTab = useSurfaceStore((s) => s.updateBrowserTab)
  const setBrowserEmulation = useSurfaceStore((s) => s.setBrowserEmulation)
  const [urlInput, setUrlInput] = useState(url)
  const [networkUnlocked, setNetworkUnlocked] = useState(false)
  const [confirmingUnlock, setConfirmingUnlock] = useState(false)
  const [sessionChangePending, setSessionChangePending] = useState(false)

  // The guest's navigation wins over what the operator was typing only when
  // the field is not focused: retyping a URL while a page redirects would
  // otherwise lose keystrokes.
  useEffect(() => {
    if (document.activeElement !== urlInputRef.current) setUrlInput(url)
  }, [url, urlInputRef])

  const reloadView = useCallback(() => onAction('reload'), [onAction])

  const unlockNetwork = useCallback(() => {
    void host.shell
      .studioPreviewAllowNetwork(partition)
      .then((ok) => {
        if (ok) {
          setNetworkUnlocked(true)
          setConfirmingUnlock(false)
          reloadView()
        } else {
          rWarn('studio.browser', 'preview unlock rejected', { partition })
        }
      })
      .catch((err) => rWarn('studio.browser', 'preview unlock failed', { partition, error: String(err) }))
  }, [partition, reloadView])

  const changeSessionMode = useCallback((nextMode: BrowserSessionMode) => {
    if (nextMode === sessionMode || sessionChangePending) return
    setSessionChangePending(true)
    void host.shell
      .studioBrowserSetSessionMode(instanceId, nextMode)
      .then((ok) => {
        if (ok) {
          updateBrowserTab(tabId, { sessionMode: nextMode }, conversationId)
          rInfo('studio.browser', 'browser session mode changed', { instance_id: instanceId, session_mode: nextMode })
        } else {
          rWarn('studio.browser', 'browser session mode rejected', { instance_id: instanceId, session_mode: nextMode })
        }
      })
      .catch((err) => rWarn('studio.browser', 'browser session mode change failed', { instance_id: instanceId, session_mode: nextMode, error: String(err) }))
      .finally(() => setSessionChangePending(false))
  }, [conversationId, instanceId, sessionChangePending, sessionMode, tabId, updateBrowserTab])

  const setNetworkShield = useCallback((enabled: boolean) => {
    void host.shell
      .studioBrowserSetNetworkShield(instanceId, enabled)
      .then((ok) => {
        if (ok) {
          setNetworkUnlocked(!enabled)
          setConfirmingUnlock(false)
          reloadView()
        } else {
          rWarn('studio.browser', 'browser network shield change rejected', { instance_id: instanceId, enabled })
        }
      })
      .catch((err) => rWarn('studio.browser', 'browser network shield change failed', { instance_id: instanceId, enabled, error: String(err) }))
  }, [instanceId, reloadView])

  useEffect(() => {
    if (mode !== 'preview') return
    setNetworkUnlocked(false)
    void host.shell
      .studioBrowserSetNetworkShield(instanceId, previewNetworkShield)
      .then((ok) => {
        if (ok) setNetworkUnlocked(!previewNetworkShield)
        else rWarn('studio.browser', 'preview network shield default rejected', { instance_id: instanceId, enabled: previewNetworkShield })
      })
      .catch((err) => rWarn('studio.browser', 'preview network shield default failed', { instance_id: instanceId, enabled: previewNetworkShield, error: String(err) }))
  }, [instanceId, mode, previewNetworkShield])

  const iconButton = (disabled: boolean): React.CSSProperties => ({
    border: 'none',
    background: 'transparent',
    color: disabled ? colors.textMuted : colors.textTertiary,
    cursor: disabled ? 'default' : 'pointer',
    display: 'flex',
    alignItems: 'center',
    padding: 2,
  })
  const pill: React.CSSProperties = {
    border: `1px solid ${colors.containerBorder}`,
    background: 'transparent',
    color: colors.accent,
    cursor: 'pointer',
    borderRadius: 5,
    fontSize: 10,
    padding: '1px 5px',
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  }

  return (
    <>
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
        <Tooltip text="Back"><button style={iconButton(!canGoBack)} disabled={!canGoBack} onClick={() => onAction('back')} aria-label="Back">
          <ArrowLeft size={13} />
        </button></Tooltip>
        <Tooltip text="Forward"><button style={iconButton(!canGoForward)} disabled={!canGoForward} onClick={() => onAction('forward')} aria-label="Forward">
          <ArrowRight size={13} />
        </button></Tooltip>
        <Tooltip text={loading ? 'Loading' : 'Reload'}><button style={iconButton(false)} onClick={() => onAction('reload')} aria-label="Reload" aria-busy={loading}>
          <ArrowsClockwise size={13} color={loading ? colors.accent : undefined} />
        </button></Tooltip>
        {mode === 'preview' && (
          <Tooltip text={networkUnlocked ? 'Restore preview network shield' : 'Allow preview network'}>
            <button
              onClick={() => (networkUnlocked ? setNetworkShield(true) : setConfirmingUnlock(true))}
              style={{ ...iconButton(false), color: networkUnlocked ? colors.warningFg : colors.accent }}
              aria-label={networkUnlocked ? 'Restore preview network shield' : 'Allow preview network'}
            >
              {networkUnlocked ? <ShieldWarning size={13} /> : <ShieldCheck size={13} />}
            </button>
          </Tooltip>
        )}
        {emulation && (
          <Tooltip text={`Emulating ${emulation.device ?? 'a custom viewport'} at ${emulation.width}x${emulation.height} CSS pixels. Click to restore the responsive view.`}>
            <button onClick={() => setBrowserEmulation(conversationId, instanceId, null)} style={pill} aria-label="Reset browser emulation">
              <DeviceMobile size={11} />
              {emulation.device ?? `${emulation.width}x${emulation.height}`}
            </button>
          </Tooltip>
        )}
        {zoomLevel !== 0 && (
          <Tooltip text="Page zoom. Click to reset to 100%.">
            <button onClick={() => onZoom('reset')} style={pill} aria-label="Reset browser zoom">
              {zoomPercent(zoomLevel)}%
              <X size={9} />
            </button>
          </Tooltip>
        )}
        {mode === 'browse' && (
          <div aria-label="Browser session mode" style={{ display: 'flex', overflow: 'hidden', border: `1px solid ${colors.containerBorder}`, borderRadius: 5 }}>
            {(['isolated', 'shared'] as const).map((candidate) => (
              <button
                key={candidate}
                disabled={sessionChangePending}
                onClick={() => changeSessionMode(candidate)}
                style={{
                  border: 'none',
                  borderLeft: candidate === 'shared' ? `1px solid ${colors.containerBorder}` : 'none',
                  background: sessionMode === candidate ? colors.accent : 'transparent',
                  color: sessionMode === candidate ? colors.textOnAccent : colors.textSecondary,
                  cursor: sessionChangePending ? 'default' : 'pointer',
                  fontSize: 10,
                  padding: '3px 6px',
                }}
              >
                {candidate === 'isolated' ? 'Private' : 'Shared'}
              </button>
            ))}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 5, padding: '2px 8px', borderRadius: 6, border: `1px solid ${colors.containerBorder}`, background: colors.inputPillBg }}>
          {faviconUrl
            ? <img src={faviconUrl} alt="" width={12} height={12} style={{ flexShrink: 0 }} />
            : <Globe size={12} color={colors.textTertiary} />}
          <input
            ref={urlInputRef}
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const target = normalizeUrl(urlInput)
                if (target) onNavigate(target)
                e.currentTarget.blur()
              }
              if (e.key === 'Escape') {
                setUrlInput(url)
                e.currentTarget.blur()
              }
            }}
            placeholder="Enter URL"
            spellCheck={false}
            aria-label="Address"
            style={{ flex: 1, minWidth: 0, fontSize: 11, fontFamily: 'monospace', padding: '1px 0', border: 'none', background: 'transparent', color: colors.textPrimary, outline: 'none' }}
          />
        </div>
        <Tooltip text="Find in page"><button style={iconButton(false)} onClick={onOpenFind} aria-label="Find in page">
          <MagnifyingGlass size={13} />
        </button></Tooltip>
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
          Allow this preview to load network resources? The shield is on by default to keep local HTML offline.
          <button onClick={unlockNetwork} style={{ border: `1px solid ${colors.containerBorder}`, borderRadius: 4, background: 'transparent', color: colors.accent, cursor: 'pointer', fontSize: 10, padding: '1px 8px' }}>
            Allow network
          </button>
          <button onClick={() => setConfirmingUnlock(false)} style={{ border: 'none', background: 'transparent', color: colors.textTertiary, cursor: 'pointer', fontSize: 10 }}>
            Keep offline
          </button>
        </div>
      )}
    </>
  )
}
