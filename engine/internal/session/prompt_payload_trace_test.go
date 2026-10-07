package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/utils"
)

// A prompt sent from a fire handler carries the fire's traceparent onto the
// run's overrides, and newRunTrace then joins that trace under the fire's
// root span. A prompt without one leaves nil overrides alone.
func TestWithPayloadTraceparentJoinsFireTrace(t *testing.T) {
	fire := (&extension.Context{SessionKey: "k"}).WithTraceRoot("schedule", "job")
	payload := extension.SendPromptPayload{Text: "go", Traceparent: extension.FireTraceparent(fire)}
	overrides := withPayloadTraceparent(nil, payload, "k", "test")
	if overrides == nil || overrides.Traceparent != payload.Traceparent {
		t.Fatalf("overrides = %+v", overrides)
	}
	traceID, span := newRunTrace("k", "run", overrides)
	if traceID != fire.TraceID || span.parentSpanID != fire.RunSpanID {
		t.Errorf("run trace/parent = %q/%q, want the fire's %q/%q", traceID, span.parentSpanID, fire.TraceID, fire.RunSpanID)
	}
	if got := withPayloadTraceparent(nil, extension.SendPromptPayload{Text: "go"}, "k", "test"); got != nil {
		t.Errorf("prompt without trace context grew overrides %+v", got)
	}
	if !utils.IsValidTraceID(traceID) {
		t.Errorf("trace id %q invalid", traceID)
	}
}
