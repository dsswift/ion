package backend

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// delegated_telemetry.go gives the delegated-CLI backends (claude-code,
// codex, grok, cursor) the per-call telemetry the API run loop emits itself.
// A CLI runs its own model loop and tools, so the engine sees them only as
// the CLI reports them:
//
//   - tool.execute and tool.failure, for every CLI: a span from the tool call
//     the CLI reports to its result, failed when the result is an error.
//   - llm.call, provider.ttft and context.pressure, for claude-code: its
//     stream marks each model call with message_start and message_stop. The
//     time to first token is measured from the moment the CLI had everything
//     for the call (the run start, the previous call's end, or a tool result)
//     to message_start, so it includes the CLI's own overhead.
//   - context.pressure for codex, from the per-call token usage it reports.
//     Codex reports no call start, so it has no llm.call or provider.ttft.
//
// Every event carries `backend` (the CLI kind), so a dashboard can tell
// these apart from the API run loop's events, which carry none.

// RunTelemetrySetter is implemented by a backend that takes no RunConfig
// (the delegated CLIs). SetRunTelemetry hands it the collector for one run;
// call it before StartRun.
type RunTelemetrySetter interface {
	SetRunTelemetry(requestID string, telem TelemetryCollector)
}

// delegatedTelemetry is the per-backend registry of runs with a collector.
// The zero value is ready to use.
type delegatedTelemetry struct {
	mu      sync.Mutex
	pending map[string]TelemetryCollector
	runs    map[string]*delegatedRunTelemetry
}

// SetRunTelemetry records the collector for a run about to start.
func (d *delegatedTelemetry) SetRunTelemetry(requestID string, telem TelemetryCollector) {
	if telem == nil {
		return
	}
	d.mu.Lock()
	if d.pending == nil {
		d.pending = map[string]TelemetryCollector{}
	}
	d.pending[requestID] = telem
	d.mu.Unlock()
}

// begin starts tracking a run if a collector was set for it. kind is the CLI
// ("claude-code", "codex", "grok", "cursor").
func (d *delegatedTelemetry) begin(requestID, kind string, opts types.RunOptions) {
	d.mu.Lock()
	defer d.mu.Unlock()
	telem, ok := d.pending[requestID]
	if !ok {
		return
	}
	delete(d.pending, requestID)
	if d.runs == nil {
		d.runs = map[string]*delegatedRunTelemetry{}
	}
	d.runs[requestID] = &delegatedRunTelemetry{
		telem:    telem,
		kind:     kind,
		model:    opts.Model,
		ctx:      telemCtxFromOptions(requestID, &opts, opts.ConversationID),
		tools:    map[string]delegatedToolSpan{},
		calls:    map[string]*delegatedModelCall{},
		boundary: time.Now(),
	}
	utils.LogWithFields(utils.LevelDebug, "backend.telemetry", "delegated run telemetry started", map[string]any{"run_id": requestID, "backend": kind})
}

func (d *delegatedTelemetry) get(requestID string) *delegatedRunTelemetry {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.runs[requestID]
}

// observe feeds one normalized event the backend is about to emit.
func (d *delegatedTelemetry) observe(requestID string, ev types.NormalizedEvent) {
	if r := d.get(requestID); r != nil {
		r.observe(ev)
	}
}

// end stops tracking a run, closing any span the CLI left open.
func (d *delegatedTelemetry) end(requestID string) {
	d.mu.Lock()
	r := d.runs[requestID]
	delete(d.runs, requestID)
	delete(d.pending, requestID)
	d.mu.Unlock()
	if r != nil {
		r.close()
	}
}

type delegatedToolSpan struct {
	name string
	span Span
}

type delegatedModelCall struct {
	span         Span
	stopReason   string
	outputTokens int
}

// delegatedRunTelemetry tracks one run's open tool spans and model calls.
// Model calls are keyed by the CLI's parent_tool_use_id ("" for the main
// agent), because a claude-code sub-agent's calls interleave with the main
// agent's.
type delegatedRunTelemetry struct {
	mu       sync.Mutex
	telem    TelemetryCollector
	kind     string
	model    string
	ctx      map[string]any
	tools    map[string]delegatedToolSpan
	calls    map[string]*delegatedModelCall
	turn     int
	boundary time.Time
}

func (r *delegatedRunTelemetry) observe(ev types.NormalizedEvent) {
	switch e := ev.Data.(type) {
	case *types.ToolCallEvent:
		attrs := map[string]any{"tool": e.ToolName, "backend": r.kind}
		span := r.telem.StartSpanCtx("tool.execute", attrs, r.ctx)
		r.mu.Lock()
		r.tools[e.ToolID] = delegatedToolSpan{name: e.ToolName, span: span}
		r.mu.Unlock()
	case *types.ToolResultEvent:
		r.mu.Lock()
		t, ok := r.tools[e.ToolID]
		delete(r.tools, e.ToolID)
		r.boundary = time.Now()
		turn := r.turn
		r.mu.Unlock()
		if !ok {
			return
		}
		var endAttrs map[string]any
		if r.telem.PrivacyLevel() == "full" {
			endAttrs = map[string]any{"output": truncatePreview(e.Content, telemPreviewLimit)}
		}
		if !e.IsError {
			t.span.End(endAttrs)
			return
		}
		t.span.End(endAttrs, "tool reported an error")
		payload := map[string]any{
			"tool": t.name, "tool_use_id": e.ToolID, "failure_category": "tool_error",
			"turn": turn, "backend": r.kind,
		}
		if r.telem.PrivacyLevel() != "minimal" {
			payload["error_preview"] = truncatePreview(e.Content, telemPreviewLimit)
		}
		r.telem.Event("tool.failure", payload, r.ctx)
	case *types.UsageEvent:
		// Codex reports each model call's usage and nothing else about it.
		if r.kind == "codex" {
			r.mu.Lock()
			r.turn++
			turn := r.turn
			r.mu.Unlock()
			r.contextPressure(r.model, turn, e.Usage)
		}
	}
}

// contextPressure reports how full the model's context was for one call.
func (r *delegatedRunTelemetry) contextPressure(model string, turn int, u types.UsageData) {
	used := derefInt(u.InputTokens) + derefInt(u.CacheReadInputTokens) + derefInt(u.CacheCreationInputTokens)
	if used == 0 {
		return
	}
	payload := map[string]any{"turn": turn, "tokens_used": used, "estimated": false, "backend": r.kind}
	if info := providers.GetModelInfo(model); info != nil && info.ContextWindow > 0 {
		payload["context_window"] = info.ContextWindow
		payload["percent"] = float64(used) / float64(info.ContextWindow) * 100
	}
	r.telem.Event("context.pressure", payload, r.ctx)
}

// claudeStreamLine reads the model-call markers from one raw claude-code
// stream line. Lines that are not stream events are ignored.
func (r *delegatedRunTelemetry) claudeStreamLine(raw json.RawMessage) {
	var line struct {
		Type            string  `json:"type"`
		ParentToolUseID *string `json:"parent_tool_use_id"`
		Event           struct {
			Type    string `json:"type"`
			Message *struct {
				Model string          `json:"model"`
				Usage types.UsageData `json:"usage"`
			} `json:"message"`
			Delta *struct {
				StopReason string `json:"stop_reason"`
			} `json:"delta"`
			Usage *types.UsageData `json:"usage"`
		} `json:"event"`
	}
	if json.Unmarshal(raw, &line) != nil || line.Type != "stream_event" {
		return
	}
	parent := ""
	if line.ParentToolUseID != nil {
		parent = *line.ParentToolUseID
	}
	switch line.Event.Type {
	case "message_start":
		model := r.model
		var usage types.UsageData
		if line.Event.Message != nil {
			if line.Event.Message.Model != "" {
				model = line.Event.Message.Model
			}
			usage = line.Event.Message.Usage
		}
		r.mu.Lock()
		r.turn++
		turn := r.turn
		ttft := time.Since(r.boundary)
		r.mu.Unlock()
		attrs := map[string]any{"model": model, "turn": turn, "backend": r.kind, "span_kind": telemetry.SpanKindClient}
		if parent != "" {
			attrs["parent_tool_use_id"] = parent
		}
		span := r.telem.StartSpanCtx("llm.call", attrs, r.ctx)
		r.mu.Lock()
		if prev := r.calls[parent]; prev != nil {
			prev.span.End(map[string]any{"stop_reason": prev.stopReason}, "superseded by the next call before message_stop")
		}
		r.calls[parent] = &delegatedModelCall{span: span}
		r.mu.Unlock()
		info := providers.GetModelInfo(model)
		provider := ""
		if info != nil {
			provider = info.ProviderID
		}
		r.telem.Event("provider.ttft", map[string]any{
			"provider": provider, "model": model, "ttft_ms": ttft.Milliseconds(), "attempt": 1, "backend": r.kind,
		}, r.ctx)
		r.contextPressure(model, turn, usage)
	case "message_delta":
		r.mu.Lock()
		if c := r.calls[parent]; c != nil {
			if line.Event.Delta != nil && line.Event.Delta.StopReason != "" {
				c.stopReason = line.Event.Delta.StopReason
			}
			if line.Event.Usage != nil && line.Event.Usage.OutputTokens != nil {
				c.outputTokens = *line.Event.Usage.OutputTokens
			}
		}
		r.mu.Unlock()
	case "message_stop":
		r.mu.Lock()
		c := r.calls[parent]
		delete(r.calls, parent)
		r.boundary = time.Now()
		r.mu.Unlock()
		if c != nil {
			c.span.End(map[string]any{"stop_reason": c.stopReason, "output_tokens": c.outputTokens})
		}
	}
}

// close ends every span the CLI never closed, as failed: the run ended with
// a tool or model call still open (cancelled, crashed, or killed).
func (r *delegatedRunTelemetry) close() {
	r.mu.Lock()
	tools, calls := r.tools, r.calls
	r.tools, r.calls = map[string]delegatedToolSpan{}, map[string]*delegatedModelCall{}
	r.mu.Unlock()
	for _, t := range tools {
		t.span.End(nil, "run ended before the tool result")
	}
	for _, c := range calls {
		c.span.End(map[string]any{"stop_reason": c.stopReason}, "run ended before message_stop")
	}
}

func derefInt(v *int) int {
	if v == nil {
		return 0
	}
	return *v
}
