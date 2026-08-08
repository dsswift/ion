package utils

// log_egress_spool_test.go — regressions for the spool memory/CPU bombs.
//
// These pin the properties that the original whole-file-in-memory helpers
// violated. The headline one (TestEgressSpool_TrimOversizedSpoolIsLinear) is a
// true regression test: it builds a spool far enough over cap that the old
// O(n²) `for len(strings.Join(lines,"\n")) > max { lines = lines[1:] }` loop
// cannot finish inside the deadline, while the streaming rewrite finishes in
// milliseconds. Reverting log_egress_spool.go to the old implementation turns
// it red on the timeout.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// writeSpoolRecords writes n synthetic spool records and returns the file size.
func writeSpoolRecords(t *testing.T, path string, n int, msgPrefix string) int64 {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	file, err := os.Create(path)
	if err != nil {
		t.Fatalf("create spool: %v", err)
	}
	w := bufio.NewWriterSize(file, 1<<20)
	for i := range n {
		b, err := json.Marshal(rec(fmt.Sprintf("%s-%08d", msgPrefix, i)))
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		if _, err := w.Write(append(b, '\n')); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	if err := w.Flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	return info.Size()
}

// readSpoolLines returns the spool's lines (test-only; sizes here are small).
func readSpoolLines(t *testing.T, path string) []string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read spool: %v", err)
	}
	trimmed := strings.TrimRight(string(data), "\n")
	if trimmed == "" {
		return nil
	}
	return strings.Split(trimmed, "\n")
}

// ---------------------------------------------------------------------------
// The headline regression: trimming a badly-oversized spool must be linear
// ---------------------------------------------------------------------------

// TestEgressSpool_TrimOversizedSpoolIsLinear builds a spool ~80× over cap and
// requires the trim to finish quickly, leave the file at or under the cap, and
// keep the NEWEST records (drop-oldest FIFO).
//
// This is the production failure reduced to test scale. In the field the spool
// reached 1.37 GB against a 50 MB cap (3.4 M records) after an OTLP sink
// returned 401 for an extended period. The old trim re-joined the whole
// remaining slice per dropped line, so it needed ~3.3 M passes over ~1.3 GB:
// the flush goroutine pinned a core, the heap hit 9.5 GB, and the engine never
// reached its socket bind — every conversation on the machine went dark.
//
// RED on the old code: the O(n²) loop cannot finish ~79k drop iterations over
// an ~8 MB join inside the deadline.
func TestEgressSpool_TrimOversizedSpoolIsLinear(t *testing.T) {
	dir := t.TempDir()
	spool := spoolForDir(dir)

	// ~80k records ≈ 8 MB, against a 100 KB cap: ~80× over, the same shape as
	// the 27× overshoot seen in production, sized so the two implementations
	// are separated by orders of magnitude rather than by a stopwatch margin.
	// Streaming finishes in tens of milliseconds; the O(n²) loop needs ~79k
	// passes over ~8 MB and takes minutes.
	const records = 80_000
	const cap100K = int64(100 * 1024)
	size := writeSpoolRecords(t, spool, records, "trim")
	if size <= cap100K {
		t.Fatalf("test setup produced a %d-byte spool, not over the %d cap", size, cap100K)
	}

	f := &EgressForwarder{spoolPath: spool, spoolMaxB: cap100K}

	// 10s is ~100× the streaming implementation's runtime and a small fraction
	// of the O(n²) loop's, so the verdict is never a stopwatch coin-flip.
	const trimDeadline = 10 * time.Second

	done := make(chan error, 1)
	start := time.Now()
	go func() { done <- f.trimSpoolToCap(cap100K) }()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("trim failed: %v", err)
		}
	case <-time.After(trimDeadline):
		t.Fatalf("trim of a %d-byte spool (%d× cap) did not finish in %s — "+
			"the trim is super-linear in spool size; this is the loop that "+
			"pinned a core and grew the heap to 9.5 GB in production",
			size, size/cap100K, trimDeadline)
	}
	elapsed := time.Since(start)

	info, err := os.Stat(spool)
	if err != nil {
		t.Fatalf("spool missing after trim: %v", err)
	}
	if info.Size() > cap100K {
		t.Errorf("spool is %d bytes after trim, cap is %d", info.Size(), cap100K)
	}
	t.Logf("trimmed %d bytes -> %d bytes in %v", size, info.Size(), elapsed)

	// Drop-oldest: the survivors must be the tail of what was written, and
	// every one must still be parseable (the realignment must not leave a
	// half-record at the front).
	lines := readSpoolLines(t, spool)
	if len(lines) == 0 {
		t.Fatal("trim left an empty spool; expected the newest records to survive")
	}
	var first, last egressRecord
	if err := json.Unmarshal([]byte(lines[0]), &first); err != nil {
		t.Fatalf("first surviving line is not valid JSON (realignment dropped a partial record?): %v", err)
	}
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &last); err != nil {
		t.Fatalf("last surviving line is not valid JSON: %v", err)
	}
	wantLast := fmt.Sprintf("trim-%08d", records-1)
	if last.Msg != wantLast {
		t.Errorf("newest record is %q, want %q — trim dropped from the wrong end", last.Msg, wantLast)
	}
	if first.Msg == "trim-00000000" {
		t.Error("oldest record survived a trim that dropped 97% of the file")
	}
}

// TestEgressSpool_TrimRealignsToRecordBoundary pins that the survivor never
// begins mid-record: the byte offset lands wherever it lands, and the rewrite
// must skip forward to the next newline.
func TestEgressSpool_TrimRealignsToRecordBoundary(t *testing.T) {
	dir := t.TempDir()
	spool := spoolForDir(dir)
	writeSpoolRecords(t, spool, 200, "align")

	info, err := os.Stat(spool)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	// A cap deliberately unaligned to any record boundary.
	capBytes := info.Size()/2 + 37

	f := &EgressForwarder{spoolPath: spool, spoolMaxB: capBytes}
	if err := f.trimSpoolToCap(capBytes); err != nil {
		t.Fatalf("trim: %v", err)
	}

	for i, line := range readSpoolLines(t, spool) {
		var r egressRecord
		if err := json.Unmarshal([]byte(line), &r); err != nil {
			t.Fatalf("line %d is not valid JSON after trim: %v (%q)", i, err, line)
		}
	}
}

// TestEgressSpool_TrimUnderCapIsNoop pins that a spool within cap is untouched
// — byte-for-byte, no rewrite, no realignment loss.
func TestEgressSpool_TrimUnderCapIsNoop(t *testing.T) {
	dir := t.TempDir()
	spool := spoolForDir(dir)
	writeSpoolRecords(t, spool, 10, "noop")
	before, err := os.ReadFile(spool)
	if err != nil {
		t.Fatalf("read: %v", err)
	}

	f := &EgressForwarder{spoolPath: spool, spoolMaxB: 1 << 20}
	if err := f.trimSpoolToCap(1 << 20); err != nil {
		t.Fatalf("trim: %v", err)
	}

	after, err := os.ReadFile(spool)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(before) != string(after) {
		t.Error("trim modified a spool that was already under cap")
	}
	if _, err := os.Stat(spool + ".tmp"); err == nil {
		t.Error("trim left a temp file behind")
	}
}

// ---------------------------------------------------------------------------
// Drain: streaming, and no temp file left behind
// ---------------------------------------------------------------------------

// TestEgressSpool_DrainLargeSpoolStreams pins that a spool much larger than any
// single POST body drains completely, in chunks, without loading the file into
// memory as one slice of records.
func TestEgressSpool_DrainLargeSpoolStreams(t *testing.T) {
	dir := t.TempDir()
	spool := spoolForDir(dir)
	const records = 5_000
	writeSpoolRecords(t, spool, records, "drain")

	var received atomic.Int64
	var maxBody atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var batch []map[string]any
		if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		received.Add(int64(len(batch)))
		if n := int64(len(batch)); n > maxBody.Load() {
			maxBody.Store(n)
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	f := newTestForwarder(t, srv, dir, types.LoggingConfig{EgressChunkSize: 250})
	if err := f.drainSpool(); err != nil {
		t.Fatalf("drain: %v", err)
	}

	if got := received.Load(); got != records {
		t.Errorf("sink received %d records, want %d", got, records)
	}
	if got := maxBody.Load(); got > 250 {
		t.Errorf("a POST carried %d records, chunk size is 250 — drain is not chunking", got)
	}
	if _, err := os.Stat(spool); !os.IsNotExist(err) {
		t.Error("spool file survived a fully successful drain")
	}
	if _, err := os.Stat(spool + ".tmp"); err == nil {
		t.Error("drain left a temp file behind")
	}
}

// TestEgressSpool_DrainSkipsCorruptLine pins that one unparseable line is
// consumed rather than wedging the spool forever. The old drain silently
// skipped it on read but never removed it from the rewritten tail on a partial
// failure, so a corrupt line could be retried indefinitely.
func TestEgressSpool_DrainSkipsCorruptLine(t *testing.T) {
	dir := t.TempDir()
	spool := spoolForDir(dir)
	if err := os.MkdirAll(filepath.Dir(spool), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	good, err := json.Marshal(rec("good-record"))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	content := string(good) + "\n" + "{not json at all\n" + string(good) + "\n"
	if err := os.WriteFile(spool, []byte(content), 0o644); err != nil {
		t.Fatalf("write spool: %v", err)
	}

	var received atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var batch []map[string]any
		if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		received.Add(int64(len(batch)))
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)

	f := newTestForwarder(t, srv, dir)
	if err := f.drainSpool(); err != nil {
		t.Fatalf("drain: %v", err)
	}
	if got := received.Load(); got != 2 {
		t.Errorf("sink received %d records, want the 2 parseable ones", got)
	}
	if _, err := os.Stat(spool); !os.IsNotExist(err) {
		t.Error("corrupt line left the spool on disk; it would be retried forever")
	}
}

// ---------------------------------------------------------------------------
// The other half of the bomb: a failed drain must not park records in the heap
// ---------------------------------------------------------------------------

// TestEgressFlush_FailedDrainSpoolsLiveBuffer pins that when the spool drain
// fails, the live buffer is moved to disk rather than left in memory.
//
// RED on the old code: Flush returned early on a drain error and never touched
// the live buffer, so every subsequent failed flush left more records resident.
// With a permanently-failing sink the in-memory buffer was the real unbounded
// queue — the spool cap bounded disk while the heap grew without limit.
func TestEgressFlush_FailedDrainSpoolsLiveBuffer(t *testing.T) {
	dir := t.TempDir()
	fail := &atomic.Bool{}
	fail.Store(true)
	srv := makeSink(t, fail)
	f := newTestForwarder(t, srv, dir)

	// First failed flush creates the spool.
	f.ship(rec("first"))
	if err := f.Flush(); err == nil {
		t.Fatal("expected the failing sink to error")
	}
	f.resetBackoffForTest()

	// Now the spool exists, so subsequent flushes take the drain-failure path.
	for i := range 25 {
		f.ship(rec(fmt.Sprintf("buffered-%d", i)))
		if err := f.Flush(); err == nil {
			t.Fatal("expected the failing sink to error")
		}
		f.resetBackoffForTest()
	}

	f.mu.Lock()
	buffered := len(f.buffer)
	f.mu.Unlock()
	if buffered != 0 {
		t.Errorf("%d records still resident in the live buffer after failed flushes; "+
			"a dead sink must push records to the bounded spool, not the heap", buffered)
	}

	lines := readSpoolLines(t, f.spoolPath)
	if len(lines) < 26 {
		t.Errorf("spool holds %d records, want all 26 shipped records", len(lines))
	}
}

// TestEgressBuffer_CapEvictsOldest pins the heap backstop: when even the spool
// write cannot keep up, the in-memory buffer evicts oldest-first instead of
// growing without bound, and reports the loss at ERROR on the next flush.
func TestEgressBuffer_CapEvictsOldest(t *testing.T) {
	dir := t.TempDir()
	fail := &atomic.Bool{}
	fail.Store(false)
	srv := makeSink(t, fail)
	f := newTestForwarder(t, srv, dir, types.LoggingConfig{EgressBufferMaxRecords: 10})

	for i := range 25 {
		f.ship(rec(fmt.Sprintf("rec-%02d", i)))
	}

	f.mu.Lock()
	buffered := len(f.buffer)
	dropped := f.bufferDropped
	oldest := f.buffer[0].Msg
	newest := f.buffer[len(f.buffer)-1].Msg
	f.mu.Unlock()

	if buffered != 10 {
		t.Errorf("buffer holds %d records, cap is 10", buffered)
	}
	if dropped != 15 {
		t.Errorf("recorded %d drops, want 15", dropped)
	}
	if oldest != "rec-15" {
		t.Errorf("oldest surviving record is %q, want rec-15 (drop-oldest FIFO)", oldest)
	}
	if newest != "rec-24" {
		t.Errorf("newest surviving record is %q, want rec-24", newest)
	}

	// The drop count is reported from the flush path (never from enqueue,
	// which would recurse through ship) and cleared once reported.
	f.reportBufferDrops()
	f.mu.Lock()
	remaining := f.bufferDropped
	f.mu.Unlock()
	if remaining != 0 {
		t.Errorf("drop counter is %d after reporting, want 0", remaining)
	}
}

// resetBackoffForTest clears the failure backoff so a test can drive
// consecutive flushes without waiting out the exponential delay.
func (f *EgressForwarder) resetBackoffForTest() {
	f.mu.Lock()
	f.backoffUntil = time.Time{}
	f.backoffDelay = 0
	f.mu.Unlock()
}
