# ADR-023: Root-Session Park and Wake for Background Bash Completion

## Status

Accepted.

## Context

`Bash(run_in_background: true)` was fire-and-forget. The terminal watcher in
`engine/internal/tools/tasks_bash.go` stamped a status on the tasks registry and wrote a
log line; nothing reached the agent. An orchestrator that started a twenty-minute build
had exactly two options: poll `TaskGet` in a loop (burning a turn per check), or forget
about the command entirely.

Background *agent* dispatch already had the missing machinery. A dispatched child can
call `ctx.suspend()`, which ends its LLM run without completing the dispatch; a live
`runChild` goroutine stays parked on `reviveCh` and restarts the run when the awaited
children finish (`internal/session/extcontext/dispatch_registry_suspend.go`). Completion
callbacks reach extensions as `dispatch_complete` / `dispatch_error` notifications
(`internal/extension/host_rpc.go`).

None of it was reachable from the root. `ext/task_suspend` hard-rejected at depth 0 with
`"suspend not available: not inside a dispatched run"`, and the rejection was accurate:
the root has no `runChild` loop, so there was no mechanism to revive it even if the
suspend had been allowed.

Two gaps, then: background bash exit notified nobody, and the root orchestrator could not
go idle and be woken.

## Decision

Background bash commands become first-class outstanding work that a **session**
accumulates, and run parking becomes available at depth 0.

### 1. Opt-in per call, decided per turn

`Bash` gains `notify_on_complete`. A command started with it joins the session's
outstanding set; a command without it behaves exactly as before.

There is deliberately **no** `wait_for_completion` flag. Parking is decided by the engine
at the turn boundary from the live outstanding set, not declared by the model at
tool-call time. A model that starts a long build does not yet know whether it has other
work to do first, and the workflow this exists to support is "start a command, keep
working, start another, keep working, then stop." A tool-call-time declaration cannot
express that; a turn-boundary decision can, because the turn boundary is the only point
where the answer is actually known.

### 2. The outstanding set is session-scoped

It lives on `engineSession`, not `activeRun`. A model may register commands across
several turns and several runs before it finally stops. A run-scoped set would forget
the earlier commands the moment the run that started them exited, and the session would
complete while its own background work was still in flight.

The run loop reads the set through a `RunConfig` **function**, not a slice, because the
model can start commands mid-run — a value copied at run start would be stale exactly
when the park decision reads it.

### 3. The root parks by exiting; it revives by starting a new run

This is the structural difference from the dispatch path, and it is a necessity rather
than a preference:

| | Dispatched child | Root session |
|---|---|---|
| What holds the parked state | A live `runChild` goroutine blocked on `reviveCh` | A `parkedRun` record on the session; no goroutine |
| What the run does | Exits the LLM loop, dispatch stays alive | Exits entirely; the backend forgets the requestID |
| How it revives | Channel send on `reviveCh` | `SendPrompt` starts a **new** run with the completion injected |
| Revive condition | Every awaited child has completed | **Each** completion, one at a time |

The park itself reuses existing mechanics: `activeRun.suspendCh`, `suspendSignal`, and
the `TaskSuspendEvent` emission were already backend-generic and `requestID`-addressed.
Only the revive driver is new.

### 4. Wake is per completion, not wait-for-all

Dispatch's `PendingChildren` revives only when the whole awaited set drains. This diverges
from that precedent **deliberately**. A finished command frequently unblocks work the
orchestrator can do while the others still run; withholding task 1's result until task 3
finishes would forfeit that entirely and reduce the feature to a slower `TaskGet`.

So each completion drains one task and wakes the session with that result plus the
still-outstanding list. If the woken run ends its turn with work remaining, the
turn-boundary check parks it again. The cycle repeats until the set empties. Per-completion
wake degrades to wait-for-all when the model chooses to park each time, so it is strictly
more capable than the alternative.

### 5. Delivery is an opinion; the typed event is not

Per the engine-consumer framing, the engine owns the mechanism and the consumer owns the
policy. `engine_background_task_complete` and the `background_task_completed` hook fire
for **every** notifying command regardless of configuration — that is the engine's
complete signaling obligation (engine-grounding §3). What a consumer configures is
*delivery*: `wake` (default), `queue`, or `event_only`.

`backgroundTasks.parkTimeoutMs` bounds a park so a command that never exits cannot strand
a session; on timeout the session wakes and the command **stays** outstanding, so a merely
slow command still notifies when it eventually finishes.

## Consequences

### On "the engine never blocks for user input"

It still doesn't. That rule is about the **socket** (see
[`../../engine-grounding.md`](../engine-grounding.md) § 2): no dispatch arm may hold the
client's read loop waiting on a human. A parked session holds nothing — the run has fully
exited, the socket is idle, and the client is free. This is the same shape as the
delegated-CLI login flow: return immediately, continue on a bounded, cancellable
background path. The bound here is `parkTimeoutMs`; the cancel is session teardown.

### On unattended runs

Once parked, a completion starts a run with no user present. This has precedent (the
scheduler does the same) and it is the entire point of the feature, but it is a real
behavior change: a session can now consume tokens while nobody is watching. `event_only`
and `queue` are the operator's off switch, and `maxOutstandingPerSession` bounds how much
work one session can queue up.

### On the wire contract

Everything is additive. `TaskSuspendEvent` gains `awaitingTaskIds` alongside
`awaitingDispatchIds`; `StatusFields` gains `backgroundShells` alongside
`backgroundAgents`; `engine_background_task_complete` is a new variant. A consumer built
against the previous surface decodes all of it unchanged — pinned by
`normalized_event_background_task_test.go`, which asserts an old-shape `task_suspend`
payload still decodes.

### On the clients

`backgroundShells` reaches the desktop and iOS through the existing status pipeline, so a
parked session reads as "waiting on N background shells" rather than as idle — a run the
user started ended without completing, and that must be visible. Both clients render it
with the same pink shell dot, and both block closing a tab with outstanding commands
(closing kills the processes).

## Alternatives rejected

**Steer-only delivery.** `SteerAgent` reaches a running turn but a parked or idle session
has no run to steer, so the signal would drop precisely in the case the feature exists
for. Steer is used *in addition*, for the mid-turn case.

**Queue-only delivery as the default.** Degrades "tell me when the build is done" to "tell
me next time I talk to you", which is barely better than polling and leaves the real
capability unbuilt. Available as a configured mode for operators who want it.

**A `wait_for_completion` flag on the tool.** Forces the park decision at tool-call time,
before the model knows whether it has other work to do. Breaks the accumulate-then-park
workflow.

**Wait-for-all revival (matching `PendingChildren`).** Consistent with dispatch, but hides
each result until the last command finishes and forfeits the parallel-workflow case. See
decision 4.
