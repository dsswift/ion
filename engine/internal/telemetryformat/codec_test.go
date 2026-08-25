package telemetryformat

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func testEvent() Event {
	return Event{
		Name: "run.complete", Ts: "2026-03-20T12:00:00Z", SchemaVersion: 3,
		Component: "engine", InstallID: "install", Host: "host", Version: "dev",
		EventID: "event", User: "user", TraceID: "trace",
		Payload: map[string]any{"z": float64(1), "a": map[string]any{"b": true, "a": "first"}},
		Context: map[string]any{"session_id": "session"},
	}
}

func TestCompactExpandRoundTrip(t *testing.T) {
	first := testEvent()
	second := testEvent()
	second.Name = "tool.execute"
	second.Payload = map[string]any{"a": "again"}
	frame, err := Compact([]Event{first, second})
	if err != nil {
		t.Fatal(err)
	}
	if frame.Record != frameRecord || frame.Schema != FrameVersion {
		t.Fatalf("frame = %#v", frame)
	}
	if len(frame.Identities) != 1 || len(frame.Contexts) != 1 {
		t.Fatalf("tables = %#v", frame)
	}
	if frame.Events[0].Identity != 0 || frame.Events[1].Identity != 0 {
		t.Errorf("identity indexes = %#v", frame.Events)
	}
	if frame.Events[0].Context == nil || *frame.Events[0].Context != 0 {
		t.Errorf("context index = %#v", frame.Events[0].Context)
	}
	expanded, err := Expand(frame)
	if err != nil {
		t.Fatal(err)
	}
	want := []Event{first, second}
	want[0].SchemaVersion = FrameVersion
	want[1].SchemaVersion = FrameVersion
	if !reflect.DeepEqual(expanded, want) {
		t.Errorf("expanded = %#v", expanded)
	}
}

func TestCompactUsesFirstSeenInternedTables(t *testing.T) {
	first := testEvent()
	second := testEvent()
	second.Component = "relay"
	second.Context = map[string]any{"b": "second", "a": "first"}
	third := testEvent()
	third.Context = map[string]any{"a": "first", "b": "second"}
	frame, err := Compact([]Event{first, second, third})
	if err != nil {
		t.Fatal(err)
	}
	if got := []int{frame.Events[0].Identity, frame.Events[1].Identity, frame.Events[2].Identity}; !reflect.DeepEqual(got, []int{0, 1, 0}) {
		t.Errorf("identity indexes = %v", got)
	}
	if len(frame.Contexts) != 2 {
		t.Fatalf("context count = %d, want 2", len(frame.Contexts))
	}
	if frame.Events[1].Context == nil || frame.Events[2].Context == nil || *frame.Events[1].Context != 1 || *frame.Events[2].Context != 1 {
		t.Errorf("context indexes = %#v, %#v", frame.Events[1].Context, frame.Events[2].Context)
	}
	if !reflect.DeepEqual(frame.Contexts[1].Context, second.Context) {
		t.Errorf("context map = %#v, want native map %#v", frame.Contexts[1].Context, second.Context)
	}
}

func TestDecodeLineSupportsLegacyAndV4(t *testing.T) {
	event := testEvent()
	legacy, err := EncodeEventLine(event)
	if err != nil {
		t.Fatal(err)
	}
	for _, schema := range []int{1, 2, 3} {
		legacyEvent := event
		legacyEvent.SchemaVersion = schema
		line, err := EncodeEventLine(legacyEvent)
		if err != nil {
			t.Fatal(err)
		}
		events, err := DecodeLine(line)
		if err != nil {
			t.Fatalf("v%d: %v", schema, err)
		}
		if !reflect.DeepEqual(events, []Event{legacyEvent}) {
			t.Errorf("v%d = %#v", schema, events)
		}
	}
	if _, err := DecodeLine(legacy); err != nil {
		t.Fatal(err)
	}
	line, err := EncodeCompactLine([]Event{event})
	if err != nil {
		t.Fatal(err)
	}
	events, err := DecodeLine(line)
	if err != nil {
		t.Fatal(err)
	}
	want := event
	want.SchemaVersion = FrameVersion
	if !reflect.DeepEqual(events, []Event{want}) {
		t.Errorf("v4 = %#v", events)
	}
}

func TestV4WireContract(t *testing.T) {
	line, err := EncodeCompactLine([]Event{testEvent()})
	if err != nil {
		t.Fatal(err)
	}
	var frame map[string]any
	if err := json.Unmarshal(line, &frame); err != nil {
		t.Fatal(err)
	}
	if got, want := frame["record"], "telemetry.frame"; got != want {
		t.Errorf("record = %v, want %v", got, want)
	}
	if got, want := frame["schema"], float64(4); got != want {
		t.Errorf("schema = %v, want %v", got, want)
	}
	for _, forbidden := range []string{"v", "s", "e"} {
		if _, exists := frame[forbidden]; exists {
			t.Errorf("frame has obsolete %q field", forbidden)
		}
	}
	event := frame["events"].([]any)[0].(map[string]any)
	for _, field := range []string{"i", "name", "ts", "event_id", "payload"} {
		if _, exists := event[field]; !exists {
			t.Errorf("event has no %q field", field)
		}
	}
}

func TestFrameTypedErrors(t *testing.T) {
	valid, err := Compact([]Event{testEvent()})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name  string
		frame Frame
		want  any
	}{
		{"record", Frame{Record: "wrong", Schema: 4}, &RecordError{}},
		{"schema", Frame{Record: frameRecord, Schema: 3}, &SchemaError{}},
		{"identity reference", Frame{Record: frameRecord, Schema: 4, Events: []FrameEvent{{Identity: 0, Name: "event", Ts: "now", Payload: map[string]any{}}}}, &TableReferenceError{}},
		{"context reference", Frame{Record: frameRecord, Schema: 4, Identities: valid.Identities, Events: []FrameEvent{{Identity: 0, Context: pointer(0), Name: "event", Ts: "now", Payload: map[string]any{}}}}, &TableReferenceError{}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			err := ValidateFrame(test.frame)
			switch test.want.(type) {
			case *RecordError:
				var target *RecordError
				if !errors.As(err, &target) {
					t.Fatalf("error = %T %v", err, err)
				}
			case *SchemaError:
				var target *SchemaError
				if !errors.As(err, &target) {
					t.Fatalf("error = %T %v", err, err)
				}
			case *TableReferenceError:
				var target *TableReferenceError
				if !errors.As(err, &target) {
					t.Fatalf("error = %T %v", err, err)
				}
			}
		})
	}
}

func TestLineEncoding(t *testing.T) {
	line, err := EncodeEventLine(testEvent())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(string(line), "\n") {
		t.Error("event line has no newline")
	}
	frame, err := Compact([]Event{testEvent()})
	if err != nil {
		t.Fatal(err)
	}
	line, err = EncodeFrameLine(frame)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(line), `"record":"telemetry.frame"`) || !strings.HasSuffix(string(line), "\n") {
		t.Errorf("frame line = %s", line)
	}
}

func pointer(value int) *int { return &value }
