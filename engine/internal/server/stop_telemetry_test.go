package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// Stop must close both server-owned telemetry collectors so events buffered
// since the last periodic flush reach their targets before the process exits.
func TestStopFlushesServerTelemetryCollectors(t *testing.T) {
	dir := t.TempDir()
	newFileCollector := func(name string) (*telemetry.Collector, string) {
		path := filepath.Join(dir, name)
		return telemetry.NewCollector(types.TelemetryConfig{
			Enabled:         true,
			Targets:         []string{"file"},
			FilePath:        path,
			FlushIntervalMs: 3_600_000, // only the shutdown drain can flush
		}), path
	}
	serverCollector, serverPath := newFileCollector("server.jsonl")
	convCollector, convPath := newFileCollector("conversation.jsonl")

	srv := NewServer(filepath.Join(dir, "engine.sock"), &mockBackend{})
	srv.SetTelemetry(serverCollector)
	srv.SetConversationEventsTelemetry(convCollector)

	serverCollector.Event("client.backpressure", map[string]any{"marker": "server-final"}, nil)
	convCollector.Event("conversation.turn", map[string]any{"marker": "conversation-final"}, nil)

	if err := srv.Stop(); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	for path, want := range map[string]string{serverPath: "server-final", convPath: "conversation-final"} {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", filepath.Base(path), err)
		}
		if !strings.Contains(string(data), want) {
			t.Errorf("%s is missing %q after Stop: %q", filepath.Base(path), want, data)
		}
	}
}
