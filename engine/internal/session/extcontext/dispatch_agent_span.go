package extcontext

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// dispatch_agent_span.go holds the dispatch.agent telemetry span helpers
// (family 4b), extracted from dispatch_agent.go to keep that file under the
// file-size cap. The span covers a whole dispatch: started right after
// engine_dispatch_start is emitted, ended in runChild's terminal path (or in
// the background goroutine's panic-recovery path).

// dispatchSpanStart bundles the attributes stamped on the dispatch.agent span
// at start time, plus the child run id used on the engine_dispatch_start event.
type dispatchSpanStart struct {
	agentID          string
	parentDispatchId string
	name             string
	task             string
	model            string
	childDepth       int
	background       bool
	childReqID       string
	// extensionName and extensionVersion carry the hosting extension's identity
	// onto the dispatch.agent span so Grafana can attribute agent cost by
	// extension. Both are omit-when-empty (absent for non-extension runs).
	extensionName    string
	extensionVersion string
}

// beginDispatch emits the engine_dispatch_start workflow event on the parent
// session and opens the dispatch.agent telemetry span. Folding both into one
// helper keeps dispatch_agent.go under the file-size cap. Returns nil when
// telemetry is disabled (the dispatch_start event still fires).
func beginDispatch(sa SessionAccessor, s dispatchSpanStart) *telemetry.SpanHandle {
	sa.Emit(types.EngineEvent{
		Type:              "engine_dispatch_start",
		DispatchAgent:     s.name,
		DispatchTask:      s.task,
		DispatchModel:     s.model,
		DispatchSessionID: s.childReqID,
		DispatchDepth:     s.childDepth,
		DispatchParentId:  s.parentDispatchId,
		DispatchId:        s.agentID,
	})
	return startDispatchSpan(sa, s)
}

// startDispatchSpan opens the dispatch.agent span when telemetry is enabled on
// the session, returning nil otherwise. The returned handle is ended via
// endDispatchSpan / endDispatchSpanPanic.
func startDispatchSpan(sa SessionAccessor, s dispatchSpanStart) *telemetry.SpanHandle {
	telem := sa.Telemetry()
	if telem == nil {
		return nil
	}
	attrs := map[string]any{
		"session_id":      sa.SessionKey(),
		"conversation_id": sa.ConversationID(),
		"span_id":         s.agentID,
		"parent_span_id":  s.parentDispatchId,
		"agent":           s.name,
		"task":            s.task,
		"model":           s.model,
		"dispatch_depth":  s.childDepth,
		"background":      s.background,
	}
	// Extension attribution: omit-when-empty so non-extension dispatches are
	// unaffected and old lines group as "unattributed" in dashboards.
	if s.extensionName != "" {
		attrs["extension"] = s.extensionName
		if s.extensionVersion != "" {
			attrs["extension_version"] = s.extensionVersion
		}
	}
	return telem.StartSpan("dispatch.agent", attrs)
}

// dispatchSpanEnd bundles the terminal metrics stamped on the dispatch.agent
// span at end time, plus the fields the engine_dispatch_end event carries.
type dispatchSpanEnd struct {
	name                     string
	agentID                  string
	parentDispatchId         string
	childDepth               int
	elapsed                  float64
	exitCode                 int
	cost                     float64
	inputTokens              int
	outputTokens             int
	thinkingTokens           int
	cacheReadInputTokens     int
	cacheCreationInputTokens int
	toolCount                int
	childConversationID      string
	recalled                 bool
}

// finishDispatch emits the engine_dispatch_end workflow event on the parent
// session and ends the dispatch.agent telemetry span. Folding both into one
// helper keeps dispatch_agent.go under the file-size cap.
func finishDispatch(sa SessionAccessor, span *telemetry.SpanHandle, e dispatchSpanEnd) {
	sa.Emit(types.EngineEvent{
		Type:                   "engine_dispatch_end",
		DispatchAgent:          e.name,
		DispatchExitCode:       e.exitCode,
		DispatchElapsed:        e.elapsed,
		DispatchCost:           e.cost,
		DispatchInputTokens:    e.inputTokens,
		DispatchOutputTokens:   e.outputTokens,
		DispatchToolCount:      e.toolCount,
		DispatchThinkingTokens: e.thinkingTokens,
		DispatchDepth:          e.childDepth,
		DispatchParentId:       e.parentDispatchId,
		DispatchId:             e.agentID,
		DispatchConversationID: e.childConversationID,
	})
	endDispatchSpan(span, e)
}

// endDispatchSpan closes the dispatch.agent span with the dispatch's terminal
// cost/token/exit metrics. Nil-safe (no-op when telemetry was disabled).
func endDispatchSpan(span *telemetry.SpanHandle, e dispatchSpanEnd) {
	if span == nil {
		return
	}
	span.End(map[string]any{
		"exit_code":                   e.exitCode,
		"cost_usd":                    e.cost,
		"input_tokens":                e.inputTokens,
		"output_tokens":               e.outputTokens,
		"thinking_tokens":             e.thinkingTokens,
		"cache_read_input_tokens":     e.cacheReadInputTokens,
		"cache_creation_input_tokens": e.cacheCreationInputTokens,
		"tool_count":                  e.toolCount,
		"child_conversation_id":       e.childConversationID,
		"recalled":                    e.recalled,
	})
}

// endDispatchSpanPanic closes the dispatch.agent span on the panic-recovery
// path with an error message and exit_code 1. Nil-safe.
func endDispatchSpanPanic(span *telemetry.SpanHandle, r interface{}) {
	if span == nil {
		return
	}
	span.End(map[string]any{
		"exit_code": 1,
		"recalled":  false,
	}, fmt.Sprintf("panic: %v", r))
}
