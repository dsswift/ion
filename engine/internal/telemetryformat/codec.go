package telemetryformat

import (
	"encoding/json"
	"fmt"
	"sort"
)

// Compact converts expanded events into one deterministic v4 frame.
func Compact(events []Event) (Frame, error) {
	identities := newIdentityTable()
	contexts := newContextTable()
	frame := Frame{
		Record: frameRecord,
		Schema: FrameVersion,
		Events: make([]FrameEvent, 0, len(events)),
	}
	for index, event := range events {
		if err := ValidateEvent(event); err != nil {
			return Frame{}, fmt.Errorf("event %d: %w", index, err)
		}
		identity, err := identities.index(Identity{
			Component: event.Component,
			InstallID: event.InstallID,
			Host:      event.Host,
			Version:   event.Version,
			User:      event.User,
		})
		if err != nil {
			return Frame{}, fmt.Errorf("event %d identity: %w", index, err)
		}
		context, err := contexts.index(Context{Context: event.Context, TraceID: event.TraceID})
		if err != nil {
			return Frame{}, fmt.Errorf("event %d context: %w", index, err)
		}
		frameEvent := FrameEvent{
			Identity: identity,
			Name:     event.Name,
			Ts:       event.Ts,
			EventID:  event.EventID,
			Payload:  event.Payload,
		}
		if context != -1 {
			frameEvent.Context = &context
		}
		frame.Events = append(frame.Events, frameEvent)
	}
	frame.Identities = identities.values
	frame.Contexts = contexts.values
	return frame, nil
}

// Expand converts a validated v4 frame into expanded events.
func Expand(frame Frame) ([]Event, error) {
	if err := ValidateFrame(frame); err != nil {
		return nil, err
	}
	events := make([]Event, 0, len(frame.Events))
	for index, frameEvent := range frame.Events {
		identity := frame.Identities[frameEvent.Identity]
		event := Event{
			Name:          frameEvent.Name,
			Ts:            frameEvent.Ts,
			SchemaVersion: FrameVersion,
			Component:     identity.Component,
			InstallID:     identity.InstallID,
			Host:          identity.Host,
			Version:       identity.Version,
			EventID:       frameEvent.EventID,
			User:          identity.User,
			Payload:       frameEvent.Payload,
		}
		if frameEvent.Context != nil {
			context := frame.Contexts[*frameEvent.Context]
			event.Context = context.Context
			event.TraceID = context.TraceID
		}
		if err := ValidateEvent(event); err != nil {
			return nil, fmt.Errorf("event %d: %w", index, err)
		}
		events = append(events, event)
	}
	return events, nil
}

// ValidateEvent checks fields required by the expanded telemetry contract.
func ValidateEvent(event Event) error {
	if event.Name == "" {
		return &ValidationError{Field: "name", Reason: "is required"}
	}
	if event.Ts == "" {
		return &ValidationError{Field: "ts", Reason: "is required"}
	}
	if event.SchemaVersion < 1 {
		return &ValidationError{Field: "schema", Reason: "must be positive"}
	}
	if event.Component == "" {
		return &ValidationError{Field: "component", Reason: "is required"}
	}
	if event.Payload == nil {
		return &ValidationError{Field: "payload", Reason: "is required"}
	}
	return nil
}

// ValidateFrame checks the v4 framing and table references.
func ValidateFrame(frame Frame) error {
	if frame.Record != frameRecord {
		return &RecordError{Record: frame.Record}
	}
	if frame.Schema != FrameVersion {
		return &SchemaError{Schema: frame.Schema}
	}
	for index, identity := range frame.Identities {
		if identity.Component == "" {
			return &ValidationError{Field: fmt.Sprintf("identities[%d].component", index), Reason: "is required"}
		}
	}
	for index, frameEvent := range frame.Events {
		if frameEvent.Identity < 0 || frameEvent.Identity >= len(frame.Identities) {
			return &TableReferenceError{Table: "identities", Index: frameEvent.Identity}
		}
		if frameEvent.Context != nil && (*frameEvent.Context < 0 || *frameEvent.Context >= len(frame.Contexts)) {
			return &TableReferenceError{Table: "contexts", Index: *frameEvent.Context}
		}
		if frameEvent.Name == "" {
			return &ValidationError{Field: fmt.Sprintf("events[%d].name", index), Reason: "is required"}
		}
		if frameEvent.Ts == "" {
			return &ValidationError{Field: fmt.Sprintf("events[%d].ts", index), Reason: "is required"}
		}
		if frameEvent.Payload == nil {
			return &ValidationError{Field: fmt.Sprintf("events[%d].payload", index), Reason: "is required"}
		}
	}
	return nil
}

type identityTable struct {
	values  []Identity
	indexes map[string]int
}

func newIdentityTable() *identityTable { return &identityTable{indexes: make(map[string]int)} }

func (table *identityTable) index(identity Identity) (int, error) {
	key, err := canonicalJSON(identity)
	if err != nil {
		return 0, err
	}
	if index, ok := table.indexes[string(key)]; ok {
		return index, nil
	}
	index := len(table.values)
	table.values = append(table.values, identity)
	table.indexes[string(key)] = index
	return index, nil
}

type contextTable struct {
	values  []Context
	indexes map[string]int
}

func newContextTable() *contextTable { return &contextTable{indexes: make(map[string]int)} }

func (table *contextTable) index(context Context) (int, error) {
	if context.Context == nil && context.TraceID == "" {
		return -1, nil
	}
	key, err := canonicalJSON(context)
	if err != nil {
		return 0, err
	}
	if index, ok := table.indexes[string(key)]; ok {
		return index, nil
	}
	index := len(table.values)
	table.values = append(table.values, context)
	table.indexes[string(key)] = index
	return index, nil
}

func canonicalJSON(value any) ([]byte, error) {
	return marshalCanonical(value)
}

func marshalCanonical(value any) ([]byte, error) {
	switch value := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(value))
		for key := range value {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		encoded := []byte{'{'}
		for index, key := range keys {
			if index > 0 {
				encoded = append(encoded, ',')
			}
			keyJSON, err := json.Marshal(key)
			if err != nil {
				return nil, err
			}
			child, err := marshalCanonical(value[key])
			if err != nil {
				return nil, err
			}
			encoded = append(encoded, keyJSON...)
			encoded = append(encoded, ':')
			encoded = append(encoded, child...)
		}
		return append(encoded, '}'), nil
	case []any:
		encoded := []byte{'['}
		for index, child := range value {
			if index > 0 {
				encoded = append(encoded, ',')
			}
			childJSON, err := marshalCanonical(child)
			if err != nil {
				return nil, err
			}
			encoded = append(encoded, childJSON...)
		}
		return append(encoded, ']'), nil
	default:
		return json.Marshal(value)
	}
}
