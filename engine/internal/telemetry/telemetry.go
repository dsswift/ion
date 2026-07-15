// Package telemetry collects and exports structured events and spans.
package telemetry

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Event name constants.
const (
	SessionStart = "session.start"
	SessionEnd   = "session.end"
	LlmCall      = "llm.call"
	ToolExecute  = "tool.execute"
	Compaction   = "compaction"
	ErrorEvent   = "error"
	// RunComplete is emitted once per run at the session layer (in the
	// TaskCompleteEvent handler) so every backend — including CliBackend,
	// which emits no per-call spans — gets uniform run-level telemetry
	// (model, cost, duration, turn count, token usage).
	RunComplete = "run.complete"

	// --- Tier-4 instrumentation families ---
	// These name the additive telemetry events emitted across the engine's
	// trust, agent-loop, context-economy, provider, and platform-health
	// surfaces. Each is an opinionless data point routed through the same
	// Collector.Event pipeline; consumers subscribe and aggregate however
	// they choose.

	// Family 4a — Trust/Autonomy
	PermissionDecision = "permission.decision"
	SandboxBlock       = "sandbox.block"
	SecretContainment  = "secret.containment"

	// Family 4b — Agent-loop / Dispatch-tree
	DispatchAgent = "dispatch.agent"
	ToolFailure   = "tool.failure"

	// Family 4c — Context Economy
	ContextPressure = "context.pressure"
	// Compaction (declared above) is the context-economy compaction event.
	CacheSavings = "cache.savings"

	// Family 4d — Provider Market
	ProviderTTFT          = "provider.ttft"
	ProviderStall         = "provider.stall"
	ProviderStreamSummary = "provider.stream_summary"
	ProviderRetry         = "provider.retry"
	ProviderFallback      = "provider.fallback"

	// Family 4e — Platform Health
	ExtensionRespawn     = "extension.respawn"
	ExtensionColdstart   = "extension.coldstart"
	ExtensionHookLatency = "extension.hook_latency"
	ClientBackpressure   = "client.backpressure"
)

// Event is a single telemetry data point.
//
// Top-level fields follow the unified log contract (ADR-NNN):
//   - Ts:            RFC3339Nano UTC string (R1 — replaces the old int64 timestamp).
//   - SchemaVersion: contract version int (R4 — self-describing for central sinks).
//   - Component:     "engine" (R3 — surface discriminator).
//   - InstallID:     stable per-install anonymous UUID (R5, device ID per
//                    feature 0008 — minted once at ~/.ion/install_id, never
//                    changes, non-PII by design). Enables exact fleet counts and
//                    per-device time-series in operational dashboards.
//   - Host:          human-readable machine name (R19 — admin display).
//   - Version:       engine build string (R21 — which build emitted this line).
//   - EventID:       per-event unique ID (R22 — 16-char hex, for dedup during
//                    retry storms and exactly-once delivery semantics in sinks).
//   - User:          identity carrier (R20 — populated from enterprise OIDC
//                    auth context when present; omit-when-absent so open-source
//                    and default installs are unchanged). Seam for future auth.
type Event struct {
	Name          string `json:"name"`
	Ts            string `json:"ts"`
	SchemaVersion int    `json:"schema"`
	Component     string `json:"component"`
	InstallID     string `json:"install_id,omitempty"`
	Host          string `json:"host,omitempty"`
	Version       string `json:"version,omitempty"`
	// EventID is a per-event unique identifier (16 hex chars = 8 random bytes)
	// generated at emission time. Downstream sinks use it for deduplication
	// during retry storms. Empty on the schema_writer_changed sentinel (emitted
	// outside the normal Collector.Event path by stampSchemaCheckpoint).
	EventID string `json:"event_id,omitempty"`
	// User carries the authenticated user identity when an enterprise OIDC
	// auth context is present. Omitted (empty string, omitempty) on all
	// open-source and default installs. Set via SetUserIdentity; the seam
	// exists now so sinks can reserve the field even before OIDC lands.
	User    string         `json:"user,omitempty"`
	Payload map[string]any `json:"payload"`
	Context map[string]any `json:"context,omitempty"`
	// TraceID, when non-empty, pins this event to an existing trace so that
	// all events in one session share a single trace ID. When empty, the
	// OtelBridge generates a fresh per-event trace ID (legacy behavior).
	// Callers that hold a session context should stamp the session's trace ID
	// here to make cross-event correlation possible.
	TraceID string `json:"trace_id,omitempty"`
}

// SpanHandle tracks a timed operation in progress.
//
// start is captured at full monotonic-clock resolution (time.Time), not
// truncated to integer milliseconds. Truncating at capture time floored every
// sub-millisecond span (a fast tool.execute, a cache-hit llm.call, a quick
// dispatch.agent) to a 0ms duration, blanking the p99 duration panels for those
// spans. Retaining the time.Time lets End emit the fractional millisecond that
// float64(d.Microseconds())/1000.0 preserves, mirroring the extension.hook_latency
// precision fix. The OtelBridge still receives integer-millisecond start/end
// timestamps because the OTLP wire encodes nanoseconds-since-epoch derived from
// them; span *duration* precision lives in the duration_ms payload field.
type SpanHandle struct {
	name      string
	start     time.Time
	attrs     map[string]any
	ctx       map[string]any
	collector *Collector
}

// End completes the span and records it as an event. Optional extra attributes
// and an error message can be provided. The span's stored context (set via
// StartSpanCtx) is forwarded to Collector.Event so span-based events carry the
// same session_id / conversation_id as every other telemetry event.
func (s *SpanHandle) End(attrs map[string]any, errMsg ...string) {
	end := time.Now()
	// Sub-millisecond precision: microseconds→float milliseconds preserves the
	// fractional value that end.Sub(start).Milliseconds() would floor to 0.
	durationMs := float64(end.Sub(s.start).Microseconds()) / 1000.0
	payload := make(map[string]any, len(s.attrs)+len(attrs)+1)
	for k, v := range s.attrs {
		payload[k] = v
	}
	for k, v := range attrs {
		payload[k] = v
	}
	// R7: snake_case duration key.
	payload["duration_ms"] = durationMs
	if len(errMsg) > 0 && errMsg[0] != "" {
		payload["error"] = errMsg[0]
	}
	s.collector.Event(s.name, payload, s.ctx)

	// Forward span timing to OtelBridge if attached. The bridge expects
	// integer-millisecond epoch timestamps for OTLP start/end conversion.
	s.collector.mu.Lock()
	bridge := s.collector.otelBridge
	s.collector.mu.Unlock()
	if bridge != nil {
		bridge.RecordSpan(s.name, s.start.UnixMilli(), end.UnixMilli(), payload)
	}
}

// Collector buffers telemetry events and flushes them to configured targets.
type Collector struct {
	config     types.TelemetryConfig
	buffer     []Event
	mu         sync.Mutex
	otelBridge *OtelBridge
	// loggedFlushErrs deduplicates flush-failure ERROR logs. A misconfigured
	// file target (e.g. an unwritable path, or the "~/" tilde-expansion bug
	// this rate-limiting was added alongside) fails on every batch flush, and a
	// batch flush fires as often as events arrive. Logging every failure would
	// flood engine.jsonl with thousands of identical lines. We key on the error
	// string and log each DISTINCT failure once, so the operator sees the
	// problem exactly once per distinct cause without the flood. Guarded by mu.
	loggedFlushErrs map[string]bool

	// Periodic-flush machinery. flushTicker is non-nil when the collector is
	// running a background flush loop. stopCh signals the loop to drain and
	// exit; flushDone is closed after the loop performs its final flush. All
	// three are set once in NewCollector and never mutated after that, so they
	// are safe to read outside mu after construction.
	flushTicker *time.Ticker
	stopCh      chan struct{}
	flushDone   chan struct{}
	closeOnce   sync.Once
}

// SetOtelBridge attaches an OpenTelemetry bridge to the collector.
// When set, Event() and span End() also forward to the bridge.
func (c *Collector) SetOtelBridge(bridge *OtelBridge) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.otelBridge = bridge
}

// normalizeTelemetryConfig applies opinionated defaults to an enabled config.
// Called only from NewCollector — all defaulting lives here, not at the
// struct-default level (the json tags are omitempty; struct defaults would be
// wrong). It only fills genuinely-empty fields and only when Enabled is true;
// operators that set values explicitly keep their values unchanged.
//
//   - If Enabled and Targets is nil (field absent in JSON / struct zero value),
//     defaults to ["file"]. A non-nil but empty slice (Targets: []string{})
//     means "no sinks" and is left unchanged — this is the distinction that
//     prevents test collectors from writing to the real ~/.ion/telemetry.jsonl.
//   - If "file" is among the (possibly-defaulted) targets and FilePath is
//     empty, defaults to ~/.ion/telemetry.jsonl (tilde expanded to the real
//     home directory via utils.ExpandHomePath).
//   - If FlushIntervalMs is zero, defaults to 5 000 ms (5 seconds), providing
//     near-real-time dashboard visibility without the batch-size trigger.
//
// When Enabled is false, the config is returned unchanged (the collector is a
// no-op anyway, so defaults would never be used).
//
// nil vs empty Targets: Go's encoding/json unmarshals an absent JSON field to
// nil and an explicit [] to a non-nil empty slice. The distinction is therefore
// meaningful and config-loading-safe: operators who omit "targets" get the
// file default; operators who set "targets":[] get no sinks (unusual but
// intentional). Tests that want in-memory-only collection set Targets to
// []string{} to opt out of all file I/O without touching FilePath.
func normalizeTelemetryConfig(cfg types.TelemetryConfig) types.TelemetryConfig {
	if !cfg.Enabled {
		return cfg
	}
	if cfg.Targets == nil {
		// nil means unset (absent from JSON or zero-value struct) → apply the
		// production default of writing to the file sink.
		cfg.Targets = []string{"file"}
	}
	// A non-nil empty slice ([]string{}) means the caller explicitly wants no
	// sinks. Leave it unchanged so no file I/O occurs.
	if cfg.FilePath == "" {
		for _, t := range cfg.Targets {
			if t == "file" {
				cfg.FilePath = utils.ExpandHomePath("~/.ion/telemetry.jsonl")
				break
			}
		}
	}
	if cfg.FlushIntervalMs == 0 {
		cfg.FlushIntervalMs = 5000
	}
	return cfg
}

// NewCollector creates a Collector from the given config. If config.Enabled is
// false, all recording methods are no-ops but remain safe to call.
//
// When Enabled is true and the operator has not explicitly set targets or a
// filePath, NewCollector applies sensible defaults (file target at
// ~/.ion/telemetry.jsonl) so that {"telemetry":{"enabled":true}} is a
// complete, working configuration with no additional fields required.
//
// A periodic flush goroutine is started whenever Enabled is true and at least
// one of "file", "stdout", or "http" targets is configured. The goroutine
// flushes on the configured FlushIntervalMs cadence (default 5 s) so events
// reach disk continuously — not only at session teardown. Call Close() during
// engine shutdown to stop the goroutine and drain any remaining buffered
// events. Close is idempotent and safe to call multiple times.
//
// On first call (sync.Once-guarded), NewCollector runs the schema checkpoint
// that archives the telemetry file when the on-disk schema version is older
// than TelemetrySchemaVersion. This ensures the live file is always
// single-schema before any events are recorded.
func NewCollector(config types.TelemetryConfig) *Collector {
	config = normalizeTelemetryConfig(config)
	c := &Collector{
		config:          config,
		buffer:          make([]Event, 0, 64),
		loggedFlushErrs: make(map[string]bool),
		stopCh:          make(chan struct{}),
		flushDone:       make(chan struct{}),
	}

	// Run the schema checkpoint exactly once per process (covers both the
	// server.go and start_session.go call sites). The checkpoint archives any
	// pre-existing telemetry file whose schema version predates the current
	// TelemetrySchemaVersion and writes a fresh sidecar so the observability
	// stack knows what schema version is live.
	if config.Enabled && config.FilePath != "" {
		checkpointAndRotate(utils.ExpandHomePath(config.FilePath), engineVersion())
	}

	// Start the periodic flush loop when enabled and a persistent target is
	// present. The loop flushes on FlushIntervalMs and performs a final drain
	// on stopCh so no events are lost on clean shutdown. The batch-size trigger
	// in Event() remains as belt-and-suspenders: whichever fires first wins.
	if config.Enabled && hasFlushableTarget(config.Targets) {
		interval := time.Duration(config.FlushIntervalMs) * time.Millisecond
		c.flushTicker = time.NewTicker(interval)
		go c.flushLoop()
	} else {
		// No flush loop — close flushDone immediately so Close() does not
		// block waiting for a goroutine that was never started.
		close(c.flushDone)
	}

	return c
}

// hasFlushableTarget reports whether any of the configured targets are
// external (file, stdout, http). These are the targets that benefit from
// periodic flushing; a collector with no targets (or only in-memory use)
// does not need a background goroutine.
func hasFlushableTarget(targets []string) bool {
	for _, t := range targets {
		switch t {
		case "file", "stdout", "http":
			return true
		}
	}
	return false
}

// flushLoop runs as a goroutine and flushes on the ticker cadence. On stopCh
// it performs one final flush (draining any events buffered since the last
// tick) then closes flushDone so Close() can return.
func (c *Collector) flushLoop() {
	defer close(c.flushDone)
	for {
		select {
		case <-c.flushTicker.C:
			if err := c.Flush(); err != nil {
				c.LogFlushError(err)
			}
		case <-c.stopCh:
			// Final drain: flush whatever is still buffered before exiting.
			if err := c.Flush(); err != nil {
				c.LogFlushError(err)
			}
			return
		}
	}
}

// Close stops the periodic flush goroutine and waits for the final drain to
// complete. Safe to call multiple times — subsequent calls are no-ops. Must
// be called during engine shutdown so any events buffered since the last tick
// reach disk before the process exits.
func (c *Collector) Close() {
	c.closeOnce.Do(func() {
		if c.flushTicker != nil {
			c.flushTicker.Stop()
		}
		close(c.stopCh)
		<-c.flushDone
	})
}

// Event records a named event with payload and optional context.
func (c *Collector) Event(name string, payload, ctx map[string]any) {
	if !c.config.Enabled {
		return
	}
	e := Event{
		Name:          name,
		Ts:            time.Now().UTC().Format(time.RFC3339Nano),
		SchemaVersion: TelemetrySchemaVersion,
		Component:     "engine",
		InstallID:     resolvedInstallID(),
		Host:          resolvedHost(),
		Version:       engineVersion(),
		// EventID: per-event unique ID for downstream dedup (R22).
		EventID: genSpanID(),
		// User: populated when enterprise OIDC auth context is present (R20).
		User:    resolvedUserIdentity(),
		Payload: payload,
		Context: ctx,
	}
	c.mu.Lock()
	c.buffer = append(c.buffer, e)
	batchSize := c.config.BatchSize
	bridge := c.otelBridge
	c.mu.Unlock()

	if bridge != nil {
		bridge.RecordEvent(e)
	}

	if batchSize > 0 {
		c.mu.Lock()
		shouldFlush := len(c.buffer) >= batchSize
		c.mu.Unlock()
		if shouldFlush {
			if err := c.Flush(); err != nil {
				c.LogFlushError(err)
			}
		}
	}
}

// LogFlushError logs a telemetry flush failure at ERROR level, rate-limited to
// once per distinct error string. A failing file target flushes on every batch
// and would otherwise flood the log with identical lines; deduplicating on the
// error message surfaces each distinct cause exactly once. The configured file
// target path is included so the operator can see WHICH target failed (this is
// the exact signal whose absence made the "~/" tilde-expansion bug invisible).
// Exported so out-of-package flush sites (e.g. session teardown) route their
// flush failures through the same rate-limited path.
func (c *Collector) LogFlushError(err error) {
	if err == nil {
		return
	}
	key := err.Error()
	c.mu.Lock()
	seen := c.loggedFlushErrs[key]
	if !seen {
		c.loggedFlushErrs[key] = true
	}
	c.mu.Unlock()
	if seen {
		return
	}
	utils.LogWithFields(utils.LevelError, "telemetry", "flush failed subsequent identical errors suppressed", map[string]any{
		"status": c.config.Targets, "path": c.config.FilePath, "error": err.Error(),
	})
}

// StartSpan begins a timed span. Call End on the returned handle to complete it.
// The emitted event carries no correlation context; use StartSpanCtx when the
// caller holds a run context (session_id / conversation_id).
func (c *Collector) StartSpan(name string, attrs map[string]any) *SpanHandle {
	return c.StartSpanCtx(name, attrs, nil)
}

// StartSpanCtx begins a timed span with an explicit correlation context.
// ctx is stored on the handle and forwarded to Collector.Event when End is
// called, so the emitted event carries session_id and conversation_id just
// like every direct Collector.Event call site that passes buildTelemCtx(run).
func (c *Collector) StartSpanCtx(name string, attrs, ctx map[string]any) *SpanHandle {
	return &SpanHandle{
		name:      name,
		start:     time.Now(),
		attrs:     attrs,
		ctx:       ctx,
		collector: c,
	}
}

// BufferedEvents returns a copy of the events currently buffered but not yet
// flushed. Intended for observability and for consumers (and tests) that need
// to inspect what the collector has recorded without draining it. Returns a
// snapshot under the lock so callers never race the buffer.
func (c *Collector) BufferedEvents() []Event {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]Event, len(c.buffer))
	copy(out, c.buffer)
	return out
}

// Flush exports all buffered events to the configured targets and clears the buffer.
func (c *Collector) Flush() error {
	c.mu.Lock()
	if len(c.buffer) == 0 {
		c.mu.Unlock()
		return nil
	}
	events := make([]Event, len(c.buffer))
	copy(events, c.buffer)
	c.buffer = c.buffer[:0]
	c.mu.Unlock()

	var lastErr error
	for _, target := range c.config.Targets {
		switch target {
		case "file":
			if err := flushToFile(events, c.config.FilePath); err != nil {
				lastErr = err
			}
		case "stdout":
			if err := flushToStdout(events); err != nil {
				lastErr = err
			}
		case "http":
			if err := flushToHTTP(events, c.config.HttpEndpoint, c.config.HttpHeaders); err != nil {
				lastErr = err
			}
		}
	}
	return lastErr
}

func flushToFile(events []Event, path string) error {
	if path == "" {
		return fmt.Errorf("telemetry file path not configured")
	}
	// engine.json is human-edited, so filePath routinely arrives as "~/...".
	// Go performs no shell tilde expansion, so os.OpenFile would try to create
	// a directory literally named "~" and fail. Expand here, at the point the
	// path reaches the filesystem, so every caller resolves the path uniformly.
	path = utils.ExpandHomePath(path)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer func() {
		if err := f.Close(); err != nil {
			utils.LogWithFields(utils.LevelInfo, "telemetry", "append to file close failed", map[string]any{"path": path, "error": err.Error()})
		}
	}()

	enc := json.NewEncoder(f)
	for _, e := range events {
		if err := enc.Encode(e); err != nil {
			return err
		}
	}
	return nil
}

func flushToStdout(events []Event) error {
	enc := json.NewEncoder(os.Stdout)
	for _, e := range events {
		if err := enc.Encode(e); err != nil {
			return err
		}
	}
	return nil
}

func flushToHTTP(events []Event, endpoint string, headers map[string]string) error {
	if endpoint == "" {
		return fmt.Errorf("telemetry HTTP endpoint not configured")
	}
	body, err := json.Marshal(events)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	if err := resp.Body.Close(); err != nil {
		utils.LogWithFields(utils.LevelInfo, "telemetry", "http post response body close failed", map[string]any{"error": err.Error()})
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("telemetry HTTP POST returned status %d", resp.StatusCode)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Package-level process-singleton dimensions.
// Resolved once (lazy, atomic) and stamped on every emitted event.
// ---------------------------------------------------------------------------

// engineVer holds the engine build version. Set via SetEngineVersion; defaults
// to "dev" (the same value the binary is built with when VERSION is unset).
var engineVer atomic.Value

// SetEngineVersion records the engine binary version so every telemetry event
// carries it. Call once at startup (e.g. from cmd_serve after reading the
// linked-in version var). Safe to call multiple times; last write wins.
func SetEngineVersion(v string) {
	engineVer.Store(v)
}

// engineVersion returns the stored engine version, defaulting to "dev".
func engineVersion() string {
	if v, ok := engineVer.Load().(string); ok && v != "" {
		return v
	}
	return "dev"
}

var (
	hostOnce   sync.Once
	resolvedH  string
)

// resolvedHost returns the machine hostname, resolved once per process.
func resolvedHost() string {
	hostOnce.Do(func() {
		if h, err := os.Hostname(); err == nil {
			resolvedH = h
		}
	})
	return resolvedH
}

// ---------------------------------------------------------------------------
// user identity: enterprise OIDC carrier for R20.
// Empty by default; set via SetUserIdentity when enterprise auth lands.
// ---------------------------------------------------------------------------

// resolvedUserV holds the authenticated user identity stamped on every emitted
// event when enterprise OIDC auth is present. Set via SetUserIdentity.
// Empty (the default for all open-source and default installs) produces the
// omitempty behavior — the "user" field is absent from the wire envelope.
var resolvedUserV atomic.Value

// SetUserIdentity records the authenticated user identity so every subsequent
// telemetry event carries it in the "user" field (R20, feature 0008 carrier).
// Call with the resolved OIDC subject/email when enterprise auth succeeds.
// Call with "" to clear it (e.g. on session end or auth expiry).
// Safe to call multiple times; last write wins. Thread-safe.
func SetUserIdentity(identity string) {
	resolvedUserV.Store(identity)
}

// resolvedUserIdentity returns the current user identity, or "" when not set.
func resolvedUserIdentity() string {
	if v, ok := resolvedUserV.Load().(string); ok {
		return v
	}
	return ""
}

// ---------------------------------------------------------------------------
// install_id: stable per-install anonymous UUID persisted at ~/.ion/install_id.
// Minted once on first engine run; never changed. Non-PII by design.
// ---------------------------------------------------------------------------

var (
	installIDOnce   sync.Once
	resolvedInstall string
)

// resolvedInstallID returns the per-install anonymous UUID, minting it on the
// first call. Thread-safe.
func resolvedInstallID() string {
	installIDOnce.Do(func() {
		resolvedInstall = loadOrMintInstallID()
	})
	return resolvedInstall
}

// loadOrMintInstallID reads ~/.ion/install_id, minting a fresh UUID if absent.
func loadOrMintInstallID() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	idPath := filepath.Join(home, ".ion", "install_id")
	if data, err := os.ReadFile(idPath); err == nil {
		id := string(data)
		// Trim whitespace/newlines from a human-edited file.
		for len(id) > 0 && (id[len(id)-1] == '\n' || id[len(id)-1] == '\r' || id[len(id)-1] == ' ') {
			id = id[:len(id)-1]
		}
		if id != "" {
			return id
		}
	}
	// Mint a new UUID using crypto/rand via the genTraceID helper (32-hex →
	// format as 8-4-4-4-12 UUID). We generate 16 random bytes directly for the
	// standard UUID shape.
	id := mintInstallID()
	_ = os.MkdirAll(filepath.Dir(idPath), 0o700)
	_ = os.WriteFile(idPath, []byte(id+"\n"), 0o600)
	utils.LogWithFields(utils.LevelInfo, "telemetry", "install id minted", map[string]any{"status": id})
	return id
}

// mintInstallID generates a new random UUID v4 string.
func mintInstallID() string {
	// Use 16 random bytes → UUID v4 format.
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// Fallback: use genTraceID (32 hex chars) as a non-UUID unique ID.
		return genTraceID()
	}
	// Set version 4 and variant bits.
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
