package providers

import (
	"context"
	"net/http"

	"github.com/dsswift/ion/engine/internal/utils"
)

// applyTraceparent sends the request's trace position to the provider as a
// W3C `traceparent` header. ctx is the streaming context the run loop built
// for one provider call: it carries the run's trace-id and the llm.call span
// the call runs under (backend.withLlmCallSpan), so a provider that records
// its own spans parents them under the engine's llm.call. Sends nothing when
// ctx carries no trace; both branches are logged.
func applyTraceparent(ctx context.Context, req *http.Request, providerID string) {
	traceparent := utils.TraceparentFromContext(ctx)
	if traceparent == "" {
		utils.LogWithFields(utils.LevelDebug, "providers", "request carries no trace; traceparent omitted", map[string]any{"provider": providerID, "path": req.URL.Host})
		return
	}
	req.Header.Set("traceparent", traceparent)
	utils.LogWithFields(utils.LevelDebug, "providers", "traceparent set on provider request", map[string]any{"provider": providerID, "path": req.URL.Host, "traceparent": traceparent})
}
