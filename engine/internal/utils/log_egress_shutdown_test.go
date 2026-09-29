package utils

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// otlpBodySink records every OTLP logs request body it receives.
type otlpBodySink struct {
	mu     sync.Mutex
	bodies []string
}

func (s *otlpBodySink) all() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return strings.Join(s.bodies, "\n")
}

// Records buffered just before shutdown — an engine log line and a line
// appended to a tailed source the tailer has not polled yet — must reach the
// OTLP sink through ShutdownLogEgress, with no periodic flush in between.
func TestShutdownLogEgressDrainsBufferedRecords(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("ION_DATA_DIR", dir)

	sink := &otlpBodySink{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read body: %v", err)
		}
		sink.mu.Lock()
		sink.bodies = append(sink.bodies, string(body))
		sink.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	desktopLog := filepath.Join(dir, "desktop.jsonl")
	if err := os.WriteFile(desktopLog, []byte(`{"ts":"2026-09-23T00:00:00Z","level":"INFO","msg":"history line"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	ConfigureLogging(&types.LoggingConfig{
		LogDir:                dir,
		OutputMode:            "file",
		EgressTargets:         []string{"otel"},
		EgressOtel:            &types.OtelConfig{Enabled: true, Endpoint: srv.URL},
		EgressFlushIntervalMs: int64(time.Hour / time.Millisecond),
		EgressShipSources:     []string{"engine", "desktop"},
	})
	t.Cleanup(func() { ShutdownLogEgress(5 * time.Second) })
	fwd := ActiveEgressForwarder()
	if fwd == nil {
		t.Fatal("expected an active egress forwarder")
	}
	if tailer := StartEgressTailer([]string{"desktop"}, fwd); tailer == nil {
		t.Fatal("expected a tailer for the desktop source")
	}
	// The tailer opens a first-seen file at EOF on its first poll and persists
	// that cursor. Wait for it, so the line appended below is new to the
	// tailer and can only ship through the shutdown-time poll.
	cursorFile := filepath.Join(dir, ".engine-egress-tailer-cursors.json")
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(cursorFile); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("tailer never completed its first poll")
		}
		time.Sleep(50 * time.Millisecond)
	}

	f, err := os.OpenFile(desktopLog, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(`{"ts":"2026-09-23T00:00:01Z","level":"INFO","msg":"tailed-final-line"}` + "\n"); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	LogWithFields(LevelInfo, "test", "engine-final-line", nil)

	if got := sink.all(); got != "" {
		t.Fatalf("nothing should ship before shutdown, got %q", got)
	}
	if !ShutdownLogEgress(10 * time.Second) {
		t.Fatal("shutdown drain did not finish within its budget")
	}

	got := sink.all()
	for _, want := range []string{"engine-final-line", "tailed-final-line", "log egress shutdown drain starting"} {
		if !strings.Contains(got, want) {
			t.Errorf("sink is missing %q", want)
		}
	}
	if strings.Contains(got, "history line") {
		t.Error("tailer must not backfill history present before it started")
	}
	if ActiveEgressForwarder() != nil {
		t.Error("forwarder should be detached after shutdown")
	}
}

func TestShutdownLogEgressNothingConfigured(t *testing.T) {
	ShutdownLogEgress(time.Second) // clear anything a prior test left
	if !ShutdownLogEgress(time.Second) {
		t.Fatal("an unconfigured egress has nothing to drain and must report success")
	}
}
