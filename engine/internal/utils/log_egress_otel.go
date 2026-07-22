package utils

// log_egress_otel.go — the OTLP ("otel") egress target for operational log
// lines. Split from log_egress.go (which owns the buffer/spool machinery and
// the HTTP target) to keep each file under the file-size cap. The OTLP wire
// types, the native-scalar attribute-value convention, and flushEgressToOtel
// live here; they are shared byte-for-byte with the desktop exporter
// (desktop/src/main/log-egress.ts).

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// otlpLogSeverityNumber maps a log level string to its OTLP severity number.
func otlpLogSeverityNumber(level string) int {
	switch level {
	case "TRACE":
		return 1
	case "DEBUG":
		return 5
	case "INFO":
		return 9
	case "WARN":
		return 13
	case "ERROR":
		return 17
	default:
		return 9
	}
}

// normalizedSeverityText returns a non-empty severity string for a record whose
// level is absent or empty. Telemetry event records carry no `level`, so the
// severityText would otherwise be "" — normalize it to INFO exactly as
// otlpLogSeverityNumber's default maps "" to 9, and as the desktop
// normalizeSeverityText does. Keeps engine↔desktop OTLP output byte-identical
// for a telemetry record.
func normalizedSeverityText(level string) string {
	if level == "" {
		return "INFO"
	}
	return level
}

// otlpLogBody returns the OTLP log-record body: the full serialized Ion JSONL
// line. Alloy's ion_otlp_unwrap pipeline extracts this as `inner_body` and
// rewrites the Loki log line with it, so the stored Loki line IS the canonical
// Ion JSONL. Dashboard queries that do `| json | device_name=~"$device"` (or
// any other json extraction) work because the body is a parseable JSON object,
// not a bare plain-text message string.
//
// Structured context is also carried in OTLP attributes for consumers who read
// attributes directly (component, tag, correlation IDs, user, every fields key).
// The body and attributes are complementary, not redundant: attributes give
// label-promotion and metadata without a parser; the body gives full JSON access
// to every nested field (e.g. fields.device_name via `| json fields_device_name`).
func otlpLogBody(rec egressRecord) string {
	b, err := json.Marshal(rec)
	if err != nil {
		// Fallback to bare msg on pathological records so a bad line never
		// breaks the batch flush. A structurally invalid egressRecord is
		// extremely unlikely (all fields are basic Go types), but guard anyway.
		return rec.Msg
	}
	return string(b)
}

// --- OTLP Logs wire types (minimal subset for /v1/logs) ---

type otlpLogsExportRequest struct {
	ResourceLogs []otlpResourceLogs `json:"resourceLogs"`
}

type otlpResourceLogs struct {
	Resource  otlpLogResource `json:"resource"`
	ScopeLogs []otlpScopeLogs `json:"scopeLogs"`
}

type otlpLogResource struct {
	Attributes []otlpLogAttr `json:"attributes"`
}

type otlpScopeLogs struct {
	Scope      otlpLogScope    `json:"scope"`
	LogRecords []otlpLogRecord `json:"logRecords"`
}

type otlpLogScope struct {
	Name string `json:"name"`
}

type otlpLogRecord struct {
	TimeUnixNano   string        `json:"timeUnixNano"`
	SeverityNumber int           `json:"severityNumber"`
	SeverityText   string        `json:"severityText"`
	Body           otlpLogBodyV  `json:"body"`
	Attributes     []otlpLogAttr `json:"attributes"`
}

type otlpLogBodyV struct {
	StringValue string `json:"stringValue"`
}

type otlpLogAttr struct {
	Key   string         `json:"key"`
	Value otlpLogAttrVal `json:"value"`
}

// otlpLogAttrVal is the OTLP AnyValue subset the egress exporter emits. Exactly
// one field is non-nil per value (pointer fields so a zero scalar — false, 0 —
// still serializes rather than being dropped by omitempty). The typing
// convention is native-scalar and is shared byte-for-byte with the desktop
// exporter (desktop/src/main/log-egress.ts):
//   - string           -> stringValue
//   - bool             -> boolValue
//   - integer          -> intValue (int64 rendered as a decimal string, per the
//     OTLP/JSON protobuf mapping)
//   - non-integer float -> doubleValue
//   - nested object/array -> JSON-stringified into stringValue
//
// A whole-valued float (e.g. 3.0) is emitted as intValue so a fields map that
// survives a JSON spool round-trip (where all numbers decode to float64)
// serializes identically to the same map read live.
type otlpLogAttrVal struct {
	StringValue *string  `json:"stringValue,omitempty"`
	BoolValue   *bool    `json:"boolValue,omitempty"`
	IntValue    *string  `json:"intValue,omitempty"`
	DoubleValue *float64 `json:"doubleValue,omitempty"`
}

// otlpStr builds a string-valued OTLP attribute value.
func otlpStr(s string) otlpLogAttrVal {
	return otlpLogAttrVal{StringValue: &s}
}

// otlpAttrValFromAny converts an arbitrary fields value to its OTLP AnyValue
// representation using the native-scalar convention documented on
// otlpLogAttrVal. Nested objects and arrays are JSON-stringified.
func otlpAttrValFromAny(v any) otlpLogAttrVal {
	switch t := v.(type) {
	case nil:
		return otlpStr("")
	case string:
		return otlpStr(t)
	case bool:
		b := t
		return otlpLogAttrVal{BoolValue: &b}
	case int:
		return otlpInt(int64(t))
	case int8:
		return otlpInt(int64(t))
	case int16:
		return otlpInt(int64(t))
	case int32:
		return otlpInt(int64(t))
	case int64:
		return otlpInt(t)
	case uint:
		return otlpInt(int64(t))
	case uint8:
		return otlpInt(int64(t))
	case uint16:
		return otlpInt(int64(t))
	case uint32:
		return otlpInt(int64(t))
	case uint64:
		return otlpInt(int64(t))
	case float32:
		return otlpFloat(float64(t))
	case float64:
		return otlpFloat(t)
	default:
		// Nested object, array, or any other composite: JSON-stringify.
		b, err := json.Marshal(v)
		if err != nil {
			return otlpStr(fmt.Sprintf("%v", v))
		}
		return otlpStr(string(b))
	}
}

// otlpInt builds an integer-valued OTLP attribute value (int64 as a string).
func otlpInt(n int64) otlpLogAttrVal {
	s := fmt.Sprintf("%d", n)
	return otlpLogAttrVal{IntValue: &s}
}

// otlpFloat builds a numeric OTLP attribute value, promoting whole-valued
// floats to intValue so live and spool-round-tripped records serialize alike.
func otlpFloat(f float64) otlpLogAttrVal {
	if f == math.Trunc(f) && !math.IsInf(f, 0) {
		return otlpInt(int64(f))
	}
	d := f
	return otlpLogAttrVal{DoubleValue: &d}
}

// otlpAttrsFromRecord flattens a record to the complete OTLP attribute set:
// component and tag always; each present correlation ID and user; and every
// key in the fields map (run_id rides here). The list is sorted by key so the
// engine and desktop exporters produce identical output for the same record.
func otlpAttrsFromRecord(r egressRecord) []otlpLogAttr {
	attrs := make([]otlpLogAttr, 0, len(r.Fields)+7)
	attrs = append(attrs,
		otlpLogAttr{Key: "component", Value: otlpStr(r.Component)},
		otlpLogAttr{Key: "tag", Value: otlpStr(r.Tag)},
	)
	if r.SessionID != "" {
		attrs = append(attrs, otlpLogAttr{Key: "session_id", Value: otlpStr(r.SessionID)})
	}
	if r.ConversationID != "" {
		attrs = append(attrs, otlpLogAttr{Key: "conversation_id", Value: otlpStr(r.ConversationID)})
	}
	if r.TraceID != "" {
		attrs = append(attrs, otlpLogAttr{Key: "trace_id", Value: otlpStr(r.TraceID)})
	}
	if r.User != "" {
		attrs = append(attrs, otlpLogAttr{Key: "user", Value: otlpStr(r.User)})
	}
	if r.EventID != "" {
		attrs = append(attrs, otlpLogAttr{Key: "event_id", Value: otlpStr(r.EventID)})
	}
	for k, v := range r.Fields {
		attrs = append(attrs, otlpLogAttr{Key: k, Value: otlpAttrValFromAny(v)})
	}
	sort.Slice(attrs, func(i, j int) bool { return attrs[i].Key < attrs[j].Key })
	return attrs
}

// ---------------------------------------------------------------------------
// Telemetry-event OTLP mapping — file-tail parity path.
//
// Telemetry EVENT records ({name, ts, schema, component, payload, context})
// are a distinct shape from operational log records ({ts, level, msg, ...,
// fields}). They arrive here because the egress tailer ships
// ~/.ion/telemetry.jsonl verbatim (log_egress_tailer.go). Their meaningful data
// lives in Name (the event kind), Payload.* (cost/tokens/model/duration), and
// Context.* (extension/conversation/session) — NONE of which the operational
// attribute mapper (otlpAttrsFromRecord) reads. Mapped through the operational
// path, a run.complete event carried a single attribute (component), silently
// discarding every cost, kind, and attribution field — so the remote's Cost /
// Runs / Extensions dashboards could never populate against an OTLP-ingested
// backend.
//
// This is the engine counterpart of the desktop's otlpAttrsFromTelemetryEvent
// (desktop/src/main/log-egress-otel.ts) and of the file-tail telemetry pipeline
// in docs/observability/alloy-config.alloy (`loki.process "ion_telemetry"`). It
// mirrors that pipeline's stage.json field map EXACTLY so the SAME generated
// dashboards render identically against both ingestion methods, and it is
// byte-identical with the desktop exporter for the same event. host/event_id
// ride in the verbatim body (telemetryEventBody) but are omitted from the
// ATTRIBUTE set — matching the desktop, whose file-tail attribute mirror does
// not promote them either.
// ---------------------------------------------------------------------------

// telemetryServiceName is the Loki `service`/`service.name` value the telemetry
// stream carries so `{service_name="ion-telemetry", kind="run.complete"}`
// dashboard queries select it. Mirrors the desktop TELEMETRY_SERVICE.
const telemetryServiceName = "ion-telemetry"

// isTelemetryEventRecord reports whether r is a telemetry EVENT (not an
// operational log line). Operational records never carry a top-level Name or
// Payload; telemetry events always do and carry no Msg/Level. This is the
// discriminator the tailer and exporter branch on. Mirrors the desktop
// isTelemetryEventRecord.
func isTelemetryEventRecord(r egressRecord) bool {
	return r.Name != "" && r.Payload != nil
}

// telemetryEventBody returns the verbatim event JSON: the tailer parsed the
// original telemetry.jsonl line into the carrier fields, so re-marshalling the
// telemetry-shaped envelope reproduces the object graph
// ({name, ts, schema, component, payload, context, ...}) the file-tail pipeline
// ingests as the raw line. A dashboard's `| json | unwrap payload_run_cost_usd`
// therefore flattens payload.run_cost_usd to payload_run_cost_usd identically
// on both ingestion paths. Never fails the batch: a pathological record falls
// back to an empty body, leaving the flat attributes as the queryable surface.
func telemetryEventBody(r egressRecord) string {
	env := map[string]any{
		"name":      r.Name,
		"ts":        r.Ts,
		"component": r.Component,
		"payload":   r.Payload,
	}
	if r.Schema != nil {
		env["schema"] = r.Schema
	}
	if r.Context != nil {
		env["context"] = r.Context
	}
	if r.InstallID != "" {
		env["install_id"] = r.InstallID
	}
	if r.Version != "" {
		env["version"] = r.Version
	}
	if r.Host != "" {
		env["host"] = r.Host
	}
	if r.EventID != "" {
		env["event_id"] = r.EventID
	}
	if r.TraceID != "" {
		env["trace_id"] = r.TraceID
	}
	b, err := json.Marshal(env)
	if err != nil {
		return ""
	}
	return string(b)
}

// pushIfPresent appends an attribute for key sourced from src[srcKey], but only
// when the value is present (not nil) — mirroring the file-tail pipeline, where
// a missing JSON field yields no label/metadata. A present zero or false IS
// emitted (valid telemetry values), via otlpAttrValFromAny. Mirrors the desktop
// pushIfPresent.
func pushIfPresent(attrs []otlpLogAttr, key string, src map[string]any, srcKey string) []otlpLogAttr {
	if src == nil {
		return attrs
	}
	v, ok := src[srcKey]
	if !ok || v == nil {
		return attrs
	}
	return append(attrs, otlpLogAttr{Key: key, Value: otlpAttrValFromAny(v)})
}

// otlpAttrsFromTelemetryEvent builds the OTLP attribute set for a telemetry
// EVENT record, mirroring the file-tail `ion_telemetry` pipeline's stage.json
// field map (and the desktop otlpAttrsFromTelemetryEvent) EXACTLY. Sorted by
// key for determinism and engine↔desktop byte parity.
func otlpAttrsFromTelemetryEvent(r egressRecord) []otlpLogAttr {
	attrs := make([]otlpLogAttr, 0, 24)
	// kind = name; service is the stream discriminator the dashboards select on.
	attrs = append(attrs,
		otlpLogAttr{Key: "kind", Value: otlpStr(r.Name)},
		otlpLogAttr{Key: "service", Value: otlpStr(telemetryServiceName)},
		otlpLogAttr{Key: "component", Value: otlpStr(r.Component)},
	)

	// payload.* — names mirror alloy-config.alloy stage.json (renames included).
	attrs = pushIfPresent(attrs, "model", r.Payload, "model")
	attrs = pushIfPresent(attrs, "tool", r.Payload, "tool")
	attrs = pushIfPresent(attrs, "stop_reason", r.Payload, "stop_reason")
	attrs = pushIfPresent(attrs, "duration_ms", r.Payload, "duration_ms")
	attrs = pushIfPresent(attrs, "run_cost_usd", r.Payload, "run_cost_usd")
	attrs = pushIfPresent(attrs, "agg_cost_usd", r.Payload, "aggregate_cost_usd")
	attrs = pushIfPresent(attrs, "dispatch_depth", r.Payload, "dispatch_depth")
	attrs = pushIfPresent(attrs, "num_turns", r.Payload, "num_turns")
	attrs = pushIfPresent(attrs, "input_tokens", r.Payload, "input_tokens")
	attrs = pushIfPresent(attrs, "output_tokens", r.Payload, "output_tokens")
	attrs = pushIfPresent(attrs, "cache_read_tokens", r.Payload, "cache_read_input_tokens")
	attrs = pushIfPresent(attrs, "cache_creation_tokens", r.Payload, "cache_creation_input_tokens")
	attrs = pushIfPresent(attrs, "error", r.Payload, "error")

	// top-level event envelope fields.
	if r.TraceID != "" {
		attrs = append(attrs, otlpLogAttr{Key: "trace_id", Value: otlpStr(r.TraceID)})
	}
	if r.Schema != nil {
		attrs = append(attrs, otlpLogAttr{Key: "schema_version", Value: otlpAttrValFromAny(r.Schema)})
	}
	if r.InstallID != "" {
		attrs = append(attrs, otlpLogAttr{Key: "install_id", Value: otlpStr(r.InstallID)})
	}
	if r.Version != "" {
		attrs = append(attrs, otlpLogAttr{Key: "engine_version", Value: otlpStr(r.Version)})
	}

	// context.* attribution fields.
	attrs = pushIfPresent(attrs, "context_conversation_id", r.Context, "conversation_id")
	attrs = pushIfPresent(attrs, "context_session_id", r.Context, "session_id")
	attrs = pushIfPresent(attrs, "context_extension", r.Context, "extension")
	attrs = pushIfPresent(attrs, "context_extension_version", r.Context, "extension_version")

	sort.Slice(attrs, func(i, j int) bool { return attrs[i].Key < attrs[j].Key })
	return attrs
}

// flushEgressToOtel exports log records as OTLP log records using client.
func flushEgressToOtel(records []egressRecord, cfg *types.OtelConfig, client *http.Client) error {
	if cfg == nil || cfg.Endpoint == "" {
		return fmt.Errorf("log egress otel: endpoint not configured")
	}
	serviceName := cfg.ServiceName
	if serviceName == "" {
		serviceName = "ion-engine"
	}

	otlpRecords := make([]otlpLogRecord, 0, len(records))
	for _, r := range records {
		var tsNano string
		if t, err := time.Parse(time.RFC3339Nano, r.Ts); err == nil {
			tsNano = fmt.Sprintf("%d", t.UnixNano())
		}

		if isTelemetryEventRecord(r) {
			// TELEMETRY EVENT record. Its data lives in name/payload/context, NOT
			// in msg/level/fields, so the operational mapper would drop everything
			// but component. Map it through the file-tail mirror instead:
			//   - body = the verbatim event JSON. A dashboard's
			//     `| json | unwrap payload_run_cost_usd` flattens
			//     payload.run_cost_usd to payload_run_cost_usd exactly as the
			//     file-tail raw line does.
			//   - attributes = the flat file-tail label/metadata set (kind,
			//     service, run_cost_usd, ...).
			//   - loki.attribute.labels hint promotes service+kind+component to
			//     Loki STREAM LABELS so `{service="ion-telemetry",
			//     kind="run.complete"}` selects the stream. otelcol.exporter.loki
			//     does not promote OTLP attributes to labels without this hint;
			//     non-promoted attributes become Loki structured metadata (so
			//     `| unwrap run_cost_usd` also resolves), matching the file-tail
			//     representation.
			attrs := otlpAttrsFromTelemetryEvent(r)
			attrs = append(attrs, otlpLogAttr{Key: "loki.attribute.labels", Value: otlpStr("service, kind, component")})
			sort.Slice(attrs, func(i, j int) bool { return attrs[i].Key < attrs[j].Key })
			otlpRecords = append(otlpRecords, otlpLogRecord{
				TimeUnixNano:   tsNano,
				SeverityNumber: otlpLogSeverityNumber(r.Level),
				SeverityText:   normalizedSeverityText(r.Level),
				Body:           otlpLogBodyV{StringValue: telemetryEventBody(r)},
				Attributes:     attrs,
			})
			continue
		}

		// OPERATIONAL log record. loki.attribute.labels promotes component+tag to
		// Loki stream labels so the operational panels that select on them — "Log
		// volume by component" (`{component=~".+"}`) and "Extension activity"
		// (`{component="extension"}`) — resolve against the OTLP-ingested backend
		// exactly as they do against the file-tail backend. Harmless (idempotent)
		// if the ingestion side already promotes them. Mirrors the desktop
		// operational hint.
		attrs := otlpAttrsFromRecord(r)
		attrs = append(attrs, otlpLogAttr{Key: "loki.attribute.labels", Value: otlpStr("component, tag")})
		sort.Slice(attrs, func(i, j int) bool { return attrs[i].Key < attrs[j].Key })
		otlpRecords = append(otlpRecords, otlpLogRecord{
			TimeUnixNano:   tsNano,
			SeverityNumber: otlpLogSeverityNumber(r.Level),
			SeverityText:   r.Level,
			Body:           otlpLogBodyV{StringValue: otlpLogBody(r)},
			Attributes:     attrs,
		})
	}

	payload := otlpLogsExportRequest{
		ResourceLogs: []otlpResourceLogs{{
			Resource: otlpLogResource{
				Attributes: []otlpLogAttr{{
					Key:   "service.name",
					Value: otlpStr(serviceName),
				}},
			},
			ScopeLogs: []otlpScopeLogs{{
				Scope:      otlpLogScope{Name: serviceName},
				LogRecords: otlpRecords,
			}},
		}},
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("log egress otel: marshal: %w", err)
	}
	endpoint := cfg.Endpoint + "/v1/logs"
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("log egress otel: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range cfg.Headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("log egress otel: POST: %w", err)
	}
	if resp.StatusCode >= 400 {
		// Read up to 512 bytes of the error body so the rejection reason
		// appears in engine.jsonl instead of a bare status code.
		errBody, readErr := io.ReadAll(io.LimitReader(resp.Body, 512))
		if closeErr := resp.Body.Close(); closeErr != nil {
			Log("log_egress", fmt.Sprintf("otel: response body close (error path) failed: %v", closeErr))
		}
		if readErr != nil || len(errBody) == 0 {
			return fmt.Errorf("log egress otel: POST returned status %d", resp.StatusCode)
		}
		return fmt.Errorf("log egress otel: POST returned status %d: %s", resp.StatusCode, strings.TrimSpace(string(errBody)))
	}
	if err := resp.Body.Close(); err != nil {
		Log("log_egress", fmt.Sprintf("otel: response body close failed: %v", err))
	}
	return nil
}
