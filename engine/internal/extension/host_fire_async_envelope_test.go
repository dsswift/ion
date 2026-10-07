package extension

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/asyncreg"
)

// The fire envelope carries the fire's trace root so the handler's context
// has traceId/spanId, and omits both when the delivery has no trace.
func TestBuildAsyncFireEnvelopeCarriesTraceRoot(t *testing.T) {
	h := NewHost()
	fire := (&Context{SessionKey: "sess"}).WithTraceRoot("schedule", "job")
	env := h.buildAsyncFireEnvelope(asyncreg.KindSchedule, "job", fire, map[string]any{"firedAt": "now"})
	if env.TraceID != fire.TraceID || env.SpanID != fire.RunSpanID {
		t.Errorf("envelope trace/span = %q/%q, want %q/%q", env.TraceID, env.SpanID, fire.TraceID, fire.RunSpanID)
	}
	if env.Kind != "schedule" || env.ID != "job" {
		t.Errorf("envelope kind/id = %q/%q", env.Kind, env.ID)
	}
	bare := h.buildAsyncFireEnvelope(asyncreg.KindWebhook, "/hook", &Context{}, nil)
	if bare.TraceID != "" || bare.SpanID != "" {
		t.Errorf("untraced delivery sent %q/%q", bare.TraceID, bare.SpanID)
	}
}
