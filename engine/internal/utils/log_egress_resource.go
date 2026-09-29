package utils

// log_egress_resource.go — the OTLP resource and the trace correlation ids
// every shipped log record and span carries.
//
// One egress batch holds records from several sources (engine, extensions,
// server, desktop, web, iOS, telemetry), so the resource is derived from each
// record rather than from the exporter: a record's service is
// ion-<component>, and records group into one resourceLogs/resourceSpans
// entry per distinct resource. Logs and spans from the same source therefore
// share a resource, which is what lets a backend join them.
//
// The attribute set follows the OpenTelemetry resource semantic conventions.
// Application Insights derives RoleName (cloud_RoleName) from
// service.namespace and service.name, and RoleInstance from
// service.instance.id; Tempo and Loki read service.name. The TypeScript
// exporter (packages/shared/src/log-egress-resource.ts) derives the same set
// by the same rule. See docs/observability/log-schema.md § Correlation model.

import (
	"sort"
	"strings"
	"sync/atomic"
)

// IonServiceNamespace is the service.namespace every Ion component reports.
const IonServiceNamespace = "ion"

// iosComponent is the component of lines the iOS app wrote. Those lines ship
// from the paired host, but they describe the device, so their instance and
// version come from the line, not from the shipping host.
const iosComponent = "ios"

var serviceVersion atomic.Value

// SetServiceVersion records the build version the egress resource reports as
// service.version for this host's components. Call once at startup.
func SetServiceVersion(v string) {
	serviceVersion.Store(v)
}

// ServiceVersion returns the version SetServiceVersion stored, or "dev".
func ServiceVersion() string {
	if v, ok := serviceVersion.Load().(string); ok && v != "" {
		return v
	}
	return "dev"
}

// ResourceHostName is the host.name resource value: HostName without
// macOS's ".local" suffix, so it matches the value System Metrics reports.
func ResourceHostName() string {
	return strings.TrimSuffix(HostName(), ".local")
}

// ServiceNameForComponent is the service.name of a record from component.
func ServiceNameForComponent(component string) string {
	if component == "" {
		component = "engine"
	}
	return "ion-" + component
}

// egressResourceAttrs builds the resource of the source that wrote r, sorted
// by key. An iOS line and a telemetry event carry their source's identity
// themselves; every other record was written on this host. configured (the otel config's resourceAttributes) wins over every
// derived value except service.name, which always names the record's source.
func egressResourceAttrs(r egressRecord, configured map[string]string) []otlpLogAttr {
	values := map[string]string{
		"service.namespace": IonServiceNamespace,
	}
	component := r.Component
	switch {
	case component == iosComponent:
		values["service.instance.id"] = stringField(r.Fields, "device_id")
		values["service.version"] = stringField(r.Fields, "app_version")
	case isTelemetryEventRecord(r):
		// A telemetry event names the install, build, and host that recorded
		// it, which is not always the process shipping it.
		values["service.instance.id"] = firstNonEmpty(r.InstallID, InstallID())
		values["host.name"] = strings.TrimSuffix(firstNonEmpty(r.Host, ResourceHostName()), ".local")
		values["service.version"] = firstNonEmpty(r.Version, ServiceVersion())
	default:
		values["service.instance.id"] = InstallID()
		values["host.name"] = ResourceHostName()
		values["service.version"] = ServiceVersion()
	}
	for k, v := range configured {
		values[k] = v
	}
	values["service.name"] = ServiceNameForComponent(component)

	attrs := make([]otlpLogAttr, 0, len(values))
	for k, v := range values {
		if v != "" {
			attrs = append(attrs, otlpLogAttr{Key: k, Value: otlpStr(v)})
		}
	}
	sort.Slice(attrs, func(i, j int) bool { return attrs[i].Key < attrs[j].Key })
	return attrs
}

// resourceKey identifies a resource for grouping. Attributes are sorted and
// all string-valued, so joining them is unambiguous.
func resourceKey(attrs []otlpLogAttr) string {
	var b strings.Builder
	for _, a := range attrs {
		b.WriteString(a.Key)
		b.WriteByte('=')
		if a.Value.StringValue != nil {
			b.WriteString(*a.Value.StringValue)
		}
		b.WriteByte('\n')
	}
	return b.String()
}

// resourceServiceName reads service.name back out of a built resource.
func resourceServiceName(attrs []otlpLogAttr) string {
	for _, a := range attrs {
		if a.Key == "service.name" && a.Value.StringValue != nil {
			return *a.Value.StringValue
		}
	}
	return ""
}

// logRecordTraceIDs returns the OTLP LogRecord traceId and spanId for r. The
// trace is the record's trace_id. The span is the one the record is about: a
// span record's own span_id, otherwise the span a telemetry event was
// emitted under (context.parent_span_id). Invalid ids are dropped, and a span
// id is never set without a trace id.
func logRecordTraceIDs(r egressRecord) (string, string) {
	if !IsValidTraceID(r.TraceID) {
		return "", ""
	}
	src := r.Fields
	if isTelemetryEventRecord(r) {
		src = r.Payload
	}
	if id := stringField(src, "span_id"); IsValidSpanID(id) {
		return r.TraceID, id
	}
	if id := stringField(r.Context, "parent_span_id"); IsValidSpanID(id) {
		return r.TraceID, id
	}
	return r.TraceID, ""
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func stringField(m map[string]any, key string) string {
	s, _ := m[key].(string) //nolint:errcheck // a non-string value is treated as absent
	return s
}
