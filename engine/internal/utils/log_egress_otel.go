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
	"math"
	"net/http"
	"sort"
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
//                         OTLP/JSON protobuf mapping)
//   - non-integer float -> doubleValue
//   - nested object/array -> JSON-stringified into stringValue
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
	for k, v := range r.Fields {
		attrs = append(attrs, otlpLogAttr{Key: k, Value: otlpAttrValFromAny(v)})
	}
	sort.Slice(attrs, func(i, j int) bool { return attrs[i].Key < attrs[j].Key })
	return attrs
}

// flushEgressToOtel exports log records as OTLP log records.
func flushEgressToOtel(records []egressRecord, cfg *types.OtelConfig) error {
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
		otlpRecords = append(otlpRecords, otlpLogRecord{
			TimeUnixNano:   tsNano,
			SeverityNumber: otlpLogSeverityNumber(r.Level),
			SeverityText:   r.Level,
			Body:           otlpLogBodyV{StringValue: otlpLogBody(r)},
			Attributes:     otlpAttrsFromRecord(r),
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
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("log egress otel: POST: %w", err)
	}
	if err := resp.Body.Close(); err != nil {
		Log("log_egress", fmt.Sprintf("otel: response body close failed: %v", err))
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("log egress otel: POST returned status %d", resp.StatusCode)
	}
	return nil
}
