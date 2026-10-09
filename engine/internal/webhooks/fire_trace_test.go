package webhooks

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Each webhook delivery runs under its own trace, rooted at the delivery, on
// a copy of the resolved session context.
func TestFireTraceContextMintsPerDelivery(t *testing.T) {
	resolved := &extension.Context{SessionKey: "sess"}
	route := extension.WebhookRoute{Path: "/hook"}
	first := fireTraceContext(resolved, route, "req-1")
	second := fireTraceContext(resolved, route, "req-2")
	if !utils.IsValidTraceID(first.TraceID) || !utils.IsValidSpanID(first.RunSpanID) {
		t.Fatalf("delivery trace/span = %q/%q", first.TraceID, first.RunSpanID)
	}
	if first.TraceID == second.TraceID {
		t.Errorf("two deliveries share trace %q", first.TraceID)
	}
	if first.SessionKey != "sess" || first.RunID != "" {
		t.Errorf("delivery context = %+v", first)
	}
	if resolved.TraceID != "" {
		t.Errorf("resolver context mutated: %+v", resolved)
	}
}
