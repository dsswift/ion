---
title: Webhooks SDK
description: Register inbound HTTP webhook routes from an Ion extension and dispatch agents on receipt.
sidebar_position: 10
---

# Webhooks SDK

Extensions register inbound HTTP webhook routes through
`ion.webhooks.register(...)`. The engine runs a single listener
(off by default; auto-enables when any route is registered) and
dispatches matching requests to the extension handler. Inside the
handler the standard `ctx` surface is available: `ctx.dispatchAgent`,
`ctx.sendPrompt`, `ctx.emit`, `ctx.setPlanMode`, `ctx.getContextUsage`,
`ctx.searchHistory` all work normally.

See [D-011 Webhooks SDK](https://github.com/dsswift/ion/tree/main/.analysis)
for the design decision.

## Quick start

```ts
import { createIon } from '../sdk/ion-sdk'

const ion = createIon()

ion.webhooks.register({
  path: '/webhook/my-event',
  method: 'POST',
  auth: { kind: 'bearer', token: () => process.env.MY_TOKEN ?? '' },
  handler: async (ctx, req) => {
    const body = req.json<{ user: string; action: string }>()
    await ctx.dispatchAgent({
      name: 'my-agent',
      task: `${body.user} did ${body.action}`,
    })
    return { status: 200, body: 'ok' }
  },
})
```

That's it. Static (module-scope) registration is the most common
shape; the SDK queues the declaration and ships it to the engine in
the `init` handshake response. Dynamic registration (from inside a
hook handler or tool) returns the same `WebhookHandle` and routes
through an `ext/register_webhook` RPC.

## Configuration

The engine's HTTP listener is OFF by default. It auto-starts when
any extension registers a webhook route, or when `engine.json`
declares a `webhooks` block:

```jsonc
{
  "webhooks": {
    "port": 7421,                  // default
    "bindInterface": "127.0.0.1",  // default (loopback-only)
    "defaultMaxBodyBytes": 1048576, // 1 MiB default
    "fireTimeoutMs": 30000,         // 30s default
    "enabled": null                 // null = auto; true = force on; false = force off
  }
}
```

Non-loopback bind interfaces log a loud `WARN` so accidental network
exposure is visible in the engine log.

## Auth strategies

Every webhook route declares an authentication strategy. All comparison
paths use `crypto/subtle.ConstantTimeCompare` and `crypto/hmac.Equal`
internally — there is no hand-rolled crypto in the auth layer.

### `none`

```ts
ion.webhooks.register({
  path: '/healthz',
  method: 'GET',
  auth: { kind: 'none' },
  handler: async () => ({ status: 200, body: 'ok' }),
})
```

Only sensible for loopback-bound listeners or explicitly-public health
endpoints. The zero `WebhookAuth` value is **not** valid — you must
specify `kind: 'none'` explicitly so accidental zero-value declarations
don't expose a sensitive route.

### `bearer`

```ts
ion.webhooks.register({
  path: '/webhook/github',
  auth: {
    kind: 'bearer',
    token: () => process.env.GH_BEARER ?? '',
  },
  handler: async (ctx, req) => { /* ... */ },
})
```

Requires `Authorization: Bearer <token>`. The `token` callback
resolves the secret lazily; the engine invokes it via an
`engine/resolve_token` RPC at request time rather than caching the
value in process memory.

### `shared-secret`

```ts
ion.webhooks.register({
  path: '/webhook/slack',
  auth: {
    kind: 'shared-secret',
    headerName: 'X-Slack-Token',
    token: () => process.env.SLACK_TOKEN ?? '',
  },
  handler: async (ctx, req) => { /* ... */ },
})
```

Compares a custom header against the resolved token.

### `hmac-signature`

```ts
ion.webhooks.register({
  path: '/webhook/github',
  auth: {
    kind: 'hmac-signature',
    headerName: 'X-Hub-Signature-256',
    algorithm: 'sha256',
    token: () => process.env.GH_SECRET ?? '',
  },
  handler: async (ctx, req) => { /* ... */ },
})
```

Computes `HMAC-SHA256(rawBody, secret)` and compares it to the header.
Accepts both bare hex (`abc123…`) and the `sha256=<hex>` prefix used
by GitHub / Slack / Stripe, case-insensitive.

Only `sha256` is supported today. Other algorithms reject at
registration time with a clear validation error.

## Request and response

The handler receives a `WebhookRequest` and returns a `WebhookResponse`:

```ts
interface WebhookRequest {
  method: string
  path: string
  url: string
  query: string
  headers: Record<string, string>
  body: string
  remote: string
  json<T = unknown>(): T   // parse body as JSON; returns {} on malformed/empty
  text(): string            // raw body
}

interface WebhookResponse {
  status?: number     // default 200
  body?: string       // default ""
  headers?: Record<string, string>
}
```

Returning `void` (or `undefined`) is equivalent to `{ status: 200 }`.

## Dynamic registration and the handle

`ion.webhooks.register` returns a `WebhookHandle`:

```ts
interface WebhookHandle {
  id: string                       // the route path
  unregister(): Promise<void>      // dynamic deregister
}
```

Static and dynamic registration share the same surface. A registration
made inside a hook handler or tool issues an `ext/register_webhook`
RPC to the engine; `handle.unregister()` issues `ext/deregister_webhook`.

```ts
ion.on('session_start', async (ctx) => {
  const handle = await ion.webhooks.register({
    path: `/webhook/session-${ctx.sessionKey}`,
    auth: { kind: 'none' },
    handler: async () => ({ status: 200, body: 'ok' }),
  })
  // ... later:
  await handle.unregister()
})
```

## Lifecycle hooks

The engine fires two lifecycle hooks for every webhook registration
and deregistration:

```ts
ion.on('webhook_registered', (ctx, info) => {
  // info: { kind: 'webhook', id: string, origin: 'init' | 'runtime', decl: WebhookRoute }
  if (info.id.startsWith('/admin')) {
    return { block: true, reason: 'admin endpoints disabled in this env' }
  }
})

ion.on('webhook_deregistered', (ctx, info) => {
  // observational only — the deregistration has already happened
  log.info('webhook removed', { path: info.id })
})
```

The `webhook_registered` hook is **veto-capable**: returning
`{ block: true, reason: string }` blocks the registration. The reason
is surfaced to the caller via the RPC error and to the
`engine_webhook_handler_error` observability event.

The `webhook_deregistered` hook is informational only.
Deregistration cannot be vetoed because letting one extension trap
another extension's resources would be a footgun.

## Observability events

Every fire emits a structured `engine_webhook_*` event for the
desktop/iOS audit-log panel:

| Event | Fires when |
|---|---|
| `engine_webhook_received` | HTTP request matched a route, before auth |
| `engine_webhook_authenticated` | Auth check passed |
| `engine_webhook_handler_error` | 4xx/5xx response written, with `asyncReason` |
| `engine_webhook_responded` | Handler returned successfully |
| `engine_webhook_registered` | Registration committed (init or runtime) |
| `engine_webhook_deregistered` | Deregistration committed |
| `engine_async_fire_dropped` | Fire dropped before reaching the handler |

Every event carries `asyncKind: "webhook"` plus the `asyncId` (route
path) and `asyncRequestId` so a consumer can correlate
received → responded.

## Escape hatch: roll your own server

The engine listener is engine-internal — extensions never reach into
it. If you need streaming, WebSocket upgrades, or any HTTP feature the
SDK doesn't expose, run your own `http.createServer` inside the
extension subprocess; the two listeners coexist on different ports.

```ts
import { createServer } from 'node:http'

const myServer = createServer((req, res) => {
  if (req.url === '/ws-upgrade') { /* ... */ }
})
myServer.listen(9999, '127.0.0.1')
```

## Plan mode

If a session is in plan mode when a webhook fires, the handler runs
normally. Plan mode is an agent-loop constraint, not a session-wide
quiet mode — webhooks and schedules still dispatch, and the agents
they spawn observe the session's plan-mode state through
`ctx.isInPlanMode()` (or `ctx.getPlanMode()` for the plan file path too) and choose their own behavior.

If you want a webhook to defer-fire while in plan mode, check at
handler entry and return early:

```ts
handler: async (ctx, req) => {
  if (await ctx.isInPlanMode()) return { status: 503, body: 'session in plan mode' }
  // ... normal dispatch
}
```

## Migration

If your extension currently runs its own `http.createServer` to receive
webhooks and dispatch agents, the migration is mechanical:

```ts
// before
http.createServer((req, res) => {
  // ... auth check, body read
  cachedCtx.dispatchAgent(...) // cached ctx workaround
})

// after
ion.webhooks.register({
  path: '/webhook/x',
  auth: { kind: 'bearer', token: () => process.env.TOKEN },
  handler: async (ctx, req) => {
    await ctx.dispatchAgent(...) // ctx is fresh per fire
    return { status: 200 }
  },
})
```

The cached-ctx workaround that powered the pre-D-011 era is no longer
needed: the engine builds `ctx` fresh on every fire through
`extcontext.NewExtContext`, the same path hook handlers already use.
