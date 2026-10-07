package extension

import (
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/utils"
)

// HookSpan is one span in progress, as the group needs it: its id (so each
// host's hook call can parent under it) and End.
type HookSpan interface {
	SpanID() string
	End(attrs map[string]any, errMsg ...string)
}

// HookSpanStarter begins a span on the session's telemetry collector. The
// session manager wires one with SetSpanStarter when the session has a
// collector; it stays nil otherwise and the group records nothing.
type HookSpanStarter func(name string, attrs, ctx map[string]any) HookSpan

// SetSpanStarter installs the function the group's fan-outs record their
// hook.fanout spans through. Nil turns the spans off.
func (g *ExtensionGroup) SetSpanStarter(fn HookSpanStarter) {
	g.spanStarter = fn
}

// beginFanout opens the hook.fanout span for one hook point fired across
// every host of the group and returns the context each host is handed (a
// copy carrying the span's id as HookFanoutSpanID, so each host's
// extension.hook_latency is its child) and the function that ends the span
// once every host has answered or timed out. With no starter, no hosts, or
// a nil context the fan-out is recorded as nothing and ctx is returned as is.
//
// The span joins the run's trace (ctx.TraceID / ctx.RunSpanID) when one is
// in flight: it is then the child of run.execute, or of a schedule or
// webhook fire's root span. Outside a run it records with the session
// correlation only.
func (g *ExtensionGroup) beginFanout(ctx *Context, hook string) (*Context, func()) {
	if g.spanStarter == nil || len(g.hosts) == 0 || ctx == nil {
		return ctx, func() {}
	}
	corr := map[string]any{"session_id": ctx.SessionKey}
	if ctx.ConversationID != "" {
		corr["conversation_id"] = ctx.ConversationID
	}
	if ctx.TraceID != "" && ctx.RunSpanID != "" {
		corr["trace_id"] = ctx.TraceID
		corr["parent_span_id"] = ctx.RunSpanID
	}
	span := g.spanStarter(telemetry.HookFanout, map[string]any{"hook": hook, "hosts": len(g.hosts)}, corr)
	if span == nil {
		return ctx, func() {}
	}
	fanned := *ctx
	fanned.HookFanoutSpanID = span.SpanID()
	utils.LogWithFields(utils.LevelDebug, "extension.group", "hook fanout span started", map[string]any{
		"hook": hook, "hosts": len(g.hosts), "span_id": span.SpanID(), "session_id": ctx.SessionKey, "trace_id": ctx.TraceID,
	})
	return &fanned, func() { span.End(nil) }
}
