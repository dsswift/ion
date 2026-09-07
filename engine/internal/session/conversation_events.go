package session

import (
	"encoding/json"
	"strings"
	"sync"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// conversation_events.go adapts child 03's ConversationEmitter core
// (internal/telemetry/conversation_emitter.go) onto the ROOT session path —
// the sibling of internal/session/extcontext/dispatch_conversation_events.go,
// which does the same job for dispatched-child runs (issue #378, child 05).
//
// Root-owned Conversations route every normalized event through
// handleNormalizedEvent (event_translation.go) before client translation.
// That function already carries the drop/translate gate and the structured-
// transcript recorder; emitConversationEvents is called from it, early and
// unconditionally (never gated on s.extGroup, unlike the G34 tool-hook
// switch), so conversation.* events fire regardless of whether the session
// has any extension attached.

// EmitConversationsDeleted fires conversation.lifecycle("deleted") once per
// conversation ID, for durable deletions confirmed by the caller (issue #378,
// child 04: conversation.DeleteStoredExact's explicit-delete path and
// conversation.CleanupStored's retention-cleanup path — see their own doc
// comments on why each returns the deleted IDs rather than a bare count).
// Exported because both call sites live in internal/server (dispatch.go),
// outside this package, and neither owns session-scoped correlation state
// (the conversation may have no live session at delete time) — so the ctx map
// carries only the conversation ID, with no session/extension/run
// correlation to attach.
func (m *Manager) EmitConversationsDeleted(conversationIDs []string) {
	if len(conversationIDs) == 0 {
		return
	}
	emitter := m.conversationEmitter()
	for _, id := range conversationIDs {
		if id == "" {
			continue
		}
		ctx := conversationCorrelationCtx("", id, "", "", "", "")
		emitter.Lifecycle(ctx, id, telemetry.ActionDeleted, "")
	}
}

// conversationEmitter constructs the conversation.* emitter fresh from the
// manager's current ConversationEventsTelemetry() collector, rather than
// caching one field at Manager construction time. This deliberately departs
// from a literal "build once at startup" reading of the child 04 spec: the
// collector is installed dynamically by SetConversationEventsTelemetry from
// the server's SetConfig, which runs AFTER the Manager is constructed (see
// cmd/ion/cmd_serve.go), so a field cached at NewManager time would
// permanently observe a nil collector. NewConversationEmitter is a cheap
// pointer wrap (see its own doc comment) and nil-safe on a nil collector, so
// building it fresh at every call site costs nothing and can never go stale
// — the same pattern the dispatch path already uses via
// buildDispatchConversationEmitter(sa).
func (m *Manager) conversationEmitter() *telemetry.ConversationEmitter {
	return telemetry.NewConversationEmitter(m.ConversationEventsTelemetry())
}

// conversationEmitterFor is conversationEmitter's extension-aware sibling:
// it additionally wires SetBeforeEvent so the before_conversation_event hook
// fires on every emission this ConversationEmitter makes. extGroup nil (no
// attached extensions, or a caller with no session in scope — e.g.
// EmitConversationsDeleted) produces the exact same no-op emitter
// conversationEmitter() returns.
func (m *Manager) conversationEmitterFor(extGroup *extension.ExtensionGroup, ctx *extension.Context) *telemetry.ConversationEmitter {
	e := m.conversationEmitter()
	if extGroup == nil || extGroup.IsEmpty() {
		return e
	}
	return e.SetBeforeEvent(func(info telemetry.BeforeEventInfo) map[string]any {
		return extGroup.FireBeforeConversationEvent(ctx, extension.BeforeConversationEventInfo{
			EventName:      info.EventName,
			ConversationID: info.ConversationID,
			RunID:          info.RunID,
			DispatchID:     info.DispatchID,
			TraceID:        info.TraceID,
		})
	})
}

// sessionCostTracker pairs backend.RunConfig.OnCallCost's per-turn delivery
// with the UsageEvent that closes the same assistant message. Mirrors
// extcontext.convCostTracker (dispatch_conversation_events.go) exactly;
// duplicated rather than shared because the two live in different packages
// and the type is a two-method, no-dependency pairing buffer — not worth an
// exported cross-package surface for.
type sessionCostTracker struct {
	mu    sync.Mutex
	model string
	cost  *telemetry.CallCost
}

// record stores the latest per-turn cost delivered by RunConfig.OnCallCost.
// Wired as runCfg.OnCallCost in buildRunConfig.
func (t *sessionCostTracker) record(model string, cost *telemetry.CallCost) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.model = model
	t.cost = cost
}

// take returns and clears the tracked model/cost pair. Called from the
// UsageEvent branch in emitConversationEvents when e.EntryID is non-empty —
// the signal that this usage event closes a completed assistant message
// (see types.UsageEvent's own doc comment) on the API-backend path, the SAME
// code block in runloop.go that just invoked OnCallCost.
func (t *sessionCostTracker) take() (string, *telemetry.CallCost) {
	t.mu.Lock()
	defer t.mu.Unlock()
	model, cost := t.model, t.cost
	t.model, t.cost = "", nil
	return model, cost
}

// convTextTracker pairs backend.RunConfig.OnUserMessage / OnAssistantMessage's
// per-turn text delivery with the NormalizedEvent that closes the same turn.
// Same record/take shape as sessionCostTracker, kept as a separate type
// because it carries a bare string rather than a model+cost pair.
type convTextTracker struct {
	mu   sync.Mutex
	text string
}

// record stores the latest delivered text. Wired as runCfg.OnUserMessage /
// runCfg.OnAssistantMessage in buildRunConfig.
func (t *convTextTracker) record(_ /* entryID or model */ string, text string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.text = text
}

// take returns and clears the tracked text.
func (t *convTextTracker) take() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	text := t.text
	t.text = ""
	return text
}

// convToolInfo accumulates one in-flight tool call's name and streamed
// partial-input JSON, keyed by ToolID in engineSession.convToolNames. Input
// arrives incrementally via *types.ToolCallUpdateEvent.PartialInput and is
// drained (parsed best-effort) when the terminal *types.ToolResultEvent
// arrives.
type convToolInfo struct {
	Name      string
	InputJSON strings.Builder
}

// decodeToolInput best-effort parses an accumulated partial-input JSON
// string into a map. A parse failure (empty accumulator, or a genuinely
// malformed/incomplete stream) returns nil rather than failing the emission
// — conversation.tool_call still fires with output and outcome; input is
// simply omitted, exactly like ConversationEmitter.ToolCall's own documented
// contract for its input parameter.
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

// codexUsageCallCost maps a codex NormalizedEvent's UsageData into a
// *telemetry.CallCost with CostUsd pinned at 0 — the same real-zero
// reasoning as backend.codexCallCost (internal/backend/codex_events.go),
// replicated here because that helper is unexported in a different package
// (per child 06's report: "replicate at this layer since the helper is
// unexported"). Codex is subscription-metered, not per-call; the token
// buckets are real and known, so CostUsd=0 is a known value, never an
// absence (which is what a nil *CallCost would claim).
func codexUsageCallCost(u types.UsageData) *telemetry.CallCost {
	return &telemetry.CallCost{
		InputTokens:              derefInt(u.InputTokens),
		OutputTokens:             derefInt(u.OutputTokens),
		CacheReadInputTokens:     derefInt(u.CacheReadInputTokens),
		CacheCreationInputTokens: derefInt(u.CacheCreationInputTokens),
		CostUsd:                  0,
	}
}

// conversationCorrelationCtx builds the ctx map for a conversation.* emission
// at a given seam. runID/traceID are omit-when-empty via withRunCorrelation,
// so a lifecycle call made outside any active run (StartSession, StopSession,
// a stored-conversation delete) correctly omits them rather than stamping a
// stale or synthetic identifier.
func conversationCorrelationCtx(sessionKey, conversationID, extName, extVersion, runID, traceID string) map[string]any {
	return withRunCorrelation(correlationCtxExt(sessionKey, conversationID, extName, extVersion), runID, traceID)
}

// withAppContext stamps the session's client-supplied application context
// onto a conversation.* correlation map under "app_context".
//
// The engine never interprets the keys — see types.EngineConfig.AppContext
// for why the shape is opaque. A nil or empty map adds no key at all, so a
// consumer that supplies nothing (every consumer, by default) emits exactly
// the event shape it emitted before this field existed.
//
// The map is copied rather than aliased: the stored session value must not
// be reachable for mutation through an emitted event's context, which a
// before_conversation_event handler or a target's own marshaling could
// otherwise observe mid-flight.
func withAppContext(ctx map[string]any, appContext map[string]string) map[string]any {
	if ctx == nil || len(appContext) == 0 {
		return ctx
	}
	cp := make(map[string]any, len(appContext))
	for k, v := range appContext {
		cp[k] = v
	}
	ctx["app_context"] = cp
	return ctx
}

// emitConversationEvents is the root-path counterpart of dispatch_agent.go's
// per-event conversation.* switch. Called unconditionally from
// handleNormalizedEvent (event_translation.go), before the translate/drop
// gate, so a conversation.* event fires for every root-owned Conversation
// regardless of whether an extension is attached and regardless of whether
// the underlying NormalizedEvent has any client-facing EngineEvent
// translation (UserTurnPersistedEvent and TaskUpdateEvent have none).
//
// Per-backend assistant-message signal (frozen contract per child 06's
// mapping, cited inline below):
//   - ApiBackend / HybridBackend's API route: the terminal UsageEvent that
//     carries a real EntryID, paired with the exact cost RunConfig.OnCallCost
//     already delivered via s.convCostTracker.
//   - Claude Code: TaskUpdateEvent (the assistant-message-complete signal —
//     see fireCliTurnHooks's own comment in event_translation.go), cost=nil.
//     No persisted entry id is known at this point (Ion's tree-entry id for
//     a CLI-served turn is minted later, in persistCliTurn at run exit), so
//     entryID is omitted — the same "no id yet" case ConversationEmitter's
//     putID already handles by omission.
//   - Codex: the terminal UsageEvent, discriminated from the ApiBackend case
//     by s.runCaps.Kind=="codex" (codex's UsageEvent never carries an
//     EntryID — see codex_events.go's NotifTokenUsageUpdated mapping), cost
//     built by codexUsageCallCost. entryID omitted for the same reason as
//     Claude Code.
//   - ACP (grok/cursor): verified in source that acp_events.go/acp_backend.go
//     emit neither TaskUpdateEvent nor a distinguishable per-turn UsageEvent
//     — there is no assistant-message-complete signal to observe on this
//     path today. This mirrors the tool-outcome "denied/blocked structurally
//     unreachable for delegated backends" finding child 06 already
//     documented: it is a verified fact about current backend behavior, not
//     a gap this child papers over.
func (m *Manager) emitConversationEvents(key, runID string, event types.NormalizedEvent) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		return
	}

	m.mu.RLock()
	conversationID := s.conversationID
	extName := s.extensionName
	extVersion := s.extensionVersion
	appContext := s.config.AppContext
	traceID := s.runTraceID
	kind := s.runCaps.Kind
	tracker := s.convCostTracker
	userMsgTracker := s.convUserMsgTracker
	assistantMsgTracker := s.convAssistantMsgTracker
	model := s.lastModel
	extGroup := s.extGroup
	m.mu.RUnlock()

	if conversationID == "" {
		// No durable conversation identity yet (SessionInitEvent has not
		// landed). Every conversation.* payload requires conversation_id to
		// be meaningful; nothing to emit against.
		return
	}

	ctx := withAppContext(conversationCorrelationCtx(key, conversationID, extName, extVersion, runID, traceID), appContext)
	emitter := m.conversationEmitterFor(extGroup, m.newExtContext(s, key))

	switch e := event.Data.(type) {
	case *types.UserTurnPersistedEvent:
		if e.EntryID == "" {
			return
		}
		var text string
		if userMsgTracker != nil {
			text = userMsgTracker.take()
		}
		emitter.UserMessage(ctx, conversationID, e.EntryID, runID, "", text)

	case *types.UsageEvent:
		if e.EntryID != "" {
			// ApiBackend / Hybrid-API route: the terminal usage event that
			// closes this turn's assistant message. costModel/cost and text
			// were delivered synchronously just before this event, from the
			// SAME runloop.go code block, via RunConfig.OnCallCost /
			// OnAssistantMessage.
			var costModel string
			var cost *telemetry.CallCost
			if tracker != nil {
				costModel, cost = tracker.take()
			}
			if costModel == "" {
				costModel = model
			}
			var text string
			if assistantMsgTracker != nil {
				text = assistantMsgTracker.take()
			}
			emitter.AssistantMessage(ctx, conversationID, e.EntryID, runID, "", costModel, text, cost)
			return
		}
		if kind == "codex" {
			// Codex reports usage via NotifTokenUsageUpdated with no EntryID
			// (see codex_events.go); this is codex's own per-turn assistant-
			// complete signal. entryID omitted — see doc comment above.
			// AssistantText is populated from the paired item/completed
			// notification's Text field (codex_events.go).
			emitter.AssistantMessage(ctx, conversationID, "", runID, "", model, e.AssistantText, codexUsageCallCost(e.Usage))
		}
		// Any other EntryID=="" UsageEvent (Claude Code's early/mid-stream
		// cache-token progress from message_start — see normalizer.go) is
		// NOT a completion signal; deliberately ignored here.

	case *types.TaskUpdateEvent:
		if kind == "claude-code" {
			emitter.AssistantMessage(ctx, conversationID, "", runID, "", e.Message.Model, joinAssistantText(e.Message.Content), nil)
		}

	case *types.ToolCallEvent:
		m.mu.Lock()
		if s2, ok2 := m.sessions[key]; ok2 {
			if s2.convToolNames == nil {
				s2.convToolNames = make(map[string]*convToolInfo)
			}
			s2.convToolNames[e.ToolID] = &convToolInfo{Name: e.ToolName}
		}
		m.mu.Unlock()

	case *types.ToolCallUpdateEvent:
		m.mu.Lock()
		if s2, ok2 := m.sessions[key]; ok2 && s2.convToolNames != nil {
			if info, ok3 := s2.convToolNames[e.ToolID]; ok3 {
				info.InputJSON.WriteString(e.PartialInput)
			}
		}
		m.mu.Unlock()

	case *types.ToolResultEvent:
		m.mu.Lock()
		var toolName string
		var input map[string]any
		if s2, ok2 := m.sessions[key]; ok2 && s2.convToolNames != nil {
			if info, ok3 := s2.convToolNames[e.ToolID]; ok3 {
				toolName = info.Name
				input = decodeToolInput(info.InputJSON.String())
				delete(s2.convToolNames, e.ToolID)
			}
		}
		m.mu.Unlock()
		outcome := telemetry.ToolResultOutcome(e.IsError, e.Content)
		emitter.ToolCall(ctx, conversationID, "", e.ToolID, toolName, runID, "", outcome, input, e.Content)
	}
}

// joinAssistantText concatenates every text content block in a completed
// Claude Code assistant message, in order. Non-text blocks (tool_use) are
// skipped — their input/output travels on conversation.tool_call instead.
func joinAssistantText(blocks []types.ContentBlock) string {
	var sb strings.Builder
	for _, b := range blocks {
		if b.Type == "text" && b.Text != "" {
			sb.WriteString(b.Text)
		}
	}
	return sb.String()
}

// SetAppContext replaces the session's client-supplied application context —
// the map stamped onto its conversation.* events under "app_context".
//
// Called for any addressed ClientCommand that carries appContext, not only
// start_session, so a client whose surface was renamed, moved, or re-parented
// reflects that on its very next command instead of at the next session
// start. Passing an empty (non-nil) map clears the stored value, which is the
// honest encoding of "this surface no longer has an identity to report"
// rather than leaving a stale one stamped on every later event.
//
// Returns false when the key names no live session, so the caller can log the
// miss rather than silently accepting context for a session that ended.
func (m *Manager) SetAppContext(key string, appContext map[string]string) bool {
	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.Unlock()
		utils.LogWithFields(utils.LevelDebug, "session", "app context ignored: no live session for key", map[string]any{
			"key": key, "app_context_keys": len(appContext),
		})
		return false
	}
	if len(appContext) == 0 {
		s.config.AppContext = nil
	} else {
		cp := make(map[string]string, len(appContext))
		for k, v := range appContext {
			cp[k] = v
		}
		s.config.AppContext = cp
	}
	m.mu.Unlock()
	utils.LogWithFields(utils.LevelDebug, "session", "app context updated for conversation events", map[string]any{
		"key": key, "app_context_keys": len(appContext),
	})
	return true
}
