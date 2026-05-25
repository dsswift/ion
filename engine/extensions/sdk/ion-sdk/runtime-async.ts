// Ion Extension SDK — async-trigger registration runtime.
//
// Implements ion.webhooks.register(...) and ion.schedule.{daily, weekly,
// interval}(...). Both surface a unified static/dynamic registration
// path:
//
//   - Calls before the engine's `init` request arrives queue the
//     declaration; the queued set is included in the init response.
//   - Calls after init resolves go out as `ext/register_webhook` or
//     `ext/register_schedule` RPCs and return a handle.
//
// The returned handle (`.unregister()`) issues
// `ext/deregister_webhook` or `ext/deregister_schedule`.
//
// engine/fire_async incoming RPCs look up the registered handler by
// (kind, id) in the local Maps and invoke it with a freshly-built
// ctx. Webhook handlers return `{status, body, headers}`; schedule
// handlers return void.
//
// engine/resolve_token and engine/resolve_predicate let the engine
// fetch the lazy `() => string | bool` callbacks the extension
// registered alongside auth declarations or enabled predicates.

import type {
  IonContext,
  ScheduleDaily,
  ScheduleInterval,
  ScheduleJob,
  ScheduleWeekly,
  ScheduleHandle,
  WebhookHandle,
  WebhookRequest,
  WebhookResponse,
  WebhookRoute,
} from './types'

// --- Registry state ---
// Module-scope Maps keyed by (kind, id). Both static (pre-init queue
// flushed via the init response) and dynamic (post-init register
// RPC) entries land here; lookup is uniform.
const webhookHandlers = new Map<string, (ctx: IonContext, req: WebhookRequest) => Promise<WebhookResponse> | WebhookResponse>()
const scheduleHandlers = new Map<string, (ctx: IonContext) => Promise<void> | void>()

// TokenRefs and PredicateRefs name the lazy callbacks the engine
// resolves on demand. Keyed by the symbolic name the extension
// declared (WebhookAuth.tokenRef / ScheduleJob.enabledRef).
const tokenRefs = new Map<string, () => string | Promise<string>>()
const predicateRefs = new Map<string, () => boolean | Promise<boolean>>()

// Pending init-time queues. Flushed into the init response by the
// runtime's handleRequest('init', ...) path.
const pendingInitWebhooks: WebhookRoute[] = []
const pendingInitSchedules: ScheduleJob[] = []

// initResolved flips true after the engine's `init` request has been
// handled. Used to decide whether a new registration goes to the
// pending queue (pre-init) or directly via RPC (post-init).
let initResolved = false

// rpcRequest is wired by runtime.ts. We don't import it directly to
// avoid a circular dep; instead runtime.ts calls registerRpcBridge
// after it sets up its plumbing.
type RpcRequest = (method: string, params: unknown) => Promise<unknown>
let rpcRequest: RpcRequest | null = null

/** Wired by runtime.ts during createIon(). */
export function registerRpcBridge(fn: RpcRequest): void {
  rpcRequest = fn
}

// drainPendingInit returns the static init declarations the runtime
// should bundle into its init response, then marks init as resolved
// so subsequent registrations go via RPC.
export function drainPendingInit(): { webhooks: WebhookRoute[]; schedules: ScheduleJob[] } {
  const out = {
    webhooks: pendingInitWebhooks.slice(),
    schedules: pendingInitSchedules.slice(),
  }
  pendingInitWebhooks.length = 0
  pendingInitSchedules.length = 0
  initResolved = true
  return out
}

// --- Public API: webhook registration ---

export interface WebhooksApi {
  register(route: WebhookRoute): Promise<WebhookHandle>
}

export const webhooksApi: WebhooksApi = {
  async register(route: WebhookRoute): Promise<WebhookHandle> {
    if (!route || typeof route.path !== 'string' || !route.path.startsWith('/')) {
      throw new Error(`ion.webhooks.register: route.path must start with '/' (got ${route?.path})`)
    }
    // Stash the handler under (path) for engine/fire_async dispatch.
    const handler = route.handler
    if (typeof handler !== 'function') {
      throw new Error(`ion.webhooks.register: handler must be a function (got ${typeof handler})`)
    }
    webhookHandlers.set(route.path, handler as any)

    // Stash the auth token callback under a symbolic name so the engine
    // can resolve it lazily. The name is the path (unique per route)
    // unless the caller supplied an explicit tokenRefName via the auth
    // object — convenience: extensions usually just write
    // `token: () => process.env.X` and we pick the ref name for them.
    let tokenRefName = ''
    if (route.auth && route.auth.kind !== 'none') {
      const a: any = route.auth
      if (typeof a.token === 'function') {
        tokenRefName = `webhook:${route.path}:token`
        tokenRefs.set(tokenRefName, a.token)
      } else if (typeof a.token === 'string') {
        // Inline string token — wrap in a callback so the engine path
        // is uniform. Note that inline strings carry credentials in
        // extension code; the `() => process.env.X` form is preferred.
        const v = a.token
        tokenRefName = `webhook:${route.path}:token`
        tokenRefs.set(tokenRefName, () => v)
      }
    }

    const wireRoute: WebhookRoute = {
      path: route.path,
      method: route.method,
      auth: stripCallableAuth(route.auth, tokenRefName),
      maxBodyBytes: route.maxBodyBytes,
      interface: route.interface,
      // handler not sent on the wire — it stays local.
    } as any

    if (!initResolved) {
      pendingInitWebhooks.push(wireRoute)
      return { id: route.path, unregister: () => unregisterWebhook(route.path) }
    }
    if (!rpcRequest) throw new Error('ion.webhooks.register: RPC bridge not wired')
    await rpcRequest('ext/register_webhook', wireRoute)
    return { id: route.path, unregister: () => unregisterWebhook(route.path) }
  },
}

async function unregisterWebhook(path: string): Promise<void> {
  webhookHandlers.delete(path)
  tokenRefs.delete(`webhook:${path}:token`)
  if (!initResolved) {
    // Trim from the pending queue if init hasn't fired yet.
    const i = pendingInitWebhooks.findIndex((r) => r.path === path)
    if (i >= 0) pendingInitWebhooks.splice(i, 1)
    return
  }
  if (!rpcRequest) return
  await rpcRequest('ext/deregister_webhook', { path })
}

function stripCallableAuth(auth: any, tokenRefName: string): any {
  if (!auth) return { kind: 'none' }
  if (auth.kind === 'none') return { kind: 'none' }
  return {
    kind: auth.kind,
    headerName: auth.headerName,
    algorithm: auth.algorithm,
    tokenRefName,
  }
}

// --- Public API: schedule registration ---

export interface ScheduleApi {
  daily(opts: ScheduleDaily): Promise<ScheduleHandle>
  weekly(opts: ScheduleWeekly): Promise<ScheduleHandle>
  interval(opts: ScheduleInterval): Promise<ScheduleHandle>
}

export const scheduleApi: ScheduleApi = {
  daily(opts) {
    return registerSchedule({
      id: opts.id,
      kind: 'daily',
      time: opts.time,
      tz: opts.tz,
      timeoutMs: opts.timeoutMs,
      enabledRefName: stashEnabled(opts.id, opts.enabled),
    }, opts.handler)
  },
  weekly(opts) {
    return registerSchedule({
      id: opts.id,
      kind: 'weekly',
      time: opts.time,
      dayOfWeek: opts.dayOfWeek,
      tz: opts.tz,
      timeoutMs: opts.timeoutMs,
      enabledRefName: stashEnabled(opts.id, opts.enabled),
    }, opts.handler)
  },
  interval(opts) {
    return registerSchedule({
      id: opts.id,
      kind: 'interval',
      intervalMs: opts.intervalMs,
      timeoutMs: opts.timeoutMs,
      enabledRefName: stashEnabled(opts.id, opts.enabled),
    }, opts.handler)
  },
}

function stashEnabled(id: string, enabled: (() => boolean | Promise<boolean>) | undefined): string {
  if (typeof enabled !== 'function') return ''
  const name = `schedule:${id}:enabled`
  predicateRefs.set(name, enabled)
  return name
}

async function registerSchedule(
  job: ScheduleJob,
  handler: (ctx: IonContext) => Promise<void> | void,
): Promise<ScheduleHandle> {
  if (!job || !job.id) throw new Error('ion.schedule.*: id is required')
  if (typeof handler !== 'function') {
    throw new Error('ion.schedule.*: handler must be a function')
  }
  scheduleHandlers.set(job.id, handler)

  if (!initResolved) {
    pendingInitSchedules.push(job)
    return { id: job.id, unregister: () => unregisterSchedule(job.id) }
  }
  if (!rpcRequest) throw new Error('ion.schedule.*: RPC bridge not wired')
  await rpcRequest('ext/register_schedule', job)
  return { id: job.id, unregister: () => unregisterSchedule(job.id) }
}

async function unregisterSchedule(id: string): Promise<void> {
  scheduleHandlers.delete(id)
  predicateRefs.delete(`schedule:${id}:enabled`)
  if (!initResolved) {
    const i = pendingInitSchedules.findIndex((j) => j.id === id)
    if (i >= 0) pendingInitSchedules.splice(i, 1)
    return
  }
  if (!rpcRequest) return
  await rpcRequest('ext/deregister_schedule', { id })
}

// --- Incoming RPC handlers (engine/fire_async, engine/resolve_token, engine/resolve_predicate) ---

/**
 * Dispatch an engine/fire_async payload. Returns the handler's result
 * shaped per kind, or throws when no handler is registered for the
 * (kind, id) pair. The runtime caller wraps any thrown error in a
 * JSON-RPC error response.
 */
export async function dispatchFireAsync(params: any, buildContext: (raw: any) => IonContext): Promise<unknown> {
  const kind = String(params?.kind ?? '')
  const id = String(params?.id ?? '')
  const payload = params?.payload ?? {}
  const ctx = buildContext({ sessionKey: params?.sessionKey })

  if (kind === 'webhook') {
    const handler = webhookHandlers.get(id)
    if (!handler) throw new Error(`fire_async webhook: no handler for ${id}`)
    const req: WebhookRequest = buildWebhookRequest(payload)
    const resp = await handler(ctx, req)
    return normaliseWebhookResponse(resp)
  }
  if (kind === 'schedule') {
    const handler = scheduleHandlers.get(id)
    if (!handler) throw new Error(`fire_async schedule: no handler for ${id}`)
    await handler(ctx)
    return { ok: true }
  }
  throw new Error(`fire_async: unknown kind ${kind}`)
}

export async function dispatchResolveToken(params: any): Promise<unknown> {
  const name = String(params?.name ?? '')
  const fn = tokenRefs.get(name)
  if (!fn) return { value: '' }
  const v = await fn()
  return { value: typeof v === 'string' ? v : '' }
}

export async function dispatchResolvePredicate(params: any): Promise<unknown> {
  const name = String(params?.name ?? '')
  const fn = predicateRefs.get(name)
  if (!fn) return { enabled: true }
  const v = await fn()
  return { enabled: Boolean(v) }
}

function buildWebhookRequest(payload: any): WebhookRequest {
  const body: string = typeof payload?.body === 'string' ? payload.body : ''
  const headers: Record<string, string> = payload?.headers ?? {}
  return {
    method: String(payload?.method ?? ''),
    path: String(payload?.path ?? ''),
    url: String(payload?.url ?? ''),
    query: String(payload?.query ?? ''),
    headers,
    body,
    remote: String(payload?.remote ?? ''),
    json<T = unknown>(): T {
      if (!body) return {} as T
      try {
        return JSON.parse(body) as T
      } catch {
        return {} as T
      }
    },
    text(): string {
      return body
    },
  }
}

function normaliseWebhookResponse(resp: WebhookResponse | undefined | void): WebhookResponse {
  if (!resp || typeof resp !== 'object') {
    return { status: 200, body: '' }
  }
  return {
    status: typeof resp.status === 'number' ? resp.status : 200,
    body: typeof resp.body === 'string' ? resp.body : '',
    headers: resp.headers ?? undefined,
  }
}
