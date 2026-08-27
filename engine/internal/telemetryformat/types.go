// Package telemetryformat provides telemetry JSONL encoding and decoding.
package telemetryformat

const (
	FrameVersion = 4
	frameRecord  = "telemetry.frame"
)

// Event is one expanded telemetry data point. Its JSON fields match telemetry.Event.
type Event struct {
	Name          string         `json:"name"`
	Ts            string         `json:"ts"`
	SchemaVersion int            `json:"schema"`
	Component     string         `json:"component"`
	InstallID     string         `json:"install_id,omitempty"`
	Host          string         `json:"host,omitempty"`
	Version       string         `json:"version,omitempty"`
	EventID       string         `json:"event_id,omitempty"`
	User          string         `json:"user,omitempty"`
	Payload       map[string]any `json:"payload"`
	Context       map[string]any `json:"context,omitempty"`
	TraceID       string         `json:"trace_id,omitempty"`
}

// Frame is a v4 telemetry frame. Identities and Contexts are interned tables.
type Frame struct {
	Record     string       `json:"record"`
	Schema     int          `json:"schema"`
	Identities []Identity   `json:"identities"`
	Contexts   []Context    `json:"contexts"`
	Events     []FrameEvent `json:"events"`
}

// Identity contains event source fields shared by one or more events.
type Identity struct {
	Component string `json:"component"`
	InstallID string `json:"install_id"`
	Host      string `json:"host"`
	Version   string `json:"version"`
	User      string `json:"user,omitempty"`
}

// Context contains optional context data shared by one or more events.
type Context struct {
	Context map[string]any `json:"context,omitempty"`
	TraceID string         `json:"trace_id,omitempty"`
}

// FrameEvent refers to entries in the identity and context tables.
type FrameEvent struct {
	Identity int            `json:"i"`
	Context  *int           `json:"c,omitempty"`
	Name     string         `json:"name"`
	Ts       string         `json:"ts"`
	EventID  string         `json:"event_id,omitempty"`
	Payload  map[string]any `json:"payload"`
}

// ValidationError identifies an invalid event or frame value.
type ValidationError struct {
	Field  string
	Reason string
}

func (e *ValidationError) Error() string {
	if e.Field == "" {
		return "telemetry format: " + e.Reason
	}
	return "telemetry format: " + e.Field + ": " + e.Reason
}

// RecordError identifies an unsupported frame record.
type RecordError struct{ Record string }

func (e *RecordError) Error() string { return "telemetry format: unsupported record " + e.Record }

// SchemaError identifies an unsupported telemetry schema.
type SchemaError struct{ Schema int }

func (e *SchemaError) Error() string { return "telemetry format: unsupported schema" }

// TableReferenceError identifies an event reference outside an interned table.
type TableReferenceError struct {
	Table string
	Index int
}

func (e *TableReferenceError) Error() string {
	return "telemetry format: " + e.Table + " table index is out of range"
}
