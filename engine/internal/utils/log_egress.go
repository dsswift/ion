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
// hot-looping against a dead sink. The spool file mechanics themselves live in
// log_egress_spool.go, which documents the bounded-memory invariant they obey.
//
// Two caps, two jobs: the spool cap bounds DISK, the buffer cap
// (EgressBufferMaxRecords) bounds HEAP. A sink that fails indefinitely must
// grow neither — records move from the buffer to the spool on every failed
// flush, and the spool trims oldest-first from there.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
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

// defaultEgressChunkSize is the maximum number of records per POST when
// draining the spool. 500 records at ~350 bytes each ≈ 175 KB per POST, well
// within the limits of any intermediate proxy (Cloudflare caps at 100 MB;
// nginx/Traefik default to 1 MB). Configurable via LoggingConfig.EgressChunkSize.
const defaultEgressChunkSize = 500

// defaultEgressRequestTimeoutMs is the per-POST HTTP timeout for egress
// flushes. 5 minutes is generous enough for a large spool chunk over a slow
// link while still guaranteeing the flush goroutine can't block indefinitely.
// Configurable via LoggingConfig.EgressRequestTimeoutMs.
const defaultEgressRequestTimeoutMs = 5 * 60 * 1000

// defaultEgressBufferMaxRecords caps the in-memory staging buffer. At the
// ~350-byte average record size this is ~17 MB of heap — enough to absorb a
// multi-minute sink outage at a high log rate, small enough that a permanently
// dead sink cannot grow the engine's heap without limit. Overflow evicts
// oldest-first, mirroring the spool cap; the durable overflow path is the
// on-disk spool, not RAM. Configurable via LoggingConfig.EgressBufferMaxRecords.
const defaultEgressBufferMaxRecords = 50_000

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

	// --- Telemetry-event carrier fields ---
	//
	// A telemetry event ({name, ts, schema, component, payload, context, ...})
	// is a DISTINCT shape from an operational log line ({ts, level, msg, ...,
	// fields}). The engine egress tailer (log_egress_tailer.go) ships
	// ~/.ion/telemetry.jsonl verbatim, so those events arrive here. These fields
	// carry the parsed telemetry envelope so the OTLP exporter can map them to
	// the file-tail-parity attribute set (kind/service/payload/context) instead
	// of stuffing the raw JSON into Msg — which the remote ion_otlp_unwrap
	// pipeline cannot recognize as telemetry. All omitempty so operational
	// records serialize unchanged and the fields survive the spool JSON
	// round-trip. Mirrors the desktop EgressRecord index-signature carrying the
	// parsed telemetry event (desktop/src/main/log-egress-otel.ts).
	Name      string         `json:"name,omitempty"`
	Payload   map[string]any `json:"payload,omitempty"`
	Context   map[string]any `json:"context,omitempty"`
	Schema    any            `json:"schema,omitempty"`
	InstallID string         `json:"install_id,omitempty"`
	Version   string         `json:"version,omitempty"`
	// Host and EventID complete the telemetry v3 envelope in the OTLP body so
	// the shipped body is lossless (the remote Fleet dashboard queries `host`
	// from the telemetry stream, and `event_id` is the downstream-dedup key).
	// They are carried in the BODY only — the attribute set omits them to stay
	// byte-identical with the desktop otlpAttrsFromTelemetryEvent. The telemetry
	// envelope is a versioned typed contract (telemetry.Event); a schema field
	// addition updates that struct and this carrier in lockstep.
	Host    string `json:"host,omitempty"`
	EventID string `json:"event_id,omitempty"`
}

// EgressForwarder buffers operational log lines and ships them to one or more
// downstream targets ("http", "otel"). Constructed by newEgressForwarder and
// stored as a package-level singleton in logger.go (activeEgressForwarder).
type EgressForwarder struct {
	cfg types.LoggingConfig
	// shipOwn gates whether the engine's own in-process records enter the
	// buffer (matrix source "engine"). Tailed sources bypass the gate via
	// shipTailed — a forwarder may exist solely to ship tailed files.
	shipOwn   bool
	spoolPath string
	spoolMaxB int64
	// httpClient is the shared HTTP client for all egress POSTs. Built once at
	// construction with the configured per-request timeout; never mutated after
	// that. Using a dedicated client (rather than http.DefaultClient) ensures
	// the timeout is scoped to egress only and does not affect other callers.
	httpClient *http.Client
	// ambientFields are stable machine-identity fields (host, machine_id,
	// mdm_device_id, mdm_serial) merged into every egress record. Populated
	// once at construction from getMachineIdentity(); never mutated after that.
	// Caller-supplied fields take precedence — ambient only fills absent keys.
	ambientFields map[string]any

	// bufferMax caps how many records may sit in the in-memory buffer. The
	// buffer is a staging area, not storage: the durable overflow path is the
	// on-disk spool, which is bounded by spoolMaxB. Without this cap a sink
	// that fails every flush grows the buffer without limit for as long as the
	// engine keeps logging — the heap becomes the unbounded queue that the
	// spool cap exists to prevent. Zero means the compiled default.
	bufferMax int

	// spoolMu serializes every read/write/rewrite of the spool file. The flush
	// goroutine and a batch-size-triggered Flush on a logging goroutine can
	// both enter the spool path concurrently; without this they double-ship
	// records and clobber each other's rewrite.
	spoolMu sync.Mutex

	mu         sync.Mutex
	buffer     []egressRecord
	loggedErrs map[string]bool // dedup flush-error log lines (mirrors Collector)
	// bufferDropped counts records evicted from the in-memory buffer because
	// it hit bufferMax. Reported from the flush path, never from enqueue:
	// logging inside enqueue would re-enter ship → enqueue and recurse.
	bufferDropped int64

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

	requestTimeoutMs := cfg.EgressRequestTimeoutMs
	if requestTimeoutMs <= 0 {
		requestTimeoutMs = defaultEgressRequestTimeoutMs
	}

	// Locate the spool alongside ~/.ion/engine.jsonl.
	home, _ := os.UserHomeDir() //nolint:errcheck // empty home handled by caller
	spoolPath := filepath.Join(home, ".ion", ".engine-egress-spool.jsonl")

	f := &EgressForwarder{
		cfg:           cfg,
		shipOwn:       shipSourcesContain(sources, "engine"),
		spoolPath:     spoolPath,
		spoolMaxB:     spoolMax,
		bufferMax:     cfg.EgressBufferMaxRecords,
		httpClient:    &http.Client{Timeout: time.Duration(requestTimeoutMs) * time.Millisecond},
		buffer:        make([]egressRecord, 0, 64),
		loggedErrs:    make(map[string]bool),
		stopCh:        make(chan struct{}),
		flushDone:     make(chan struct{}),
		ambientFields: ambientFieldsFromIdentity(getMachineIdentity()),
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
// shipTailed. Stamps a per-record event_id (when absent) and merges ambient
// machine-identity fields into the record before buffering: ambient fills
// absent keys; caller-supplied fields take precedence.
func (f *EgressForwarder) enqueue(rec egressRecord) {
	// Stamp a unique event_id when the record does not already carry one. This
	// is the single construction chokepoint both ship and shipTailed funnel
	// through, so engine-own records get an id here, while a tailed telemetry
	// record that already parsed its own event_id keeps it (downstream-dedup
	// key). 16 hex chars, matching the telemetry event_id shape.
	if rec.EventID == "" {
		rec.EventID = GenEventID()
	}
	if len(f.ambientFields) > 0 {
		if rec.Fields == nil {
			merged := make(map[string]any, len(f.ambientFields))
			for k, v := range f.ambientFields {
				merged[k] = v
			}
			rec.Fields = merged
		} else {
			for k, v := range f.ambientFields {
				if _, exists := rec.Fields[k]; !exists {
					rec.Fields[k] = v
				}
			}
		}
	}
	f.mu.Lock()
	f.buffer = append(f.buffer, rec)
	// Evict oldest on overflow (same drop-oldest policy as the spool cap).
	// The eviction is not logged here: Error() routes back through logAtFull →
	// ship → enqueue, and an overflowing buffer would recurse forever. The
	// count is reported from the flush path instead.
	if max := f.bufferMaxRecords(); len(f.buffer) > max {
		excess := len(f.buffer) - max
		f.buffer = f.buffer[excess:]
		f.bufferDropped += int64(excess)
	}
	batchSize := f.cfg.EgressBatchSize
	shouldFlush := batchSize > 0 && len(f.buffer) >= batchSize
	f.mu.Unlock()

	if shouldFlush {
		if err := f.Flush(); err != nil {
			f.logFlushError(err)
		}
	}
}

// bufferMaxRecords resolves the in-memory buffer cap (configured or default).
func (f *EgressForwarder) bufferMaxRecords() int {
	if f.bufferMax > 0 {
		return f.bufferMax
	}
	return defaultEgressBufferMaxRecords
}

// takeBuffer atomically removes and returns every buffered record.
func (f *EgressForwarder) takeBuffer() []egressRecord {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.buffer) == 0 {
		return nil
	}
	records := make([]egressRecord, len(f.buffer))
	copy(records, f.buffer)
	f.buffer = f.buffer[:0]
	return records
}

// reportBufferDrops logs and clears the pending buffer-overflow count. Called
// from the flush path, never from enqueue — see EgressForwarder.bufferDropped.
func (f *EgressForwarder) reportBufferDrops() {
	f.mu.Lock()
	dropped := f.bufferDropped
	f.bufferDropped = 0
	f.mu.Unlock()
	if dropped > 0 {
		Error("log_egress", fmt.Sprintf(
			"egress buffer overflow: dropped %d oldest records (cap=%d); sink has been failing long enough to fill the in-memory buffer",
			dropped, f.bufferMaxRecords()))
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
			if err := flushEgressToHTTP(records, f.cfg.EgressEndpoint, httpHeaders, f.httpClient); err != nil {
				lastErr = err
			}
		case "otel":
			if err := flushEgressToOtel(records, otelCfg, f.httpClient); err != nil {
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

	f.reportBufferDrops()

	// Drain the spool before the live buffer (FIFO delivery order).
	if err := f.drainSpool(); err != nil {
		// Spool drain failed → the sink is down. Move the live buffer to the
		// spool anyway: the spool is bounded by EgressSpoolMaxBytes, the
		// in-memory buffer is bounded only by bufferMax and costs heap. Leaving
		// records buffered here on every failed drain is what let a dead sink
		// convert an outage into unbounded memory growth.
		if records := f.takeBuffer(); len(records) > 0 {
			f.appendToSpool(records)
		}
		f.advanceBackoff()
		return err
	}

	// Now flush the live buffer.
	records := f.takeBuffer()
	if len(records) == 0 {
		return nil
	}

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
			f.drainSpool() //nolint:errcheck // best-effort; failure not actionable here
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

// flushEgressToHTTP POSTs a JSON array of log records to endpoint using client.
func flushEgressToHTTP(records []egressRecord, endpoint string, headers map[string]string, client *http.Client) error {
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
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("log egress http: POST: %w", err)
	}
	if resp.StatusCode >= 400 {
		// Read up to 512 bytes of the error body so the rejection reason
		// appears in engine.jsonl instead of a bare status code.
		errBody, readErr := io.ReadAll(io.LimitReader(resp.Body, 512))
		if closeErr := resp.Body.Close(); closeErr != nil {
			Log("log_egress", fmt.Sprintf("http: response body close (error path) failed: %v", closeErr))
		}
		if readErr != nil || len(errBody) == 0 {
			return fmt.Errorf("log egress http: POST returned status %d", resp.StatusCode)
		}
		return fmt.Errorf("log egress http: POST returned status %d: %s", resp.StatusCode, strings.TrimSpace(string(errBody)))
	}
	if err := resp.Body.Close(); err != nil {
		Log("log_egress", fmt.Sprintf("http: response body close failed: %v", err))
	}
	return nil
}
