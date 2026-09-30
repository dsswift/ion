package extcontext

import (
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/utils"
)

// wireRecallControls binds both name recall and exact-ID recall to one
// extension context. Both are scoped to what the context's dispatch owns
// (everything, at the root); name recall acts only on a unique name match in
// that scope and reports ambiguity otherwise.
func wireRecallControls(ctx *extension.Context, registry *DispatchRegistry, depth int, dispatchID string) {
	if registry == nil {
		return
	}

	ctx.RecallAgent = func(name string, opts extension.RecallAgentOpts) (extension.RecallAgentResult, error) {
		reason := opts.Reason
		if reason == "" {
			reason = "recall_agent"
		}
		result := registry.RecallOwnedByName(dispatchID, name, reason)
		utils.LogWithFields(utils.LevelInfo, "session.extcontext", "recall agent resolved", map[string]any{"owner_dispatch_id": dispatchID, "owner_depth": depth, "agent_name": name, "outcome": result.Outcome, "count": len(result.MatchingIDs), "reason": reason})
		return RecallAgentResult(result), nil
	}

	ctx.RecallDispatch = func(targetID string, opts extension.RecallDispatchOpts) (extension.RecallDispatchResult, error) {
		reason := opts.Reason
		if reason == "" {
			reason = "recall_dispatch"
		}
		result := registry.RecallOwnedByID(dispatchID, targetID, reason)
		utils.LogWithFields(utils.LevelInfo, "session.extcontext", "recall dispatch resolved", map[string]any{"owner_dispatch_id": dispatchID, "owner_depth": depth, "dispatch_id": targetID, "outcome": result.Outcome, "reason": reason})
		return RecallDispatchResult(result), nil
	}
}
