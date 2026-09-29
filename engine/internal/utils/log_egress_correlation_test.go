package utils

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// captureOtlp posts records through the otel target and returns the raw
// /v1/logs and /v1/traces bodies, decoded generically so a test sees the
// exact wire keys.
func captureOtlp(t *testing.T, records []egressRecord, cfg *types.OtelConfig) (map[string]any, map[string]any) {
	t.Helper()
	var mu sync.Mutex
	bodies := map[string]map[string]any{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body) //nolint:errcheck // test server
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Errorf("%s body: %v", r.URL.Path, err)
		}
		mu.Lock()
		bodies[r.URL.Path] = m
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	cfg.Endpoint = srv.URL
	if err := flushEgressToOtel(records, cfg, srv.Client()); err != nil {
		t.Fatalf("flush: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	return bodies["/v1/logs"], bodies["/v1/traces"]
}

func asMaps(v any) []map[string]any {
	items, _ := v.([]any) //nolint:errcheck // absent list decodes as empty
	out := make([]map[string]any, 0, len(items))
	for _, it := range items {
		if m, ok := it.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func attrValues(v any) map[string]string {
	out := map[string]string{}
	for _, a := range asMaps(v) {
		val, _ := a["value"].(map[string]any) //nolint:errcheck // test decode
		s, _ := val["stringValue"].(string)   //nolint:errcheck // non-string values are not compared here
		key, _ := a["key"].(string)           //nolint:errcheck // test decode
		out[key] = s
	}
	return out
}

// resourceByService indexes resourceLogs / resourceSpans by service.name,
// returning each resource's attributes and its records (logRecords or spans).
func resourceByService(t *testing.T, body map[string]any, listKey, scopeKey, itemsKey string) (map[string]map[string]string, map[string][]map[string]any) {
	t.Helper()
	attrs := map[string]map[string]string{}
	items := map[string][]map[string]any{}
	for _, rl := range asMaps(body[listKey]) {
		res, _ := rl["resource"].(map[string]any) //nolint:errcheck // test decode
		a := attrValues(res["attributes"])
		name := a["service.name"]
		if _, dup := attrs[name]; dup {
			t.Fatalf("service %s split across two resources", name)
		}
		attrs[name] = a
		for _, sl := range asMaps(rl[scopeKey]) {
			items[name] = append(items[name], asMaps(sl[itemsKey])...)
		}
	}
	return attrs, items
}

// A log record carries its trace and span as the OTLP LogRecord traceId and
// spanId fields, where Application Insights reads a log's operation, and
// nowhere else: no attribute repeats them, the component (service.name), or
// the host and install (host.name, service.instance.id).
func TestOtlpLogRecordCarriesTraceAndSpanIDs(t *testing.T) {
	records := []egressRecord{
		{Ts: "2026-09-23T10:00:01Z", Level: "INFO", Msg: "run started", Component: "engine", Tag: "session", TraceID: testTraceID,
			Fields: map[string]any{"host": "box.local", "install_id": "iid", "turn": 1.0}},
		{Ts: "2026-09-23T10:00:01Z", Level: "INFO", Msg: "prompt.handle", Component: "server", Tag: SpanLogTag, TraceID: testTraceID,
			Fields: map[string]any{"span_id": testSpanID, "parent_span_id": testParentID, "duration_ms": 4.0, "span_kind": "server"}},
		{Ts: "2026-09-23T10:00:01Z", Component: "engine", Name: "tool.execute", TraceID: testTraceID,
			Payload: map[string]any{"tool": "Bash"}, Context: map[string]any{"parent_span_id": testParentID}},
		{Ts: "2026-09-23T10:00:01Z", Level: "INFO", Msg: "no trace", Component: "engine", Tag: "session"},
		{Ts: "2026-09-23T10:00:01Z", Level: "INFO", Msg: "bad trace", Component: "engine", Tag: "session", TraceID: "4BF92F3577B34DA6A3CE929D0E0E4736"},
	}
	logs, _ := captureOtlp(t, records, &types.OtelConfig{})
	_, byService := resourceByService(t, logs, "resourceLogs", "scopeLogs", "logRecords")

	byBody := map[string]map[string]any{}
	for _, recs := range byService {
		for _, lr := range recs {
			body, _ := lr["body"].(map[string]any) //nolint:errcheck // test decode
			s, _ := body["stringValue"].(string)   //nolint:errcheck // test decode
			var parsed map[string]any
			if err := json.Unmarshal([]byte(s), &parsed); err != nil {
				t.Fatalf("body is not JSON: %v", err)
			}
			key, _ := parsed["msg"].(string) //nolint:errcheck // telemetry bodies carry name instead
			if key == "" {
				key, _ = parsed["name"].(string) //nolint:errcheck // test decode
			}
			byBody[key] = lr
		}
	}

	want := map[string][2]string{
		"run started":   {testTraceID, ""},
		"prompt.handle": {testTraceID, testSpanID},
		"tool.execute":  {testTraceID, testParentID},
		"no trace":      {"", ""},
		"bad trace":     {"", ""},
	}
	for msg, ids := range want {
		lr, ok := byBody[msg]
		if !ok {
			t.Fatalf("record %q not shipped", msg)
		}
		traceID, hasTrace := lr["traceId"]
		spanID, hasSpan := lr["spanId"]
		if ids[0] == "" && hasTrace || ids[0] != "" && traceID != ids[0] {
			t.Errorf("%s: traceId = %v, want %q", msg, traceID, ids[0])
		}
		if ids[1] == "" && hasSpan || ids[1] != "" && spanID != ids[1] {
			t.Errorf("%s: spanId = %v, want %q", msg, spanID, ids[1])
		}
		attrs := attrValues(lr["attributes"])
		for _, k := range []string{"trace_id", "span_id", "component", "host", "install_id", "kind", "service", "engine_version", "loki.attribute.labels"} {
			if _, ok := attrs[k]; ok {
				t.Errorf("%s: attribute %s repeats the envelope or resource", msg, k)
			}
		}
	}
}

// Logs and spans from one source share one resource carrying the identity
// Application Insights builds RoleName and RoleInstance from. iOS lines,
// shipped by the paired host, describe the device instead.
func TestEgressResourceAttributesOnLogsAndSpans(t *testing.T) {
	SetServiceVersion("9.9.9")
	t.Cleanup(func() { SetServiceVersion("") })
	span := func(component string) egressRecord {
		return egressRecord{Ts: "2026-09-23T10:00:01Z", Level: "INFO", Msg: "s", Component: component, Tag: SpanLogTag, TraceID: testTraceID,
			Fields: map[string]any{"span_id": testSpanID, "duration_ms": 1.0, "device_id": "DEV-1", "app_version": "3.2.1"}}
	}
	records := []egressRecord{
		{Ts: "2026-09-23T10:00:01Z", Level: "INFO", Msg: "hello", Component: "engine", Tag: "session"},
		{Ts: "2026-09-23T10:00:01Z", Level: "INFO", Msg: "hello", Component: "server", Tag: "prompt"},
		span("server"),
		span("ios"),
		{Ts: "2026-09-23T10:00:01Z", Component: "engine", Name: "run.complete", Version: "9.9.9", Payload: map[string]any{"run_cost_usd": 0.1}},
	}
	cfg := &types.OtelConfig{ResourceAttributes: map[string]string{"deployment.environment.name": "prod", "service.name": "ignored"}}
	logs, traces := captureOtlp(t, records, cfg)
	logRes, _ := resourceByService(t, logs, "resourceLogs", "scopeLogs", "logRecords")
	spanRes, _ := resourceByService(t, traces, "resourceSpans", "scopeSpans", "spans")

	host := ResourceHostName()
	for _, name := range []string{"ion-server"} {
		if len(logRes[name]) == 0 || len(spanRes[name]) == 0 {
			t.Fatalf("%s missing from logs or spans", name)
		}
		for k, v := range logRes[name] {
			if spanRes[name][k] != v {
				t.Errorf("%s: span resource %s=%q, log resource %q", name, k, spanRes[name][k], v)
			}
		}
	}
	server := logRes["ion-server"]
	for k, want := range map[string]string{
		"service.namespace": IonServiceNamespace, "service.instance.id": InstallID(), "host.name": host,
		"service.version": "9.9.9", "deployment.environment.name": "prod",
	} {
		if server[k] != want {
			t.Errorf("ion-server %s = %q, want %q", k, server[k], want)
		}
	}
	if logRes["ion-engine"]["service.version"] == "" {
		t.Errorf("ion-engine has no service.version: %v", logRes["ion-engine"])
	}
	ios := spanRes["ion-ios"]
	if ios["service.instance.id"] != "DEV-1" || ios["service.version"] != "3.2.1" || ios["host.name"] != "" || ios["service.namespace"] != IonServiceNamespace {
		t.Errorf("ion-ios resource = %v", ios)
	}
	if _, ok := logRes["ignored"]; ok {
		t.Error("a configured service.name overrode the record's source")
	}
}

// A telemetry event's resource is the install, build, and host that recorded
// it, which can differ from the process shipping it; without its own identity
// it falls back to this host's.
func TestTelemetryEventResourceIsItsRecorder(t *testing.T) {
	SetServiceVersion("9.9.9")
	t.Cleanup(func() { SetServiceVersion("") })
	res := func(r egressRecord) map[string]string {
		out := map[string]string{}
		for _, a := range egressResourceAttrs(r, nil) {
			out[a.Key] = *a.Value.StringValue
		}
		return out
	}
	own := res(egressRecord{Component: "engine", Name: "run.complete", Payload: map[string]any{},
		InstallID: "install-a", Version: "1.2.3", Host: "other.local"})
	for k, want := range map[string]string{"service.name": "ion-engine", "service.instance.id": "install-a", "service.version": "1.2.3", "host.name": "other"} {
		if own[k] != want {
			t.Errorf("event with identity: %s = %q, want %q", k, own[k], want)
		}
	}
	bare := res(egressRecord{Component: "engine", Name: "run.complete", Payload: map[string]any{}})
	for k, want := range map[string]string{"service.instance.id": InstallID(), "service.version": "9.9.9", "host.name": ResourceHostName()} {
		if bare[k] != want {
			t.Errorf("event without identity: %s = %q, want %q", k, bare[k], want)
		}
	}
}

// Every hop records the kind a trace backend needs to split requests from
// dependencies and draw an edge between services: a CLIENT span in one
// service is the parent of the SERVER span in the next.
func TestSpanKindPerHopAndClientParentsServer(t *testing.T) {
	const (
		sendID   = "a000000000000001"
		handleID = "a000000000000002"
		callID   = "a000000000000003"
		runID    = "a000000000000004"
		llmID    = "a000000000000005"
	)
	line := func(component, name, id, parent, kind string) egressRecord {
		return egressRecord{Ts: "2026-09-23T10:00:01Z", Level: "INFO", Msg: name, Component: component, Tag: SpanLogTag, TraceID: testTraceID,
			Fields: map[string]any{"span_id": id, "parent_span_id": parent, "duration_ms": 1.0, "span_kind": kind}}
	}
	event := func(name, id, parent, kind string) egressRecord {
		return egressRecord{Ts: "2026-09-23T10:00:01Z", Component: "engine", Name: name, TraceID: testTraceID,
			Payload: map[string]any{"span_id": id, "duration_ms": 1.0, "span_kind": kind}, Context: map[string]any{"parent_span_id": parent}}
	}
	records := []egressRecord{
		line("web", "prompt.send", sendID, "", "client"),
		line("server", "prompt.handle", handleID, sendID, "server"),
		line("server", "engine.send_prompt", callID, handleID, "client"),
		event("run.execute", runID, callID, "server"),
		event("llm.call", llmID, runID, "client"),
	}
	req, count, ok := buildTracesExport(records, nil)
	if !ok || count != len(records) {
		t.Fatalf("exported %d spans, want %d", count, len(records))
	}
	type placed struct {
		service string
		span    otlpSpan
	}
	byID := map[string]placed{}
	for _, rs := range req.ResourceSpans {
		service := resourceServiceName(rs.Resource.Attributes)
		for _, s := range rs.ScopeSpans[0].Spans {
			byID[s.SpanID] = placed{service, s}
		}
	}
	wantKind := map[string]int{sendID: otlpSpanKindClient, handleID: otlpSpanKindServer, callID: otlpSpanKindClient, runID: otlpSpanKindServer, llmID: otlpSpanKindClient}
	for id, kind := range wantKind {
		if byID[id].span.Kind != kind {
			t.Errorf("%s kind = %d, want %d", byID[id].span.Name, byID[id].span.Kind, kind)
		}
	}
	for _, edge := range [][2]string{{sendID, handleID}, {callID, runID}} {
		client, server := byID[edge[0]], byID[edge[1]]
		if server.span.ParentSpanID != client.span.SpanID || client.span.TraceID != server.span.TraceID {
			t.Errorf("%s is not the parent of %s", client.span.Name, server.span.Name)
		}
		if client.service == server.service {
			t.Errorf("edge %s -> %s stays inside %s", client.span.Name, server.span.Name, client.service)
		}
	}
}

// An iOS line's device and app build are its resource (service.instance.id,
// service.version), so they are not repeated as attributes; its other fields
// are.
func TestIOSAttributesOmitResourceFields(t *testing.T) {
	attrs := map[string]bool{}
	for _, a := range otlpAttrsFromRecord(egressRecord{Component: "ios", Tag: "session",
		Fields: map[string]any{"device_id": "DEV-1", "app_version": "3.2.1", "device_model": "iPhone", "host": "paired"}}) {
		attrs[a.Key] = true
	}
	if attrs["device_id"] || attrs["app_version"] {
		t.Errorf("iOS resource fields repeated as attributes: %v", attrs)
	}
	if !attrs["device_model"] || !attrs["host"] {
		t.Errorf("iOS line lost a non-resource field: %v", attrs)
	}
}
