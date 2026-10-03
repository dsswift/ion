package backend

import (
	"github.com/dsswift/ion/engine/internal/procres"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// runloop_tool_telemetry.go holds the tool.execute span helpers, extracted
// from runloop_tools.go to keep that file under the file-size cap. Span
// start/end attrs are gated by the configured privacy level
// (docs/enterprise/telemetry.md): "minimal" (default) carries only the tool
// name and duration/error; "standard" also attaches the tool's input
// parameters; "full" additionally attaches a truncated tool output preview.
// The level is checked before building the gated attrs map, not merely
// before attaching it, so no input/output copy is constructed at a lower
// level only to be discarded.
//
// Every level also carries the engine process's descriptor reading at the end
// of the call (fd_open, fd_limit) and its change across the call (fd_delta).
// They are counts, never content. The table is process-wide, so a delta
// includes whatever concurrent work opened or closed during the call.

// toolExecution tracks one tool-use block from start to end: its tool.execute
// span (nil when telemetry is disabled) and the descriptor reading taken
// before the tool ran.
type toolExecution struct {
	span        Span
	toolName    string
	requestID   string
	descriptors procres.Descriptors
}

// startToolExecuteSpan opens the tool.execute span for one tool-use block and
// records the descriptor reading the call starts from.
func startToolExecuteSpan(telem TelemetryCollector, run *activeRun, toolName string, input map[string]any) *toolExecution {
	exec := &toolExecution{toolName: toolName, descriptors: procres.ReadDescriptors()}
	if run != nil {
		exec.requestID = run.requestID
	}
	if telem == nil {
		return exec
	}
	spanAttrs := map[string]interface{}{
		"tool": toolName,
	}
	if telem.PrivacyLevel() != "minimal" {
		spanAttrs["input"] = input
	}
	exec.span = telem.StartSpanCtx("tool.execute", spanAttrs, buildTelemCtx(run))
	return exec
}

// endToolExecuteSpan closes a tool.execute span with the run's error (if
// any), the descriptor reading and its change across the call, and, at "full"
// privacy level only, a truncated preview of the tool's output content. A
// call that changed the descriptor count is also logged, so growth can be
// traced to a tool with telemetry disabled.
func endToolExecuteSpan(exec *toolExecution, telem TelemetryCollector, toolResult *types.ToolResult, callErr error) {
	if exec == nil {
		return
	}
	endAttrs := map[string]interface{}{}
	after := procres.ReadDescriptors()
	after.Fields(endAttrs)
	if delta, ok := after.Delta(exec.descriptors); ok {
		endAttrs["fd_delta"] = delta
		if delta != 0 {
			fields := map[string]any{"tool": exec.toolName, "run_id": exec.requestID, "fd_delta": delta}
			after.Fields(fields)
			utils.LogWithFields(utils.LevelDebug, "backend", "tool call changed descriptor count", fields)
		}
	}
	if exec.span == nil {
		return
	}
	errStr := ""
	if callErr != nil {
		errStr = callErr.Error()
	}
	if telem != nil && telem.PrivacyLevel() == "full" && toolResult != nil {
		endAttrs["output"] = truncatePreview(toolResult.Content, telemPreviewLimit)
	}
	exec.span.End(endAttrs, errStr)
}
