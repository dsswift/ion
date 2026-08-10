# ADR-026: Async Agent Dispatch by Default

## Status

Accepted.

## Context

Agent dispatch historically blocked the calling Agent tool, SDK RPC, and CLI
`ion_agent` MCP request until a child reached a terminal state. The Agent tool
was exempt from normal tool deadlines, so a child could keep the root
conversation apparently active for hours while user messages queued behind a
non-draining tool call. A user could neither redirect the orchestrator nor ask
it to steer the child until completion.

## Decision

Agent dispatch is asynchronous unless caller explicitly requests
`waitForCompletion: true` or `wait_for_completion: true` on built-in Agent.
The legacy `background` field remains decodable, but neither omission nor
`background: false` selects foreground behavior.

Every non-detached asynchronous dispatch returns a collision-safe dispatch ID
immediately. The engine owns terminal delivery:

- A child of a dispatched parent records its result on exact parent dispatch
  before child deregistration. An active API parent consumes recorded result at
  its run-loop checkpoint. A parent ending its turn parks/resumes with same
  child conversation and recorded result.
- A root-owned child delivers its terminal result through session prompt queue
  as machine-authored `agent_completion`. Active roots queue it behind current
  turn; idle roots start a new run. This avoids trying to inject inside an
  active tool goroutine.
- A detached dispatch is genuine fire-and-forget. It emits lifecycle and state
  events but does not wake its parent.

Callbacks are observational. They may update harness state, but correctness
must not depend on callback code waking parent.

## Consequences

Users can submit prompts after agent dispatch returns. The orchestrator can
continue work, end turn, or use exact dispatch ID with steering APIs. Clients
receive existing agent snapshots and dispatch events; no UI-specific signal is
inserted into model text beyond classified terminal completion input.

Explicit foreground work is bounded by normal tool timeout. API parents can
consume completion before next provider call. CLI parents receive completion
once current native turn exits; ACP lacks mid-turn steering but remains
wakeable when idle.

## Race invariants

1. Terminal result records before deregistration.
2. Parent sees either live child or undrained terminal record.
3. Record drains exactly once, either at active checkpoint or parked resume.
4. Root completion uses session queue, so active, exiting, and idle root states
   share one delivery mechanism.
5. Detached dispatch never enters parent outstanding set.
