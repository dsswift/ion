/**
 * Studio browser contracts shared by the main process, the preload bridge,
 * and the Studio renderer.
 *
 * Two things live here and nothing else:
 *
 *   1. `BrowserEmulationState` — the resolved device/viewport override a
 *      browser tab currently runs under. It is *tab-local persisted state*:
 *      the descriptor carries it so a restored or recreated guest comes back
 *      on the same emulated viewport instead of silently reverting to a
 *      desktop layout mid-session.
 *   2. The correlated main→renderer browser command surface. Main owns the
 *      Playwright runtime but does NOT own Surface descriptors, so every
 *      structural change (create the Agent-linked tab, close it, reveal it,
 *      record an emulation change) is a request the renderer applies and
 *      acknowledges. The renderer answers only once its descriptor is
 *      updated AND the matching webview has registered, so a tool call never
 *      races a half-mounted guest.
 *
 * Diagnostics (console/network history) are deliberately absent: they are
 * bounded live runtime data owned by the main-process recorders and never
 * cross into renderer state or onto disk.
 */
import type { BrowserSessionMode } from './studio-surface-types'

/** Emulated screen orientation. Mirrors Playwright's device descriptors. */
export type BrowserOrientation = 'portrait' | 'landscape'
export type BrowserColorScheme = 'light' | 'dark' | 'no-preference'
export type BrowserReducedMotion = 'reduce' | 'no-preference'
export type BrowserForcedColors = 'active' | 'none'

/** Emulated geolocation fix. `accuracy` follows the Geolocation API default. */
export interface BrowserGeolocation {
  latitude: number
  longitude: number
  accuracy?: number
}

/**
 * A browser tab's resolved emulation state.
 *
 * `width`/`height` are always present because every emulation state pins an
 * exact CSS-pixel viewport — that is the whole point of the feature, and a
 * partially-specified viewport would leave the visible device frame guessing.
 * Everything else is optional and absent means "no override": the guest keeps
 * Chromium's own value rather than an Ion-invented default.
 *
 * `device` records the preset name a caller asked for so the UI badge and
 * tool output can say `iPhone 15` instead of `393x852`. It is a label over
 * the resolved numbers, never a second source of truth — the numbers below
 * are what is actually applied.
 */
export interface BrowserEmulationState {
  /** Playwright device-registry name, when the state came from a preset. */
  device?: string
  width: number
  height: number
  screenWidth?: number
  screenHeight?: number
  deviceScaleFactor?: number
  isMobile?: boolean
  hasTouch?: boolean
  userAgent?: string
  locale?: string
  timezoneId?: string
  orientation?: BrowserOrientation
  colorScheme?: BrowserColorScheme
  reducedMotion?: BrowserReducedMotion
  forcedColors?: BrowserForcedColors
  geolocation?: BrowserGeolocation
  offline?: boolean
  javaScriptEnabled?: boolean
}

export const MAX_EMULATION_DIMENSION = 8192
export const MIN_EMULATION_DIMENSION = 1
export const MAX_EMULATION_SCALE_FACTOR = 5

/**
 * Validate an emulation state arriving over IPC.
 *
 * Used by BOTH sides on purpose: main validates what the renderer registers,
 * the renderer validates what main asks it to store, and the persistence
 * parser validates what came off disk. One implementation means the three
 * can never disagree about what a legal state is.
 */
export function parseBrowserEmulation(raw: unknown): BrowserEmulationState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const v = raw as Record<string, unknown>
  const width = v.width
  const height = v.height
  if (!isDimension(width) || !isDimension(height)) return null

  const state: BrowserEmulationState = { width, height }
  if (typeof v.device === 'string' && v.device.length > 0 && v.device.length <= 128) state.device = v.device
  if (isDimension(v.screenWidth)) state.screenWidth = v.screenWidth
  if (isDimension(v.screenHeight)) state.screenHeight = v.screenHeight
  if (typeof v.deviceScaleFactor === 'number' && Number.isFinite(v.deviceScaleFactor) && v.deviceScaleFactor > 0 && v.deviceScaleFactor <= MAX_EMULATION_SCALE_FACTOR) {
    state.deviceScaleFactor = v.deviceScaleFactor
  }
  if (typeof v.isMobile === 'boolean') state.isMobile = v.isMobile
  if (typeof v.hasTouch === 'boolean') state.hasTouch = v.hasTouch
  if (typeof v.userAgent === 'string' && v.userAgent.length > 0 && v.userAgent.length <= 512) state.userAgent = v.userAgent
  if (typeof v.locale === 'string' && /^[A-Za-z0-9_-]{2,35}$/.test(v.locale)) state.locale = v.locale
  if (typeof v.timezoneId === 'string' && v.timezoneId.length > 0 && v.timezoneId.length <= 64) state.timezoneId = v.timezoneId
  if (v.orientation === 'portrait' || v.orientation === 'landscape') state.orientation = v.orientation
  if (v.colorScheme === 'light' || v.colorScheme === 'dark' || v.colorScheme === 'no-preference') state.colorScheme = v.colorScheme
  if (v.reducedMotion === 'reduce' || v.reducedMotion === 'no-preference') state.reducedMotion = v.reducedMotion
  if (v.forcedColors === 'active' || v.forcedColors === 'none') state.forcedColors = v.forcedColors
  if (typeof v.offline === 'boolean') state.offline = v.offline
  if (typeof v.javaScriptEnabled === 'boolean') state.javaScriptEnabled = v.javaScriptEnabled

  const geo = v.geolocation
  if (geo && typeof geo === 'object' && !Array.isArray(geo)) {
    const g = geo as Record<string, unknown>
    if (
      typeof g.latitude === 'number' && Number.isFinite(g.latitude) && g.latitude >= -90 && g.latitude <= 90 &&
      typeof g.longitude === 'number' && Number.isFinite(g.longitude) && g.longitude >= -180 && g.longitude <= 180
    ) {
      state.geolocation = {
        latitude: g.latitude,
        longitude: g.longitude,
        ...(typeof g.accuracy === 'number' && Number.isFinite(g.accuracy) && g.accuracy >= 0 ? { accuracy: g.accuracy } : {}),
      }
    }
  }
  return state
}

function isDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_EMULATION_DIMENSION && value <= MAX_EMULATION_DIMENSION
}

/** One browser tab as the main process and the tools see it. */
export interface StudioBrowserTabInfo {
  instanceId: string
  url: string
  title: string
  mode: 'preview' | 'browse'
  sessionMode: BrowserSessionMode
  /** True only for the conversation's single Agent-linked tab. */
  agentLinked: boolean
  emulation: BrowserEmulationState | null
}

/**
 * A correlated request from main to the Studio renderer.
 *
 * `ensure` is the one that carries the single-link rule: it returns the
 * conversation's Agent-linked tab, creating exactly one when the pointer is
 * null. It never adopts an existing unlinked user tab — a preloaded page the
 * operator prepared for themselves must not become an agent target because
 * some other tab happened to close.
 */
export type StudioBrowserCommand =
  | { kind: 'ensure'; conversationId: string; url?: string }
  | { kind: 'status'; conversationId: string }
  | { kind: 'close'; conversationId: string }
  | { kind: 'reveal'; conversationId: string }
  | {
      kind: 'emulate'
      conversationId: string
      instanceId: string
      /** null clears every override and restores the responsive view. */
      emulation: BrowserEmulationState | null
    }

/** Envelope carrying one command plus its reply correlator. */
export interface StudioBrowserCommandEnvelope {
  callId: string
  command: StudioBrowserCommand
}

/**
 * The renderer's single answer for one `callId`.
 *
 * `ok: false` with a populated `error` is a real refusal the model should
 * read (no Studio window, unknown conversation, guest never registered).
 * It is never a silent empty success.
 */
export interface StudioBrowserCommandResult {
  callId: string
  ok: boolean
  error?: string
  tab?: StudioBrowserTabInfo
}

/** Validate a command envelope crossing into the renderer. */
export function parseBrowserCommandEnvelope(raw: unknown): StudioBrowserCommandEnvelope | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  if (typeof v.callId !== 'string' || v.callId.length === 0 || v.callId.length > 128) return null
  const command = parseBrowserCommand(v.command)
  return command ? { callId: v.callId, command } : null
}

function parseBrowserCommand(raw: unknown): StudioBrowserCommand | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  const conversationId = v.conversationId
  if (typeof conversationId !== 'string' || conversationId.length === 0 || conversationId.length > 128) return null
  switch (v.kind) {
    case 'status':
    case 'close':
    case 'reveal':
      return { kind: v.kind, conversationId }
    case 'ensure':
      return {
        kind: 'ensure',
        conversationId,
        ...(typeof v.url === 'string' && v.url.length > 0 && v.url.length <= 8192 ? { url: v.url } : {}),
      }
    case 'emulate': {
      if (typeof v.instanceId !== 'string' || v.instanceId.length === 0 || v.instanceId.length > 128) return null
      // An absent/null emulation is the explicit reset, distinct from a
      // malformed payload: only reject when a value was supplied and failed.
      const emulation = v.emulation == null ? null : parseBrowserEmulation(v.emulation)
      if (v.emulation != null && emulation === null) return null
      return { kind: 'emulate', conversationId, instanceId: v.instanceId, emulation }
    }
    default:
      return null
  }
}

/** Validate the renderer's acknowledgement before main resolves its promise. */
export function parseBrowserCommandResult(raw: unknown): StudioBrowserCommandResult | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  if (typeof v.callId !== 'string' || !v.callId || typeof v.ok !== 'boolean') return null
  const result: StudioBrowserCommandResult = { callId: v.callId, ok: v.ok }
  if (typeof v.error === 'string' && v.error) result.error = v.error.slice(0, 2048)
  const tab = v.tab
  if (tab && typeof tab === 'object' && !Array.isArray(tab)) {
    const t = tab as Record<string, unknown>
    if (typeof t.instanceId === 'string' && t.instanceId) {
      result.tab = {
        instanceId: t.instanceId,
        url: typeof t.url === 'string' ? t.url : '',
        title: typeof t.title === 'string' ? t.title : '',
        mode: t.mode === 'preview' ? 'preview' : 'browse',
        sessionMode: t.sessionMode === 'isolated' ? 'isolated' : 'shared',
        agentLinked: t.agentLinked === true,
        emulation: parseBrowserEmulation(t.emulation),
      }
    }
  }
  return result
}
