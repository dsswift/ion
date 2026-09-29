package utils

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// A process that exits before the tailer's first tick ships what it wrote
// after the tailer started, and skips what was there before. A CI run lasts
// about a second; the old first poll came at shutdown, took the run's own
// output for history, and shipped none of it.
func TestTailerShipsOutputOfARunShorterThanOnePoll(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("ION_DATA_DIR", dir)
	resetStartupHold(t)

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
	if err := os.WriteFile(desktopLog, []byte(`{"ts":"2026-09-23T00:00:00Z","level":"INFO","msg":"history-line"}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	ConfigureLogging(&types.LoggingConfig{
		LogDir:                dir,
		OutputMode:            "file",
		EgressTargets:         []string{"otel"},
		EgressOtel:            &types.OtelConfig{Enabled: true, Endpoint: srv.URL},
		EgressFlushIntervalMs: int64(time.Hour / time.Millisecond),
		EgressShipSources:     []string{"engine", "desktop", "server"},
	})
	if StartEgressTailer([]string{"desktop", "server"}, ActiveEgressForwarder()) == nil {
		t.Fatal("expected a tailer")
	}

	appendLine := func(path, msg string) {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.WriteString(`{"ts":"2026-09-23T00:00:01Z","level":"INFO","msg":"` + msg + `"}` + "\n"); err != nil {
			t.Fatal(err)
		}
		if err := f.Close(); err != nil {
			t.Fatal(err)
		}
	}
	appendLine(desktopLog, "run-line-existing-file")
	appendLine(filepath.Join(dir, "server.jsonl"), "run-line-new-file")

	if !ShutdownLogEgress(10 * time.Second) {
		t.Fatal("shutdown drain timed out")
	}
	got := sink.all()
	for _, want := range []string{"run-line-existing-file", "run-line-new-file"} {
		if !strings.Contains(got, want) {
			t.Errorf("%s did not ship", want)
		}
	}
	if strings.Contains(got, "history-line") {
		t.Error("history present before the tailer started was shipped")
	}
}
