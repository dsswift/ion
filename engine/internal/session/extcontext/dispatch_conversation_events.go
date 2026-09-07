package extcontext

import (
	"encoding/json"
	"strings"
	"sync"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/utils"
)

// dispatch_conversation_events.go adapts a dispatched child's run into the
// conversation.* telemetry family (issue #378), using the SAME
// *telemetry.ConversationEmitter core child 03 built
// (internal/telemetry/conversation_emitter.go) that the root path (child 04)
// adapts independently in internal/session/event_translation.go. Extracted to
// its own file — rather than growing dispatch_agent.go further, which already
// carries a file-size-exception — so the emitter wiring stays reviewable on
// its own.
//
// Every helper here is nil-safe end to end: buildDispatchConversationEmitter
// always returns a non-nil *telemetry.ConversationEmitter (NewConversationEmitter
// tolerates a nil collector and every emitter method no-ops on a nil
// collector), so call sites in dispatch_agent.go never need a nil check before
// calling UserMessage/AssistantMessage/ToolCall/Lifecycle.

// buildDispatchConversationEmitter constructs the conversation.* emitter for
// one dispatched child run, sourced from SessionAccessor.ConversationEventsTelemetry
// (the standalone collector child 02 built, reached through the Manager-level
// plumbing added alongside this child — see session_accessor.go's
// ConversationEventsTelemetry and extcontext.go's SessionAccessor interface
// method of the same name). A nil collector (conversation events disabled, or
// sa is a lightweight test accessor with no wiring) produces a no-op emitter,
// so every call site below is unconditional.
func buildDispatchConversationEmitter(sa SessionAccessor) *telemetry.ConversationEmitter {
	e := telemetry.NewConversationEmitter(sa.ConversationEventsTelemetry())
	extGroup := sa.ExtGroup()
	if extGroup == nil || extGroup.IsEmpty() {
		return e
	}
	return e.SetBeforeEvent(func(info telemetry.BeforeEventInfo) map[string]any {
		return extGroup.FireBeforeConversationEvent(nil, extension.BeforeConversationEventInfo{
			EventName:      info.EventName,
			ConversationID: info.ConversationID,
			RunID:          info.RunID,
			DispatchID:     info.DispatchID,
			TraceID:        info.TraceID,
		})
	})
}

// resolveDispatchConvExisted reports whether the dispatched child's backing
// conversation file already existed on disk BEFORE this dispatch's run
// starts. Must be called before startChild — checking any later would race
// the child's own first persistence write and always read "true".
//
// conversationID is the id the child run's RunOptions.ConversationID was
// built with (buildDispatchRunOptions sets it from opts.SessionID when the
// caller supplied one, meaning "resume this existing dispatched agent's
// conversation"; empty means the child mints a brand-new conversation id
// itself, so there is nothing to check — always "created").
//
// This mirrors the convExists seam the root path uses at session start
// (internal/session/start_session.go: "convExists := conversation.Exists(convID, "")"),
// per the child 05 spec's explicit instruction to reuse that pattern.
// Verified in source (not assumed) that the dispatch path has no
// StartSession-equivalent of its own to hook instead: BuildDispatchAgentFunc
// builds RunOptions directly (dispatch_runopts.go) and calls the child
// backend's StartRun/StartRunWithConfig — it never goes through
// session.StartSession, so this is the dispatch path's own, first, and only
// lifecycle-classification point, distinct from (not shared with) child 04's
// root-path wiring.
func resolveDispatchConvExisted(conversationID string) bool {
	if conversationID == "" {
		return false
	}
	return conversation.Exists(conversationID, "")
}

// dispatchLifecycleAction maps the existed flag from
// resolveDispatchConvExisted to the frozen LifecycleAction vocabulary.
func dispatchLifecycleAction(existed bool) telemetry.LifecycleAction {
	if existed {
		return telemetry.ActionResumed
	}
	return telemetry.ActionCreated
}

// convCostTracker holds the most recently delivered per-turn model + CallCost
// from backend.RunConfig.OnCallCost (backend.go), so the paired UsageEvent —
// emitted from the SAME code block in runloop.go immediately after OnCallCost
// is invoked, before any other event can intervene — can attach it to
// ConversationEmitter.AssistantMessage without recomputing it (frozen
// contract E; the child 05 spec requires reusing the existing accumulated
// value, not re-deriving it from LlmUsage).
//
// Guarded by its own mutex rather than the OnNormalized callback's
// lifecycleMu: OnCallCost is invoked directly from runloop.go's turn-closing
// code path, not from fireLifecycleCallbacks, so it is a distinct writer that
// must not contend with (or be assumed to run under) the tool-callback
// accumulator lock.
type convCostTracker struct {
	mu    sync.Mutex
	model string
	cost  *telemetry.CallCost
}

// record stores the latest per-turn cost delivered by OnCallCost. Safe to
// call with a nil cost (RunConfig.OnCallCost's own contract allows it); take
// then returns a nil *CallCost, which AssistantMessage treats as "no cost
// available" per its own documented contract.
func (t *convCostTracker) record(model string, cost *telemetry.CallCost) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.model = model
	t.cost = cost
}

// take returns and clears the tracked model/cost pair. Called from the
// UsageEvent handler in dispatch_agent.go when e.EntryID is non-empty (the
// signal that this usage event closes a completed assistant message — see
// types.UsageEvent's own doc comment). Clearing on read means a later
// UsageEvent with no preceding OnCallCost (should not happen on the paired
// code path, but defensively) reports "no cost" rather than replaying a stale
// value from an earlier turn.
func (t *convCostTracker) take() (string, *telemetry.CallCost) {
	t.mu.Lock()
	defer t.mu.Unlock()
	model, cost := t.model, t.cost
	t.model, t.cost = "", nil
	return model, cost
}

// convTextTracker pairs backend.RunConfig.OnUserMessage / OnAssistantMessage's
// per-turn text delivery with the NormalizedEvent that closes the same turn.
// Mirrors session.convTextTracker exactly; duplicated for the same reason
// convCostTracker is duplicated across the two packages (see its own doc
// comment above).
type convTextTracker struct {
	mu   sync.Mutex
	text string
}

func (t *convTextTracker) record(_ string, text string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.text = text
}

func (t *convTextTracker) take() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	text := t.text
	t.text = ""
	return text
}

// convToolInfo accumulates one in-flight tool call's name and streamed
// partial-input JSON, keyed by ToolID. Mirrors session.convToolInfo exactly.
type convToolInfo struct {
	Name      string
	InputJSON strings.Builder
}

// decodeToolInput best-effort parses accumulated partial-input JSON into a
// map. Mirrors session.decodeToolInput exactly — a parse failure returns nil
// rather than failing the emission.
func decodeToolInput(raw string) map[string]any {
	if raw == "" {
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		utils.LogWithFields(utils.LevelDebug, "telemetry", "conversation.tool_call: partial input did not parse as JSON", map[string]any{"error": err.Error(), "len": len(raw)})
		return nil
	}
	return m
}

// dispatchAppCtx builds the correlation context for a dispatched child's
// conversation.* events, carrying the parent session's client-supplied
// application context under "app_context".
//
// A dispatched child runs inside the same client surface as its parent — a
// sub-agent has no tab of its own — so an enterprise consumer attributing a
// child's tool call to a surface needs the parent's identity. Returns nil
// when the client supplied none, which keeps the historical shape (these
// emissions passed a nil context before this field existed) for every
// consumer that does not opt in.
func dispatchAppCtx(sa SessionAccessor) map[string]any {
	appContext := sa.AppContext()
	if len(appContext) == 0 {
		return nil
	}
	cp := make(map[string]any, len(appContext))
	for k, v := range appContext {
		cp[k] = v
	}
	return map[string]any{"app_context": cp}
}
