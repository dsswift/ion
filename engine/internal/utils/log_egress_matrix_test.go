package utils

// log_egress_matrix_test.go — behavior pins for authenticated egress and
// the shipping-responsibility matrix.
//
// Test matrix:
//  1. EngineShipSources resolution: explicit list wins; nil preserves the
//     legacy boolean semantics (own records unless delegated).
//  2. Flush-time auth headers: the provider's freshly-minted Authorization
//     reaches the sink and wins over a stale static value.
//  3. shipOwn gating: a forwarder whose matrix excludes "engine" drops own
//     records but ships tailed ones.
//  4. Tailer: first-seen files start at EOF; appended canonical lines ship
//     as parsed records; the cursor survives polls; truncation resets.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestEngineShipSources_Resolution(t *testing.T) {
	cases := []struct {
		name string
		cfg  types.LoggingConfig
		want []string
	}{
		{"legacy default ships own", types.LoggingConfig{}, []string{"engine"}},
		{"legacy delegated ships nothing", types.LoggingConfig{EgressManagedByClient: true}, nil},
		{"explicit list wins over boolean", types.LoggingConfig{
			EgressManagedByClient: true,
			EgressShipSources:     []string{"engine", "desktop"},
		}, []string{"engine", "desktop"}},
		{"explicit empty list ships nothing", types.LoggingConfig{
			EgressShipSources: []string{},
		}, []string{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := EngineShipSources(tc.cfg)
			if len(got) != len(tc.want) {
				t.Fatalf("EngineShipSources = %v, want %v", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("EngineShipSources = %v, want %v", got, tc.want)
				}
			}
		})
	}
}

func TestEgressFlush_AuthProviderHeaderWinsOverStatic(t *testing.T) {
	var gotAuth, gotStatic atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth.Store(r.Header.Get("Authorization"))
		gotStatic.Store(r.Header.Get("X-Static"))
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	dir := t.TempDir()
	f := newTestForwarder(t, srv, dir)
	f.cfg.EgressHeaders = map[string]string{
		"Authorization": "Bearer stale-static",
		"X-Static":      "s",
	}

	var counter atomic.Int64
	SetEgressAuthHeaderProvider(func() map[string]string {
		return map[string]string{"Authorization": fmt.Sprintf("Bearer minted-%d", counter.Add(1))}
	})
	t.Cleanup(func() { SetEgressAuthHeaderProvider(nil) })

	f.ship(rec("authed-1"))
	if err := f.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if gotAuth.Load() != "Bearer minted-1" {
		t.Errorf("Authorization = %q; minted token must win over static", gotAuth.Load())
	}
	if gotStatic.Load() != "s" {
		t.Errorf("X-Static = %q; non-colliding static headers must survive the merge", gotStatic.Load())
	}

	// Second flush re-invokes the provider: token freshness is per flush.
	f.ship(rec("authed-2"))
	if err := f.Flush(); err != nil {
		t.Fatalf("Flush 2: %v", err)
	}
	if gotAuth.Load() != "Bearer minted-2" {
		t.Errorf("second flush Authorization = %q; provider must be called per flush", gotAuth.Load())
	}
}

func TestEgressForwarder_ShipOwnGate(t *testing.T) {
	var received atomic.Value
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var records []map[string]any
		_ = json.NewDecoder(r.Body).Decode(&records)
		received.Store(records)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	dir := t.TempDir()
	f := newTestForwarder(t, srv, dir)
	f.shipOwn = false // matrix assigned the engine only tailed sources

	f.ship(rec("own-record-must-not-ship"))
	f.shipTailed(egressRecord{Ts: time.Now().UTC().Format(time.RFC3339Nano), Level: "INFO", Msg: "tailed-record", Component: "desktop", Tag: "t"})

	if err := f.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	records, _ := received.Load().([]map[string]any)
	if len(records) != 1 {
		t.Fatalf("expected exactly the tailed record, got %d: %v", len(records), records)
	}
	if records[0]["msg"] != "tailed-record" {
		t.Errorf("shipped msg = %v", records[0]["msg"])
	}
}

func TestEgressTailer_ShipsAppendedLinesAndHandlesTruncate(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	ionDir := filepath.Join(dir, ".ion")
	if err := os.MkdirAll(ionDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	desktopLog := filepath.Join(ionDir, "desktop.jsonl")

	// Pre-existing history that must NOT ship (first-seen starts at EOF).
	historyLine := `{"ts":"2026-07-10T00:00:00Z","level":"INFO","msg":"history","component":"desktop","tag":"x"}` + "\n"
	if err := os.WriteFile(desktopLog, []byte(historyLine), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	var shipped []egressRecord
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var records []egressRecord
		_ = json.NewDecoder(r.Body).Decode(&records)
		shipped = append(shipped, records...)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	f := newTestForwarder(t, srv, dir)
	f.shipOwn = false

	tailer := StartEgressTailer([]string{"desktop"}, f)
	if tailer == nil {
		t.Fatal("StartEgressTailer returned nil")
	}
	// Poll directly (deterministic) instead of waiting on the 2 s ticker.
	tailer.pollFile("desktop", desktopLog)

	// Append a new canonical line and poll again.
	appendLine := `{"ts":"2026-07-10T00:00:01Z","level":"ERROR","msg":"fresh","component":"desktop","tag":"y","session_id":"s1"}` + "\n"
	fh, err := os.OpenFile(desktopLog, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatalf("open append: %v", err)
	}
	if _, err := fh.WriteString(appendLine); err != nil {
		t.Fatalf("append: %v", err)
	}
	fh.Close()
	tailer.pollFile("desktop", desktopLog)

	if err := f.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if len(shipped) != 1 {
		t.Fatalf("expected only the appended line (no history backfill), got %d: %v", len(shipped), shipped)
	}
	if shipped[0].Msg != "fresh" || shipped[0].Level != "ERROR" || shipped[0].SessionID != "s1" {
		t.Errorf("tailed record fields lost: %+v", shipped[0])
	}

	// Truncate in place with new content: cursor resets and the fresh
	// content ships from the top.
	truncLine := `{"ts":"2026-07-10T00:00:02Z","level":"INFO","msg":"after-truncate","component":"desktop","tag":"z"}` + "\n"
	if err := os.WriteFile(desktopLog, []byte(truncLine), 0o644); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	tailer.pollFile("desktop", desktopLog)
	if err := f.Flush(); err != nil {
		t.Fatalf("Flush 2: %v", err)
	}
	if len(shipped) != 2 || shipped[1].Msg != "after-truncate" {
		t.Fatalf("truncate handling failed; shipped: %+v", shipped)
	}

	tailer.Stop()
}
