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
	// Kind classifies the injection semantically. "agent_completion" means
	// this is a machine-to-machine dispatch callback (a completed child
	// agent's result being routed back to a parent agent) rather than a
	// turn the user authored. "slash_command" means the injection is the
	// expanded body of a slash command whose display turn is the command
	// pill (the engine persists the raw invocation via
	// AddUserMessageWithInvocation); the body is redundant with the pill and
	// clients suppress it. Empty (the default) means the injection is a
	// genuine extension-initiated turn with no special classification.
	// Consumers interpret the classification however they choose.
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
	// AwaitingTaskIDs lists the background bash task IDs the run is waiting
	// on when the engine parks a session at a turn boundary because it has
	// outstanding notifying background commands (Bash run_in_background with
	// notify_on_complete). Distinct from AwaitingDispatchIDs: those are child
	// agents, these are shell processes. A parked ROOT session reports its
	// task IDs here — unlike a dispatched child, the root's run exits fully
	// and is revived by starting a new run when a task completes.
	//
	// Revive semantics differ from AwaitingDispatchIDs by design: the dispatch
	// path revives only when EVERY awaited child has completed, whereas this
	// set is drained one task at a time and the session is woken on EACH
	// completion (a finished command may unblock work the model can do while
	// the rest still run). If the session ends its next turn with tasks still
	// outstanding, it parks again.
	AwaitingTaskIDs []string `json:"awaitingTaskIds,omitempty"`
}

func (TaskSuspendEvent) eventType() string { return EventTaskSuspend }

// BackgroundTaskCompleteEvent fires when a background bash command started
// with notify_on_complete reaches a terminal state (exited, failed, or was
// stopped). It is the engine's complete signaling obligation for that
// completion: it is emitted for every notifying task regardless of whether the
// engine also delivers the result into a run.
//
// The event is advisory in the sense that a consumer which ignores it still
// sees the effect through the normal pipeline — under the default delivery
// mode the session is woken with the result as an injected prompt, which
// surfaces as an ordinary run. Consumers that want to render completions
// distinctly (a toast, a task list, a headless pipeline that acts on exit
// codes) read this event instead of scraping run content.
type BackgroundTaskCompleteEvent struct {
	// TaskID is the tasks-registry ID of the completed task, matching the ID
	// the Bash tool returned when the command was started.
	TaskID string `json:"taskId"`
	// Status is the terminal status: "completed" (exit 0), "failed"
	// (non-zero exit), or "stopped" (killed via TaskStop or session teardown
	// before it finished).
	Status string `json:"status"`
	// ExitCode is the process exit code. Zero for a "stopped" task killed
	// before it reported one.
	ExitCode int `json:"exitCode"`
	// ElapsedMs is wall-clock milliseconds from command start to terminal
	// transition.
	ElapsedMs int64 `json:"elapsedMs"`
	// OutputPath is the on-disk file holding the command's full interleaved
	// stdout+stderr. Always present; the file outlives the event.
	OutputPath string `json:"outputPath,omitempty"`
	// Tail is the bounded in-memory tail of the command's output, provided so
	// a consumer can render a result without reading OutputPath.
	Tail string `json:"tail,omitempty"`
	// Command is the shell command that ran, so a consumer can label the
	// completion without having retained the start event.
	Command string `json:"command,omitempty"`
	// RemainingTaskIDs lists the session's still-outstanding notifying task
	// IDs at the instant this one completed. Empty means this was the last
	// one. Lets a consumer render "2 of 3 done" without tracking starts.
	RemainingTaskIDs []string `json:"remainingTaskIds,omitempty"`
}

func (BackgroundTaskCompleteEvent) eventType() string { return EventBackgroundTaskComplete }

// DispatchLostEvent fires once per dispatch that was recorded as running (or
// suspended) in the conversation file but is provably dead: the engine
// process restarted, the dispatch registry is process memory, and every
// in-flight dispatched child died with the old process — no terminal
// callback (OnComplete/OnError/OnRecall) ever fired for it. Emitted on the
// owning session's stream during dispatch-state rehydration at session
// start.
//
// This is the engine's complete signaling obligation for the loss (see the
// typed-event corollary): the engine does not resurrect the child's LLM run
// — resuming half-finished work is a conversation-level decision the
// consumer owns. A consumer may redispatch, harvest partial work from the
// child's conversation file (ChildConversationID), notify an orchestrator,
// or ignore the event. The rehydrated agent-state row is independently
// marked "error" so no panel shows a dead dispatch as running.
type DispatchLostEvent struct {
	// DispatchID is the lost dispatch's collision-safe unique ID.
	DispatchID string `json:"dispatchId"`
	// AgentName is the dispatched agent's name (e.g. "dev-lead").
	AgentName string `json:"agentName"`
	// Task is the task brief the dispatch was running, so a consumer can
	// redispatch without reconstructing it.
	Task string `json:"task,omitempty"`
	// ParentDispatchID is the dispatch ID of the parent that spawned this
	// dispatch; empty for a top-level dispatch.
	ParentDispatchID string `json:"parentDispatchId,omitempty"`
	// Depth is the dispatch's nesting depth (0/1 = top-level per the
	// persisted attribution, matching the agent-state metadata).
	Depth int `json:"depth,omitempty"`
	// ChildConversationID is the child session's conversation ID when it was
	// captured before the loss. The child's partial transcript survives on
	// disk under this ID even though its run is gone — the harvest handle.
	ChildConversationID string `json:"childConversationId,omitempty"`
}

func (DispatchLostEvent) eventType() string { return EventDispatchLost }
