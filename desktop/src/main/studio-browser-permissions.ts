/**
 * studio-browser-permissions — what a page may have, and who decides.
 *
 * Three requests a page can make are answered here, all by the operator:
 *
 *   - a permission (geolocation, camera, notifications, …) through the
 *     session's permission handlers,
 *   - an HTTP login through the guest's `login` event,
 *   - trust in a bad certificate through the guest's `certificate-error` event.
 *
 * With no handler installed, a Chromium session GRANTS permission requests,
 * so a page in a browse tab used to get the camera without anyone being
 * asked. The default here is deny: a request is refused unless the operator
 * says otherwise through the prompt bar in the chrome.
 *
 * Decisions live in memory for the session and are never written to disk. A
 * persisted grant is a durable security decision, and there is no settings
 * surface to review or revoke one; a grant the operator cannot see or undo is
 * worse than being asked again after a restart. Certificate trust is scoped
 * further still, to one host and one certificate.
 *
 * This module owns no `webContents.send`: prompts leave through a sender the
 * IPC layer injects, which is what keeps every Studio-bound send in one file.
 */
import { session, type WebContents } from 'electron'
import { debug as _debug, log as _log, warn as _warn } from './logger'
import type { BrowserPermission, StudioBrowserPrompt, StudioBrowserPromptAnswer, StudioBrowserPromptBody } from '@ion/shared/studio-browser-types'

const TAG = 'studio-browser-permissions'

const PROMPTABLE: ReadonlySet<string> = new Set<BrowserPermission>([
  'geolocation', 'notifications', 'media', 'midi', 'midiSysex', 'clipboard-read',
  'display-capture', 'idle-detection', 'pointerLock', 'keyboardLock',
])

/** Granted without asking: a page going full-screen is visible and reversible. */
const AUTO_GRANTED: ReadonlySet<string> = new Set(['fullscreen'])

/**
 * The operator's answers so far. Pure, so the rules are pinned by test
 * without a session: a grant is reused for the same partition, origin, and
 * permission; anything else asks again.
 */
export class PermissionDecisions {
  private readonly permissions = new Map<string, boolean>()
  private readonly certificates = new Set<string>()

  decide(partition: string, origin: string, permission: string): boolean | undefined {
    return this.permissions.get(`${partition}\n${origin}\n${permission}`)
  }

  record(partition: string, origin: string, permission: string, granted: boolean): void {
    this.permissions.set(`${partition}\n${origin}\n${permission}`, granted)
  }

  allowCertificate(partition: string, host: string, fingerprint: string): void {
    this.certificates.add(`${partition}\n${host}\n${fingerprint}`)
  }

  certificateAllowed(partition: string, host: string, fingerprint: string): boolean {
    return this.certificates.has(`${partition}\n${host}\n${fingerprint}`)
  }
}

export const decisions = new PermissionDecisions()

export interface GuestContext {
  conversationId: string
  instanceId: string
  partition: string
}

interface Pending {
  prompt: StudioBrowserPrompt
  partition: string
  /** Settle the underlying Chromium callback. Runs exactly once. */
  settle(answer: StudioBrowserPromptAnswer | null): void
}

const pending = new Map<string, Pending>()
let promptSeq = 0

let promptSender: ((prompt: StudioBrowserPrompt) => void) | null = null
/** Injected by the IPC layer, which owns the send. */
export function setBrowserPromptSender(sender: typeof promptSender): void {
  promptSender = sender
}

function open(context: GuestContext, prompt: StudioBrowserPromptBody, settle: Pending['settle']): void {
  const promptId = `browser-prompt-${++promptSeq}`
  const full: StudioBrowserPrompt = { promptId, conversationId: context.conversationId, instanceId: context.instanceId, ...prompt }
  let settled = false
  pending.set(promptId, {
    prompt: full,
    partition: context.partition,
    settle: (answer) => {
      if (settled) return
      settled = true
      pending.delete(promptId)
      settle(answer)
    },
  })
  _log(TAG, 'browser prompt opened', { conversation_id: context.conversationId, instance_id: context.instanceId, prompt_id: promptId, kind: prompt.kind })
  if (promptSender) promptSender(full)
  else _warn(TAG, 'browser prompt has no sender yet; it waits for the chrome', { prompt_id: promptId, kind: prompt.kind })
}

/** Prompts still waiting on one document, re-sent when its chrome mounts. */
export function pendingBrowserPrompts(conversationId: string, instanceId: string): StudioBrowserPrompt[] {
  return [...pending.values()].filter((p) => p.prompt.conversationId === conversationId && p.prompt.instanceId === instanceId).map((p) => p.prompt)
}

/** The chrome answered. Returns false for an unknown or already-settled prompt. */
export function answerBrowserPrompt(answer: StudioBrowserPromptAnswer): boolean {
  const entry = pending.get(answer.promptId)
  if (!entry || entry.prompt.kind !== answer.kind) {
    _warn(TAG, 'browser prompt answer ignored', { prompt_id: answer.promptId, kind: answer.kind, known: !!entry })
    return false
  }
  entry.settle(answer)
  return true
}

/** A guest went away: every prompt it had open resolves as refused. */
export function refuseBrowserPromptsFor(conversationId: string, instanceId: string): void {
  for (const entry of [...pending.values()]) {
    if (entry.prompt.conversationId === conversationId && entry.prompt.instanceId === instanceId) entry.settle(null)
  }
}

function originOf(raw: string): string {
  try {
    return new URL(raw).origin
  } catch {
    return ''
  }
}

const sessionsInstalled = new Set<string>()

/**
 * Install the session-level permission handlers for one partition.
 *
 * Both handlers matter. The request handler answers a page that asks; the
 * check handler answers `navigator.permissions.query`, which without one
 * reports "granted" for permissions nobody granted.
 */
export function installBrowserPermissionHandlers(partition: string, resolveContext: (contents: WebContents) => GuestContext | null): void {
  if (sessionsInstalled.has(partition)) return
  sessionsInstalled.add(partition)
  const ses = session.fromPartition(partition)

  ses.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
    if (AUTO_GRANTED.has(permission)) return true
    const origin = originOf(requestingOrigin)
    const context = contents ? resolveContext(contents) : null
    const granted = context ? decisions.decide(partition, origin, permission) === true : false
    // DEBUG: a page may query its permissions on every frame.
    _debug(TAG, 'browser permission check', { partition, permission, origin, granted })
    return granted
  })

  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const context = resolveContext(contents)
    const origin = originOf(details.requestingUrl)
    if (AUTO_GRANTED.has(permission)) {
      _log(TAG, 'browser permission auto-granted', { partition, permission, origin })
      callback(true)
      return
    }
    if (!context || !origin || !PROMPTABLE.has(permission)) {
      _log(TAG, 'browser permission denied', { partition, permission, origin, reason: !context ? 'not a browser guest' : !origin ? 'no origin' : 'not promptable' })
      callback(false)
      return
    }
    const remembered = decisions.decide(partition, origin, permission)
    if (remembered !== undefined) {
      _log(TAG, 'browser permission answered from memory', { partition, permission, origin, granted: remembered })
      callback(remembered)
      return
    }
    const mediaTypes = 'mediaTypes' in details && Array.isArray(details.mediaTypes) ? details.mediaTypes : []
    open(context, { kind: 'permission', origin, permission: permission as BrowserPermission, mediaTypes }, (answer) => {
      const granted = answer?.kind === 'permission' && answer.granted
      decisions.record(partition, origin, permission, granted)
      _log(TAG, 'browser permission decided', { partition, permission, origin, granted, answered: answer !== null })
      callback(granted)
    })
  })
}

/**
 * Install the per-guest prompts: HTTP auth and certificate errors.
 *
 * The `login` listener is on the guest, not on `app`, so a login the engine
 * or an OAuth window raises is never intercepted here.
 */
export function installGuestSecurityPrompts(guest: WebContents, context: GuestContext): void {
  guest.on('login', (event, _request, authInfo, callback) => {
    event.preventDefault()
    open(context, { kind: 'auth', host: `${authInfo.host}:${authInfo.port}`, realm: authInfo.realm, isProxy: authInfo.isProxy }, (answer) => {
      // The callback must run exactly once either way; a missed call leaves
      // the request hanging with the page blank. Credentials are never logged.
      if (answer?.kind === 'auth' && !('cancel' in answer)) {
        _log(TAG, 'browser auth supplied', { conversation_id: context.conversationId, url_host: authInfo.host, realm: authInfo.realm })
        callback(answer.username, answer.password)
      } else {
        _log(TAG, 'browser auth cancelled', { conversation_id: context.conversationId, url_host: authInfo.host, realm: authInfo.realm })
        callback()
      }
    })
  })

  guest.on('certificate-error', (event, url, error, certificate, callback, isMainFrame) => {
    let host = ''
    try { host = new URL(url).host } catch { host = '' }
    const fingerprint = certificate.fingerprint
    if (decisions.certificateAllowed(context.partition, host, fingerprint)) {
      event.preventDefault()
      callback(true)
      return
    }
    if (!isMainFrame) {
      // A bad certificate on a subresource is refused quietly: there is no
      // page to show an interstitial for, and the operator cannot judge it.
      _warn(TAG, 'browser subresource certificate refused', { conversation_id: context.conversationId, url_host: host, error })
      callback(false)
      return
    }
    event.preventDefault()
    open(context, { kind: 'certificate', host, error, issuer: certificate.issuerName, fingerprint }, (answer) => {
      const proceed = answer?.kind === 'certificate' && answer.proceed
      if (proceed) decisions.allowCertificate(context.partition, host, fingerprint)
      _log(TAG, 'browser certificate decided', { conversation_id: context.conversationId, url_host: host, error, proceed })
      callback(proceed)
    })
  })
}
