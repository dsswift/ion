// log_egress_traces.go — span records shipped as OTLP traces.
//
// Spans travel inside the streams log egress already ships, so a span needs
// no second transport, credential, or spool. Two record shapes carry one:
//
//   - a telemetry event whose payload holds span_id and duration_ms (engine
//     spans: run.execute, llm.call, tool.execute, extension.hook_latency);
//     its parent is the correlation context's parent_span_id.
//   - an operational log line with tag "span" (server, desktop, web, and
//     iOS spans); msg is the span name and fields hold span_id,
//     parent_span_id, duration_ms, and the span's attributes.
//
// Either way the record's ts is the span's END and top-level trace_id is its
// trace. The otel target posts every span record in a batch to /v1/traces
// after the batch's logs are accepted. See docs/observability/log-schema.md
// § Spans.
package utils

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// SpanLogTag is the operational-log tag that marks a line as a span record.
const SpanLogTag = "span"

// reservedSpanKeys are span-record keys that describe the span itself rather
// than being its attributes.
var reservedSpanKeys = map[string]bool{
	"span_id": true, "parent_span_id": true, "duration_ms": true, "error": true, "span_kind": true,
}

type otlpTracesExportRequest struct {
	ResourceSpans []otlpResourceSpans `json:"resourceSpans"`
}

type otlpResourceSpans struct {
	Resource   otlpLogResource  `json:"resource"`
	ScopeSpans []otlpScopeSpans `json:"scopeSpans"`
}

type otlpScopeSpans struct {
	Scope otlpLogScope `json:"scope"`
	Spans []otlpSpan   `json:"spans"`
}

// otlpSpan is the OTLP/JSON span subset Ion emits. Ids are lowercase hex, as
// the OTLP/JSON mapping specifies for trace and span ids.
type otlpSpan struct {
	TraceID           string        `json:"traceId"`
	SpanID            string        `json:"spanId"`
	ParentSpanID      string        `json:"parentSpanId,omitempty"`
	Name              string        `json:"name"`
	Kind              int           `json:"kind"`
	StartTimeUnixNano string        `json:"startTimeUnixNano"`
	EndTimeUnixNano   string        `json:"endTimeUnixNano"`
	Attributes        []otlpLogAttr `json:"attributes"`
	Status            otlpSpanState `json:"status"`
}

type otlpSpanState struct {
	Code    int    `json:"code"`
	Message string `json:"message,omitempty"`
}

// OTLP span kinds and status codes (opentelemetry-proto trace.proto).
const (
	otlpSpanKindInternal = 1
	otlpSpanKindServer   = 2
	otlpSpanKindClient   = 3
	otlpStatusUnset      = 0
	otlpStatusError      = 2
)

// spanRecord is one span decoded from an egress record, with the service
// that recorded it.
type spanRecord struct {
	service string
	span    otlpSpan
}

// spanFromRecord decodes r as a span record. ok is false for any record that
// is not a complete, valid span.
func spanFromRecord(r egressRecord) (spanRecord, bool) {
	var src map[string]any
	var name, parent string
	switch {
	case isTelemetryEventRecord(r):
		src, name = r.Payload, r.Name
		parent, _ = r.Context["parent_span_id"].(string) //nolint:errcheck // non-string parent is treated as absent
	case r.Tag == SpanLogTag:
		src, name = r.Fields, r.Msg
		parent, _ = src["parent_span_id"].(string) //nolint:errcheck // non-string parent is treated as absent
	default:
		return spanRecord{}, false
	}
	spanID, _ := src["span_id"].(string) //nolint:errcheck // non-string span_id is not a span
	durationMs, hasDuration := spanNumber(src["duration_ms"])
	end, err := time.Parse(time.RFC3339Nano, r.Ts)
	if name == "" || !IsValidTraceID(r.TraceID) || !IsValidSpanID(spanID) || !hasDuration || err != nil {
		return spanRecord{}, false
	}
	if !IsValidSpanID(parent) {
		parent = ""
	}
	start := end.Add(-time.Duration(durationMs * float64(time.Millisecond)))

	attrs := make([]otlpLogAttr, 0, len(src)+2)
	onResource := resourceFieldKeys(r.Component)
	for k, v := range src {
		if !reservedSpanKeys[k] && !onResource[k] {
			attrs = append(attrs, otlpLogAttr{Key: k, Value: otlpAttrValFromAny(v)})
		}
	}
	if r.SessionID != "" {
		attrs = append(attrs, otlpLogAttr{Key: "session_id", Value: otlpStr(r.SessionID)})
	}
	if r.ConversationID != "" {
		attrs = append(attrs, otlpLogAttr{Key: "conversation_id", Value: otlpStr(r.ConversationID)})
	}
	for _, k := range []string{"session_id", "conversation_id", "run_id"} {
		if v, ok := r.Context[k].(string); ok && v != "" {
			attrs = append(attrs, otlpLogAttr{Key: k, Value: otlpStr(v)})
		}
	}
	sort.Slice(attrs, func(i, j int) bool { return attrs[i].Key < attrs[j].Key })

	status := otlpSpanState{Code: otlpStatusUnset}
	if msg, ok := src["error"].(string); ok && msg != "" {
		status = otlpSpanState{Code: otlpStatusError, Message: msg}
	}
	return spanRecord{
		service: ServiceNameForComponent(r.Component),
		span: otlpSpan{
			TraceID:           r.TraceID,
			SpanID:            spanID,
			ParentSpanID:      parent,
			Name:              name,
			Kind:              spanKind(src["span_kind"]),
			StartTimeUnixNano: fmt.Sprintf("%d", start.UnixNano()),
			EndTimeUnixNano:   fmt.Sprintf("%d", end.UnixNano()),
			Attributes:        attrs,
			Status:            status,
		},
	}, true
}

func spanNumber(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	}
	return 0, false
}

func spanKind(v any) int {
	switch v {
	case "server":
		return otlpSpanKindServer
	case "client":
		return otlpSpanKindClient
	}
	return otlpSpanKindInternal
}

// buildTracesExport groups the span records in records by the resource of
// the source that recorded them (egressResourceAttrs), so a span shares its
// resource with the same source's logs. configured is the otel config's
// resourceAttributes. ok is false when records hold no span.
func buildTracesExport(records []egressRecord, configured map[string]string) (otlpTracesExportRequest, int, bool) {
	req := otlpTracesExportRequest{ResourceSpans: []otlpResourceSpans{}}
	groupIndex := map[string]int{}
	count := 0
	for _, r := range records {
		sr, ok := spanFromRecord(r)
		if !ok {
			continue
		}
		res := egressResourceAttrs(r, configured)
		key := resourceKey(res)
		i, seen := groupIndex[key]
		if !seen {
			i = len(req.ResourceSpans)
			groupIndex[key] = i
			req.ResourceSpans = append(req.ResourceSpans, otlpResourceSpans{
				Resource:   otlpLogResource{Attributes: res},
				ScopeSpans: []otlpScopeSpans{{Scope: otlpLogScope{Name: sr.service}}},
			})
		}
		req.ResourceSpans[i].ScopeSpans[0].Spans = append(req.ResourceSpans[i].ScopeSpans[0].Spans, sr.span)
		count++
	}
	if count == 0 {
		return otlpTracesExportRequest{}, 0, false
	}
	sort.SliceStable(req.ResourceSpans, func(a, b int) bool {
		return resourceServiceName(req.ResourceSpans[a].Resource.Attributes) < resourceServiceName(req.ResourceSpans[b].Resource.Attributes)
	})
	return req, count, true
}

// shipSpansToOtel posts the batch's span records to <endpoint>/v1/traces.
// Called once the batch's logs were accepted. A failure is logged, never
// returned: the logs already landed, and retrying the batch would ship them
// twice. The span line itself stays in Loki, so a lost span is still
// findable by trace_id.
func shipSpansToOtel(records []egressRecord, cfg *types.OtelConfig, client *http.Client) {
	req, count, ok := buildTracesExport(records, cfg.ResourceAttributes)
	if !ok {
		return
	}
	if err := postOtlpTraces(req, cfg, client); err != nil {
		LogWithFields(LevelWarn, "log_egress", "span export failed; the span lines still shipped as logs", map[string]any{"spans": count, "error": err.Error()})
		return
	}
	LogWithFields(LevelDebug, "log_egress", "spans exported", map[string]any{"spans": count})
}

func postOtlpTraces(payload otlpTracesExportRequest, cfg *types.OtelConfig, client *http.Client) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, cfg.Endpoint+"/v1/traces", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range cfg.Headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("POST: %w", err)
	}
	errBody, readErr := io.ReadAll(io.LimitReader(resp.Body, 512))
	if closeErr := resp.Body.Close(); closeErr != nil {
		LogWithFields(LevelDebug, "log_egress", "traces response body close failed", map[string]any{"error": closeErr.Error()})
	}
	if resp.StatusCode >= 400 {
		if readErr != nil || len(errBody) == 0 {
			return fmt.Errorf("POST returned status %d", resp.StatusCode)
		}
		return fmt.Errorf("POST returned status %d: %s", resp.StatusCode, strings.TrimSpace(string(errBody)))
	}
	return nil
}
