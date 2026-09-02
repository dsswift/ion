package session

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/utils"
)

// slash_clears_conversation.go runs the pre-execution clear for a command that
// declares the `clears-conversation` frontmatter key.
//
// Some commands are defined by the absence of context. A review must judge the
// work against a durable spec, not against the conversation that produced the
// work — prior discussion biases the verdict toward the reasoning that was
// already accepted. A squash must operate on the repository state, not on a
// transcript that happens to describe it. For those commands an inherited
// conversation is not a convenience, it is a correctness problem.
//
// Declaring the intent in frontmatter makes the boundary structural instead of
// procedural. The operator cannot forget to clear first, because the command
// carries the requirement.
//
// Ordering matters and is the whole reason this runs where it does: the clear
// lands BEFORE the model-tier boundary gate is evaluated. After the wipe the
// conversation holds no model-visible history, so the command's own `model:`
// tier is evaluated at a genuinely fresh boundary and is applied. That is what
// lets a command both demand a clean slate and pin the tier it runs on — the
// two frontmatter keys compose into one hard workflow boundary.
//
// The engine performs the clear unconditionally when the key is set. It does
// not ask first: the engine never blocks for user input. A consumer that wants
// to confirm with the operator reads ClearsConversation from the discovery feed
// (types.SlashCommandListing) and confirms before it ever sends the prompt.

// applySlashClearsConversation wipes the session's conversation when the
// resolved command declares `clears-conversation`, so the command body runs
// against an empty context. A durable-clear failure aborts the command; running
// it with inherited history would violate the command's declared precondition.
//
// Called with m.mu held. The durable write happens before live denial/occupancy
// state is reset, so a failed save leaves both durable and in-memory state true.
func (m *Manager) applySlashClearsConversation(s *engineSession, key string, res *ResolvedSlash) (bool, error) {
	return m.applySlashClearsConversationWith(s, key, res, clearConversationFile)
}

func (m *Manager) applySlashClearsConversationWith(
	s *engineSession,
	key string,
	res *ResolvedSlash,
	clearFile func(string) (clearResult, error),
) (bool, error) {
	if res == nil || !res.ClearsConversation {
		return false, nil
	}

	if s.conversationID == "" {
		_, deniedCleared := m.clearSessionDenialsLocked(key)
		utils.LogWithFields(utils.LevelDebug, "session.slash", "clears-conversation command has no bound conversation nothing to wipe", map[string]any{
			"session_id": key, "command": res.Command, "denied_cleared": deniedCleared,
		})
		return false, nil
	}

	fileResult, err := clearFile(s.conversationID)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "session.slash", "clears-conversation wipe failed aborting command", map[string]any{
			"session_id": key, "command": res.Command, "conversation_id": s.conversationID, "error": err,
		})
		return false, fmt.Errorf("command %s requires a fresh conversation: %w", res.Command, err)
	}
	_, deniedCleared := m.clearSessionDenialsLocked(key)

	utils.LogWithFields(utils.LevelInfo, "session.slash", "clears-conversation cleared context before command body", map[string]any{
		"session_id": key, "command": res.Command, "conversation_id": s.conversationID,
		"wiped": fileResult.wiped, "denied_cleared": deniedCleared,
	})
	return fileResult.wiped, nil
}
