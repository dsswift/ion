package telemetry

import (
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Span identity rides on ordinary telemetry events so a span needs no second
// stream. An event is a span when its payload carries `span_id` and
// `duration_ms`. Its parent is the correlation context's `parent_span_id`,
// which Collector.Event also lifts into Event.ParentSpanID. The event's ts is
// the span's end; its start is ts minus duration_ms. Log egress turns such
// events into OTLP spans (engine/internal/utils/log_egress_traces.go).
const (
	spanIDKey       = "span_id"
	parentSpanIDKey = "parent_span_id"
)

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
	spanID    string
	start     time.Time
	attrs     map[string]any
	ctx       map[string]any
	collector *Collector
}

// SpanID returns the span-id this handle records under. Work started inside
// the span passes it as its own parent_span_id.
func (s *SpanHandle) SpanID() string {
	return s.spanID
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
	payload := make(map[string]any, len(s.attrs)+len(attrs)+2)
	for k, v := range s.attrs {
		payload[k] = v
	}
	for k, v := range attrs {
		payload[k] = v
	}
	// R7: snake_case duration key.
	payload["duration_ms"] = durationMs
	payload[spanIDKey] = s.spanID
	if len(errMsg) > 0 && errMsg[0] != "" {
		payload["error"] = errMsg[0]
	}
	// Collector.Event hands the event to the OtelBridge, which records it as
	// a timed span because the payload carries span_id and duration_ms.
	s.collector.Event(s.name, payload, s.ctx)
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
// A ctx `parent_span_id` makes this span that span's child.
func (c *Collector) StartSpanCtx(name string, attrs, ctx map[string]any) *SpanHandle {
	return &SpanHandle{
		name:      name,
		spanID:    utils.NewSpanID(),
		start:     time.Now(),
		attrs:     attrs,
		ctx:       ctx,
		collector: c,
	}
}

// parentSpanIDFromCorrelationContext returns ctx's parent_span_id when it is
// a valid W3C span-id, or "".
func parentSpanIDFromCorrelationContext(ctx map[string]any) string {
	if ctx == nil {
		return ""
	}
	id, _ := ctx[parentSpanIDKey].(string) //nolint:errcheck // non-string parent is unusable; treat as absent
	if !utils.IsValidSpanID(id) {
		return ""
	}
	return id
}
