package utils

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// resetStartupHold returns the startup hold to a fresh process's state.
func resetStartupHold(t *testing.T) {
	t.Helper()
	logMu.Lock()
	heldStartupRecords, startupHoldDone, heldStartupDropped = nil, false, 0
	logMu.Unlock()
}

// Lines logged before engine.json configures egress ship with the first
// forwarder, so the shipped log starts where the file does.
func TestStartupLinesShipWithFirstForwarder(t *testing.T) {
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

	LogWithFields(LevelInfo, "test", "before-configure-line", nil)
	ConfigureLogging(&types.LoggingConfig{
		LogDir:                dir,
		OutputMode:            "file",
		EgressTargets:         []string{"otel"},
		EgressOtel:            &types.OtelConfig{Enabled: true, Endpoint: srv.URL},
		EgressFlushIntervalMs: int64(time.Hour / time.Millisecond),
		EgressShipSources:     []string{"engine"},
	})
	LogWithFields(LevelInfo, "test", "after-configure-line", nil)
	if !ShutdownLogEgress(10 * time.Second) {
		t.Fatal("shutdown drain timed out")
	}
	got := sink.all()
	if !strings.Contains(got, "before-configure-line") || !strings.Contains(got, "after-configure-line") {
		t.Fatalf("shipped = %q", got)
	}
	if i, j := strings.Index(got, "before-configure-line"), strings.Index(got, "after-configure-line"); i > j {
		t.Errorf("startup line shipped after a later line")
	}
}

// Holding ends at the first configuration, and the hold is capped.
func TestStartupHoldStopsAndIsBounded(t *testing.T) {
	resetStartupHold(t)
	t.Cleanup(func() { resetStartupHold(t) })
	logMu.Lock()
	for i := 0; i < maxHeldStartupRecords+5; i++ {
		holdStartupRecordLocked(egressRecord{Msg: "x"})
	}
	held, dropped := takeHeldStartupRecordsLocked()
	holdStartupRecordLocked(egressRecord{Msg: "after"})
	after := len(heldStartupRecords)
	logMu.Unlock()
	if len(held) != maxHeldStartupRecords || dropped != 5 {
		t.Errorf("held = %d, dropped = %d", len(held), dropped)
	}
	if after != 0 {
		t.Errorf("records held after configuration: %d", after)
	}
}
