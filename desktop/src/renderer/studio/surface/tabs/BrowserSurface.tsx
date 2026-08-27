/**
 * BrowserSurface — a `browser:` surface tab: chrome in the DOM, body in main.
 *
 * The body is a main-process `WebContentsView`, NOT a `<webview>` element.
 * That is forced by automation: Chromium reports a `<webview>` to CDP as a
 * target of type `webview`, and Playwright only turns `page`/`iframe`/`frame`
 * targets into objects — so a webview guest never appears in
 * `context.pages()` and no browser tool could ever attach to it. A
 * WebContentsView is a real `page` target.
 *
 * The consequence for this component is that it renders a HOLE, not a page.
 * The div below is a measured placeholder: it occupies the layout, and its
 * rect is reported to main, which positions the view over exactly that
 * rectangle. Nothing paints inside it here.
 *
 * D6 two modes, one component:
 *   preview — file:// HTML preview on an ephemeral studio-preview-<id>
 *   partition whose session blocks network (file:/data:/blob: only). The
 *   shield click confirms and lifts the block for THIS tab's partition.
 *   browse — shared tabs use the persistent persist:studio-browser partition;
 *   isolated tabs use a private studio-isolated-<instanceId> partition.
 *
 * The view is created once and hidden (not destroyed) on tab switch, so
 * sessions, history, and scroll position survive exactly as they did before.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ArrowsClockwise, DeviceMobile, ShieldWarning, ShieldCheck } from '@phosphor-icons/react'
import { Tooltip } from '../../../components/git/Tooltip'
import { useColors } from '../../../theme'
import { usePreferencesStore } from '../../../preferences'
import { useSurfaceStore } from '../surface-store'
import type { BrowserSessionMode } from '../../../../shared/studio-surface-types'
import type { BrowserEmulationState } from '../../../../shared/studio-browser-types'
import { browserPartitionFor } from '../../../../shared/studio-browser-partitions'
import { rDebug, rInfo, rWarn } from '../../../rendererLogger'

function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '') return ''
  if (/^(https?|file):\/\//i.test(trimmed)) return trimmed
  if (trimmed === 'about:blank') return trimmed
  // Scheme fixup: bare host → https.
  return `https://${trimmed}`
}

/** Re-exported for existing call sites; the rule itself is shared with main. */
export function browserPartition(_conversationId: string, instanceId: string, mode: 'preview' | 'browse', sessionMode: BrowserSessionMode): string {
  return browserPartitionFor(instanceId, mode, sessionMode)
}

export function BrowserSurface({
  conversationId,
  tabId,
  instanceId,
  url,
  mode,
  sessionMode,
  emulation,
}: {
  conversationId: string
  tabId: string
  instanceId: string
  url: string
  mode: 'preview' | 'browse'
  sessionMode: BrowserSessionMode
  /** Device/viewport override for this tab, when the agent or operator set one. */
  emulation?: BrowserEmulationState | null
}): React.JSX.Element {
  const colors = useColors()
  const previewNetworkShield = usePreferencesStore((s) => s.browserPreviewNetworkShield)
  /** The hole in the layout the main-process view is positioned over. */
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [urlInput, setUrlInput] = useState(url)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [networkUnlocked, setNetworkUnlocked] = useState(false)
  const [confirmingUnlock, setConfirmingUnlock] = useState(false)
  const [sessionChangePending, setSessionChangePending] = useState(false)
  const updateBrowserTab = useSurfaceStore((s) => s.updateBrowserTab)
  const setBrowserEmulation = useSurfaceStore((s) => s.setBrowserEmulation)

  const partition = browserPartition(conversationId, instanceId, mode, sessionMode)


  // Scale the device frame to fit the panel. Measured rather than guessed: a
  // computed ratio from a hardcoded assumption drifts the moment the dock or
  // the operator's zoom changes, and the drift is invisible until the frame
  // overflows its container.
  const frameHostRef = useRef<HTMLDivElement | null>(null)
  const [frameScale, setFrameScale] = useState(1)
  useEffect(() => {
    const host = frameHostRef.current
    if (!host || !emulation) {
      setFrameScale(1)
      return
    }
    const measure = (): void => {
      const { width, height } = host.getBoundingClientRect()
      if (width <= 0 || height <= 0) return
      const margin = 16
      const fit = Math.min((width - margin) / emulation.width, (height - margin) / emulation.height, 1)
      setFrameScale(fit > 0 ? Number(fit.toFixed(3)) : 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [emulation])

  // Ensure the view exists, then keep its geometry in sync.
  //
  // Main creates the guest when a tool call needs it, so this is the visible
  // path only: it covers a tab the operator opened themselves, and is
  // idempotent when main already made one.
  //
  // Geometry is pushed on every layout change rather than computed once: the
  // view is not in the document, so nothing moves it when the panel resizes,
  // the dock opens, or the operator drags the splitter. A ResizeObserver on
  // the placeholder is what keeps the two in agreement.
  useEffect(() => {
    let cancelled = false
    void window.ion
      .studioBrowserViewEnsure(conversationId, instanceId, url || 'about:blank', partition)
      .then((ok) => {
        if (!ok && !cancelled) {
          rWarn('studio.browser', 'browser view creation refused', {
            conversation_id: conversationId,
            instance_id: instanceId,
          })
        }
      })
      .catch((err) => rWarn('studio.browser', 'browser view creation failed', {
        conversation_id: conversationId,
        instance_id: instanceId,
        error: String(err),
      }))
    return () => { cancelled = true }
    // `url` is deliberately absent: it seeds the FIRST load only. Re-running on
    // every navigation would fight the guest's own history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, instanceId, partition])

  useEffect(() => {
    const host = bodyRef.current
    if (!host) return
    const push = (): void => {
      // getBoundingClientRect already returns REAL on-screen pixels relative to
      // the content area, which is exactly the coordinate space a child of
      // `contentView` is positioned in. No conversion belongs here.
      //
      // In particular do NOT run this through zoomRect: that divides by the UI
      // zoom to produce CSS units for `position: fixed` elements. A view is not
      // a DOM element and never sees the zoom, so dividing made the view
      // progressively larger and higher than its hole at any zoom above 1.0 —
      // which is why the body spilled over the conversation.
      const rect = host.getBoundingClientRect()
      // An off-screen or collapsed placeholder means this tab is not the one
      // being shown; the view is hidden rather than positioned at a stale rect.
      const visible = rect.width > 1 && rect.height > 1 && host.offsetParent !== null
      window.ion.studioBrowserViewBounds(
        conversationId,
        instanceId,
        { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        visible,
      )
    }
    push()
    const observer = new ResizeObserver(push)
    observer.observe(host)
    // The placeholder can move without changing size (a sibling panel opening,
    // the window itself moving), which a ResizeObserver never reports.
    window.addEventListener('resize', push)
    const interval = window.setInterval(push, 250)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', push)
      window.clearInterval(interval)
      // Hide on unmount so a backgrounded tab's view cannot paint over the
      // shell while its React body is gone.
      window.ion.studioBrowserViewBounds(conversationId, instanceId, { x: 0, y: 0, width: 0, height: 0 }, false)
    }
  }, [conversationId, instanceId, emulation, frameScale])

  // The chrome reads the guest's state from main now: the URL bar and the
  // back/forward buttons have no element to interrogate.
  useEffect(() => {
    return window.ion.onStudioBrowserViewState((next) => {
      if (next.conversationId !== conversationId || next.instanceId !== instanceId) return
      setUrlInput(next.url)
      setCanGoBack(next.canGoBack)
      setCanGoForward(next.canGoForward)
      updateBrowserTab(tabId, { url: next.url, ...(next.title ? { title: next.title } : {}) })
      rDebug('studio.browser', 'navigated', { url: next.url.slice(0, 120) })
    })
  }, [conversationId, instanceId, tabId, updateBrowserTab])

  const navigate = useCallback(
    (raw: string) => {
      const target = normalizeUrl(raw)
      if (!target) return
      void window.ion.studioBrowserViewNavigate(conversationId, instanceId, target)
        .catch((err) => rWarn('studio.browser', 'navigate failed', { error: String(err) }))
      updateBrowserTab(tabId, { url: target })
    },
    [conversationId, instanceId, tabId, updateBrowserTab],
  )

  const viewAction = useCallback((action: 'back' | 'forward' | 'reload') => {
    void window.ion.studioBrowserViewAction(conversationId, instanceId, action)
      .catch((err) => rWarn('studio.browser', 'browser view action failed', { action, error: String(err) }))
  }, [conversationId, instanceId])
  const reloadView = useCallback(() => viewAction('reload'), [viewAction])

  const unlockNetwork = useCallback(() => {
    void window.ion
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
    void window.ion
      .studioBrowserSetSessionMode(instanceId, nextMode)
      .then((ok) => {
        if (ok) {
          updateBrowserTab(tabId, { sessionMode: nextMode })
          rInfo('studio.browser', 'browser session mode changed', { instance_id: instanceId, session_mode: nextMode })
        } else {
          rWarn('studio.browser', 'browser session mode rejected', { instance_id: instanceId, session_mode: nextMode })
        }
      })
      .catch((err) => rWarn('studio.browser', 'browser session mode change failed', { instance_id: instanceId, session_mode: nextMode, error: String(err) }))
      .finally(() => setSessionChangePending(false))
  }, [instanceId, sessionChangePending, sessionMode, tabId, updateBrowserTab])

  const setNetworkShield = useCallback((enabled: boolean) => {
    void window.ion
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
    void window.ion
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
        <Tooltip text="Back"><button style={iconButton(!canGoBack)} disabled={!canGoBack} onClick={() => viewAction('back')} aria-label="Back">
          <ArrowLeft size={13} />
        </button></Tooltip>
        <Tooltip text="Forward"><button style={iconButton(!canGoForward)} disabled={!canGoForward} onClick={() => viewAction('forward')} aria-label="Forward">
          <ArrowRight size={13} />
        </button></Tooltip>
        <Tooltip text="Reload"><button style={iconButton(false)} onClick={() => viewAction('reload')} aria-label="Reload">
          <ArrowsClockwise size={13} />
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
            <button
              onClick={() => setBrowserEmulation(conversationId, instanceId, null)}
              style={{
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
              }}
              aria-label="Reset browser emulation"
            >
              <DeviceMobile size={11} />
              {emulation.device ?? `${emulation.width}x${emulation.height}`}
            </button>
          </Tooltip>
        )}
        {mode === 'browse' && (
          <div
            aria-label="Browser session mode"
            style={{ display: 'flex', overflow: 'hidden', border: `1px solid ${colors.containerBorder}`, borderRadius: 5 }}
          >
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
          Allow this preview to load network resources? The shield is on by default to keep local HTML offline.
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
      <div
        ref={frameHostRef}
        style={{
          flex: 1,
          minHeight: 0,
          ...(emulation
            ? { display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', background: colors.surfaceSecondary }
            : {}),
        }}
      >
        <div
          ref={bodyRef}
          // Nothing renders inside this element. It reserves the rectangle the
          // main-process view is positioned over; the border is what the
          // operator sees framing an emulated device.
          style={
            emulation
              ? {
                  width: emulation.width,
                  height: emulation.height,
                  flex: '0 0 auto',
                  transform: frameScale === 1 ? undefined : `scale(${frameScale})`,
                  transformOrigin: 'center center',
                  boxShadow: `0 0 0 1px ${colors.containerBorder}`,
                  background: colors.surfacePrimary,
                }
              : { width: '100%', height: '100%' }
          }
        />
      </div>
    </div>
  )
}
