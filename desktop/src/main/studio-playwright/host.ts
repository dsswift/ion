/**
 * Studio Playwright host — main-process ownership of Studio browser targets.
 *
 * Chromium exposes its debugging server only on loopback. That protects the
 * transport, but not target selection. Each target is bound to the exact
 * conversation and browser instance that created it. Tools can address only
 * that pair; they cannot supply a WebContents ID or use the active tab.
 */
import { app, type WebContents } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'studio-playwright'
const LOOPBACK_HOST = '127.0.0.1'
const DEVTOOLS_ACTIVE_PORT = 'DevToolsActivePort'
const MAX_TARGET_ID_LENGTH = 128

function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export interface StudioBrowserTarget {
  conversationId: string
  instanceId: string
  webContents: WebContents
  cdpTargetId: string | null
}

/** The browser chooses a free local port and writes it after Chromium starts. */
if (typeof app.commandLine?.appendSwitch === 'function') {
  app.commandLine.appendSwitch('remote-debugging-address', LOOPBACK_HOST)
  app.commandLine.appendSwitch('remote-debugging-port', '0')
}

function targetKey(conversationId: string, instanceId: string): string {
  return `${conversationId}\u0000${instanceId}`
}

function validTargetPart(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TARGET_ID_LENGTH && /^[A-Za-z0-9._-]+$/.test(value)
}

/** Read Chromium's dynamic debugging endpoint. Exported for focused lifecycle tests. */
export async function readDevToolsEndpoint(
  activePortFile = join(app.getPath('userData'), DEVTOOLS_ACTIVE_PORT),
): Promise<string> {
  const content = await readFile(activePortFile, 'utf8')
  const port = content.split(/\r?\n/, 1)[0]?.trim()
  if (!/^[1-9]\d{0,4}$/.test(port ?? '') || Number(port) > 65535) {
    throw new Error('DevToolsActivePort has no valid port')
  }
  return `http://${LOOPBACK_HOST}:${port}`
}

async function readCdpTargetId(webContents: WebContents): Promise<string> {
  const debuggerApi = webContents.debugger
  const attachedHere = !debuggerApi.isAttached()
  if (attachedHere) debuggerApi.attach('1.3')
  try {
    const result = await debuggerApi.sendCommand('Target.getTargetInfo') as {
      targetInfo?: { targetId?: unknown }
    }
    if (!validTargetPart(result.targetInfo?.targetId)) {
      throw new Error('DevTools target did not return a target ID')
    }
    return result.targetInfo.targetId
  } finally {
    if (attachedHere && debuggerApi.isAttached()) debuggerApi.detach()
  }
}

export class StudioPlaywrightHost {
  private readonly targets = new Map<string, StudioBrowserTarget>()

  /**
   * Register a guest only after the Studio webview policy accepted it. The
   * caller supplies the descriptor's conversation and instance identity.
   */
  register(conversationId: unknown, instanceId: unknown, webContents: WebContents): void {
    if (!validTargetPart(conversationId) || !validTargetPart(instanceId)) {
      warn('browser target registration refused: invalid descriptor identity', {
        conversation_id_type: typeof conversationId,
        instance_id_type: typeof instanceId,
      })
      return
    }
    const key = targetKey(conversationId, instanceId)
    const target: StudioBrowserTarget = { conversationId, instanceId, webContents, cdpTargetId: null }
    this.targets.set(key, target)
    webContents.once('destroyed', () => {
      if (this.targets.get(key) === target) this.targets.delete(key)
      log('browser target removed', { conversation_id: conversationId, instance_id: instanceId, reason: 'destroyed' })
    })
    void readCdpTargetId(webContents)
      .then((cdpTargetId) => {
        if (this.targets.get(key) !== target || webContents.isDestroyed()) return
        target.cdpTargetId = cdpTargetId
        log('browser target registered', { conversation_id: conversationId, instance_id: instanceId, cdp_target_id: cdpTargetId })
      })
      .catch((err: unknown) => {
        if (this.targets.get(key) !== target) return
        warn('browser target DevTools identity unavailable', {
          conversation_id: conversationId,
          instance_id: instanceId,
          error: String(err),
        })
      })
  }

  /** Drop a target explicitly, for a view closed before its guest died. */
  unregister(conversationId: unknown, instanceId: unknown): void {
    if (!validTargetPart(conversationId) || !validTargetPart(instanceId)) return
    const key = targetKey(conversationId, instanceId)
    if (!this.targets.delete(key)) return
    log('browser target removed', { conversation_id: conversationId, instance_id: instanceId, reason: 'closed' })
  }

  resolve(conversationId: unknown, instanceId: unknown): StudioBrowserTarget | null {
    if (!validTargetPart(conversationId) || !validTargetPart(instanceId)) {
      warn('browser target lookup refused: invalid descriptor identity', {
        conversation_id_type: typeof conversationId,
        instance_id_type: typeof instanceId,
      })
      return null
    }
    const target = this.targets.get(targetKey(conversationId, instanceId))
    if (!target || target.webContents.isDestroyed() || !target.cdpTargetId) {
      warn('browser target lookup refused: target is unavailable', { conversation_id: conversationId, instance_id: instanceId })
      return null
    }
    return target
  }
}

export const studioPlaywrightHost = new StudioPlaywrightHost()

/** Attach Studio guests only after Electron's webview hardening accepts them. */
export function registerStudioPlaywrightWebview(
  conversationId: unknown,
  instanceId: unknown,
  webContents: WebContents,
): void {
  studioPlaywrightHost.register(conversationId, instanceId, webContents)
}

/** Release a Studio guest whose browser tab was closed. */
export function unregisterStudioPlaywrightWebview(conversationId: unknown, instanceId: unknown): void {
  studioPlaywrightHost.unregister(conversationId, instanceId)
}
