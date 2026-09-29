package telemetry

import "github.com/dsswift/ion/engine/internal/utils"

// Span kinds a span event names in its payload's span_kind. An engine span
// that answers another Ion process's call is a server span (run.execute); one
// that calls out of the engine is a client span (llm.call). Every other span
// is internal. Log egress and the OTLP bridge both map these to OTLP kinds.
const (
	SpanKindServer = "server"
	SpanKindClient = "client"
	spanKindKey    = "span_kind"
	// spanKindAttr carries the kind from RecordEvent to recordSpan without
	// colliding with a payload attribute; it never reaches the exported span.
	spanKindAttr = "ion.span_kind"
)

// hostResourceAttributes is this host's OTLP resource identity: the values
// log egress stamps on the engine's own records, so the SDK trace and metrics
// exports land under the same service instance. configured wins.
func hostResourceAttributes(configured map[string]string) map[string]string {
	out := make(map[string]string, len(configured)+4)
	out["service.namespace"] = utils.IonServiceNamespace
	out["service.version"] = utils.ServiceVersion()
	if host := utils.ResourceHostName(); host != "" {
		out["host.name"] = host
	} else {
		utils.LogWithFields(utils.LevelWarn, "telemetry.otel", "hostname unreadable; host.name not set", nil)
	}
	if id := utils.InstallID(); id != "" {
		out["service.instance.id"] = id
	}
	for k, v := range configured {
		out[k] = v
	}
	return out
}
