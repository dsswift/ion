package backend

import (
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// startContextAssembleSpan opens the context.assemble span for one turn: the
// build of the model context from the sanitized conversation, the ephemeral
// initial messages, and the tool definitions, through the stream options the
// provider call is made with. A child of run.execute, preceding the turn's
// llm.call. Nil without a collector.
func startContextAssembleSpan(run *activeRun, turn int) Span {
	telem := runTelemetry(run)
	if telem == nil {
		return nil
	}
	return telem.StartSpanCtx(telemetry.ContextAssemble, map[string]interface{}{"turn": turn}, buildTelemCtx(run))
}

// endContextAssembleSpan closes the span with the shape of what was built:
// how many messages (and how many of them ephemeral) and tools the request
// carries, and whether a system prompt is set.
func endContextAssembleSpan(span Span, opts *types.LlmStreamOptions, initialMessages int) {
	if span == nil {
		return
	}
	attrs := map[string]interface{}{"initial_messages": initialMessages}
	if opts != nil {
		attrs["messages"] = len(opts.Messages)
		attrs["tools"] = len(opts.Tools)
		attrs["server_tools"] = len(opts.ServerTools)
		attrs["has_system"] = opts.System != ""
		attrs["model"] = opts.Model
	}
	span.End(attrs)
}
