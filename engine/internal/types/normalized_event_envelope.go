package types

// normalizedEventEnvelope is the set of keys NormalizedEvent's JSON carries
// outside the variant's own fields: the type discriminator and the trace
// position of the run that emitted the event. UnmarshalJSON peeks it before
// decoding the variant; MarshalJSON writes it through stampEnvelope. The
// contract manifest (testdata/contracts.json, "normalizedEventEnvelope")
// lists its keys so the TS and Swift mirrors pin the set the marshaler writes.
type normalizedEventEnvelope struct {
	Type    string `json:"type"`
	TraceID string `json:"trace_id,omitempty"`
	SpanID  string `json:"span_id,omitempty"`
}

// stampEnvelope writes the trace keys into an already-flattened event map.
// Empty values are omitted so an event outside a run carries no trace keys.
func (e NormalizedEvent) stampEnvelope(m map[string]any) {
	if e.TraceID != "" {
		m["trace_id"] = e.TraceID
	}
	if e.SpanID != "" {
		m["span_id"] = e.SpanID
	}
}

// WithTrace returns the event stamped with a run's trace position when the
// event carries none yet. An event that already names its trace (a backend
// that stamped it at emit time) is returned unchanged, so a later stamping
// layer never overwrites the closer one.
func (e NormalizedEvent) WithTrace(traceID, spanID string) NormalizedEvent {
	if e.TraceID == "" {
		e.TraceID = traceID
	}
	if e.SpanID == "" {
		e.SpanID = spanID
	}
	return e
}
