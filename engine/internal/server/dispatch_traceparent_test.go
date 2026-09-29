package server

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/protocol"
)

// A command's traceparent reaches the run's prompt overrides, so the run
// joins the caller's trace.
func TestPromptOverridesFromCommandCarriesTraceparent(t *testing.T) {
	const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
	got := promptOverridesFromCommand(&protocol.ClientCommand{Key: "k", Traceparent: tp})
	if got == nil || got.Traceparent != tp {
		t.Fatalf("overrides = %+v", got)
	}
}
