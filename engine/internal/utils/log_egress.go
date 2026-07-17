package utils

// log_egress.go — optional downstream shipping path for operational log lines.
//
// When engine.json sets logging.egressTargets to ["http"] or ["otel"] (or both),
// every log line written by logAtFull is also buffered here and flushed
// periodically (and on engine shutdown) to the configured sinks.
//
// The shape mirrors internal/telemetry's Collector: buffer under a mutex,
// periodic flush goroutine, batch-size trigger, and per-target flush helpers.
// Enterprise enforcement (EnforceEnterprise in config/merge.go) can force
// egress on so users cannot disable it.
//
// Disk spool: when a flush fails (sink unreachable / non-2xx), the batch is
// appended to ~/.ion/.engine-egress-spool.jsonl instead of being dropped.
// On each flush tick the spool is drained first (FIFO) before the live buffer
// is sent. The spool cap (EgressSpoolMaxBytes, default 50 MB) trims the oldest
// lines when exceeded. Exponential backoff (base 5 s, cap 5 min) prevents
// hot-looping against a dead sink.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// defaultSpoolMaxBytes is the maximum size of the on-disk spool before
// drop-oldest trimming kicks in. 50 MB matches the operational-log default.
const defaultSpoolMaxBytes = 50 * 1024 * 1024

// egressRecord is the structured payload shipped to downstream egress targets.
// It mirrors the canonical log schema (docs/observability/log-schema.md) so
// the egress stream is parseable by the same tooling as the local JSONL file,
// and mirrors the desktop EgressRecord (desktop/src/main/log-egress.ts) so
// engine and desktop egress are byte-shape identical for the same record.
//
// Correlation-ID placement follows the operational log schema exactly:
//   - session_id / conversation_id / trace_id are top-level (schema top-level).
//   - run_id is NOT a top-level field: the schema keeps it inside the "fields"
//     map, so it rides losslessly in Fields and is flattened to an OTLP
//     attribute like any other field key. Promoting it top-level would diverge
//     from both the on-disk JSONL line and the desktop record.
//   - span_id is a reserved top-level correlation ID in the schema, but the
//     engine's operational logger never populates it today (the logAtFull /
//     ambient-correlation path carries only session/conversation/trace), so no
//     span_id field is added here — a field nothing writes would be dead weight.
//   - user is the attribution carrier (R20), top-level and omit-when-empty,
//     matching the desktop EgressRecord and the telemetry envelope.
type egressRecord struct {
	Ts             string         `json:"ts"`
	Level          string         `json:"level"`
	Msg            string         `json:"msg"`
	Component      string         `json:"component"`
	Tag            string         `json:"tag"`
	SessionID      string         `json:"session_id,omitempty"`
	ConversationID string         `json:"conversation_id,omitempty"`
	TraceID        string         `json:"trace_id,omitempty"`
	User           string         `json:"user,omitempty"`
	Fields         map[string]any `json:"fields,omitempty"`
}

// EgressForwarder buffers operational log lines and ships them to one or more
// downstream targets ("http", "otel"). Constructed by newEgressForwarder and
// stored as a package-level singleton in logger.go (activeEgressForwarder).
type EgressForwarder struct {
	cfg         types.LoggingConfig
	// shipOwn gates whether the engine's own in-process records enter the
	// buffer (matrix source "engine"). Tailed sources bypass the gate via
	// shipTailed — a forwarder may exist solely to ship tailed files.
	shipOwn     bool
	spoolPath   string
	spoolMaxB   int64

	mu          sync.Mutex
	buffer      []egressRecord
	loggedErrs  map[string]bool // dedup flush-error log lines (mirrors Collector)

	// Backoff state for sink failures.
	backoffUntil time.Time
	backoffDelay time.Duration

	flushTicker *time.Ticker
	stopCh      chan struct{}
	flushDone   chan struct{}
	closeOnce   sync.Once
}

// EngineShipSources resolves the shipping-responsibility matrix for the
// engine surface: which log sources the engine's forwarder ships.
//
// Explicit EgressShipSources wins. Unset (nil) preserves legacy semantics:
// ["engine"] unless EgressManagedByClient delegates everything to a managing
// client (then nothing). See LoggingConfig.EgressShipSources.
func EngineShipSources(cfg types.LoggingConfig) []string {
	if cfg.EgressShipSources != nil {
		return cfg.EgressShipSources
	}
	if cfg.EgressManagedByClient {
		return nil
	}
	return []string{"engine"}
}

// shipSourcesContain reports whether the resolved matrix assigns source to
// this surface.
func shipSourcesContain(sources []string, source string) bool {
	for _, s := range sources {
		if s == source {
			return true
		}
	}
	return false
}

// newEgressForwarder creates a forwarder from cfg. Returns nil when no egress
// targets are configured (the zero-config default); callers must nil-check.
//
// Returns nil ALSO when the shipping-responsibility matrix assigns the engine
// no sources at all (legacy: cfg.EgressManagedByClient true): a managing
// client (the desktop) tails engine.jsonl and ships every engine line on the
// engine's behalf under its own authenticated egress. Running the engine's
// own forwarder in that mode would double-ship every line — once by the
// engine and once by the client. Headless/CI/Docker engines default to
// shipping their own records. See docs/enterprise/central-log-collection.md.
//
// When the matrix assigns the engine additional sources ("desktop", "ios",
// "telemetry"), the forwarder still constructs; the file tailer that feeds
// those sources into it is started separately (see StartEgressTailer in
// log_egress_tailer.go — wired at serve startup). shipOwn gates whether the
// engine's OWN in-process records enter the buffer.
func newEgressForwarder(cfg types.LoggingConfig) *EgressForwarder {
	if len(cfg.EgressTargets) == 0 {
		return nil
	}
	sources := EngineShipSources(cfg)
	if len(sources) == 0 {
		Log("log_egress", "egress delegated to managing client (no sources assigned to engine); engine forwarder suppressed to avoid double-shipping")
		return nil
	}
	if cfg.EgressFlushIntervalMs == 0 {
		cfg.EgressFlushIntervalMs = 5000
	}

	spoolMax := cfg.EgressSpoolMaxBytes
	if spoolMax <= 0 {
		spoolMax = defaultSpoolMaxBytes
	}

	// Locate the spool alongside ~/.ion/engine.jsonl.
	home, _ := os.UserHomeDir()
	spoolPath := filepath.Join(home, ".ion", ".engine-egress-spool.jsonl")

	f := &EgressForwarder{
		cfg:        cfg,
		shipOwn:    shipSourcesContain(sources, "engine"),
		spoolPath:  spoolPath,
		spoolMaxB:  spoolMax,
		buffer:     make([]egressRecord, 0, 64),
		loggedErrs: make(map[string]bool),
		stopCh:     make(chan struct{}),
		flushDone:  make(chan struct{}),
	}
	interval := time.Duration(cfg.EgressFlushIntervalMs) * time.Millisecond
	f.flushTicker = time.NewTicker(interval)
	go f.flushLoop()
	return f
}

// ship appends a log record to the buffer. Non-blocking: it acquires only the
// forwarder's own mutex, never logMu. Called from logAtFull under logMu so
// it must return quickly.
func (f *EgressForwarder) ship(rec egressRecord) {
	if f == nil || !f.shipOwn {
		return
	}
	f.enqueue(rec)
}

// shipTailed appends a record read from a tailed source file (matrix
// sources "desktop", "ios", "telemetry"). Bypasses the shipOwn gate: a
// forwarder may exist solely to ship tailed files.
func (f *EgressForwarder) shipTailed(rec egressRecord) {
	if f == nil {
		return
	}
	f.enqueue(rec)
}

// enqueue is the shared buffer-append + batch-flush trigger behind ship and
// shipTailed.
func (f *EgressForwarder) enqueue(rec egressRecord) {
	f.mu.Lock()
	f.buffer = append(f.buffer, rec)
	batchSize := f.cfg.EgressBatchSize
	shouldFlush := batchSize > 0 && len(f.buffer) >= batchSize
	f.mu.Unlock()

	if shouldFlush {
		if err := f.Flush(); err != nil {
			f.logFlushError(err)
		}
	}
}

// Close drains remaining buffered records and stops the background goroutine.
// Safe to call multiple times (idempotent via sync.Once).
func (f *EgressForwarder) Close() {
	if f == nil {
		return
	}
	f.closeOnce.Do(func() {
		if f.flushTicker != nil {
			f.flushTicker.Stop()
		}
		close(f.stopCh)
		<-f.flushDone
	})
}

// exportRecords ships a batch to every configured target. It resolves
// flush-time auth headers (a fresh operator token when an egressTokenScope
// provider is installed via SetEgressAuthHeaderProvider) and merges them
// over the static EgressHeaders / EgressOtel.Headers — the minted token
// wins over a stale static Authorization value. Single implementation
// behind the live flush, the spool drain, and the shutdown drain.
func (f *EgressForwarder) exportRecords(records []egressRecord) error {
	httpHeaders := f.cfg.EgressHeaders
	otelCfg := f.cfg.EgressOtel
	if authHeaders := resolvedEgressAuthHeaders(); len(authHeaders) > 0 {
		merged := make(map[string]string, len(f.cfg.EgressHeaders)+len(authHeaders))
		for k, v := range f.cfg.EgressHeaders {
			merged[k] = v
		}
		for k, v := range authHeaders {
			merged[k] = v
		}
		httpHeaders = merged

		if otelCfg != nil {
			otelMerged := make(map[string]string, len(otelCfg.Headers)+len(authHeaders))
			for k, v := range otelCfg.Headers {
				otelMerged[k] = v
			}
			for k, v := range authHeaders {
				otelMerged[k] = v
			}
			otelCopy := *otelCfg
			otelCopy.Headers = otelMerged
			otelCfg = &otelCopy
		}
	}

	var lastErr error
	for _, target := range f.cfg.EgressTargets {
		switch target {
		case "http":
			if err := flushEgressToHTTP(records, f.cfg.EgressEndpoint, httpHeaders); err != nil {
				lastErr = err
			}
		case "otel":
			if err := flushEgressToOtel(records, otelCfg); err != nil {
				lastErr = err
			}
		}
	}
	return lastErr
}

// Flush drains the spool first (FIFO), then exports live buffered records to
// the configured egress targets. Sink failures spool undeliverable batches to
// disk rather than dropping them.
func (f *EgressForwarder) Flush() error {
	if f == nil {
		return nil
	}

	// Respect backoff: if a previous failure set a backoff window, skip the
	// flush until the window expires.
	f.mu.Lock()
	inBackoff := time.Now().Before(f.backoffUntil)
	f.mu.Unlock()
	if inBackoff {
		return nil
	}

	// Drain the spool before the live buffer (FIFO delivery order).
	if err := f.drainSpool(); err != nil {
		// Spool drain failed → advance backoff and return; live buffer untouched.
		f.advanceBackoff()
		return err
	}

	// Now flush the live buffer.
	f.mu.Lock()
	if len(f.buffer) == 0 {
		f.mu.Unlock()
		return nil
	}
	records := make([]egressRecord, len(f.buffer))
	copy(records, f.buffer)
	f.buffer = f.buffer[:0]
	f.mu.Unlock()

	if lastErr := f.exportRecords(records); lastErr != nil {
		// Sink failed: spool the records so they are not lost.
		f.appendToSpool(records)
		f.advanceBackoff()
		return lastErr
	}

	// Success: reset backoff.
	f.mu.Lock()
	f.backoffDelay = 0
	f.backoffUntil = time.Time{}
	f.mu.Unlock()
	return nil
}

func (f *EgressForwarder) flushLoop() {
	defer close(f.flushDone)
	for {
		select {
		case <-f.flushTicker.C:
			if err := f.Flush(); err != nil {
				f.logFlushError(err)
			}
		case <-f.stopCh:
			// Final drain: attempt one spool drain then flush live buffer.
			// Any remaining spool content stays on disk for the next launch.
			_ = f.drainSpool()
			f.mu.Lock()
			records := make([]egressRecord, len(f.buffer))
			copy(records, f.buffer)
			f.buffer = f.buffer[:0]
			f.mu.Unlock()
			if len(records) > 0 {
				if lastErr := f.exportRecords(records); lastErr != nil {
					f.appendToSpool(records)
				}
			}
			return
		}
	}
}

// ---------------------------------------------------------------------------
// Spool helpers
// ---------------------------------------------------------------------------

// appendToSpool writes records to the on-disk spool. If the spool would exceed
// spoolMaxB after appending, the oldest lines are trimmed.
func (f *EgressForwarder) appendToSpool(records []egressRecord) {
	lines := make([]string, 0, len(records))
	for _, r := range records {
		b, err := json.Marshal(r)
		if err != nil {
			continue
		}
		lines = append(lines, string(b))
	}
	if len(lines) == 0 {
		return
	}
	batch := strings.Join(lines, "\n") + "\n"

	file, err := os.OpenFile(f.spoolPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		Error("log_egress", fmt.Sprintf("spool open failed: %v", err))
		return
	}
	if _, err := file.WriteString(batch); err != nil {
		if closeErr := file.Close(); closeErr != nil {
			Error("log_egress", fmt.Sprintf("spool file close (on write error) failed: %v", closeErr))
		}
		Error("log_egress", fmt.Sprintf("spool write failed: %v", err))
		return
	}
	if closeErr := file.Close(); closeErr != nil {
		Error("log_egress", fmt.Sprintf("spool file close failed: %v", closeErr))
	}

	// Trim to cap after appending (oldest-first).
	if err := f.trimSpoolToCap(f.spoolMaxB); err != nil {
		Error("log_egress", fmt.Sprintf("spool trim failed: %v", err))
	}
}

// drainSpool reads all spooled records and ships them to the configured targets.
// On success it removes the spool file. Returns the first target error.
func (f *EgressForwarder) drainSpool() error {
	info, err := os.Stat(f.spoolPath)
	if os.IsNotExist(err) || (err == nil && info.Size() == 0) {
		return nil
	}
	if err != nil {
		return nil // can't stat — skip silently
	}

	data, err := os.ReadFile(f.spoolPath)
	if err != nil {
		return nil // can't read — skip
	}

	var records []egressRecord
	sc := bufio.NewScanner(strings.NewReader(string(data)))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var r egressRecord
		if json.Unmarshal([]byte(line), &r) == nil {
			records = append(records, r)
		}
	}

	if len(records) == 0 {
		_ = os.Remove(f.spoolPath)
		return nil
	}

	lastErr := f.exportRecords(records)

	if lastErr == nil {
		_ = os.Remove(f.spoolPath)
		Log("log_egress", fmt.Sprintf("spool drained: %d records shipped", len(records)))
	}
	return lastErr
}

// trimSpoolToCap ensures the spool file is at most maxBytes bytes by removing
// lines from the start (FIFO: oldest-first).
func (f *EgressForwarder) trimSpoolToCap(maxBytes int64) error {
	info, err := os.Stat(f.spoolPath)
	if os.IsNotExist(err) || err != nil {
		return nil
	}
	if info.Size() <= maxBytes {
		return nil
	}

	data, err := os.ReadFile(f.spoolPath)
	if err != nil {
		return err
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	// Drop lines from the front until the content fits.
	dropped := 0
	for int64(len(strings.Join(lines, "\n")+"\n")) > maxBytes && len(lines) > 0 {
		lines = lines[1:]
		dropped++
	}
	if dropped > 0 {
		Error("log_egress", fmt.Sprintf("spool cap exceeded: dropped %d oldest records (cap=%d bytes)", dropped, maxBytes))
	}
	newContent := strings.Join(lines, "\n") + "\n"
	return os.WriteFile(f.spoolPath, []byte(newContent), 0o644)
}

// advanceBackoff doubles the backoff delay (base 5 s, cap 5 min).
func (f *EgressForwarder) advanceBackoff() {
	f.mu.Lock()
	defer f.mu.Unlock()
	const base = 5 * time.Second
	const cap = 5 * time.Minute
	if f.backoffDelay == 0 {
		f.backoffDelay = base
	} else {
		f.backoffDelay = time.Duration(math.Min(float64(f.backoffDelay*2), float64(cap)))
	}
	f.backoffUntil = time.Now().Add(f.backoffDelay)
}

// logFlushError logs an egress flush failure once per distinct error string.
func (f *EgressForwarder) logFlushError(err error) {
	if err == nil {
		return
	}
	key := err.Error()
	f.mu.Lock()
	seen := f.loggedErrs[key]
	if !seen {
		f.loggedErrs[key] = true
	}
	f.mu.Unlock()
	if !seen {
		Error("log_egress", fmt.Sprintf(
			"egress flush failed (subsequent identical errors suppressed): targets=%v err=%v",
			f.cfg.EgressTargets, err))
	}
}

// ---------------------------------------------------------------------------
// Target implementations
// ---------------------------------------------------------------------------

// flushEgressToHTTP POSTs a JSON array of log records to endpoint.
func flushEgressToHTTP(records []egressRecord, endpoint string, headers map[string]string) error {
	if endpoint == "" {
		return fmt.Errorf("log egress HTTP endpoint not configured")
	}
	body, err := json.Marshal(records)
	if err != nil {
		return fmt.Errorf("log egress http: marshal: %w", err)
	}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("log egress http: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("log egress http: POST: %w", err)
	}
	if err := resp.Body.Close(); err != nil {
		Log("log_egress", fmt.Sprintf("http: response body close failed: %v", err))
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("log egress http: POST returned status %d", resp.StatusCode)
	}
	return nil
}
