package backend

import (
	"os"
	"testing"

	"github.com/dsswift/ion/engine/internal/procres"
)

// A tool call that leaves descriptors open must show that growth on its own
// tool.execute span, beside the process's count and limit, so a leak can be
// traced to the tool that caused it.
func TestToolExecuteSpanCarriesDescriptorGrowth(t *testing.T) {
	if procres.ReadDescriptors().Open == procres.Unknown {
		t.Skip("descriptor counting is unavailable on this platform")
	}
	telem := &mockTelemetry{}
	exec := startToolExecuteSpan(telem, &activeRun{requestID: "run-fd"}, "Bash", nil)

	const leaked = 3
	for i := 0; i < leaked; i++ {
		f, err := os.Open(os.DevNull)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close() //nolint:errcheck // test cleanup
	}
	endToolExecuteSpan(exec, telem, nil, nil)

	spans := telem.eventsByName("tool.execute")
	if len(spans) != 1 {
		t.Fatalf("tool.execute spans = %d, want 1", len(spans))
	}
	payload := spans[0].Payload
	if payload["fd_delta"] != leaked {
		t.Errorf("fd_delta = %v, want %d", payload["fd_delta"], leaked)
	}
	open, ok := payload["fd_open"].(int)
	if !ok || open < leaked {
		t.Errorf("fd_open = %v, want a count of at least %d", payload["fd_open"], leaked)
	}
	if limit, ok := payload["fd_limit"].(int64); !ok || limit < int64(open) {
		t.Errorf("fd_limit = %v, want a limit at or above fd_open (%d)", payload["fd_limit"], open)
	}
}

// With telemetry disabled the helpers still run without a span.
func TestToolExecuteSpanWithoutTelemetry(t *testing.T) {
	exec := startToolExecuteSpan(nil, nil, "Read", nil)
	endToolExecuteSpan(exec, nil, nil, nil)
}
