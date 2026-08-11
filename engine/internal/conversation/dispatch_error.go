package conversation

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/utils"
)

// DispatchErrorData records a dispatch failure that the engine learns only
// AFTER the child backend has already exited and saved its conversation.
//
// The canonical case is an engine-initiated cancel that is not a recall. API
// backends report that exit as code 0 + signal "cancelled"; dispatch_agent maps
// it to a real failure (exitCode 1) after OnExit so the parent/harness does not
// hear a false success. Because the child run has already completed its final
// save by then, no ErrorEvent or message in the child conversation records why
// the dispatch row is red. Persisting this typed entry closes that state/history
// split without putting the error into provider-visible LLM context.
//
// DispatchID is retained for provenance and de-duplication. Message is the exact
// terminal error the dispatcher received (e.g. "run cancelled by engine...").
type DispatchErrorData struct {
	DispatchID string `json:"dispatchId"`
	Message    string `json:"message"`
}

// AppendDispatchError persists a durable error row in a child conversation.
//
// The entry advances the display tree's leaf so historical reload sees it after
// the child's final assistant output. It is its own entry type, not a generic
// system MessageData: generic system message entries are not replayed by
// flattenEntries, and making every such message visible would be an unrelated
// contract expansion. Dispatch errors are display/history data only;
// buildContextPath ignores this entry type, so a future resume never feeds the
// engine-authored error back to the model.
//
// Idempotent by DispatchID. Terminal callbacks can race with shutdown/replay;
// writing the same failure twice would make one dispatch look like two failures.
func AppendDispatchError(conversationID, dispatchID, message string) error {
	if conversationID == "" {
		return fmt.Errorf("append dispatch error: empty conversation id")
	}
	if dispatchID == "" {
		return fmt.Errorf("append dispatch error: empty dispatch id")
	}
	if message == "" {
		return fmt.Errorf("append dispatch error: empty message")
	}

	conv, err := Load(conversationID, "")
	if err != nil {
		return fmt.Errorf("append dispatch error: load %s: %w", conversationID, err)
	}
	for _, entry := range conv.Entries {
		if entry.Type != EntryDispatchError {
			continue
		}
		data := asDispatchErrorData(entry.Data)
		if data != nil && data.DispatchID == dispatchID {
			utils.LogWithFields(utils.LevelDebug, "conversation", "append dispatch error: already persisted", map[string]any{
				"conversation_id": conversationID,
				"dispatch_id":     dispatchID,
			})
			return nil
		}
	}

	AppendEntry(conv, EntryDispatchError, DispatchErrorData{
		DispatchID: dispatchID,
		Message:    message,
	})
	if err := Save(conv, ""); err != nil {
		return fmt.Errorf("append dispatch error: save %s: %w", conversationID, err)
	}
	utils.LogWithFields(utils.LevelInfo, "conversation", "dispatch error persisted", map[string]any{
		"conversation_id": conversationID,
		"dispatch_id":     dispatchID,
	})
	return nil
}

func asDispatchErrorData(data any) *DispatchErrorData {
	switch d := data.(type) {
	case DispatchErrorData:
		return &d
	case *DispatchErrorData:
		return d
	case map[string]any:
		dispatchID, _ := d["dispatchId"].(string) //nolint:errcheck // malformed persisted data is ignored
		message, _ := d["message"].(string)       //nolint:errcheck // malformed persisted data is ignored
		return &DispatchErrorData{DispatchID: dispatchID, Message: message}
	default:
		return nil
	}
}
