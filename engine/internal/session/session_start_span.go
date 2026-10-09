package session

import (
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// sessionStartTrace is one session.start span in progress: the trace it
// belongs to (the command.dispatch trace when start_session carried one, a
// new trace otherwise) and the span-id its children (conversation.load,
// extension.spawn) parent under while startSession runs.
type sessionStartTrace struct {
	traceID string
	spanID  string
}

// sessionStartTraces holds the in-progress session.start spans by session
// key. A child span started during startSession looks its parent up here;
// the entry is removed when the span ends. Zero value ready.
type sessionStartTraces struct {
	mu     sync.Mutex
	active map[string]sessionStartTrace
}

func (t *sessionStartTraces) begin(key string, trace sessionStartTrace) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.active == nil {
		t.active = map[string]sessionStartTrace{}
	}
	t.active[key] = trace
}

func (t *sessionStartTraces) end(key string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.active, key)
}

func (t *sessionStartTraces) lookup(key string) (sessionStartTrace, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	trace, ok := t.active[key]
	return trace, ok
}

// StartSession creates a new session with the given config and, optionally,
// the principal (manifest C1/C2) this session is attributed to. principal is
// variadic so every one of the engine's existing call sites (production and
// the several hundred across the test suite) compiles unchanged; only the
// first supplied value is used, and no value at all preserves pre-existing
// behavior exactly -- no attribution is stored or stamped.
func (m *Manager) StartSession(key string, config types.EngineConfig, principal ...*types.SessionPrincipal) (*StartSessionResult, error) {
	var p *types.SessionPrincipal
	if len(principal) > 0 {
		p = principal[0]
	}
	return m.StartSessionTraced(key, config, p, "")
}

// StartSessionTraced is StartSession recorded as a session.start span. A
// valid traceparent (the server's command.dispatch span for start_session)
// makes the span its child; otherwise the start is a trace of its own. The
// span is written to the new session's collector, or to the process
// collector when the start was refused before one existed; with neither it
// is not written. Attributes: existed (an idempotent re-assert), the
// conversation bound, and the error when the start failed.
func (m *Manager) StartSessionTraced(key string, config types.EngineConfig, principal *types.SessionPrincipal, traceparent string) (*StartSessionResult, error) {
	start := time.Now()
	trace := sessionStartTrace{spanID: utils.NewSpanID()}
	ctx := map[string]any{"session_id": key}
	if traceID, parentSpanID, ok := utils.ParseTraceparent(traceparent); ok {
		trace.traceID = traceID
		ctx["parent_span_id"] = parentSpanID
		utils.LogWithFields(utils.LevelDebug, "session", "session.start joined the caller trace", map[string]any{"key": key, "trace_id": traceID, "span_id": trace.spanID, "parent_span_id": parentSpanID})
	} else {
		trace.traceID = utils.NewTraceID()
		utils.LogWithFields(utils.LevelDebug, "session", "session.start began a new trace", map[string]any{"key": key, "trace_id": trace.traceID, "span_id": trace.spanID, "traceparent": traceparent})
	}
	ctx["trace_id"] = trace.traceID
	m.startTraces.begin(key, trace)
	result, err := m.startSession(key, config, principal, nil, nil)
	m.startTraces.end(key)

	telem := m.sessionOrProcessTelemetry(key)
	if telem == nil {
		utils.LogWithFields(utils.LevelDebug, "session", "session.start span not recorded: no telemetry collector", map[string]any{"key": key})
		return result, err
	}
	stampContextIdentity(ctx, principal.AttributionForTelemetry())
	attrs := map[string]any{"span_kind": telemetry.SpanKindServer}
	if result != nil {
		attrs["existed"] = result.Existed
		attrs["conversation_id"] = result.ConversationID
	}
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	}
	telem.StartSpanCtxAt(telemetry.SessionStart, attrs, ctx, start).WithSpanID(trace.spanID).End(nil, errMsg)
	utils.LogWithFields(utils.LevelInfo, "session", "session.start span recorded", map[string]any{
		"key": key, "trace_id": trace.traceID, "span_id": trace.spanID, "duration_ms": float64(time.Since(start).Microseconds()) / 1000.0, "error": errMsg,
	})
	return result, err
}

// sessionOrProcessTelemetry is the session's collector when the session
// exists, else the process-level one; nil when neither is enabled.
func (m *Manager) sessionOrProcessTelemetry(key string) *telemetry.Collector {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if s, ok := m.sessions[key]; ok && s.telemetry != nil {
		return s.telemetry
	}
	return m.procTelemetry
}

// sessionSpanCtx is the correlation context for a span the session records
// outside the run loop (conversation.load on rehydrate, extension.spawn,
// mcp.start, hook.fanout). It carries the session and conversation, the
// principal, and the trace in flight: the run's span while a run is active
// (the span is then run.execute's child), else the session.start span while
// the session is starting; neither outside both. Caller must not hold
// Manager.mu.
func (m *Manager) sessionSpanCtx(s *engineSession, key string) map[string]any {
	if s == nil {
		return nil
	}
	ctx := stampPrincipalIdentity(correlationCtx(key, s.conversationID), s)
	if runID, traceID := s.runIdentitySnapshot(); runID != "" && traceID != "" {
		if span := s.runSpanSnapshot(); span.spanID != "" {
			ctx["trace_id"] = traceID
			ctx["parent_span_id"] = span.spanID
			return ctx
		}
	}
	if trace, ok := m.startTraces.lookup(key); ok {
		ctx["trace_id"] = trace.traceID
		ctx["parent_span_id"] = trace.spanID
	}
	return ctx
}

// hookSpanStarter adapts the session's collector to the extension group's
// HookSpanStarter so hook.fanout spans record on it. Nil without a collector.
func hookSpanStarter(telem *telemetry.Collector) extension.HookSpanStarter {
	if telem == nil {
		return nil
	}
	return func(name string, attrs, ctx map[string]any) extension.HookSpan {
		return telem.StartSpanCtx(name, attrs, ctx)
	}
}
