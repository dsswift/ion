package mcp

import (
	"context"

	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// CallToolSpan is CallTool recorded as an mcp.call span on telem: a client
// span (a call into the server's process) with attributes server and tool,
// the error when the call fails. corr is the caller's correlation context
// (session_id, conversation_id, and the trace with the enclosing span as
// parent_span_id); SpanCorrelation builds it from a Go context. A nil telem
// is plain CallTool.
func (c *Connection) CallToolSpan(ctx context.Context, toolName string, params map[string]interface{}, telem *telemetry.Collector, corr map[string]any) (*types.ToolResult, error) {
	if telem == nil {
		return c.CallTool(ctx, toolName, params)
	}
	span := telem.StartSpanCtx(telemetry.McpCall, map[string]any{
		"server": c.name, "tool": toolName, "span_kind": telemetry.SpanKindClient,
	}, corr)
	result, err := c.CallTool(ctx, toolName, params)
	attrs := map[string]any{}
	errMsg := ""
	if err != nil {
		errMsg = err.Error()
	} else if result != nil {
		attrs["is_error"] = result.IsError
	}
	span.End(attrs, errMsg)
	return result, err
}

// SpanCorrelation builds the correlation context for a span recorded under
// ctx: the session and conversation named, plus ctx's trace and enclosing
// span (utils.WithSpanID) as trace_id / parent_span_id when ctx carries them.
func SpanCorrelation(ctx context.Context, sessionID, conversationID string) map[string]any {
	corr := map[string]any{}
	if sessionID != "" {
		corr["session_id"] = sessionID
	}
	if conversationID != "" {
		corr["conversation_id"] = conversationID
	}
	if traceID := utils.TraceIDFromContext(ctx); traceID != "" {
		corr["trace_id"] = traceID
		if spanID := utils.SpanIDFromContext(ctx); spanID != "" {
			corr["parent_span_id"] = spanID
		}
	}
	return corr
}
