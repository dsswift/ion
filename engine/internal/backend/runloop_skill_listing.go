package backend

import (
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// injectSkillListingDelta writes an initial listing once per conversation, then
// only names newly added to the session registry. The typed marker survives
// restart and is the precise resume dedup source.
func injectSkillListingDelta(conv *conversation.Conversation, opts types.RunOptions, hooks RunHooks) {
	if opts.DisableSkillSystemPrompt {
		utils.LogWithFields(utils.LevelDebug, "backend.skills", "skill listing suppressed by configuration", map[string]any{"conversation_id": conv.ID})
		return
	}
	announced := conversation.AnnouncedSkillNames(conv)
	names, text := tools.BuildSkillListingDelta(opts.SessionKey, announced)
	if len(names) == 0 || text == "" {
		utils.LogWithFields(utils.LevelDebug, "backend.skills", "skill listing has no delta", map[string]any{"conversation_id": conv.ID, "announced": len(announced)})
		return
	}
	if hooks.OnSystemInject != nil {
		rewritten, suppress := hooks.OnSystemInject("skill_listing", text, 0, 0)
		if suppress {
			utils.LogWithFields(utils.LevelInfo, "backend.skills", "skill listing suppressed by hook", map[string]any{"conversation_id": conv.ID, "count": len(names)})
			return
		}
		if rewritten != "" {
			text = rewritten
		}
	}
	if !conversation.AppendSkillListingToLastUser(conv, names, text) {
		utils.LogWithFields(utils.LevelWarn, "backend.skills", "skill listing skipped without inbound user carrier", map[string]any{"conversation_id": conv.ID, "count": len(names)})
		return
	}
	utils.LogWithFields(utils.LevelInfo, "backend.skills", "skill listing injected", map[string]any{"conversation_id": conv.ID, "count": len(names), "initial": len(announced) == 0})
}
