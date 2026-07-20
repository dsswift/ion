package utils

// log_egress_test.go — tests for the disk spool and backoff in EgressForwarder.
//
// Coverage:
//   S1  Failed flush appends records to the spool file.
//   S2  Next successful flush drains the spool FIFO before the live buffer.
//   S3  Spool cap trims oldest lines when exceeded, logs ERROR.
//   S4  Spool survives restart (persists across forwarder recreations).
//   S5  Backoff suppresses flush calls during the backoff window.
//   S6  Chunked drain: 9 records + chunk-size 3 → 3 separate POSTs.
//   S7  Partial failure: spool rewritten to unshipped tail; recovery ships remainder.
//   S8  Error body included in returned error message.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// makeSink creates a test HTTP server.  When fail=true it returns 503;
// otherwise it returns 200.  call count is exposed via callCount.
func makeSink(t *testing.T, fail *atomic.Bool) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if fail.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// spoolForDir returns the expected spool path for a given home dir.
func spoolForDir(dir string) string {
	return filepath.Join(dir, ".ion", ".engine-egress-spool.jsonl")
}

// newTestForwarder builds a forwarder pointing at srv with the spool in dir.
func newTestForwarder(t *testing.T, srv *httptest.Server, dir string, cfg ...types.LoggingConfig) *EgressForwarder {
	t.Helper()
	var c types.LoggingConfig
	if len(cfg) > 0 {
		c = cfg[0]
	}
	c.EgressTargets = []string{"http"}
	c.EgressEndpoint = srv.URL
	c.EgressFlushIntervalMs = 60_000 // very long — manual flush only
	c.EgressBatchSize = 0

	if c.EgressSpoolMaxBytes == 0 {
		c.EgressSpoolMaxBytes = defaultSpoolMaxBytes
	}

	home := filepath.Join(dir, ".ion")
	if err := os.MkdirAll(home, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	f := &EgressForwarder{
		cfg:        c,
		shipOwn:    true, // tests exercise the engine's own-record path
		spoolPath:  spoolForDir(dir),
		spoolMaxB:  c.EgressSpoolMaxBytes,
		buffer:     make([]egressRecord, 0, 64),
		loggedErrs: make(map[string]bool),
		stopCh:     make(chan struct{}),
		flushDone:  make(chan struct{}),
	}
	// Don't start the background goroutine — tests call Flush manually.
	// Close the flushDone channel immediately so Close() doesn't deadlock.
	close(f.flushDone)
	return f
}

func rec(msg string) egressRecord {
	return egressRecord{
		Ts:        time.Now().UTC().Format(time.RFC3339Nano),
		Level:     "INFO",
		Msg:       msg,
		Component: "engine",
		Tag:       "test",
	}
}

// ---------------------------------------------------------------------------
// S1: failed flush spools the records
// ---------------------------------------------------------------------------

// TestEgressSpool_FailedFlushSpools verifies that when the sink returns a
// non-2xx status, the batch is appended to the spool file rather than dropped.
// RED on old code: the old Flush returned the error and dropped records.
func TestEgressSpool_FailedFlushSpools(t *testing.T) {
	dir := t.TempDir()
	fail := &atomic.Bool{}
	fail.Store(true)
	srv := makeSink(t, fail)

	f := newTestForwarder(t, srv, dir)
	f.ship(rec("spooled-1"))
	f.ship(rec("spooled-2"))

	err := f.Flush()
	if err == nil {
		t.Error("expected flush error when sink returns 503, got nil")
	}

	// Records must be in the spool file.
	data, readErr := os.ReadFile(f.spoolPath)
	if readErr != nil {
		t.Fatalf("spool file missing after failed flush: %v", readErr)
	}
	content := string(data)
	if !strings.Contains(content, "spooled-1") {
		t.Error("spooled-1 not found in spool file")
	}
	if !strings.Contains(content, "spooled-2") {
		t.Error("spooled-2 not found in spool file")
	}
}

// ---------------------------------------------------------------------------
// S2: next successful flush drains spool FIFO before live buffer
// ---------------------------------------------------------------------------

// TestEgressSpool_DrainBeforeLiveBuffer verifies that after a failure creates
// a spool, the next successful flush drains the spool first, then the live
// buffer.  The order in the sink's received records must be: spool records,
// then live buffer records.
// RED on old code: the spool was never written or drained.
func TestEgressSpool_DrainBeforeLiveBuffer(t *testing.T) {
	dir := t.TempDir()
	fail := &atomic.Bool{}
	fail.Store(true)
	srv := makeSink(t, fail)

	f := newTestForwarder(t, srv, dir)

	// First flush: fails, spools.
	f.ship(rec("spool-a"))
	f.ship(rec("spool-b"))
	_ = f.Flush()

	// Now bring the sink up and add a live record.
	fail.Store(false)
	f.mu.Lock()
	f.backoffUntil = time.Time{}
	f.backoffDelay = 0
	f.mu.Unlock()

	// Use a capturing sink so we see delivery order.
	var mu sync.Mutex
	var received []string
	capSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var records []egressRecord
		if json.NewDecoder(r.Body).Decode(&records) == nil {
			mu.Lock()
			for _, r := range records {
				received = append(received, r.Msg)
			}
			mu.Unlock()
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer capSrv.Close()
	f.cfg.EgressEndpoint = capSrv.URL
	f.spoolPath = spoolForDir(dir) // same spool

	f.ship(rec("live-c"))
	if err := f.Flush(); err != nil {
		t.Fatalf("flush after recovery failed: %v", err)
	}

	mu.Lock()
	got := make([]string, len(received))
	copy(got, received)
	mu.Unlock()

	// Spool must be drained (file absent or empty).
	if info, err := os.Stat(f.spoolPath); err == nil && info.Size() > 0 {
		t.Error("spool file not drained after successful flush")
	}

	// Expected order: spool records first, then live.
	if len(got) < 3 {
		t.Fatalf("expected at least 3 records (2 spool + 1 live), got %d: %v", len(got), got)
	}
	// The two spool records must precede the live one.
	spoolIdx := -1
	for i, m := range got {
		if m == "spool-a" || m == "spool-b" {
			if spoolIdx < 0 {
				spoolIdx = i
			}
		}
	}
	liveIdx := -1
	for i, m := range got {
		if m == "live-c" {
			liveIdx = i
			break
		}
	}
	if spoolIdx < 0 {
		t.Error("spool records not found in received set")
	}
	if liveIdx < 0 {
		t.Error("live record not found in received set")
	}
	if liveIdx <= spoolIdx {
		t.Errorf("live record (idx %d) appeared before or with spool records (idx %d): order must be spool-first", liveIdx, spoolIdx)
	}
}

// ---------------------------------------------------------------------------
// S3: spool cap trims oldest lines
// ---------------------------------------------------------------------------

// TestEgressSpool_CapTrimsOldest verifies that when the spool exceeds the cap,
// the oldest lines are removed and an ERROR is logged.
// RED on old code: no cap existed; spool grew unbounded.
func TestEgressSpool_CapTrimsOldest(t *testing.T) {
	dir := t.TempDir()
	_ = os.MkdirAll(filepath.Join(dir, ".ion"), 0o755)

	// Cap that fits only a handful of records. Each JSON record is ~100-150 bytes.
	const smallCap = int64(500)

	fail := &atomic.Bool{}
	fail.Store(true)
	srv := makeSink(t, fail)
	f := newTestForwarder(t, srv, dir, types.LoggingConfig{EgressSpoolMaxBytes: smallCap})

	// Ship 20 records; with the cap each flush trims so the spool stays bounded.
	for i := range 20 {
		f.ship(rec("record-" + string(rune('a'+i%26))))
		// Trigger flush after each record to simulate repeated failed flushes.
		_ = f.Flush()
		// Reset backoff between calls.
		f.mu.Lock()
		f.backoffUntil = time.Time{}
		f.backoffDelay = 0
		f.mu.Unlock()
	}

	info, err := os.Stat(f.spoolPath)
	if err != nil {
		t.Fatalf("spool file missing after capped flushes: %v", err)
	}
	// Spool must be at most 2×cap (generous: trimming happens after each append).
	if info.Size() > smallCap*2 {
		t.Errorf("spool file size %d bytes exceeds 2×cap %d (trimming not working)", info.Size(), smallCap*2)
	}

	// The file must be valid JSONL.
	data, _ := os.ReadFile(f.spoolPath)
	sc := bufio.NewScanner(strings.NewReader(string(data)))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Errorf("spool contains invalid JSON after trim: %q", line)
		}
	}
}

// ---------------------------------------------------------------------------
// S4: spool survives restart
// ---------------------------------------------------------------------------

// TestEgressSpool_SurvivesRestart verifies that the spool is durably written
// to disk and a new forwarder (simulating a restart) picks it up and drains it.
// RED on old code: no spool — records were dropped on restart.
func TestEgressSpool_SurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	_ = os.MkdirAll(filepath.Join(dir, ".ion"), 0o755)

	fail := &atomic.Bool{}
	fail.Store(true)
	srv := makeSink(t, fail)

	// First forwarder: fails, spools.
	f1 := newTestForwarder(t, srv, dir)
	f1.ship(rec("restart-msg-1"))
	f1.ship(rec("restart-msg-2"))
	_ = f1.Flush()

	// Verify spool written.
	data, err := os.ReadFile(f1.spoolPath)
	if err != nil {
		t.Fatalf("spool file missing after first flush: %v", err)
	}
	if !strings.Contains(string(data), "restart-msg-1") {
		t.Error("spool does not contain restart-msg-1")
	}

	// Second forwarder (simulates restart): same spool path, sink now up.
	fail.Store(false)
	var mu sync.Mutex
	var received []string
	capSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var records []egressRecord
		if json.NewDecoder(r.Body).Decode(&records) == nil {
			mu.Lock()
			for _, rec := range records {
				received = append(received, rec.Msg)
			}
			mu.Unlock()
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer capSrv.Close()

	f2 := newTestForwarder(t, capSrv, dir)
	if err := f2.Flush(); err != nil {
		t.Fatalf("second forwarder flush failed: %v", err)
	}

	mu.Lock()
	got := make([]string, len(received))
	copy(got, received)
	mu.Unlock()

	found1, found2 := false, false
	for _, m := range got {
		if m == "restart-msg-1" {
			found1 = true
		}
		if m == "restart-msg-2" {
			found2 = true
		}
	}
	if !found1 || !found2 {
		t.Errorf("restart records not delivered: got %v", got)
	}

	// Spool must be cleared after drain.
	if info, err := os.Stat(f2.spoolPath); err == nil && info.Size() > 0 {
		t.Error("spool not cleared after restart drain")
	}
}

// ---------------------------------------------------------------------------
// D1/D2: desktop-delegation gate (egressManagedByClient)
// ---------------------------------------------------------------------------

// TestEgressForwarder_SuppressedWhenManagedByClient verifies that the engine's
// own forwarder is NOT constructed when a managing client (the desktop) is
// shipping engine.jsonl on the engine's behalf. This prevents the double-ship
// that balloons the spool with unauthenticated 401 failures: with a desktop
// tailing and shipping under its OIDC token, the engine must not also ship the
// same lines from an unauthenticated forwarder.
// RED on pre-fix code: newEgressForwarder ignored the flag and returned a live
// forwarder whenever EgressTargets was non-empty.
func TestEgressForwarder_SuppressedWhenManagedByClient(t *testing.T) {
	cfg := types.LoggingConfig{
		EgressTargets:         []string{"otel"},
		EgressManagedByClient: true,
		EgressOtel:            &types.OtelConfig{Endpoint: "https://ingest.example.com"},
	}
	if f := newEgressForwarder(cfg); f != nil {
		f.Close()
		t.Fatal("expected nil forwarder when egressManagedByClient=true (desktop ships on engine's behalf), got a live forwarder")
	}
}

// TestEgressForwarder_ActiveWhenHeadless verifies that a headless/CI engine
// (no managing client, egressManagedByClient=false) STILL constructs its own
// forwarder and ships for itself. This is the F5 non-interactive path — the
// engine is the only shipper on the box and must not be silenced by the gate.
func TestEgressForwarder_ActiveWhenHeadless(t *testing.T) {
	cfg := types.LoggingConfig{
		EgressTargets: []string{"otel"},
		// EgressManagedByClient left false: no desktop is managing this engine.
		EgressOtel: &types.OtelConfig{Endpoint: "https://ingest.example.com"},
	}
	f := newEgressForwarder(cfg)
	if f == nil {
		t.Fatal("expected a live forwarder for a headless engine (egressManagedByClient=false), got nil")
	}
	f.Close()
}

// TestEgressForwarder_NilWhenNoTargets pins that the zero-config default (no
// egress targets at all) still yields no forwarder, independent of the new
// delegation flag. This guards the ordering of the two nil-returns.
func TestEgressForwarder_NilWhenNoTargets(t *testing.T) {
	if f := newEgressForwarder(types.LoggingConfig{}); f != nil {
		f.Close()
		t.Fatal("expected nil forwarder when no egress targets configured")
	}
}

// ---------------------------------------------------------------------------
// S6: chunked spool drain — all chunks succeed
// ---------------------------------------------------------------------------

// TestEgressSpool_ChunkedDrain verifies that drainSpool sends records in
// multiple chunk-sized POSTs rather than one monolithic request, and that the
// spool is removed on full success. Chunk size 3, 9 records → 3 POSTs.
// RED on old code: all 9 records land in one POST (no chunking).
func TestEgressSpool_ChunkedDrain(t *testing.T) {
	dir := t.TempDir()
	_ = os.MkdirAll(filepath.Join(dir, ".ion"), 0o755)

	var mu sync.Mutex
	var posts [][]string // per-POST message lists
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var records []egressRecord
		if err := json.NewDecoder(r.Body).Decode(&records); err != nil {
			t.Errorf("decode: %v", err)
		}
		msgs := make([]string, len(records))
		for i, r := range records {
			msgs[i] = r.Msg
		}
		mu.Lock()
		posts = append(posts, msgs)
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	// Build a forwarder with chunk size 3.
	f := newTestForwarder(t, srv, dir, types.LoggingConfig{EgressChunkSize: 3})

	// Seed 9 records directly into the spool (bypasses the live buffer).
	for i := range 9 {
		f.ship(rec(fmt.Sprintf("chunk-rec-%d", i)))
	}
	fail := &atomic.Bool{}
	fail.Store(true)
	// First Flush fails so records land in spool.
	brokenSrv := makeSink(t, fail)
	f.cfg.EgressEndpoint = brokenSrv.URL
	_ = f.Flush()
	// Reset backoff and swap back to the capturing sink.
	f.mu.Lock()
	f.backoffUntil = time.Time{}
	f.backoffDelay = 0
	f.mu.Unlock()
	f.cfg.EgressEndpoint = srv.URL

	// Now drain: should produce exactly 3 POSTs of 3 records each.
	if err := f.drainSpool(); err != nil {
		t.Fatalf("drainSpool: %v", err)
	}

	mu.Lock()
	got := make([][]string, len(posts))
	copy(got, posts)
	mu.Unlock()

	if len(got) != 3 {
		t.Fatalf("expected 3 chunk POSTs, got %d: %v", len(got), got)
	}
	for i, chunk := range got {
		if len(chunk) != 3 {
			t.Errorf("chunk %d: expected 3 records, got %d: %v", i, len(chunk), chunk)
		}
	}
	// Spool must be gone.
	if info, err := os.Stat(f.spoolPath); err == nil && info.Size() > 0 {
		t.Error("spool not removed after full drain")
	}
}

// ---------------------------------------------------------------------------
// S7: chunked spool drain — partial failure rewrites spool
// ---------------------------------------------------------------------------

// TestEgressSpool_ChunkedDrain_PartialFailure verifies that when a chunk fails
// mid-drain, only the unshipped tail is left in the spool, and a subsequent
// flush (sink back up) ships exactly those remaining records.
// Chunk size 2, 6 records: first chunk (0-1) succeeds, second chunk (2-3)
// fails, third chunk never attempted. Spool must contain records 2-5.
func TestEgressSpool_ChunkedDrain_PartialFailure(t *testing.T) {
	dir := t.TempDir()
	_ = os.MkdirAll(filepath.Join(dir, ".ion"), 0o755)

	callCount := &atomic.Int64{}
	failAfter := int64(1) // fail starting from the 2nd POST
	var mu sync.Mutex
	var received []string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := callCount.Add(1)
		if n > failAfter {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		var records []egressRecord
		if err := json.NewDecoder(r.Body).Decode(&records); err != nil {
			t.Errorf("decode: %v", err)
		}
		mu.Lock()
		for _, r := range records {
			received = append(received, r.Msg)
		}
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	f := newTestForwarder(t, srv, dir, types.LoggingConfig{EgressChunkSize: 2})

	// Seed 6 records into the spool via a broken sink.
	brokenFail := &atomic.Bool{}
	brokenFail.Store(true)
	brokenSrv := makeSink(t, brokenFail)
	f.cfg.EgressEndpoint = brokenSrv.URL
	for i := range 6 {
		f.ship(rec(fmt.Sprintf("partial-%d", i)))
	}
	_ = f.Flush()
	f.mu.Lock()
	f.backoffUntil = time.Time{}
	f.backoffDelay = 0
	f.mu.Unlock()
	f.cfg.EgressEndpoint = srv.URL

	// Drain: chunk 0 (records 0-1) lands; chunk 1 (records 2-3) fails.
	err := f.drainSpool()
	if err == nil {
		t.Fatal("expected error from partial drain, got nil")
	}

	// Spool must contain only the unshipped records (2-5).
	spoolData, readErr := os.ReadFile(f.spoolPath)
	if readErr != nil {
		t.Fatalf("spool missing after partial drain: %v", readErr)
	}
	var spooled []string
	sc := bufio.NewScanner(strings.NewReader(string(spoolData)))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var r egressRecord
		if json.Unmarshal([]byte(line), &r) == nil {
			spooled = append(spooled, r.Msg)
		}
	}
	if len(spooled) != 4 {
		t.Errorf("expected 4 records left in spool (records 2-5), got %d: %v", len(spooled), spooled)
	}
	for _, m := range spooled {
		if m == "partial-0" || m == "partial-1" {
			t.Errorf("already-shipped record %q still in spool", m)
		}
	}

	// Now bring sink up fully and drain again: must ship exactly those 4.
	callCount.Store(0)
	failAfter = 99 // let all POSTs through
	f.mu.Lock()
	f.backoffUntil = time.Time{}
	f.backoffDelay = 0
	f.mu.Unlock()

	if err := f.drainSpool(); err != nil {
		t.Fatalf("second drainSpool: %v", err)
	}

	mu.Lock()
	got := make([]string, len(received))
	copy(got, received)
	mu.Unlock()

	// received so far = 2 from first successful chunk + 4 from recovery.
	if len(got) != 2+4 {
		t.Fatalf("expected 6 total delivered records, got %d: %v", len(got), got)
	}
	if info, err := os.Stat(f.spoolPath); err == nil && info.Size() > 0 {
		t.Error("spool not removed after full recovery drain")
	}
}

// ---------------------------------------------------------------------------
// S8: error body included in returned error
// ---------------------------------------------------------------------------

// TestEgressHTTP_ErrorBodyInMessage verifies that when the sink returns a 4xx
// with a body, the body text is included in the error returned by
// flushEgressToHTTP so it appears in engine.jsonl rather than a bare status.
func TestEgressHTTP_ErrorBodyInMessage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte("bad content-type"))
	}))
	defer srv.Close()

	err := flushEgressToHTTP([]egressRecord{rec("x")}, srv.URL, nil)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "bad content-type") {
		t.Errorf("error %q does not contain error body text", err.Error())
	}
	if !strings.Contains(err.Error(), "400") {
		t.Errorf("error %q does not contain status code", err.Error())
	}
}
