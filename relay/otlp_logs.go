package main

// otlp_logs.go — maps canonical relay JSONL lines to OTLP log records.
// The record shape mirrors the engine's operational OTLP exporter so the
// ingest pipeline treats relay lines exactly like engine lines: the body is
// the canonical JSON line itself, severity rides in severityNumber and
// severityText, the trace and span are the LogRecord traceId and spanId, and
// the attributes are tag, each present correlation key other than the trace,
// and every key of the nested fields object except span_id, sorted by key.
// The component and host are the resource's service.name and host.name.

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"time"
)

// --- OTLP/JSON wire types shared by logs and traces ---

type otlpAttr struct {
	Key   string       `json:"key"`
	Value otlpAttrValV `json:"value"`
}

// otlpAttrValV is the OTLP AnyValue subset the relay emits. Exactly one field
// is set. Integers ride as decimal strings per the OTLP/JSON protobuf mapping;
// whole-valued floats are emitted as integers, and nested values are
// JSON-stringified, matching the engine's native-scalar convention.
type otlpAttrValV struct {
	StringValue *string  `json:"stringValue,omitempty"`
	BoolValue   *bool    `json:"boolValue,omitempty"`
	IntValue    *string  `json:"intValue,omitempty"`
	DoubleValue *float64 `json:"doubleValue,omitempty"`
}

type otlpResource struct {
	Attributes []otlpAttr `json:"attributes"`
}

type otlpScope struct {
	Name string `json:"name"`
}

func otlpString(s string) otlpAttrValV { return otlpAttrValV{StringValue: &s} }

func otlpInt64(n int64) otlpAttrValV {
	s := strconv.FormatInt(n, 10)
	return otlpAttrValV{IntValue: &s}
}

func otlpNumber(f float64) otlpAttrValV {
	if f == math.Trunc(f) && !math.IsInf(f, 0) {
		return otlpInt64(int64(f))
	}
	return otlpAttrValV{DoubleValue: &f}
}

// otlpValue converts a decoded JSON value to an OTLP AnyValue.
func otlpValue(v any) otlpAttrValV {
	switch t := v.(type) {
	case nil:
		return otlpString("")
	case string:
		return otlpString(t)
	case bool:
		return otlpAttrValV{BoolValue: &t}
	case float64:
		return otlpNumber(t)
	case int:
		return otlpInt64(int64(t))
	case int64:
		return otlpInt64(t)
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return otlpString(fmt.Sprintf("%v", v))
		}
		return otlpString(string(b))
	}
}

// otlpServiceNamespace is the service.namespace every Ion component reports,
// the engine and server included. Application Insights joins it with
// service.name into the role name, so the relay sits beside them on the
// Application Map.
const otlpServiceNamespace = "ion"

// otlpResourceAttrs is the resource every relay export carries, sorted by
// key. The host name identifies the instance: a relay replica's pod name, or
// the machine it runs on.
func (s *otlpShipper) otlpResourceAttrs() []otlpAttr {
	attrs := []otlpAttr{
		{Key: "host.name", Value: otlpString(s.host)},
		{Key: "service.instance.id", Value: otlpString(s.host)},
		{Key: "service.name", Value: otlpString(otlpServiceName)},
		{Key: "service.namespace", Value: otlpString(otlpServiceNamespace)},
		{Key: "service.version", Value: otlpString(relayVersion)},
	}
	out := attrs[:0]
	for _, a := range attrs {
		if *a.Value.StringValue != "" {
			out = append(out, a)
		}
	}
	return out
}

// --- logs ---

type otlpLogsRequest struct {
	ResourceLogs []otlpResourceLogs `json:"resourceLogs"`
}

type otlpResourceLogs struct {
	Resource  otlpResource    `json:"resource"`
	ScopeLogs []otlpScopeLogs `json:"scopeLogs"`
}

type otlpScopeLogs struct {
	Scope      otlpScope       `json:"scope"`
	LogRecords []otlpLogRecord `json:"logRecords"`
}

// otlpLogRecord carries TraceID and SpanID as the OTLP LogRecord fields,
// where Application Insights reads a log's operation. The trace_id attribute
// stays alongside for Loki.
type otlpLogRecord struct {
	TimeUnixNano   string       `json:"timeUnixNano"`
	SeverityNumber int          `json:"severityNumber"`
	SeverityText   string       `json:"severityText"`
	TraceID        string       `json:"traceId,omitempty"`
	SpanID         string       `json:"spanId,omitempty"`
	Body           otlpAttrValV `json:"body"`
	Attributes     []otlpAttr   `json:"attributes"`
}

// relayLine is the canonical relay JSONL line as relayHandler writes it.
type relayLine struct {
	Ts             string         `json:"ts"`
	Level          string         `json:"level"`
	Component      string         `json:"component"`
	Tag            string         `json:"tag"`
	SessionID      string         `json:"session_id"`
	ConversationID string         `json:"conversation_id"`
	TraceID        string         `json:"trace_id"`
	ChannelID      string         `json:"channel_id"`
	Role           string         `json:"role"`
	Port           any            `json:"port"`
	Fields         map[string]any `json:"fields"`
}

// otlpSeverityNumber maps a canonical level to its OTLP severity number.
func otlpSeverityNumber(level string) int {
	switch level {
	case "TRACE":
		return 1
	case "DEBUG":
		return 5
	case "WARN":
		return 13
	case "ERROR":
		return 17
	default:
		return 9
	}
}

// otlpLogRecordFromLine maps one canonical line. A line that does not parse
// still ships, with the raw line as its body and the component/host set.
func (s *otlpShipper) otlpLogRecordFromLine(line []byte) otlpLogRecord {
	var l relayLine
	if err := json.Unmarshal(line, &l); err != nil {
		l = relayLine{Component: "relay"}
	}
	level := l.Level
	if level == "" {
		level = "INFO"
	}
	var tsNano string
	if t, err := time.Parse(time.RFC3339Nano, l.Ts); err == nil {
		tsNano = strconv.FormatInt(t.UnixNano(), 10)
	}

	// fields keys first, so the top-level keys win a collision.
	byKey := make(map[string]otlpAttrValV, len(l.Fields)+8)
	for k, v := range l.Fields {
		if k != "span_id" && k != "host" {
			byKey[k] = otlpValue(v)
		}
	}
	byKey["tag"] = otlpString(l.Tag)
	for k, v := range map[string]string{
		"session_id":      l.SessionID,
		"conversation_id": l.ConversationID,
		"channel_id":      l.ChannelID,
		"role":            l.Role,
	} {
		if v != "" {
			byKey[k] = otlpString(v)
		}
	}
	if l.Port != nil {
		byKey["port"] = otlpValue(l.Port)
	}

	attrs := make([]otlpAttr, 0, len(byKey))
	for k, v := range byKey {
		attrs = append(attrs, otlpAttr{Key: k, Value: v})
	}
	sort.Slice(attrs, func(i, j int) bool { return attrs[i].Key < attrs[j].Key })

	rec := otlpLogRecord{
		TimeUnixNano:   tsNano,
		SeverityNumber: otlpSeverityNumber(level),
		SeverityText:   level,
		Body:           otlpString(string(line)),
		Attributes:     attrs,
	}
	if isValidTraceID(l.TraceID) {
		rec.TraceID = l.TraceID
		if spanID, ok := l.Fields["span_id"].(string); ok && isValidSpanID(spanID) {
			rec.SpanID = spanID
		}
	}
	return rec
}

// buildLogsPayload renders a batch of canonical lines as an OTLP/HTTP JSON
// ExportLogsServiceRequest.
func (s *otlpShipper) buildLogsPayload(lines [][]byte) ([]byte, error) {
	records := make([]otlpLogRecord, 0, len(lines))
	for _, line := range lines {
		records = append(records, s.otlpLogRecordFromLine(line))
	}
	return json.Marshal(otlpLogsRequest{
		ResourceLogs: []otlpResourceLogs{{
			Resource: otlpResource{Attributes: s.otlpResourceAttrs()},
			ScopeLogs: []otlpScopeLogs{{
				Scope:      otlpScope{Name: otlpServiceName},
				LogRecords: records,
			}},
		}},
	})
}
