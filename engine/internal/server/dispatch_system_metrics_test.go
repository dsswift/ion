package server

import (
	"bufio"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/sysmetrics"
	"github.com/dsswift/ion/engine/internal/types"
)

func newSystemMetricsServer(t *testing.T) (*Server, *sysmetrics.Sampler) {
	t.Helper()
	srv := newShortPathTestServer(t, newMockBackend())
	sampler := sysmetrics.New(sysmetrics.Options{
		Config: &types.SystemMetricsConfig{BackgroundIntervalMs: 60_000, MinIntervalMs: 50},
	})
	srv.SetSystemMetrics(sampler)
	sampler.Start()
	t.Cleanup(sampler.Stop)
	return srv, sampler
}

func resultFor(t *testing.T, lines []string, requestID string) map[string]any {
	t.Helper()
	for _, l := range lines {
		if !strings.Contains(l, `"requestId":"`+requestID+`"`) {
			continue
		}
		var r struct {
			OK    bool           `json:"ok"`
			Error string         `json:"error"`
			Data  map[string]any `json:"data"`
		}
		if err := json.Unmarshal([]byte(l), &r); err != nil {
			t.Fatalf("unmarshal result: %v", err)
		}
		if !r.OK {
			t.Fatalf("command %s failed: %s", requestID, r.Error)
		}
		return r.Data
	}
	t.Fatalf("no result for %s in %v", requestID, lines)
	return nil
}

func untilRequest(id string) func(string) bool {
	return func(l string) bool { return strings.Contains(l, `"requestId":"`+id+`"`) }
}

func TestGetSystemMetricsReturnsCompleteSample(t *testing.T) {
	srv, _ := newSystemMetricsServer(t)
	conn := dialServer(t, srv)
	defer conn.Close()

	sendJSON(t, conn, map[string]any{"cmd": "get_system_metrics", "requestId": "g1"})
	data := resultFor(t, readLinesUntil(t, conn, 5*time.Second, untilRequest("g1")), "g1")
	for _, key := range []string{"sampledAt", "host", "processes", "runtime"} {
		if _, ok := data[key]; !ok {
			t.Fatalf("sample missing %q: %v", key, data)
		}
	}
}

func TestHealthCarriesSystemMetricsAndTelemetryHealth(t *testing.T) {
	srv, sampler := newSystemMetricsServer(t)
	sampler.SampleNow()
	conn := dialServer(t, srv)
	defer conn.Close()

	sendJSON(t, conn, map[string]any{"cmd": "health", "requestId": "h1"})
	data := resultFor(t, readLinesUntil(t, conn, 5*time.Second, untilRequest("h1")), "h1")
	if _, ok := data["systemMetrics"].(map[string]any); !ok {
		t.Fatalf("health missing systemMetrics: %v", data)
	}
	if _, ok := data["telemetryHealth"]; !ok {
		t.Fatalf("health missing telemetryHealth: %v", data)
	}
	formats, ok := data["compat"].([]any)
	if !ok || len(formats) == 0 {
		t.Fatalf("health missing the compat registry: %v", data["compat"])
	}
	first, _ := formats[0].(map[string]any) //nolint:errcheck // asserted below
	for _, key := range []string{"id", "owner", "version", "rule", "meaning"} {
		if _, ok := first[key]; !ok {
			t.Fatalf("compat entry missing %q: %v", key, first)
		}
	}
}

// TestSystemMetricsWatchDeliversOnlyToWatcher pins the delivery rule: a
// watching connection receives engine_system_metrics; a connection that did
// not ask receives none; and a disconnect ends the watch.
func TestSystemMetricsWatchDeliversOnlyToWatcher(t *testing.T) {
	srv, sampler := newSystemMetricsServer(t)
	watcher := dialServer(t, srv)
	defer watcher.Close()
	bystander := dialServer(t, srv)
	defer bystander.Close()

	sendJSON(t, watcher, map[string]any{"cmd": "system_metrics_watch", "requestId": "w1", "intervalMs": 50})
	lines := readLinesUntil(t, watcher, 5*time.Second, func(l string) bool {
		return strings.Contains(l, `"type":"engine_system_metrics"`)
	})
	if got := resultFor(t, lines, "w1")["intervalMs"]; got != float64(50) {
		t.Fatalf("effective interval = %v, want 50", got)
	}
	if !strings.Contains(lines[len(lines)-1], `"systemMetrics":{`) {
		t.Fatalf("watcher never received a sample: %v", lines)
	}

	bystander.SetReadDeadline(time.Now().Add(300 * time.Millisecond)) //nolint:errcheck // test read bound
	sc := bufio.NewScanner(bystander)
	for sc.Scan() {
		if strings.Contains(sc.Text(), "engine_system_metrics") {
			t.Fatal("a connection that did not watch received a sample")
		}
	}

	watcher.Close()
	deadline := time.Now().Add(5 * time.Second)
	for sampler.Watchers() != 0 {
		if time.Now().After(deadline) {
			t.Fatal("disconnect did not end the watch")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestSystemMetricsWatchStopWithZero(t *testing.T) {
	srv, sampler := newSystemMetricsServer(t)
	conn := dialServer(t, srv)
	defer conn.Close()

	sendJSON(t, conn, map[string]any{"cmd": "system_metrics_watch", "requestId": "a", "intervalMs": 1000})
	resultFor(t, readLinesUntil(t, conn, 5*time.Second, untilRequest("a")), "a")
	if sampler.Watchers() != 1 {
		t.Fatalf("watchers = %d, want 1", sampler.Watchers())
	}
	sendJSON(t, conn, map[string]any{"cmd": "system_metrics_watch", "requestId": "b", "intervalMs": 0})
	if got := resultFor(t, readLinesUntil(t, conn, 5*time.Second, untilRequest("b")), "b")["intervalMs"]; got != float64(0) {
		t.Fatalf("stop returned interval %v, want 0", got)
	}
	if sampler.Watchers() != 0 {
		t.Fatalf("watchers = %d after stop, want 0", sampler.Watchers())
	}
}

func TestSystemMetricsCommandsRefusedWhenDisabled(t *testing.T) {
	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	defer conn.Close()
	sendJSON(t, conn, map[string]any{"cmd": "get_system_metrics", "requestId": "x"})
	lines := readLinesUntil(t, conn, 5*time.Second, untilRequest("x"))
	if !strings.Contains(strings.Join(lines, "\n"), "system metrics are disabled") {
		t.Fatalf("expected a disabled refusal, got %v", lines)
	}
}
