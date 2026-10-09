package webhooks

import (
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/utils"
)

// fireTraceContext gives one webhook delivery its own trace: the resolved
// session context, copied, with a fresh trace-id and the delivery as root
// span (extension.Context.WithTraceRoot). The HTTP request id is logged
// beside the trace so the two can be joined. The resolver's context is never
// mutated.
func fireTraceContext(ctx *extension.Context, route extension.WebhookRoute, requestID string) *extension.Context {
	fire := ctx.WithTraceRoot("webhook", route.Path)
	utils.LogWithFields(utils.LevelDebug, "webhooks", "delivery trace bound to request", map[string]any{"http_request_id": requestID, "path": route.Path, "trace_id": fire.TraceID, "span_id": fire.RunSpanID})
	return fire
}
