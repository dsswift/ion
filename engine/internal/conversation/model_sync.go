package conversation

import (
	"github.com/dsswift/ion/engine/internal/utils"
)

// SyncModel tracks the model that is actually serving a run on the
// conversation, and records the switch as a durable tree entry when it differs
// from the model the conversation last ran on.
//
// It lives here rather than in a backend because it is pure conversation
// bookkeeping and every path that serves a turn owes it: the API runloop and
// the delegated-CLI turn writer both call it. A backend-local copy would have
// left CLI-served conversations with a first-run header forever.
//
// Two defects share this one seam.
//
// The header was stale. A conversation is created with the first run's model
// and every later run loaded it unchanged, so `conv.Model` reported the first
// model forever. That value is not decorative: it resolves the context window
// (ApiBackend.GetContextUsage) and labels early-stop and max-token telemetry.
// A conversation started on a small-context model and continued on a large one
// was measured against the wrong window.
//
// The switch was unrecorded. EntryModelChange and ModelChangeData have existed
// since the tree format shipped, and the persistence layer decodes them, but
// nothing ever wrote one. So a conversation that ran half its turns on one
// model and half on another was indistinguishable on disk from one that never
// moved, and per-conversation cost could not be attributed to the models that
// actually earned it.
//
// The entry is history/telemetry only. flattenEntries has no case for it, so
// it replays no scrollback row, and buildContextPath extracts messages only,
// so it never enters provider-visible context.
//
// An empty run model carries no information and never overwrites a recorded
// one. An empty recorded model (a legacy file, or one written before the
// header carried the field) is adopted without an entry: there is no previous
// model for the change to be from.
//
// Returns true when the conversation was updated. Both outcomes log — a silent
// divergence between the serving model and the persisted one is the exact
// class of defect this exists to prevent.
func SyncModel(conv *Conversation, model, runID string) bool {
	if conv == nil {
		return false
	}
	if model == "" {
		utils.LogWithFields(utils.LevelDebug, "backend.runloop", "conversation model: run carries no model, keeping persisted value", map[string]any{
			"run_id":          runID,
			"conversation_id": conv.ID,
			"model":           conv.Model,
		})
		return false
	}
	if conv.Model == model {
		utils.LogWithFields(utils.LevelDebug, "backend.runloop", "conversation model unchanged", map[string]any{
			"run_id":          runID,
			"conversation_id": conv.ID,
			"model":           model,
		})
		return false
	}
	if conv.Model == "" {
		conv.Model = model
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "conversation model adopted (none recorded)", map[string]any{
			"run_id":          runID,
			"conversation_id": conv.ID,
			"model":           model,
		})
		return true
	}

	previous := conv.Model
	AppendEntry(conv, EntryModelChange, ModelChangeData{
		Model:         model,
		PreviousModel: previous,
	})
	conv.Model = model
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "conversation model changed", map[string]any{
		"run_id":          runID,
		"conversation_id": conv.ID,
		"from":            previous,
		"to":              model,
	})
	return true
}
