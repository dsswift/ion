package backend

import "github.com/dsswift/ion/engine/internal/types"

// runloop_tool_telemetry.go holds the tool.execute span helpers, extracted
// from runloop_tools.go to keep that file under the file-size cap. Span
// start/end attrs are gated by the configured privacy level
// (docs/enterprise/telemetry.md): "minimal" (default) carries only the tool
// name and duration/error; "standard" also attaches the tool's input
// parameters; "full" additionally attaches a truncated tool output preview.
// The level is checked before building the gated attrs map, not merely
// before attaching it, so no input/output copy is constructed at a lower
// level only to be discarded.

// startToolExecuteSpan opens the tool.execute span for one tool-use block,
// or returns nil when telemetry is disabled for this run.
func startToolExecuteSpan(telem TelemetryCollector, run *activeRun, toolName string, input map[string]any) Span {
	if telem == nil {
		return nil
	}
	spanAttrs := map[string]interface{}{
		"tool": toolName,
	}
	if telem.PrivacyLevel() != "minimal" {
		spanAttrs["input"] = input
	}
	return telem.StartSpanCtx("tool.execute", spanAttrs, buildTelemCtx(run))
}

// endToolExecuteSpan closes a tool.execute span with the run's error (if
// any) and, at "full" privacy level only, a truncated preview of the tool's
// output content. Nil-safe on span.
func endToolExecuteSpan(span Span, telem TelemetryCollector, toolResult *types.ToolResult, callErr error) {
	if span == nil {
		return
	}
	errStr := ""
	if callErr != nil {
		errStr = callErr.Error()
	}
	var endAttrs map[string]interface{}
	if telem != nil && telem.PrivacyLevel() == "full" && toolResult != nil {
		endAttrs = map[string]interface{}{
			"output": truncatePreview(toolResult.Content, telemPreviewLimit),
		}
	}
	span.End(endAttrs, errStr)
}
