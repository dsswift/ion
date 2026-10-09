package server

import (
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/utils"
)

// beginCommandSpan starts the command.dispatch span for one client command
// and returns the function that ends it when the reply has been sent (the
// handler returns). The span joins the client's traceparent when the command
// carries a valid one (the server's engine.request span is then its parent)
// and starts a new trace otherwise, so every command has a trace.
//
// It rewrites cmd.Traceparent to name this span: everything the command
// starts (a run's run.execute, a session.start, a provider.probe) reads the
// field and nests under the dispatch span instead of beside it. The field is
// the in-memory decoded command, never the wire. With telemetry disabled
// nothing is recorded and the field is left as the client sent it.
func (s *Server) beginCommandSpan(cmd *protocol.ClientCommand) func() {
	telem := s.Telemetry()
	if telem == nil || cmd == nil {
		return func() {}
	}
	ctx := map[string]any{}
	if cmd.Key != "" {
		ctx["session_id"] = cmd.Key
	}
	if cmd.Principal != nil {
		if identity := cmd.Principal.AttributionForTelemetry(); identity != "" {
			ctx["principal_identity"] = identity
		}
	}
	traceID, parentSpanID, joined := utils.ParseTraceparent(cmd.Traceparent)
	if joined {
		ctx["parent_span_id"] = parentSpanID
	} else {
		traceID = utils.NewTraceID()
	}
	ctx["trace_id"] = traceID
	span := telem.StartSpanCtx(telemetry.CommandDispatch, map[string]any{
		"command":    cmd.Cmd,
		"request_id": cmd.RequestID,
		// The engine answers another process's request: a server span.
		"span_kind": telemetry.SpanKindServer,
	}, ctx)
	clientTraceparent := cmd.Traceparent
	cmd.Traceparent = utils.FormatTraceparent(traceID, span.SpanID())
	fields := map[string]any{
		"command": cmd.Cmd, "session_id": cmd.Key, "request_id": cmd.RequestID,
		"trace_id": traceID, "span_id": span.SpanID(),
	}
	switch {
	case joined:
		fields["parent_span_id"] = parentSpanID
		utils.LogWithFields(utils.LevelDebug, "server.dispatch", "command span joined the client trace", fields)
	case clientTraceparent != "":
		fields["traceparent"] = clientTraceparent
		utils.LogWithFields(utils.LevelWarn, "server.dispatch", "command span started a new trace: client traceparent is invalid", fields)
	default:
		utils.LogWithFields(utils.LevelDebug, "server.dispatch", "command span started a new trace: client sent no traceparent", fields)
	}
	return func() { span.End(nil) }
}

// commandSpanCtx is the correlation context for a span recorded while
// handling cmd: the command's session and the dispatch span as parent (via
// the traceparent beginCommandSpan rewrote). Nil parent fields when the
// command carries no valid traceparent.
func commandSpanCtx(cmd *protocol.ClientCommand) map[string]any {
	ctx := map[string]any{}
	if cmd == nil {
		return ctx
	}
	if cmd.Key != "" {
		ctx["session_id"] = cmd.Key
	}
	if traceID, spanID, ok := utils.ParseTraceparent(cmd.Traceparent); ok {
		ctx["trace_id"] = traceID
		ctx["parent_span_id"] = spanID
	}
	return ctx
}
