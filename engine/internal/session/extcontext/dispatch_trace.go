package extcontext

import (
	"context"
	"time"

	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// dispatch_trace.go places a dispatched child in the trace tree:
//
//	run.execute (dispatching run)
//	  dispatch.agent            one per dispatch, parented to the dispatching run's span
//	    run.execute (child run) the child's own server span; its llm.call and
//	                            tool.execute spans hang beneath it
//
// A dispatch that starts with no trace in flight (a background dispatch from
// a session with no run, or a test accessor) mints a trace of its own so
// dispatch.agent is never orphaned and always exports.

// dispatchTrace is the trace a dispatch belongs to and the span it hangs
// under.
type dispatchTrace struct {
	traceID string
	// parentSpanID is the dispatching run's span; empty when the dispatch
	// starts a trace of its own.
	parentSpanID string
}

// newDispatchTrace reads the dispatching run's trace from the dispatch
// context (a foreground dispatch inherits the tool call's context), then
// from the session's run identity (a background dispatch derives from the
// session root, which carries no trace), and mints a new trace when neither
// has one. Every branch is logged with the dispatch id.
func newDispatchTrace(parentCtx context.Context, sa SessionAccessor, agentID string) dispatchTrace {
	tr := dispatchTrace{}
	if parentCtx != nil {
		tr.traceID = utils.TraceIDFromContext(parentCtx)
		tr.parentSpanID = utils.SpanIDFromContext(parentCtx)
	}
	source := "dispatch context"
	if tr.traceID == "" {
		tr.traceID = sa.TraceID()
		tr.parentSpanID = runSpanID(sa)
		source = "session run"
	}
	if tr.traceID == "" {
		tr.traceID = utils.NewTraceID()
		tr.parentSpanID = ""
		source = "minted"
	}
	utils.LogWithFields(utils.LevelDebug, "session", "dispatch trace resolved", map[string]any{
		"dispatch_id": agentID, "trace_id": tr.traceID, "parent_span_id": tr.parentSpanID, "source": source,
	})
	return tr
}

// childRunTrace is the trace position of a dispatched child's run: the
// dispatch's trace, the dispatch.agent span it runs under, and its own run
// span.
type childRunTrace struct {
	dispatchTrace
	// dispatchSpanID is the dispatch.agent span; empty when telemetry is
	// disabled, in which case the child run hangs directly under the
	// dispatching run's span.
	dispatchSpanID string
	runSpanID      string
	startedAt      time.Time
}

// child positions the child run under the dispatch.agent span (nil when
// telemetry is disabled) and mints the child's run span.
func (d dispatchTrace) child(span *telemetry.SpanHandle) childRunTrace {
	c := childRunTrace{dispatchTrace: d, runSpanID: utils.NewSpanID(), startedAt: time.Now()}
	if span != nil {
		c.dispatchSpanID = span.SpanID()
	}
	return c
}

// runParentSpanID is the span the child run reports as its parent.
func (c childRunTrace) runParentSpanID() string {
	if c.dispatchSpanID != "" {
		return c.dispatchSpanID
	}
	return c.parentSpanID
}

// context stamps the child run's trace position on its parent context, so
// the backend's telemetry (llm.call, tool.execute), ambient log lines, and
// outbound traceparent hops all name the child's run span as their parent.
func (c childRunTrace) context(ctx context.Context) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	return utils.WithSpanID(utils.WithTraceID(ctx, c.traceID), c.runSpanID)
}

// stamp gives a child-emitted event the child run's trace position when the
// backend did not stamp it.
func (c childRunTrace) stamp(ev types.NormalizedEvent) types.NormalizedEvent {
	if c.runSpanID == "" {
		return ev
	}
	return ev.WithTrace(c.traceID, c.runSpanID)
}

// childRunSpanEnd is what the child's run.execute span records at its end.
type childRunSpanEnd struct {
	runID          string
	model          string
	exitCode       int
	depth          int
	conversationID string
	recalled       bool
}

// emitRunSpan records the child's run.execute span. The dispatching
// session's manager never sees a child run exit (children run their
// backends inline, see dispatch_agent.go), so this is the one place the
// child's run span can be written; a suspend/revive loop is one logical run
// and records one span. Nil-safe on a session without telemetry.
func (c childRunTrace) emitRunSpan(sa SessionAccessor, e childRunSpanEnd) {
	telem := sa.Telemetry()
	if telem == nil || c.runSpanID == "" {
		utils.LogWithFields(utils.LevelDebug, "session", "child run span skipped: telemetry disabled or no child trace", map[string]any{"run_id": e.runID})
		return
	}
	payload := map[string]any{
		"span_id":        c.runSpanID,
		"duration_ms":    float64(time.Since(c.startedAt).Microseconds()) / 1000.0,
		"model":          e.model,
		"span_kind":      telemetry.SpanKindServer,
		"exit_code":      e.exitCode,
		"dispatch_depth": e.depth,
		"recalled":       e.recalled,
	}
	if e.exitCode != 0 {
		payload["error"] = "run exited with a non-zero code"
	}
	ctx := map[string]any{
		"session_id":     sa.SessionKey(),
		"run_id":         e.runID,
		"trace_id":       c.traceID,
		"parent_span_id": c.runParentSpanID(),
	}
	if e.conversationID != "" {
		ctx["conversation_id"] = e.conversationID
	} else if conv := sa.ConversationID(); conv != "" {
		ctx["conversation_id"] = conv
	}
	if name := sa.ExtensionName(); name != "" {
		ctx["extension"] = name
		if v := sa.ExtensionVersion(); v != "" {
			ctx["extension_version"] = v
		}
	}
	if identity := sa.Principal().AttributionForTelemetry(); identity != "" {
		ctx["principal_identity"] = identity
	}
	telem.Event(telemetry.RunExecute, payload, ctx)
	utils.LogWithFields(utils.LevelInfo, "session", "child run span emitted", map[string]any{
		"run_id": e.runID, "trace_id": c.traceID, "span_id": c.runSpanID, "parent_span_id": c.runParentSpanID(), "duration_ms": payload["duration_ms"],
	})
}
