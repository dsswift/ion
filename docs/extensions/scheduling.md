---
title: Scheduling SDK
description: Register daily, weekly, interval, and one-shot jobs from an Ion extension; the engine fires them on cadence with a fresh ctx.
sidebar_position: 11
---

# Scheduling SDK

Extensions register scheduled jobs through `ion.schedule.daily(...)`,
`ion.schedule.weekly(...)`, `ion.schedule.interval(...)`, and
`ion.schedule.once(...)`. The engine runs a 1-second tick loop (off
by default; auto-starts when any job is registered) and dispatches
each job's handler with a freshly-built `ctx`.

Inside the handler the full SDK surface is available — `dispatchAgent`,
`sendPrompt`, `emit`, `setPlanMode`, `getContextUsage`, and
`searchHistory` all work normally, the same path hook handlers use.

See [D-010 Scheduling SDK](https://github.com/dsswift/ion/tree/main/.analysis)
for the design decision.

## Quick start

```ts
import { createIon } from '../sdk/ion-sdk'

const ion = createIon()

// Fire once per day at 09:00 in New York time.
ion.schedule.daily({
  id: 'morning-summary',
  time: '09:00',
  tz: 'America/New_York',
  handler: async (ctx) => {
    await ctx.dispatchAgent({
      name: 'summariser',
      task: 'Compose today\'s morning summary',
    })
  },
})

// Fire every 30s.
ion.schedule.interval({
  id: 'inbox-poll',
  intervalMs: 30_000,
  handler: async (ctx) => {
    // ... poll an external feed, dispatch agents on new items.
  },
})

// Fire every Monday at 18:00 local.
ion.schedule.weekly({
  id: 'weekly-digest',
  dayOfWeek: 'monday',
  time: '18:00',
  handler: async (ctx) => { /* ... */ },
})

// Fire once after 5s, then self-deregister.
ion.schedule.once({
  id: 'startup-check',
  delayMs: 5_000,
  handler: async (ctx) => {
    await ctx.dispatchAgent({ name: 'checker', task: 'startup diagnostics' })
  },
})
```

Static registration is the most common shape; the SDK queues the
declaration and ships it to the engine in the `init` handshake.

## Configuration

The engine's scheduler is OFF by default. It auto-starts when any
extension registers a job. `engine.json` exposes a few tuning knobs:

```jsonc
{
  "scheduling": {
    "defaultTz": "America/New_York",  // applied to daily/weekly when job omits tz
    "fireTimeoutMs": 60000,             // 60s default handler timeout
    "catchUpEnabled": true              // run missed daily/weekly fires on startup
  }
}
```

Last-run markers persist to `~/.ion/scheduler/<host>_<job>.json` so
daily/weekly catch-up survives engine restarts. The directory and
files are recreated on demand; deleting them is safe and only loses
the catch-up dedup signal.

## Job shapes

### Daily

```ts
ion.schedule.daily({
  id: string,                              // required, stable
  time: string,                             // "HH:MM" 24-hour
  tz?: string,                              // IANA tz; default = engine default
  timeoutMs?: number,                       // override fire timeout
  enabled?: () => boolean | Promise<boolean>, // skip predicate; see below
  handler: (ctx, control?) => Promise<void> | void,
})
```

### Weekly

```ts
ion.schedule.weekly({
  id: string,
  time: string,
  dayOfWeek: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday',
  tz?: string,
  timeoutMs?: number,
  enabled?: () => boolean | Promise<boolean>,
  handler: (ctx, control?) => Promise<void> | void,
})
```

### Interval

```ts
ion.schedule.interval({
  id: string,
  intervalMs: number,        // >= 1000 (scheduler ticks at 1s granularity)
  timeoutMs?: number,
  enabled?: () => boolean | Promise<boolean>,
  handler: (ctx, control?) => Promise<void> | void,
})
```

Sub-second intervals are rejected at registration time — the
scheduler's 1s tick would alias unpredictably.

### Once

```ts
ion.schedule.once({
  id: string,
  delayMs: number,           // >= 1000; milliseconds after registration to fire
  tz?: string,
  timeoutMs?: number,
  enabled?: () => boolean | Promise<boolean>,
  handler: (ctx, control?) => Promise<void> | void,
})
```

The engine fires the handler exactly once after `delayMs` has elapsed,
then removes the job from the registry automatically — no second fire
is possible and `ScheduleHandle.unregister()` is a no-op after the
handler returns.

**Skip without spending the shot.** When the optional `enabled` predicate
returns `false` at a tick, the once job is skipped for that tick but
remains armed. The predicate skip does **not** consume the shot; the
job fires the next time the predicate returns `true` and `delayMs` has
elapsed.

**Not persisted across restarts.** Like interval jobs, a once job is
not written to disk and does not catch up on engine restart. Re-arm it
in the session hook that originally registered it if survival across
restarts matters.

## Handler control argument

Every schedule handler receives an optional second argument, `control`:

```ts
type ScheduleHandler = (ctx: IonContext, control?: ScheduleControl) => Promise<void> | void

interface ScheduleControl {
  jobId: string            // the stable id this handler was registered under
  unregister(): Promise<void>  // cancel future fires from inside the handler
}
```

Existing handlers that only accept `(ctx)` continue to work unchanged —
the parameter is optional.

`control.unregister()` is most useful for repeating jobs (interval,
daily, weekly) that want to stop themselves once a condition is met,
without the caller having to hold a `ScheduleHandle` reference:

```ts
ion.schedule.interval({
  id: 'wait-for-ready',
  intervalMs: 5_000,
  handler: async (ctx, control) => {
    const ready = await checkReady()
    if (ready) {
      await startMainWork(ctx)
      await control!.unregister()  // stop polling
    }
  },
})
```

For once jobs, calling `control.unregister()` inside the handler is a
no-op — the engine auto-deregisters the job after the handler returns
regardless.

## Enable predicate

The optional `enabled` callback is invoked at each fire opportunity.
Return `false` to skip — the engine emits `engine_schedule_skipped`
with `reason: 'disabled'` and advances `nextRun`.

```ts
ion.schedule.interval({
  id: 'work-hours-only',
  intervalMs: 60_000,
  enabled: () => {
    const h = new Date().getHours()
    return h >= 9 && h < 18
  },
  handler: async () => { /* ... */ },
})
```

The predicate is invoked through an `engine/resolve_predicate` RPC
into the subprocess at fire time, so it can read any state local to
the subprocess (env vars, in-memory caches, etc.).

## Dynamic registration and the handle

Each `ion.schedule.*` call returns a `ScheduleHandle`:

```ts
interface ScheduleHandle {
  id: string
  unregister(): Promise<void>
}
```

Static and dynamic registration share the same surface. Calls made
inside a hook handler or tool issue `ext/register_schedule` /
`ext/deregister_schedule` RPCs.

```ts
ion.on('session_start', async (ctx) => {
  const job = await ion.schedule.interval({
    id: `poll-${ctx.sessionKey}`,
    intervalMs: 5000,
    handler: async () => { /* ... */ },
  })
  // ... later:
  await job.unregister()
})
```

**`ion.schedule.cancel(id)`** is the id-addressable complement to
`ScheduleHandle.unregister()`. Use it when you registered a job
statically (at module scope, before `init`) and have no handle
reference to hold:

```ts
// Registered at module scope — no handle variable.
ion.schedule.interval({ id: 'poller', intervalMs: 10_000, handler: async () => { /* ... */ } })

// Cancel it later by id (e.g. from a command handler).
ion.registerCommand('stop-poller', {
  description: 'Stop the background poller',
  execute: async (_args, _ctx) => {
    await ion.schedule.cancel('poller')
  },
})
```

Both `ScheduleHandle.unregister()` and `ion.schedule.cancel(id)` issue
the same `ext/deregister_schedule` RPC and emit
`engine_schedule_deregistered`.

## Worked example: idle-armed one-shot

A common pattern is to arm a once job when the session goes idle (e.g.
to run deferred cleanup or send a summary after a quiet period), cancel
the pending shot if activity resumes before it fires, and re-arm on
the next idle transition. The cancel-then-once pattern ensures at most
one pending shot exists per session at any time.

```ts
import { createIon } from '../sdk/ion-sdk'

const ion = createIon()

const IDLE_JOB_PREFIX = 'idle-summary'

// Return a per-session job id so multiple concurrent sessions don't
// share a single once slot.
function idleJobId(sessionKey: string) {
  return `${IDLE_JOB_PREFIX}-${sessionKey}`
}

// On every turn end, cancel any pending idle shot and arm a fresh one.
// If the user sends another prompt within 5 minutes, this fires again
// and the previous shot is cancelled before the once fires.
ion.on('turn_end', async (ctx) => {
  const id = idleJobId(ctx.sessionKey)
  // Cancel the previous shot (no-op if already fired or never armed).
  await ion.schedule.cancel(id)
  // Arm a new one-shot 5 minutes out.
  await ion.schedule.once({
    id,
    delayMs: 5 * 60 * 1000,  // 5 minutes; must be >= 1000
    handler: async (handlerCtx) => {
      await handlerCtx.dispatchAgent({
        name: 'summariser',
        task: 'The session has been idle. Summarise what was accomplished.',
      })
    },
  })
})

// If the session ends cleanly, cancel any pending shot so it doesn't
// fire into a dead session.
ion.on('session_end', async (ctx) => {
  await ion.schedule.cancel(idleJobId(ctx.sessionKey))
})
```

Key points:
- `ion.schedule.cancel(id)` before `ion.schedule.once(id)` on every
  `turn_end` ensures single-instance semantics without holding a
  handle reference.
- `delayMs` must be at least 1000 ms (the scheduler's 1s tick floor).
- The once job is not persisted. If the engine restarts between arming
  and firing, the shot is lost. Re-arm in `session_start` if
  across-restart delivery matters.

## Lifecycle hooks

```ts
ion.on('schedule_registered', (ctx, info) => {
  // info: { kind: 'schedule', id: string, origin: 'init' | 'runtime', decl: ScheduleJob }
  if (info.id.startsWith('test_')) {
    return { block: true, reason: 'test jobs disabled in prod' }
  }
})

ion.on('schedule_deregistered', (ctx, info) => {
  log.info('schedule removed', { id: info.id })
})
```

`schedule_registered` is **veto-capable**; `schedule_deregistered`
is observational only. Veto rejections surface the reason to the
caller via the registration RPC error.

## Observability events

| Event | Fires when |
|---|---|
| `engine_schedule_fired` | Handler returned successfully |
| `engine_schedule_skipped` | Enable predicate returned false, or session unavailable |
| `engine_schedule_failed` | Handler threw or timed out |
| `engine_schedule_missed` | Missed daily/weekly slot detected on restart (extension-decided catch-up) |
| `engine_schedule_registered` | Registration committed |
| `engine_schedule_deregistered` | Deregistration committed |
| `engine_schedule_unhosted` | Last alive host for the job's (extension, jobID) group removed; the job will not fire until a new host re-registers it |
| `engine_async_fire_dropped` | Fire dropped before reaching the handler |

Every event carries `asyncKind: "schedule"`, the `asyncId` (job id),
and `asyncDurationMs` where applicable. `engine_schedule_missed`
additionally carries `asyncMissedSlot` (RFC3339 UTC of the missed slot)
and `asyncHadMarker` (whether a last-run marker existed on disk).

`engine_schedule_deregistered` covers all deregistration paths: an
explicit `ScheduleHandle.unregister()` or `ion.schedule.cancel(id)`
call, a handler calling `control.unregister()`, and the automatic
once-job self-deregister after the handler returns. In the once
auto-deregister case the event carries `asyncReason: "once_complete"`
so consumers can distinguish it from an explicit cancel.

## Catch-up on restart

For daily/weekly jobs only, when the engine starts and discovers a
scheduled slot was missed while it was down, the behavior depends on
whether the extension registered a `schedule_missed` hook handler.

### Default behavior (no `schedule_missed` handler)

Auto-catch-up fires as before: the missed job is scheduled ~30s after
startup (a stagger so multiple missed jobs don't all fire at once).
Interval jobs do **not** catch up; they simply fire at `now + intervalMs`.

### Extension-decided catch-up (`schedule_missed` handler registered)

When a `schedule_missed` hook handler is registered, the scheduler does
NOT auto-fire the missed slot. Instead:

1. Emits `engine_schedule_missed` with the missed slot details.
2. Fires the `schedule_missed` hook with `ScheduleMissedInfo`.
3. The handler decides whether to backfill by calling `ctx.fireSchedule(id)`.

This lets an extension with multiple daily schedules (e.g. morning briefing
and evening summary) fire only the most recent missed one, or skip catch-up
entirely when the missed slot is stale.

### First-sighting flood guard

When a job is seen for the first time (no marker file on disk), the scheduler
records a `FirstSeenUtc` timestamp and does NOT catch up on that pass, even
if a slot has elapsed. This prevents a job registered at noon from
immediately catching up the 09:30 morning slot it never existed for. On the
next restart, the marker exists and the anchor is used to decide whether a
real slot was missed.

### Decision matrix

| Last-run marker | `schedule_missed` handler | Behavior |
|---|---|---|
| Has `LastRunUtc` after last slot | any | Normal next slot (no catch-up) |
| Has `LastRunUtc` before last slot | none | Auto-catch-up (now + 30s stagger) |
| Has `LastRunUtc` before last slot | registered | Emit `engine_schedule_missed` + fire `schedule_missed` hook |
| `FirstSeenUtc` only (no `LastRunUtc`), before last slot | none | Auto-catch-up (now + 30s stagger) |
| `FirstSeenUtc` only (no `LastRunUtc`), before last slot | registered | Emit `engine_schedule_missed` + fire `schedule_missed` hook |
| No marker at all | any | First sighting: record `FirstSeenUtc`, normal next slot |

### `ctx.fireSchedule(id)`

Triggers an immediate fire of the named schedule job. Reuses the engine's
existing fire machinery: in-flight guard, single-concurrency arbitration,
last-run recording, `engine_schedule_fired` event emission.

The handler receives a `ScheduleFireMeta` as its third argument with
`backfill: true` so it can distinguish a backfill from a live tick fire.

```ts
ion.on('schedule_missed', async (ctx, info) => {
  // Only catch up the most recent missed briefing.
  const statuses = await ctx.getScheduleStatus()
  const missed = statuses.find(s => s.id === info.id)
  if (missed && !missed.ranWithinScope) {
    await ctx.fireSchedule(info.id)
  }
})
```

### `ctx.getScheduleStatus(id?)`

Returns status entries for registered schedule jobs:

```ts
interface ScheduleStatus {
  id: string
  kind: string
  lastRunUtc?: string   // RFC3339, empty when never run
  ranWithinScope: boolean
  nextRunUtc?: string   // RFC3339
}
```

When `id` is provided, returns only the matching job. When omitted, returns
all schedule jobs on the session.

### `ScheduleFireMeta` (third handler argument)

Every schedule handler now receives an optional third argument:

```ts
interface ScheduleFireMeta {
  firedAt: string     // RFC3339 UTC
  backfill: boolean   // true when triggered by ctx.fireSchedule
  missedSlotUtc?: string  // RFC3339 UTC of the missed slot (when backfill)
}

ion.schedule.daily({
  id: 'morning-briefing',
  time: '09:00',
  tz: 'America/New_York',
  handler: async (ctx, control, meta) => {
    if (meta?.backfill) {
      // Lighter version for catch-up
      await ctx.dispatchAgent({ name: 'summariser', task: 'catch-up briefing' })
    } else {
      await ctx.dispatchAgent({ name: 'summariser', task: 'full morning briefing' })
    }
  },
})
```

Catch-up reads the last-run marker from `~/.ion/scheduler/` to decide
whether a missed slot is genuinely missed (no marker after the slot
time) or already handled (marker after the slot time).

## In-process dedup

A `sync.Map` in the engine prevents overlapping fires of the same
job: if a handler is still running when its next tick arrives, the
tick logs a skip and waits for the previous fire to complete. This
guarantees a single in-flight invocation per job, regardless of
handler latency.

Cross-subprocess arbitration (multiple engine processes sharing the
same job set) is intentionally out of scope — the engine runs as a
single process today.

## Respawn

If the extension subprocess crashes and the engine respawns it, the
new subprocess's `init` payload is the authoritative declaration set.
The previous registrations are wiped and the new ones re-register
through the same lifecycle pipeline. Last-run markers persist on
disk so dedup survives.

**Dynamic registrations from the prior subprocess are NOT restored.**
If you need a dynamically-added job to survive respawn, install a
`session_start` hook that re-issues the registration; this is the
same pattern agent specs use.

## Plan mode

If a session is in plan mode when a job fires, the handler runs
normally. Plan mode is an agent-loop constraint, not a session-wide
quiet mode. Handlers that want to defer-while-in-plan-mode can check
at entry:

```ts
handler: async (ctx) => {
  const [planMode] = ctx.getPlanMode()
  if (planMode) return // skip this tick
  // ... normal work
},
```

## Migration

If your extension currently runs its own `setInterval` polling and
caches a `ctx` workaround to dispatch agents, the migration is
mechanical:

```ts
// before
let cachedCtx: IonContext | undefined
ion.on('session_start', (ctx) => { cachedCtx = ctx })
setInterval(async () => {
  if (!cachedCtx) return
  await cachedCtx.dispatchAgent(...) // cached-ctx workaround
}, 30_000)

// after
ion.schedule.interval({
  id: 'inbox-poll',
  intervalMs: 30_000,
  handler: async (ctx) => {
    await ctx.dispatchAgent(...) // ctx is fresh per fire
  },
})
```

The cached-ctx workaround is no longer needed: the engine builds
`ctx` fresh on every fire through `extcontext.NewExtContext`, the
same path hook handlers already use.
