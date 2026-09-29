package conversation

import (
	"github.com/dsswift/ion/engine/internal/utils"
)

// SyncWorkingDirectory records the directory a run is working in on the
// conversation, so the persisted `workingDirectory` always reflects where the
// conversation is actually running.
//
// It lives here rather than in a backend because it is pure conversation
// bookkeeping and every path that writes a turn owes it, exactly like
// SyncModel. A backend-local copy only ever ran inside the API runloop, so
// conversations served by a delegated CLI, image runs, and native dispatch
// mirrors were written with an empty working directory forever. Consumers
// that group conversations by directory (worktree membership, retros) then
// could not see them.
//
// This TRACKS the current run's path rather than only filling an empty value.
// A conversation's working directory is not immutable: a consumer may relocate
// a live conversation to a different directory — for example, moving it out of
// a git worktree that is being removed while the conversation continues. A
// "write only when empty" rule would pin the first-ever path on disk forever,
// so reopening the conversation later would resolve to a directory that no
// longer exists.
//
// An empty path is never written: a run that supplies no path carries no
// information about where the conversation lives, so the previously recorded
// directory is preserved rather than erased.
//
// Returns true when the conversation was updated. Both outcomes log — a silent
// divergence between the run's actual cwd and the persisted one is exactly the
// class of defect this exists to prevent.
func SyncWorkingDirectory(conv *Conversation, workingDirectory, runID string) bool {
	if conv == nil {
		return false
	}
	if workingDirectory == "" {
		utils.LogWithFields(utils.LevelDebug, "conversation.working_directory", "conversation working directory: run carries no path, keeping persisted value", map[string]any{
			"run_id":          runID,
			"conversation_id": conv.ID,
			"working_dir":     conv.WorkingDirectory,
		})
		return false
	}
	if conv.WorkingDirectory == workingDirectory {
		utils.LogWithFields(utils.LevelDebug, "conversation.working_directory", "conversation working directory unchanged", map[string]any{
			"run_id":          runID,
			"conversation_id": conv.ID,
			"working_dir":     conv.WorkingDirectory,
		})
		return false
	}
	utils.LogWithFields(utils.LevelInfo, "conversation.working_directory", "conversation working directory updated", map[string]any{
		"run_id":          runID,
		"conversation_id": conv.ID,
		"from":            conv.WorkingDirectory,
		"to":              workingDirectory,
	})
	conv.WorkingDirectory = workingDirectory
	return true
}
