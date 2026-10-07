package server

import (
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

func telemetryRuntimeConfig() *types.EngineRuntimeConfig {
	return &types.EngineRuntimeConfig{Telemetry: &types.TelemetryConfig{Enabled: true, Targets: []string{}}}
}

// shortSocketPath returns a Unix socket path that fits the platform limit.
func shortSocketPath(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp(shortTempRoot(), "ionsp-")
	if err != nil {
		t.Fatalf("mkdir socket dir: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) }) //nolint:errcheck // best-effort test teardown
	return filepath.Join(dir, "s.sock")
}

// waitForSpans polls the collector until match returns at least want events
// or the deadline passes, for spans recorded on a background goroutine.
func waitForSpans(t *testing.T, c *telemetry.Collector, want int, match func(telemetry.Event) bool) []telemetry.Event {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var got []telemetry.Event
		for _, e := range c.BufferedEvents() {
			if match(e) {
				got = append(got, e)
			}
		}
		if len(got) >= want || time.Now().After(deadline) {
			return got
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func named(name string) func(telemetry.Event) bool {
	return func(e telemetry.Event) bool { return e.Name == name }
}

func spanID(t *testing.T, e telemetry.Event) string {
	t.Helper()
	id, _ := e.Payload["span_id"].(string) //nolint:errcheck // validated below
	if !utils.IsValidSpanID(id) {
		t.Fatalf("%s span_id = %v", e.Name, e.Payload["span_id"])
	}
	if d, ok := e.Payload["duration_ms"].(float64); !ok || d < 0 {
		t.Fatalf("%s duration_ms = %v", e.Name, e.Payload["duration_ms"])
	}
	return id
}

// daemon.startup is a root running from process start to the socket
// accepting; config.load and the boot provider.probe are its children, and a
// probe begun after start-up is not.
func TestDaemonStartupTrace(t *testing.T) {
	srv := NewServer(shortSocketPath(t), newMockBackend())
	processStart := time.Now().Add(-300 * time.Millisecond)
	configStart := processStart.Add(10 * time.Millisecond)
	configEnd := configStart.Add(40 * time.Millisecond)
	srv.SetStartupTiming(processStart, configStart, configEnd, "/x/engine.json")
	srv.SetConfig(telemetryRuntimeConfig())
	if err := srv.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { srv.Stop() })
	c := srv.Telemetry()

	startups := waitForSpans(t, c, 1, named(telemetry.DaemonStartup))
	if len(startups) != 1 {
		t.Fatalf("daemon.startup events = %d, want 1", len(startups))
	}
	root := startups[0]
	rootID := spanID(t, root)
	if root.ParentSpanID != "" || !utils.IsValidTraceID(root.TraceID) {
		t.Fatalf("daemon.startup trace/parent = %s/%s, want a root", root.TraceID, root.ParentSpanID)
	}
	if d := root.Payload["duration_ms"].(float64); d < 300 {
		t.Fatalf("daemon.startup duration_ms = %v, want it to run from process start", d)
	}

	loads := waitForSpans(t, c, 1, named(telemetry.ConfigLoad))
	if len(loads) != 1 {
		t.Fatalf("config.load events = %d, want 1", len(loads))
	}
	spanID(t, loads[0])
	if loads[0].ParentSpanID != rootID || loads[0].TraceID != root.TraceID || loads[0].Payload["duration_ms"] != 40.0 {
		t.Fatalf("config.load = trace %s parent %s duration %v", loads[0].TraceID, loads[0].ParentSpanID, loads[0].Payload["duration_ms"])
	}

	cliProbe := func(e telemetry.Event) bool { return e.Name == telemetry.ProviderProbe && e.Payload["probe"] == "cli" }
	probes := waitForSpans(t, c, 1, cliProbe)
	if len(probes) != 1 {
		t.Fatalf("boot provider.probe events = %d, want 1", len(probes))
	}
	spanID(t, probes[0])
	if probes[0].ParentSpanID != rootID || probes[0].TraceID != root.TraceID {
		t.Fatalf("boot provider.probe trace/parent = %s/%s", probes[0].TraceID, probes[0].ParentSpanID)
	}

	srv.RefreshProviderProbes()
	later := waitForSpans(t, c, 2, cliProbe)
	if len(later) != 2 {
		t.Fatalf("provider.probe events = %d, want 2", len(later))
	}
	if later[1].TraceID == root.TraceID || later[1].ParentSpanID != "" {
		t.Fatalf("a probe after start-up joined the start-up trace: %s/%s", later[1].TraceID, later[1].ParentSpanID)
	}
}

// command.dispatch joins the client's traceparent and is the parent of the
// work the command starts (here refresh_models' provider.probe).
func TestCommandDispatchSpanParentsCommandWork(t *testing.T) {
	srv := NewServer(shortSocketPath(t), newMockBackend())
	srv.SetConfig(telemetryRuntimeConfig())
	c := srv.Telemetry()

	server, client := net.Pipe()
	t.Cleanup(func() { server.Close(); client.Close() }) //nolint:errcheck // test teardown
	go io.Copy(io.Discard, client)                       //nolint:errcheck // drains replies until the pipe closes

	const traceID, clientSpan = "4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7"
	srv.dispatch(server, &protocol.ClientCommand{
		Cmd: "refresh_models", Provider: "no-such-provider", RequestID: "r1",
		Traceparent: utils.FormatTraceparent(traceID, clientSpan),
	})

	dispatches := waitForSpans(t, c, 1, named(telemetry.CommandDispatch))
	if len(dispatches) != 1 {
		t.Fatalf("command.dispatch events = %d, want 1", len(dispatches))
	}
	d := dispatches[0]
	dispatchID := spanID(t, d)
	if d.TraceID != traceID || d.ParentSpanID != clientSpan || d.Payload["command"] != "refresh_models" {
		t.Fatalf("command.dispatch = trace %s parent %s command %v", d.TraceID, d.ParentSpanID, d.Payload["command"])
	}

	modelProbe := func(e telemetry.Event) bool {
		return e.Name == telemetry.ProviderProbe && e.Payload["probe"] == "models"
	}
	probes := waitForSpans(t, c, 1, modelProbe)
	if len(probes) != 1 {
		t.Fatalf("models provider.probe events = %d, want 1", len(probes))
	}
	spanID(t, probes[0])
	if probes[0].TraceID != traceID || probes[0].ParentSpanID != dispatchID {
		t.Fatalf("provider.probe trace/parent = %s/%s, want %s/%s", probes[0].TraceID, probes[0].ParentSpanID, traceID, dispatchID)
	}
}

// A command with no traceparent starts a trace of its own.
func TestCommandDispatchSpanWithoutTraceparentIsRoot(t *testing.T) {
	srv := NewServer(shortSocketPath(t), newMockBackend())
	srv.SetConfig(telemetryRuntimeConfig())
	cmd := &protocol.ClientCommand{Cmd: "health"}
	srv.beginCommandSpan(cmd)()
	dispatches := waitForSpans(t, srv.Telemetry(), 1, named(telemetry.CommandDispatch))
	if len(dispatches) != 1 {
		t.Fatalf("command.dispatch events = %d, want 1", len(dispatches))
	}
	if dispatches[0].ParentSpanID != "" || !utils.IsValidTraceID(dispatches[0].TraceID) {
		t.Fatalf("root command.dispatch trace/parent = %s/%s", dispatches[0].TraceID, dispatches[0].ParentSpanID)
	}
	if _, span, ok := utils.ParseTraceparent(cmd.Traceparent); !ok || span != spanID(t, dispatches[0]) {
		t.Fatalf("cmd.Traceparent = %q, want it to name the dispatch span", cmd.Traceparent)
	}
}
