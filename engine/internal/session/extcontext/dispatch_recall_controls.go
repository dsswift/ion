package extcontext

import (
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/utils"
)

// wireRecallControls binds both name recall and exact-ID recall to one
// extension context. Exact-ID recall keeps ancestry authorization; name recall
// acts only on a unique name match and reports ambiguity otherwise.
func wireRecallControls(ctx *extension.Context, registry *DispatchRegistry, depth int, dispatchID string) {
	if registry == nil {
		return
	}

	ctx.RecallAgent = func(name string, opts extension.RecallAgentOpts) (extension.RecallAgentResult, error) {
		reason := opts.Reason
		if reason == "" {
			reason = "recall_agent"
		}
		outcome, matching := registry.Recall(name, reason)
		utils.LogWithFields(utils.LevelInfo, "session.extcontext", "recall agent resolved", map[string]any{"owner_dispatch_id": dispatchID, "owner_depth": depth, "agent_name": name, "outcome": outcome, "count": len(matching), "reason": reason})
		return RecallAgentResult(outcome, matching), nil
	}

	ctx.RecallDispatch = func(targetID string, opts extension.RecallDispatchOpts) (bool, error) {
		reason := opts.Reason
		if reason == "" {
			reason = "recall_dispatch"
		}
		found, err := registry.RecallOwnedByID(dispatchID, targetID, reason)
		utils.LogWithFields(utils.LevelInfo, "session.extcontext", "recall dispatch resolved", map[string]any{"owner_dispatch_id": dispatchID, "owner_depth": depth, "dispatch_id": targetID, "found": found, "authorized": err == nil, "reason": reason})
		return found, err
	}
}
