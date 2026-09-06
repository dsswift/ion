package conversation

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/utils"
)

// AppendAbortMarker persists a cancelled run as a durable tree entry.
//
// The engine holds the stop fact at three places while it happens — the abort
// command, the run loop's cancelled label, and the run exit — and none of them
// reached the conversation file, so a cancelled run was indistinguishable on
// disk from a completed one. This is the one place that writes the entry, so
// every abort path agrees on its shape.
//
// Callers must invoke this only after the backend's final save for the run has
// landed, otherwise that save overwrites the appended entry. handleRunExit is
// that point; it is the same window persistTerminalDispatches writes in.
//
// Idempotent by RunID. A run exit can be delivered more than once, and writing
// the same stop twice would make one cancelled run read as two.
func AppendAbortMarker(conversationID string, data AbortedData) error {
	if conversationID == "" {
		return fmt.Errorf("append abort marker: empty conversation id")
	}
	if data.RunID == "" {
		return fmt.Errorf("append abort marker: empty run id")
	}
	if data.Source == "" {
		return fmt.Errorf("append abort marker: empty source")
	}

	conv, err := Load(conversationID, "")
	if err != nil {
		return fmt.Errorf("append abort marker: load %s: %w", conversationID, err)
	}
	for _, entry := range conv.Entries {
		if entry.Type != EntryAborted {
			continue
		}
		existing := asAbortedData(entry.Data)
		if existing != nil && existing.RunID == data.RunID {
			utils.LogWithFields(utils.LevelDebug, "conversation", "append abort marker: already persisted", map[string]any{
				"conversation_id": conversationID,
				"run_id":          data.RunID,
			})
			return nil
		}
	}

	AppendEntry(conv, EntryAborted, data)
	if err := Save(conv, ""); err != nil {
		return fmt.Errorf("append abort marker: save %s: %w", conversationID, err)
	}
	utils.LogWithFields(utils.LevelInfo, "conversation", "abort marker persisted", map[string]any{
		"conversation_id": conversationID,
		"run_id":          data.RunID,
		"abort_source":    data.Source,
		"abort_scope":     data.Scope,
		"signal":          data.Signal,
	})
	return nil
}

func asAbortedData(data any) *AbortedData {
	switch d := data.(type) {
	case AbortedData:
		return &d
	case *AbortedData:
		return d
	case map[string]any:
		runID, _ := d["runId"].(string)   //nolint:errcheck // malformed persisted data is ignored
		source, _ := d["source"].(string) //nolint:errcheck // malformed persisted data is ignored
		scope, _ := d["scope"].(string)   //nolint:errcheck // malformed persisted data is ignored
		signal, _ := d["signal"].(string) //nolint:errcheck // malformed persisted data is ignored
		return &AbortedData{RunID: runID, Source: source, Scope: scope, Signal: signal}
	default:
		return nil
	}
}
