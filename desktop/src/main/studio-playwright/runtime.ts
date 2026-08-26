/**
 * The per-conversation browser runtime.
 *
 * This is where ownership is enforced. A browser tool call arrives with a
 * session key supplied by the tool-gate responder — never with a caller-chosen
 * conversation or tab id — and resolves to that conversation's ONE Agent-linked
 * browser tab. A model cannot address the operator's other tabs, and it cannot
 * be retargeted by the operator switching which conversation is on screen
 * mid-call.
 *
 * When a conversation has no linked tab, the renderer is asked to create
 * exactly one and the call proceeds on it. That keeps the common case
 * frictionless — "take a screenshot of localhost:3000" works with no browser
 * open — without ever letting the agent accumulate tabs.
 */
import type { Page } from 'playwright-core'
import { log as _log, warn as _warn } from '../logger'
import { tabIdFromKey } from '../../shared/session-key'
import type { BrowserEmulationState, StudioBrowserTabInfo } from '../../shared/studio-browser-types'
import { applyEmulation, emulationSession } from './emulation'
import { pageForTarget } from './connection'
import { studioPlaywrightHost } from './host'
import { ensureBrowserView, isBrowserViewVisible } from '../studio-browser-views'
import { browserPartitionFor } from '../../shared/studio-browser-partitions'
import { OperationQueues } from './operation-queue'
import { browserCommandSender } from './renderer-bridge'

const TAG = 'studio-playwright'
const COMMAND_TIMEOUT_MS = 15_000
/**
 * Registration follows a mount, so this only absorbs a slow first paint.
 *
 * Overridable for focused tests: the refusal path is worth pinning, and paying
 * the real ten seconds to pin it would make the suite slow enough that someone
 * eventually deletes the test.
 */
let registrationTimeoutMs = 10_000
const REGISTRATION_POLL_MS = 100

/** Test seam for the registration wait. Returns the previous value. */
export function setRegistrationTimeoutForTests(ms: number): number {
  const previous = registrationTimeoutMs
  registrationTimeoutMs = ms
  return previous
}

export const STUDIO_REQUIRED_ERROR =
  'The built-in browser tools require the Ion Studio window. Switch the active interface to Studio and try again.'

export interface ResolvedBrowser {
  conversationId: string
  instanceId: string
  page: Page
  tab: StudioBrowserTabInfo
}

/** Emulation currently applied per browser instance, for reapply on rebind. */
const appliedEmulation = new Map<string, BrowserEmulationState | null>()
const queues = new OperationQueues()

export function resetRuntimeForTests(): void {
  appliedEmulation.clear()
}

/** Serialize work on one browser instance. */
export function runExclusive<T>(instanceId: string, label: string, work: () => Promise<T>): Promise<T> {
  return queues.run(instanceId, label, work)
}

/** Called when a tab closes so queued work fails visibly instead of hanging. */
export function cancelBrowserWork(instanceId: string, reason: string): void {
  queues.cancel(instanceId, reason)
  appliedEmulation.delete(instanceId)
}

/**
 * Resolve the Agent-linked browser for a session, creating it when absent.
 *
 * `create: false` is for read-only status questions, which should report "no
 * browser" rather than materialize one as a side effect of asking.
 */
export async function resolveBrowser(sessionKey: string, options: { create: boolean; url?: string } = { create: true }): Promise<ResolvedBrowser | { error: string }> {
  const conversationId = tabIdFromKey(sessionKey)
  if (!conversationId) return { error: 'this conversation has no desktop tab, so it cannot own a browser tab' }

  const sender = browserCommandSender()
  if (!sender) return { error: STUDIO_REQUIRED_ERROR }

  const reply = await sender(
    options.create
      ? { kind: 'ensure', conversationId, ...(options.url ? { url: options.url } : {}) }
      : { kind: 'status', conversationId },
    COMMAND_TIMEOUT_MS,
  ).catch((err: unknown) => {
    _warn(TAG, 'studio browser command failed', { conversation_id: conversationId, error: String(err) })
    return null
  })

  if (!reply) return { error: STUDIO_REQUIRED_ERROR }
  if (!reply.ok || !reply.tab) {
    return { error: reply.error ?? (options.create ? 'Studio could not open a browser tab for this conversation.' : 'This conversation has no browser tab yet.') }
  }

  const tab = reply.tab
  // Create the guest HERE rather than waiting for a React component to mount
  // it. The renderer owns the descriptor; main owns the WebContentsView. A
  // background conversation never renders its browser body — that is the whole
  // point of it being background — so making guest creation depend on a mount
  // is what left a background agent with a descriptor and no browser.
  //
  // Idempotent: an existing guest for this instance is returned as-is, so the
  // visible path (where the component also asks) creates nothing twice.
  const created = ensureBrowserView({
    conversationId,
    instanceId: tab.instanceId,
    partition: browserPartitionFor(tab.instanceId, tab.mode, tab.sessionMode),
    url: tab.url || options.url || 'about:blank',
  })
  if (!created) return { error: STUDIO_REQUIRED_ERROR }

  const target = await waitForTarget(conversationId, tab.instanceId)
  if (!target) {
    return { error: `The browser tab for this conversation did not finish loading in time (instance ${tab.instanceId}).` }
  }

  const page = await pageForTarget(target.cdpTargetId!).catch((err: unknown) => {
    _warn(TAG, 'playwright page lookup failed', { conversation_id: conversationId, instance_id: tab.instanceId, error: String(err) })
    return null
  })
  if (!page) return { error: 'The browser tab is open but the automation connection could not attach to it.' }

  // A hidden view reports a 0x0 viewport, which makes innerWidth/innerHeight
  // zero and makes Page.captureScreenshot fail with a protocol error. A
  // background agent must be able to measure and screenshot a guest the
  // operator has never displayed, so an explicit viewport is pinned whenever
  // the tab carries no emulation of its own.
  await ensureViewportFloor(page, tab)
  await reapplyEmulation(page, conversationId, tab)
  return { conversationId, instanceId: tab.instanceId, page, tab }
}

/** Default viewport for a guest that has never been shown. */
const OFFSCREEN_VIEWPORT = { width: 1280, height: 900 }

/**
 * Give a never-displayed guest a real viewport.
 *
 * Only when the tab has no emulation state: an emulated tab gets its exact
 * requested size from `applyEmulation` a moment later, and overriding first
 * would briefly fight it. Applied through the shared session so it is not
 * reverted the instant it is set.
 */
async function ensureViewportFloor(page: Page, tab: StudioBrowserTabInfo): Promise<void> {
  if (tab.emulation) return
  try {
    // Measured in the page, not via page.viewportSize(): that returns null on
    // a CDP-attached page regardless of the real window, so trusting it would
    // re-apply the override on every single call.
    const real = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    if (real.w > 0 && real.h > 0) return
    const session = await emulationSession(page)
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: OFFSCREEN_VIEWPORT.width,
      height: OFFSCREEN_VIEWPORT.height,
      deviceScaleFactor: 0,
      mobile: false,
    })
    _log(TAG, 'browser viewport floor applied to a hidden guest', {
      instance_id: tab.instanceId,
      width: OFFSCREEN_VIEWPORT.width,
      height: OFFSCREEN_VIEWPORT.height,
    })
  } catch (err) {
    _warn(TAG, 'browser viewport floor failed', { instance_id: tab.instanceId, error: String(err) })
  }
}

/**
 * Reapply the tab's emulation after a (re)bind.
 *
 * A session-mode flip destroys and recreates the guest, and a reconnect gives
 * a fresh CDP session. Either way the CDP overrides are gone while the
 * descriptor still says the tab is a phone, so without this the visible frame
 * and the real viewport would silently disagree.
 */
async function reapplyEmulation(page: Page, conversationId: string, tab: StudioBrowserTabInfo): Promise<void> {
  const desired = tab.emulation
  const applied = appliedEmulation.get(tab.instanceId)
  if (sameEmulation(applied ?? null, desired)) return
  try {
    await applyEmulation(page, desired, isBrowserViewVisible(conversationId, tab.instanceId))
    appliedEmulation.set(tab.instanceId, desired)
    _log(TAG, 'browser emulation reapplied after bind', { instance_id: tab.instanceId, emulated: desired !== null })
  } catch (err) {
    _warn(TAG, 'browser emulation reapply failed', { instance_id: tab.instanceId, error: String(err) })
  }
}

/** Record what is applied, so a later rebind knows whether to reapply. */
export function noteEmulationApplied(instanceId: string, state: BrowserEmulationState | null): void {
  appliedEmulation.set(instanceId, state)
}

function sameEmulation(a: BrowserEmulationState | null, b: BrowserEmulationState | null): boolean {
  if (a === null || b === null) return a === b
  return JSON.stringify(a) === JSON.stringify(b)
}

async function waitForTarget(conversationId: string, instanceId: string): Promise<{ cdpTargetId: string | null } | null> {
  const deadline = Date.now() + registrationTimeoutMs
  for (;;) {
    const target = studioPlaywrightHost.resolve(conversationId, instanceId)
    if (target?.cdpTargetId) return target
    if (Date.now() >= deadline) return null
    await new Promise((done) => setTimeout(done, REGISTRATION_POLL_MS))
  }
}

/** Ask the renderer to record an emulation change and size its device frame. */
export async function pushEmulationToRenderer(conversationId: string, instanceId: string, emulation: BrowserEmulationState | null): Promise<void> {
  const sender = browserCommandSender()
  if (!sender) return
  const reply = await sender({ kind: 'emulate', conversationId, instanceId, emulation }, COMMAND_TIMEOUT_MS).catch((err: unknown) => {
    _warn(TAG, 'studio emulation push failed', { conversation_id: conversationId, instance_id: instanceId, error: String(err) })
    return null
  })
  if (reply && !reply.ok) {
    _warn(TAG, 'studio refused an emulation update', { conversation_id: conversationId, instance_id: instanceId, error: reply.error ?? '' })
  }
}

/** Ask the renderer to close the linked browser tab. */
export async function closeLinkedBrowser(conversationId: string): Promise<boolean> {
  const sender = browserCommandSender()
  if (!sender) return false
  const reply = await sender({ kind: 'close', conversationId }, COMMAND_TIMEOUT_MS).catch(() => null) // silent-ok: reported to the model as an unconfirmed close
  return reply?.ok === true
}
