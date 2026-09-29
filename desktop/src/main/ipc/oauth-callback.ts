/**
 * oauth-callback -- catch an OAuth redirect on this machine for a sign-in that
 * a server elsewhere finishes.
 *
 * A server on another machine cannot take the browser's redirect: its own
 * loopback listener is on that machine, and the person's browser is on this
 * one. So the desktop owns the listener. `listen` opens one on 127.0.0.1 and
 * returns its redirect URI, the renderer hands that URI to the server when it
 * starts the sign-in, opens the provider page here, and `await` resolves with
 * the full address the browser landed on. The renderer returns that address to
 * the server, which checks state and exchanges the code. Nothing here reads or
 * keeps the code.
 */
import { randomUUID } from 'crypto'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { ipcMain } from 'electron'
import { IPC } from '@ion/shared/types'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('oauth-callback', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('oauth-callback', msg, fields)
}

/** Matches the engine's caller-completed login lifetime, so neither side outlives the other. */
export const OAUTH_CALLBACK_TIMEOUT_MS = 10 * 60 * 1000
const CALLBACK_PATH = '/callback'

interface PendingCallback {
  server: Server
  landed: Promise<string>
  cancel(reason: string): void
}

const pending = new Map<string, PendingCallback>()

const DONE_PAGE = '<!doctype html><meta charset="utf-8"><title>Signed in</title><p style="font-family:system-ui;margin:3em">Sign-in finished. You can close this tab and return to Ion.</p>'

/** Opens a listener and returns its id and the redirect URI a sign-in must use. */
export async function listenForOAuthCallback(timeoutMs: number = OAUTH_CALLBACK_TIMEOUT_MS): Promise<{ id: string; redirectUri: string }> {
  const id = randomUUID()
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`

  let settle: { resolve(url: string): void; reject(err: Error): void } | null = null
  const landed = new Promise<string>((resolve, reject) => { settle = { resolve, reject } })
  // A caller that never awaits must not surface an unhandled rejection.
  landed.catch(() => {}) // silent-ok: the awaiting caller receives the same rejection
  const finish = (): void => {
    clearTimeout(timer)
    pending.delete(id)
    server.close()
  }
  const timer = setTimeout(() => {
    warn('no redirect arrived before the deadline', { id, port })
    finish()
    settle?.reject(new Error('The sign-in did not return to Ion in time. Start it again.'))
  }, timeoutMs)

  server.on('request', (req, res) => {
    const path = (req.url ?? '').split('?')[0]
    if (path !== CALLBACK_PATH) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(DONE_PAGE)
    log('redirect received', { id, port, has_code: (req.url ?? '').includes('code='), has_error: (req.url ?? '').includes('error=') })
    finish()
    settle?.resolve(`http://127.0.0.1:${port}${req.url ?? CALLBACK_PATH}`)
  })

  pending.set(id, {
    server,
    landed,
    cancel: (reason) => {
      finish()
      settle?.reject(new Error(reason))
    },
  })
  log('listening for a sign-in redirect', { id, port })
  return { id, redirectUri }
}

/** Resolves with the full address the browser landed on. */
export function awaitOAuthCallback(id: string): Promise<string> {
  const entry = pending.get(id)
  if (!entry) return Promise.reject(new Error('That sign-in is no longer waiting. Start it again.'))
  return entry.landed
}

/** Stops waiting, for a sign-in the renderer abandoned. */
export function cancelOAuthCallback(id: string): void {
  const entry = pending.get(id)
  if (!entry) return
  log('listener cancelled', { id })
  entry.cancel('The sign-in was cancelled.')
}

export function registerOAuthCallbackIpc(): void {
  ipcMain.handle(IPC.OAUTH_CALLBACK_LISTEN, () => listenForOAuthCallback())
  ipcMain.handle(IPC.OAUTH_CALLBACK_AWAIT, (_event, id: unknown) => awaitOAuthCallback(typeof id === 'string' ? id : ''))
  ipcMain.handle(IPC.OAUTH_CALLBACK_CANCEL, (_event, id: unknown) => {
    if (typeof id === 'string') cancelOAuthCallback(id)
  })
}
