package telemetryformat

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestDecodeLine_FrameFromOlderEngine pins the backward direction of a mixed
// fleet: an engine still emitting an earlier frame number reaches a reader
// built at FrameVersion. Exact-equality validation used to reject it, which
// silently took that engine's whole telemetry stream offline. The frame is
// structurally readable, so it must expand.
func TestDecodeLine_FrameFromOlderEngine(t *testing.T) {
	if FrameVersion < 2 {
		t.Skip("no older frame number exists yet")
	}
	frame, err := Compact([]Event{testEvent()})
	if err != nil {
		t.Fatal(err)
	}
	frame.Schema = FrameVersion - 1
	line, err := encodeLine(frame)
	if err != nil {
		t.Fatal(err)
	}

	events, err := DecodeLine(line)
	if err != nil {
		t.Fatalf("DecodeLine on an older frame = %v, want it accepted", err)
	}
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1", len(events))
	}
	if events[0].SchemaVersion != FrameVersion-1 {
		t.Errorf("schema = %d, want %d — the producer's number must survive, not be relabelled as current",
			events[0].SchemaVersion, FrameVersion-1)
	}
	if events[0].Name != "run.complete" {
		t.Errorf("name = %q, want the event to expand intact", events[0].Name)
	}
}

// TestDecodeLine_FrameFromNewerEngineWithUnknownFields pins the forward
// direction: an engine ahead of this reader adds fields inside the frame. This
// package never sets DisallowUnknownFields, so the added keys drop and every
// field this reader does know still arrives. A newer engine must not be able to
// take an older collector down.
func TestDecodeLine_FrameFromNewerEngineWithUnknownFields(t *testing.T) {
	frame, err := Compact([]Event{testEvent()})
	if err != nil {
		t.Fatal(err)
	}
	line, err := encodeLine(frame)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(line, &raw); err != nil {
		t.Fatal(err)
	}
	// A field a future engine added that this reader has never heard of.
	raw["future_table"] = []any{map[string]any{"k": "v"}}
	events := raw["events"].([]any)
	events[0].(map[string]any)["future_event_field"] = "v"
	withUnknowns, err := json.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}

	decoded, err := DecodeLine(withUnknowns)
	if err != nil {
		t.Fatalf("DecodeLine on a frame carrying unknown fields = %v, want it accepted", err)
	}
	if len(decoded) != 1 || decoded[0].Name != "run.complete" {
		t.Fatalf("decoded = %#v, want the known fields to survive the unknown ones", decoded)
	}
}

// TestDecodeLine_FrameAboveThisReaderIsRejected pins the one case that must
// still fail closed. A number above FrameVersion is the reserved signal for a
// structural framing change this build cannot interpret at all — distinct from
// merely-added fields, which never bump the number.
func TestDecodeLine_FrameAboveThisReaderIsRejected(t *testing.T) {
	frame, err := Compact([]Event{testEvent()})
	if err != nil {
		t.Fatal(err)
	}
	frame.Schema = FrameVersion + 1
	line, err := encodeLine(frame)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := DecodeLine(line); err == nil {
		t.Fatal("DecodeLine accepted a frame above FrameVersion, want a SchemaError")
	}
}

// TestDecodeLine_ExpandOutputRoundTrips pins that `ion telemetry expand` output
// is re-readable by this same decoder. Expand stamps the frame's schema onto
// every event it emits, and the unframed-event path used to reject any event at
// or above FrameVersion — so the tool's own output could not be fed back in.
func TestDecodeLine_ExpandOutputRoundTrips(t *testing.T) {
	frameLine, err := EncodeCompactLine([]Event{testEvent()})
	if err != nil {
		t.Fatal(err)
	}
	expanded, err := DecodeLine(frameLine)
	if err != nil {
		t.Fatal(err)
	}
	eventLine, err := EncodeEventLine(expanded[0])
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(eventLine), "\"schema\":") {
		t.Fatal("expanded event line carries no schema field")
	}

	again, err := DecodeLine(eventLine)
	if err != nil {
		t.Fatalf("DecodeLine on expand output = %v, want the tool's own output to be re-readable", err)
	}
	if len(again) != 1 || again[0].Name != expanded[0].Name || again[0].SchemaVersion != expanded[0].SchemaVersion {
		t.Errorf("round-tripped = %#v, want %#v", again[0], expanded[0])
	}
}
