// Package types — NormalizedEvent type-name constants.
//
// Split from normalized_event.go to keep that file under the 800-line cap:
// the const block enumerating every canonical event kind is a cohesive,
// self-contained unit (names + their doc comments), while the sibling file
// keeps the NormalizedEvent envelope, the JSON marshal/unmarshal machinery,
// and the concrete variant structs.
package types

// NormalizedEventType enumerates the canonical event kinds.
const (
	EventSessionInit       = "session_init"
	EventTextChunk         = "text_chunk"
	EventToolCall          = "tool_call"
	EventToolCallUpdate    = "tool_call_update"
	EventToolCallComplete  = "tool_call_complete"
	EventToolResult        = "tool_result"
	EventTaskUpdate        = "task_update"
	EventTaskComplete      = "task_complete"
	EventError             = "error"
	EventSessionDead       = "session_dead"
	EventRateLimit         = "rate_limit"
	EventUsage             = "usage"
	EventPermissionRequest = "permission_request"
	EventPlanModeChanged   = "plan_mode_changed"
	EventPlanProposal      = "plan_proposal"
	EventPlanModeAutoExit  = "plan_mode_auto_exit"
	// EventPlanFileWritten is emitted the moment a Write/Edit successfully
	// lands on the canonical plan file during plan mode. It is distinct from
	// EventPlanModeChanged (which fires on plan-mode *entry*, before any file
	// exists): this event fires only after the plan file actually exists on
	// disk with content, so consumers can render a "plan created / updated"
	// marker at the true point in the conversation and a link that resolves.
	EventPlanFileWritten = "plan_file_written"
	EventStreamReset     = "stream_reset"
	EventCompacting      = "compacting"
	EventToolStalled     = "tool_stalled"
	EventSteerInjected   = "steer_injected"
	// EventPromptInjected is emitted when a prompt no client submitted is
	// injected into the session — an extension calling ctx.sendPrompt
	// (dispatch-completion delivery, check-ins, orchestrator revives). The
	// injected text persists as a genuine user turn in the conversation
	// file; this event is what lets LIVE clients render that turn without
	// reloading the file. Client-submitted prompts never emit it (each
	// client does its own optimistic transcript insert).
	EventPromptInjected = "prompt_injected"
	EventModelFallback  = "model_fallback"
	// EventCapabilityUnsupported signals that a requested feature (e.g. plan
	// mode) is not supported by the backend that would serve the run, and the
	// run was declined cleanly — no dispatch, no crash-shaped exit. See
	// CapabilityUnsupportedEvent in normalized_event_capability.go.
	EventCapabilityUnsupported = "capability_unsupported"
	EventRunStalled            = "run_stalled"
	// EventTaskSuspend is the engine-internal signal that ends an LLM run
	// without completing the dispatch. The agent's LLM run exits (saving
	// tokens, showing as idle in the UI) but its parent's OnComplete callback
	// does NOT fire. The dispatch remains alive in the registry; when a revive
	// message arrives via sendPrompt, runChild restarts the LLM run with the
	// new conversation context. This is the mechanism that lets a dispatched
	// lead agent go idle while waiting for its specialist children to complete,
	// without forcing a synchronous blocking dispatch on the orchestrator.
	// Consumers (desktop, iOS) may update the agent-state pill to show a
	// "suspended" or "idle" indicator while the dispatch is parked.
	EventTaskSuspend = "task_suspend"
	// EventPlanContent is emitted in response to a get_plan_content command.
	// It carries a bounded byte-range window of a plan file so remote clients
	// can page through large plans without filesystem access to the engine host.
	EventPlanContent = "engine_plan_content"
	// EventOidcLoginURL is delivered to the client that issued an
	// oidc_begin_login command. It carries what that consumer must surface
	// to the user: the authorization URL to open (interactive PKCE) or the
	// user code + verification URI to display (device-code flow). The
	// engine owns the rest of the flow — its loopback callback server (or
	// device-code polling) completes the exchange without further client
	// involvement.
	EventOidcLoginURL = "engine_oidc_login_url"
	// EventOidcIdentity is a complete snapshot of the operator's OIDC
	// identity state (signed in with claims, or signed out). Broadcast to
	// all clients on every state transition (login completion, logout) and
	// delivered to the requester of an oidc_identity command. Consumers
	// replace their local identity view with the payload.
	EventOidcIdentity = "engine_oidc_identity"
	// Extended-thinking events surface the model's reasoning activity as a
	// first-class signal (issue #158). The engine receives Anthropic
	// thinking_delta stream events; these variants make them observable so
	// consumers can distinguish active reasoning from a genuine stall, and
	// render a "thinking" view. Emitted only when the provider supplies a
	// reasoning stream — thinking blocks are optional per turn.
	EventThinkingBlockStart = "thinking_block_start"
	EventThinkingDelta      = "thinking_delta"
	EventThinkingBlockEnd   = "thinking_block_end"

	// Extension-surface events — decode targets that consumers map to from the
	// corresponding engine_* wire events, so every conversation (plain and
	// extension-hosted) can flow through a single normalized-event reducer
	// rather than a per-event-type switch. The engine emits the underlying
	// engine_* events; these bare-named variants are the normalized shapes a
	// consumer's normalize step produces. See
	// engine/internal/types/normalized_event_extensions.go for the structs.

	// EventMessageEnd reports the end of one LLM message within a run.
	// Carries that message's token usage and a seal flag marking it complete.
	EventMessageEnd = "message_end"

	// EventUserTurnPersisted reports that the run-opening user turn has been
	// appended to the conversation and persisted, carrying its canonical
	// tree-entry id. Emitted once per run, immediately after the engine
	// persists the inbound user message — BEFORE any streaming begins — so
	// consumers can re-key an optimistic user row to the persisted identity
	// at the earliest possible moment. message_end also carries the same id
	// (UserEntryID), but only for runs that reach a message end; a run that
	// is cancelled or fails mid-stream never gets one, leaving optimistic
	// rows un-re-keyed and causing history reloads to duplicate the user
	// turn. This event closes that gap for every run outcome.
	EventUserTurnPersisted = "user_turn_persisted"

	// EventAgentState is a complete snapshot of every agent the engine
	// considers live at this moment. Consumers replace their local view —
	// do not merge incrementally.
	EventAgentState = "agent_state"

	// EventHarnessMessage is a display message injected by the extension
	// harness (e.g. a banner or inline status). Carries an optional dedupKey
	// so consumers can suppress repeated emissions within the same session.
	EventHarnessMessage = "harness_message"

	// EventWorkingMessage is a transient activity string produced by the
	// extension harness (e.g. "Compacting..."). It replaces the prior
	// working-message value; an empty string clears it.
	EventWorkingMessage = "working_message"

	// EventNotify is an ephemeral notification from the extension harness. It
	// is not part of the conversation history.
	EventNotify = "notify"

	// EventDialog is a request from the extension harness for a user response
	// (text input or option selection).
	EventDialog = "dialog"

	// EventExtensionDied signals that an extension subprocess exited
	// unexpectedly and the engine is attempting a respawn.
	EventExtensionDied = "extension_died"

	// EventExtensionRespawned signals that an extension subprocess was
	// successfully restarted after a previous crash.
	EventExtensionRespawned = "extension_respawned"

	// EventExtensionDeadPermanent signals that an extension subprocess has
	// exceeded the crash budget and will not be restarted automatically.
	EventExtensionDeadPermanent = "extension_dead_permanent"

	// EventEventsDropped signals that the event delivery buffer overflowed
	// and some events were discarded. State may be stale.
	EventEventsDropped = "events_dropped"

	// EventContextBreakdown carries a per-category token breakdown for the
	// active run. Emitted once after prompt assembly and again after the
	// first UsageEvent reconciliation (with APIReportedTotal and Unaccounted
	// populated). See ContextBreakdownEvent.
	EventContextBreakdown = "context_breakdown"

	// EventImageContent carries a single image produced during a run — either
	// returned by a tool (Source="tool", ToolID set) or generated by the
	// provider (Source="provider", ToolID empty). The engine is a pass-through
	// for images: it never generates them. The event carries a FILE PATH to the
	// saved image on disk (under the conversation's images/ directory), never
	// base64 bytes on the wire. See ImageContentEvent.
	EventImageContent = "image_content"
)
