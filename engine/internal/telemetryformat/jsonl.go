package telemetryformat

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// DecodeLine decodes one expanded event line or one frame line. Both are
// accepted at any schema number this reader can structurally interpret; see
// ValidateFrame for the one rejection case.
func DecodeLine(line []byte) ([]Event, error) {
	line = bytes.TrimSpace(line)
	if len(line) == 0 {
		return nil, &ValidationError{Field: "line", Reason: "is empty"}
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(line, &envelope); err != nil {
		return nil, fmt.Errorf("telemetry format: decode line: %w", err)
	}
	if _, ok := envelope["record"]; ok {
		var frame Frame
		if err := json.Unmarshal(line, &frame); err != nil {
			return nil, fmt.Errorf("telemetry format: decode v4 frame: %w", err)
		}
		return Expand(frame)
	}
	var event Event
	if err := json.Unmarshal(line, &event); err != nil {
		return nil, fmt.Errorf("telemetry format: decode event: %w", err)
	}
	if err := ValidateEvent(event); err != nil {
		return nil, err
	}
	// No upper bound on an unframed event's schema. A line without a "record"
	// key IS an expanded event whatever number it carries, and unknown keys
	// have already been dropped by the decode above. Rejecting schema >=
	// FrameVersion here also made `ion telemetry expand` output un-re-readable
	// by this same decoder, since Expand stamps the frame's schema onto every
	// event it emits.
	return []Event{event}, nil
}

// EncodeEventLine encodes an expanded event as a JSON line.
func EncodeEventLine(event Event) ([]byte, error) {
	if err := ValidateEvent(event); err != nil {
		return nil, err
	}
	return encodeLine(event)
}

// EncodeFrameLine encodes a validated v4 frame as a JSON line.
func EncodeFrameLine(frame Frame) ([]byte, error) {
	if err := ValidateFrame(frame); err != nil {
		return nil, err
	}
	return encodeLine(frame)
}

// EncodeCompactLine compacts events then encodes the resulting v4 frame line.
func EncodeCompactLine(events []Event) ([]byte, error) {
	frame, err := Compact(events)
	if err != nil {
		return nil, err
	}
	return EncodeFrameLine(frame)
}

func encodeLine(value any) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("telemetry format: encode line: %w", err)
	}
	return append(encoded, '\n'), nil
}
