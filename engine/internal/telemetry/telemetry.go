// Package telemetry collects and exports structured events and spans.
package telemetry

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dsswift/ion/engine/internal/durablefile"
	"github.com/dsswift/ion/engine/internal/network"
	"github.com/dsswift/ion/engine/internal/telemetryformat"
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
	// TaskCompleteEvent handler) so every backend — including ClaudeCodeBackend,
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

	// Family 4f — Enterprise enforcement (D-018 / feature 0010 audit clause).
	// Each names an enforcement action taken as an enterprise policy seal is
	// applied — a tool/model/provider/server was blocked, pruned, pinned, or a
	// session limit rejected a start. Routed through the same Collector.Event
	// pipeline; the payload carries the subject, the policy source, and any
	// correlation context in scope. Additive event names only — the telemetry
	// schema is unchanged (no version bump).
	EnforcementToolBlocked      = "enforcement.tool_blocked"
	EnforcementModelRejected    = "enforcement.model_rejected"
	EnforcementProviderPruned   = "enforcement.provider_pruned"
	EnforcementProviderPinned   = "enforcement.provider_pinned"
	EnforcementMcpPruned        = "enforcement.mcp_pruned"
	EnforcementSessionLimit     = "enforcement.session_limit"
	EnforcementExtensionBlocked = "enforcement.extension_blocked"
)

// Event is one expanded telemetry data point. The file target compacts a flush
// into a v4 telemetry frame; in-memory and non-file targets retain this shape.
type Event = telemetryformat.Event

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

	// Forward span timing to OtelBridge if attached. The bridge receives both
	// payload and correlation context: trace_id lives in the latter, and losing
	// it here used to make llm.call/tool.execute OTLP spans mint a fresh trace
	// per event even while their JSONL telemetry correctly carried the run trace.
	// Keep the two maps separate so correlation keys remain ctx.* attributes on
	// the OTLP event path rather than silently colliding with payload keys.
	s.collector.mu.Lock()
	bridge := s.collector.otelBridge
	s.collector.mu.Unlock()
	if bridge != nil {
		bridge.RecordSpan(s.name, s.start.UnixMilli(), end.UnixMilli(), payload, s.ctx)
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

	if config.Enabled && hasOtelTarget(config.Targets) && config.Otel != nil && config.Otel.Enabled && config.Otel.Endpoint != "" {
		bridgeConfig := OtelConfig{
			Endpoint:           config.Otel.Endpoint,
			Protocol:           config.Otel.Protocol,
			Headers:            config.Otel.Headers,
			ServiceName:        config.Otel.ServiceName,
			ResourceAttributes: config.Otel.ResourceAttributes,
		}
		if config.FlushIntervalMs > 0 {
			bridgeConfig.FlushInterval = time.Duration(config.FlushIntervalMs) * time.Millisecond
		}
		c.otelBridge = NewOtelBridge(bridgeConfig)
	}

	// Run the schema checkpoint exactly once per process (covers both the
	// server.go and start_session.go call sites). The checkpoint archives any
	// pre-existing telemetry file whose schema version predates the current
	// TelemetrySchemaVersion and writes a fresh sidecar so the observability
	// stack knows what schema version is live.
	if config.Enabled && config.FilePath != "" {
		checkpointAndRotate(utils.ExpandHomePath(config.FilePath), engineVersion())

		// Report the resolved rotation policy so the live bound on the file is
		// readable from engine.jsonl without reading engine.json. Both arms log:
		// an unbounded file is the case an operator most needs to see.
		p := resolveRotation(config.MaxSizeMB, config.MaxFiles, config.DisableRotation)
		if p.maxBytes <= 0 {
			utils.LogWithFields(utils.LevelWarn, "telemetry", "file target rotation disabled file will grow unbounded", map[string]any{
				"path": utils.ExpandHomePath(config.FilePath),
			})
		} else {
			utils.LogWithFields(utils.LevelInfo, "telemetry", "file target rotation policy resolved", map[string]any{
				"path":      utils.ExpandHomePath(config.FilePath),
				"max_bytes": p.maxBytes,
				"max_files": p.maxFiles,
				"max_total": p.maxBytes * int64(p.maxFiles+1),
			})
		}
	}

	// Start the periodic flush loop when enabled and a persistent target is
	// present. The loop flushes on FlushIntervalMs and performs a final drain
	// on stopCh so no events are lost on clean shutdown. The batch-size trigger
	// in Event() remains as belt-and-suspenders: whichever fires first wins.
	if config.Enabled && hasFlushableTarget(config.Targets, c.otelBridge != nil) {
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

func hasOtelTarget(targets []string) bool {
	for _, target := range targets {
		if target == "otel" {
			return true
		}
	}
	return false
}

// hasFlushableTarget reports whether any configured target needs the collector
// flush loop. The OTLP bridge needs it only when it was configured successfully.
func hasFlushableTarget(targets []string, otelConfigured bool) bool {
	for _, t := range targets {
		switch t {
		case "file", "stdout", "http":
			return true
		case "otel":
			if otelConfigured {
				return true
			}
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
		c.mu.Lock()
		bridge := c.otelBridge
		c.mu.Unlock()
		if bridge != nil {
			if err := bridge.Close(); err != nil {
				c.LogFlushError(err)
			}
		}
	})
}

// traceIDFromCorrelationContext extracts the run-scoped trace ID from the
// correlation map passed through telemetry emission sites. Context is the
// canonical carrier for session_id/conversation_id/run_id/trace_id; Event's
// top-level TraceID mirrors the same value solely because the OTLP bridge reads
// that field when it builds a span. Keeping this one explicit seam prevents the
// JSONL and OTLP representations of a run from drifting into separate traces.
//
// Empty/malformed values deliberately return "": the OtelBridge then mints an
// independent trace for a standalone event rather than exporting a malformed
// W3C traceparent. The session layer only supplies valid IDs, but this keeps
// Collector.Event safe for all direct callers.
func traceIDFromCorrelationContext(ctx map[string]any) string {
	if ctx == nil {
		return ""
	}
	traceID, _ := ctx["trace_id"].(string) //nolint:errcheck // non-string trace correlation is unusable; treat as absent
	if !isValidTraceID(traceID) {
		return ""
	}
	return traceID
}

// isValidTraceID applies the W3C trace-context trace-id constraints without
// making the telemetry package depend on a third-party tracing SDK: exactly 16
// bytes rendered as lowercase hex, and never all zero. Invalid input is never
// exported as a parent trace because a conformant backend must reject it.
func isValidTraceID(traceID string) bool {
	if len(traceID) != 32 || traceID == "00000000000000000000000000000000" {
		return false
	}
	for _, r := range traceID {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return false
		}
	}
	return true
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
		TraceID: traceIDFromCorrelationContext(ctx),
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
			rotation := resolveRotation(c.config.MaxSizeMB, c.config.MaxFiles, c.config.DisableRotation)
			if err := flushToFile(events, c.config.FilePath, rotation); err != nil {
				lastErr = err
			}
		case "stdout":
			if err := flushToStdout(events); err != nil {
				lastErr = err
			}
		case "otel":
			c.mu.Lock()
			bridge := c.otelBridge
			c.mu.Unlock()
			if bridge != nil {
				if err := bridge.Flush(); err != nil {
					lastErr = err
				}
			}
		case "http":
			if err := flushToHTTP(events, c.config.HttpEndpoint, c.config.HttpHeaders); err != nil {
				lastErr = err
			}
		}
	}
	return lastErr
}

func flushToFile(events []Event, path string, rotation rotationPolicy) error {
	if path == "" {
		return fmt.Errorf("telemetry file path not configured")
	}
	frameEvents := make([]telemetryformat.Event, len(events))
	for i, event := range events {
		if event.SchemaVersion == 0 {
			event.SchemaVersion = TelemetrySchemaVersion
		}
		if event.Component == "" {
			event.Component = "engine"
		}
		if event.Payload == nil {
			event.Payload = map[string]any{}
		}
		frameEvents[i] = event
	}
	line, err := telemetryformat.EncodeCompactLine(frameEvents)
	if err != nil {
		return fmt.Errorf("telemetry compact frame: %w", err)
	}
	path = utils.ExpandHomePath(path)
	return durablefile.Transaction(path, 5*time.Second, func(absPath string) error {
		return appendFrameLocked(line, absPath, rotation)
	})
}

// appendFrameLocked appends exactly one complete v4 frame. The caller owns the
// telemetry file transaction or schema checkpoint lock while this executes.
func appendFrameLocked(line []byte, path string, rotation rotationPolicy) error {
	rotateIfOversize(path, rotation)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := f.Close(); closeErr != nil {
			utils.LogWithFields(utils.LevelInfo, "telemetry", "append to file close failed", map[string]any{"path": path, "error": closeErr.Error()})
		}
	}()
	if _, err := f.Write(line); err != nil {
		return err
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
	resp, err := network.GetHTTPClient().Do(req)
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
	hostOnce  sync.Once
	resolvedH string
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

// resolvedInstallID returns the per-install anonymous UUID. Delegates to the
// shared utils.InstallID accessor so telemetry and egress mint/read the SAME
// value (egress carries install_id to join its records to the telemetry
// stream). Thread-safe.
func resolvedInstallID() string {
	return utils.InstallID()
}
