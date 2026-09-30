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
 * Everything above the hole (toolbar, find bar, prompt bars) is a DOM row, so
 * opening one shrinks the hole and the view follows on the next measurement.
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
import { useColors } from '../../../theme'
import { useSurfaceStore } from '../surface-store'
import type { BrowserSessionMode } from '@ion/shared/studio-surface-types'
import type { BrowserEmulationState, StudioBrowserPrompt, StudioBrowserPromptAnswer, StudioBrowserZoomRequest } from '@ion/shared/studio-browser-types'
import { browserPartitionFor } from '@ion/shared/studio-browser-partitions'
import { rDebug, rWarn } from '../../../rendererLogger'
import { host } from '../../../host/host-instance'
import { BrowserChrome } from './BrowserChrome'
import { BrowserFindBar, type FindMatches } from './BrowserFindBar'
import { BrowserPromptBar } from './BrowserPromptBar'

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
  zoomLevel: storedZoomLevel,
  faviconUrl: storedFaviconUrl,
}: {
  conversationId: string
  tabId: string
  instanceId: string
  url: string
  mode: 'preview' | 'browse'
  sessionMode: BrowserSessionMode
  /** Device/viewport override for this tab, when the agent or operator set one. */
  emulation?: BrowserEmulationState | null
  /** The zoom the document was left at; re-applied when the view is created. */
  zoomLevel?: number
  faviconUrl?: string
}): React.JSX.Element {
  const colors = useColors()
  /** The hole in the layout the main-process view is positioned over. */
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const urlInputRef = useRef<HTMLInputElement | null>(null)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [loading, setLoading] = useState(false)
  const [zoomLevel, setZoomLevel] = useState(storedZoomLevel ?? 0)
  const [findOpen, setFindOpen] = useState(false)
  const [findFocusNonce, setFindFocusNonce] = useState(0)
  const [findMatches, setFindMatches] = useState<FindMatches | null>(null)
  /** Page requests waiting on the operator, oldest first; one is shown at a time. */
  const [prompts, setPrompts] = useState<StudioBrowserPrompt[]>([])
  const updateBrowserTab = useSurfaceStore((s) => s.updateBrowserTab)

  const partition = browserPartition(conversationId, instanceId, mode, sessionMode)

  // Scale the device frame to fit the panel. Measured rather than guessed: a
  // computed ratio from a hardcoded assumption drifts the moment the dock or
  // the operator's zoom changes, and the drift is invisible until the frame
  // overflows its container.
  const frameHostRef = useRef<HTMLDivElement | null>(null)
  const [frameScale, setFrameScale] = useState(1)
  useEffect(() => {
    const frameHost = frameHostRef.current
    if (!frameHost || !emulation) {
      setFrameScale(1)
      return
    }
    const measure = (): void => {
      const { width, height } = frameHost.getBoundingClientRect()
      if (width <= 0 || height <= 0) return
      const margin = 16
      const fit = Math.min((width - margin) / emulation.width, (height - margin) / emulation.height, 1)
      setFrameScale(fit > 0 ? Number(fit.toFixed(3)) : 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(frameHost)
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
    void host.shell
      .studioBrowserViewEnsure(conversationId, instanceId, url || 'about:blank', partition, storedZoomLevel)
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
    // `url` and `storedZoomLevel` are deliberately absent: they seed the FIRST
    // load only. Re-running on every navigation would fight the guest's own
    // history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, instanceId, partition])

  useEffect(() => {
    const bodyEl = bodyRef.current
    if (!bodyEl) return
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
      const rect = bodyEl.getBoundingClientRect()
      // An off-screen or collapsed placeholder means this tab is not the one
      // being shown; the view is hidden rather than positioned at a stale rect.
      const visible = rect.width > 1 && rect.height > 1 && bodyEl.offsetParent !== null
      host.shell.studioBrowserViewBounds(
        conversationId,
        instanceId,
        { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        visible,
      )
    }
    push()
    const observer = new ResizeObserver(push)
    observer.observe(bodyEl)
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
      host.shell.studioBrowserViewBounds(conversationId, instanceId, { x: 0, y: 0, width: 0, height: 0 }, false)
    }
  }, [conversationId, instanceId, emulation, frameScale])

  // The chrome reads the guest's state from main: the URL bar, the history
  // buttons, the favicon, and the loading state have no element to ask. The
  // descriptor is patched by conversation, not by what is on screen, so a
  // background document's navigation is remembered for its restore too.
  useEffect(() => {
    return host.shell.onStudioBrowserViewState((next) => {
      if (next.conversationId !== conversationId || next.instanceId !== instanceId) return
      setCanGoBack(next.canGoBack)
      setCanGoForward(next.canGoForward)
      setLoading(next.loading)
      setZoomLevel(next.zoomLevel)
      updateBrowserTab(tabId, {
        url: next.url,
        ...(next.title ? { title: next.title } : {}),
        faviconUrl: next.faviconUrl,
        zoomLevel: next.zoomLevel,
      }, conversationId)
      rDebug('studio.browser', 'navigated', { url: next.url.slice(0, 120), loading: next.loading })
    })
  }, [conversationId, instanceId, tabId, updateBrowserTab])

  useEffect(() => {
    return host.shell.onStudioBrowserFindResult((result) => {
      if (result.conversationId !== conversationId || result.instanceId !== instanceId) return
      setFindMatches({ activeMatchOrdinal: result.activeMatchOrdinal, matches: result.matches })
    })
  }, [conversationId, instanceId])

  // A page asked for something only the operator can grant. Main re-sends
  // any prompt still open when this chrome mounts, so a request raised while
  // the document was off screen is not lost.
  useEffect(() => {
    return host.shell.onStudioBrowserPrompt((prompt) => {
      if (prompt.conversationId !== conversationId || prompt.instanceId !== instanceId) return
      setPrompts((current) => (current.some((p) => p.promptId === prompt.promptId) ? current : [...current, prompt]))
      rDebug('studio.browser', 'page prompt shown', { instance_id: instanceId, prompt_id: prompt.promptId, kind: prompt.kind })
    })
  }, [conversationId, instanceId])

  const answerPrompt = useCallback((answer: StudioBrowserPromptAnswer) => {
    host.shell.studioBrowserPromptAnswer(answer)
    setPrompts((current) => current.filter((p) => p.promptId !== answer.promptId))
  }, [])

  // Shortcuts pressed inside the guest that change the chrome. Main has
  // already moved keyboard focus to the Studio window before sending one.
  useEffect(() => {
    return host.shell.onStudioBrowserShortcut((event) => {
      if (event.conversationId !== conversationId || event.instanceId !== instanceId) return
      switch (event.action) {
        case 'focus-url-bar':
          urlInputRef.current?.focus()
          urlInputRef.current?.select()
          return
        case 'open-find':
          setFindOpen(true)
          setFindFocusNonce((n) => n + 1)
          return
        case 'close-find':
          setFindOpen(false)
          return
      }
    })
  }, [conversationId, instanceId])

  const navigate = useCallback((target: string) => {
    void host.shell.studioBrowserViewNavigate(conversationId, instanceId, target)
      .catch((err) => rWarn('studio.browser', 'navigate failed', { error: String(err) }))
    updateBrowserTab(tabId, { url: target }, conversationId)
  }, [conversationId, instanceId, tabId, updateBrowserTab])

  const viewAction = useCallback((action: 'back' | 'forward' | 'reload') => {
    void host.shell.studioBrowserViewAction(conversationId, instanceId, action)
      .catch((err) => rWarn('studio.browser', 'browser view action failed', { action, error: String(err) }))
  }, [conversationId, instanceId])

  const zoom = useCallback((request: StudioBrowserZoomRequest) => {
    void host.shell.studioBrowserSetZoom(conversationId, instanceId, request)
      .then((level) => { if (level !== null) setZoomLevel(level) })
      .catch((err) => rWarn('studio.browser', 'browser zoom failed', { error: String(err) }))
  }, [conversationId, instanceId])

  const openFind = useCallback(() => {
    setFindOpen(true)
    setFindFocusNonce((n) => n + 1)
  }, [])

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <BrowserChrome
        conversationId={conversationId}
        tabId={tabId}
        instanceId={instanceId}
        partition={partition}
        mode={mode}
        sessionMode={sessionMode}
        emulation={emulation ?? null}
        url={url}
        faviconUrl={storedFaviconUrl ?? ''}
        loading={loading}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        zoomLevel={zoomLevel}
        urlInputRef={urlInputRef}
        onNavigate={navigate}
        onAction={viewAction}
        onZoom={zoom}
        onOpenFind={openFind}
      />
      {prompts[0] && <BrowserPromptBar key={prompts[0].promptId} prompt={prompts[0]} onAnswer={answerPrompt} />}
      {findOpen && (
        <BrowserFindBar
          conversationId={conversationId}
          instanceId={instanceId}
          matches={findMatches}
          focusNonce={findFocusNonce}
          onClose={() => { setFindOpen(false); setFindMatches(null) }}
        />
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
