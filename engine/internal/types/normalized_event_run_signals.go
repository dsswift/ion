// Run-signal NormalizedEvent variants: advisory/workflow signals about an
// in-flight or incoming run (stall watchdog, steer capture, extension prompt
// injection). Split from normalized_event.go for the file-size cap; same
// package, same registry (see decode switch + contract_test.go variants map).
package types

// RunStalledEvent fires when the engine watchdog detects that an active
// run has made no progress (no provider stream events, no tool results,
// no turn boundaries) for longer than the configured run-stall threshold
// and cancels the run as a safety backstop. Emitted exactly once per
// stalled run, immediately before the engine cancels the run's context.
//
// This event is *advisory*: the authoritative completion signal is the
// follow-up TaskCompleteEvent (with a non-zero exit code) plus the
// emitExit call that fires after context cancellation propagates. A
// consumer that ignores RunStalledEvent entirely still sees the run
// reach a terminal state through the normal exit pipeline; the event
// exists so consumers that want to render "stalled" distinctly from
// "errored" (e.g. a watchdog icon vs. a generic error toast) can do so.
//
// The watchdog is the engine's last line of defense against subsystems
// that block indefinitely on a channel or syscall outside the reach of
// HTTP/2 pings or per-tool timeouts. See
// engine/internal/backend/runloop_watchdog.go for the implementation
// and the threshold default. Headless harnesses receive the event in
// the JSON stream and may abort, retry, notify, or ignore.
type RunStalledEvent struct {
	// StalledDuration is the elapsed time (seconds) since the last
	// recorded progress event on this run. Equal to or greater than
	// the configured run-stall threshold at emission time.
	StalledDuration float64 `json:"stalledDuration"`
	// LastActivity is a short human-readable description of the most
	// recent progress event observed (e.g. "provider stream chunk",
	// "tool result", "turn boundary"). Optional — included for
	// diagnostics so an operator reading the event stream can tell
	// where progress stopped without cross-referencing the engine
	// log. Empty string is permitted when no description is available.
	LastActivity string `json:"lastActivity,omitempty"`
}

func (RunStalledEvent) eventType() string { return EventRunStalled }

// SteerInjectedEvent is emitted when a mid-turn steer message is injected into
// the conversation before the next LLM call. Clients can use this to confirm
// that a steer message sent while the agent was running was successfully
// captured and will influence the model's next response.
type SteerInjectedEvent struct {
	// MessageLength is the character count of the injected steer message.
	// Provided so clients can display a non-empty confirmation without
	// echoing the full message back over the wire.
	MessageLength int `json:"messageLength"`
}

func (SteerInjectedEvent) eventType() string { return EventSteerInjected }

// PromptInjectedEvent is emitted when an ENGINE-SIDE actor (an extension via
// ctx.sendPrompt) starts a run whose user prompt no client submitted. Without
// it, live clients watch the model respond to a turn they cannot see — the
// injected prompt exists only in the conversation file until a reload.
// Clients that maintain a live transcript should append the prompt as a user
// turn; a rehydrate from the conversation file replaces it with the same
// persisted turn. Client-submitted prompts (wire `prompt` command) never emit
// this event.
type PromptInjectedEvent struct {
	// Prompt is the injected text, verbatim — the same content persisted as
	// the run's user turn.
	Prompt string `json:"prompt"`
	// Origin names the injector when known — the hosting extension's name.
	// Empty when the session has no extension identity.
	Origin string `json:"origin,omitempty"`
	// Kind classifies the injection so clients can decide whether to render
	// it as a user-visible turn. The value "agent_completion" indicates an
	// internal agent dispatch callback (a completed child agent's result
	// being routed back to a parent agent) — these are machine-to-machine
	// signals, not turns the user authored, and clients should NOT render
	// them as user bubbles. Empty (the default) means the injection is a
	// genuine extension-initiated user turn and should be rendered normally.
	Kind string `json:"kind,omitempty"`
}

func (PromptInjectedEvent) eventType() string { return EventPromptInjected }

// TaskSuspendEvent is the engine-internal signal that ends an LLM run without
// completing the dispatch. When an extension calls ctx.suspend() (or
// ctx.suspendUntilAll()), the backend emits this event and the run exits
// cleanly — the agent shows as idle/suspended in the UI. The parent's
// OnComplete callback does NOT fire. The dispatch remains alive; when a revive
// message arrives via sendPrompt, runChild restarts the LLM run with the new
// conversation context. Consumers may update the agent-state indicator to show
// a "suspended" or "idle" state while the dispatch is parked.
type TaskSuspendEvent struct {
	// AwaitingDispatchIDs lists the dispatch IDs the suspending agent is
	// waiting on (for N-child fan-out via dispatch_agents). The engine uses
	// this set to track pending children; the reviveCh is signaled only when
	// all listed children have completed. Empty for a bare suspend() call
	// (revives on the next sendPrompt to this session, regardless of origin).
	AwaitingDispatchIDs []string `json:"awaitingDispatchIds,omitempty"`
}

func (TaskSuspendEvent) eventType() string { return EventTaskSuspend }
