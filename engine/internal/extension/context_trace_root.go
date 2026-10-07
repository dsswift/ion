package extension

import "github.com/dsswift/ion/engine/internal/utils"

// WithTraceRoot returns a copy of c carrying a freshly minted trace whose
// root span is the delivery that calls it: a schedule or webhook fire. The
// copy's TraceID and RunSpanID are the fire's trace-id and root span-id, so
// the handler's envelope (AsyncFirePayload.TraceID/SpanID), every hook the
// engine records around its calls (extension.hook_latency), and the prompts
// it sends (FireTraceparent) all land in one trace. RunID stays as it was:
// the fire is not a run. source and id name the fire in the log line.
func (c *Context) WithTraceRoot(source, id string) *Context {
	root := Context{}
	if c != nil {
		root = *c
	}
	root.TraceID = utils.NewTraceID()
	root.RunSpanID = utils.NewSpanID()
	utils.LogWithFields(utils.LevelInfo, "extension", "fire trace started", map[string]any{
		"source": source, "id": id, "trace_id": root.TraceID, "span_id": root.RunSpanID, "session_id": root.SessionKey,
	})
	return &root
}

// FireTraceparent is the traceparent a prompt sent from a schedule or webhook
// handler joins: the fire's trace, parented to the fire's root span. Empty
// unless ctx is a fire context (a trace without a run); a prompt sent while a
// run is in flight starts its own trace, as every other prompt does.
func FireTraceparent(ctx *Context) string {
	if ctx == nil || ctx.RunID != "" || ctx.TraceID == "" || ctx.RunSpanID == "" {
		return ""
	}
	return utils.FormatTraceparent(ctx.TraceID, ctx.RunSpanID)
}
