// log_egress_tailer_telemetry.go — compact-frame expansion for the egress tailer.
//
// ~/.ion/telemetry.jsonl stores compact frames: shared identity and context
// data is interned into tables and each event references a table index. That
// line shape has no top-level `name` or `payload`, so the operational-record
// path cannot recognize it as telemetry — it would stuff the whole frame JSON
// into `msg` and ship it as an ordinary log line, discarding every cost, kind,
// and attribution field the remote dashboards query.
//
// So the tailer expands a frame into one record per event before shipping,
// exactly as the desktop tailer does (desktop/src/main/telemetry-frame.ts).
// Both decoders are pinned against the same fixture — see
// testdata/frame_fixture.json and the desktop's telemetry-frame.test.ts.
package utils

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/telemetryformat"
)

// isTelemetryFrameLine reports whether raw declares the compact frame record.
// It reads only the discriminator, so a line that is not a frame costs one
// shallow unmarshal rather than a full decode attempt.
func isTelemetryFrameLine(raw []byte) bool {
	var probe struct {
		Record string `json:"record"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return false
	}
	return probe.Record == telemetryformat.FrameRecord
}

// expandTelemetryFrameLine decodes one compact frame into the egress records
// its events expand to. The bool reports whether raw was a frame at all: false
// means the caller should fall through to its normal per-line handling.
//
// A frame this build cannot decode yields (nil, true) — recognized as a frame,
// but dropped. Shipping it raw would put unqueryable JSON in `msg`, and
// returning an error would stall the tailer's cursor on a line that will never
// decode. The caller logs the drop.
func expandTelemetryFrameLine(raw []byte, source string) ([]egressRecord, bool, error) {
	if !isTelemetryFrameLine(raw) {
		return nil, false, nil
	}
	events, err := telemetryformat.DecodeLine(raw)
	if err != nil {
		return nil, true, err
	}
	records := make([]egressRecord, 0, len(events))
	for _, event := range events {
		records = append(records, telemetryEventEgressRecord(event, source))
	}
	return records, true, nil
}

// telemetryEventEgressRecord carries one expanded telemetry event in the
// egressRecord telemetry-carrier fields. The field map mirrors the desktop's
// expandTelemetryFrame so the SAME event produces the same shipped shape on
// either surface — the OTLP exporter branches on Name and Payload being set
// (isTelemetryEventRecord), and maps from these fields rather than from Msg.
func telemetryEventEgressRecord(event telemetryformat.Event, source string) egressRecord {
	record := egressRecord{
		Ts:        event.Ts,
		Component: event.Component,
		Name:      event.Name,
		Payload:   event.Payload,
		Context:   event.Context,
		Schema:    event.SchemaVersion,
		InstallID: event.InstallID,
		Version:   event.Version,
		Host:      event.Host,
		EventID:   event.EventID,
		User:      event.User,
		TraceID:   event.TraceID,
	}
	// A telemetry event carries no component of its own only when the producer
	// omitted it; fall back to the source name so the record is still routable.
	if record.Component == "" {
		record.Component = source
	}
	// Payload is the discriminator the OTLP exporter branches on. An event with
	// a genuinely empty payload must still present a non-nil map, or it would
	// be mapped through the operational path and lose its telemetry attributes.
	if record.Payload == nil {
		record.Payload = map[string]any{}
	}
	return record
}
