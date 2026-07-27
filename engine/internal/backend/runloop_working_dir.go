package backend

import (
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/utils"
)

// syncConversationWorkingDirectory records the run's project path on the
// conversation so the persisted `workingDirectory` always reflects where the
// conversation is actually running.
//
// This TRACKS the current run's path rather than only filling an empty value.
// A conversation's working directory is not immutable: a consumer may relocate
// a live conversation to a different directory — for example, moving it out of
// a git worktree that is being removed while the conversation continues. The
// prior "write only when empty" rule pinned the first-ever path on disk
// forever, so reopening the conversation later resolved to a directory that no
// longer existed.
//
// An empty ProjectPath is never written: a run that supplies no project path
// carries no information about where the conversation lives, so the previously
// recorded directory is preserved rather than erased.
//
// Returns true when the conversation was updated. Both outcomes log — a silent
// divergence between the run's actual cwd and the persisted one is exactly the
// class of defect this exists to prevent.
func syncConversationWorkingDirectory(conv *conversation.Conversation, projectPath, runID string) bool {
	if conv == nil {
		return false
	}
	if projectPath == "" {
		utils.LogWithFields(utils.LevelDebug, "backend.runloop", "conversation working directory: no project path on run, keeping persisted value", map[string]any{
			"run_id":          runID,
			"conversation_id": conv.ID,
			"working_dir":     conv.WorkingDirectory,
		})
		return false
	}
	if conv.WorkingDirectory == projectPath {
		utils.LogWithFields(utils.LevelDebug, "backend.runloop", "conversation working directory unchanged", map[string]any{
			"run_id":          runID,
			"conversation_id": conv.ID,
			"working_dir":     conv.WorkingDirectory,
		})
		return false
	}
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "conversation working directory updated", map[string]any{
		"run_id":          runID,
		"conversation_id": conv.ID,
		"from":            conv.WorkingDirectory,
		"to":              projectPath,
	})
	conv.WorkingDirectory = projectPath
	return true
}
