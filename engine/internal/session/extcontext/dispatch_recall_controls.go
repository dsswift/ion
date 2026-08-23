package extcontext

import (
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/utils"
)

// wireRecallControls binds both published name recall and exact-ID recall to
// one extension context. Exact-ID recall keeps ancestry authorization; the
// name API preserves the historical compatibility semantics.
func wireRecallControls(ctx *extension.Context, registry *DispatchRegistry, depth int, dispatchID string) {
	if registry == nil {
		return
	}

	ctx.RecallAgent = func(name string, opts extension.RecallAgentOpts) (bool, error) {
		reason := opts.Reason
		if reason == "" {
			reason = "recall_agent"
		}
		found := registry.Recall(name, reason)
		utils.LogWithFields(utils.LevelInfo, "session.extcontext", "recall agent resolved", map[string]any{"owner_dispatch_id": dispatchID, "owner_depth": depth, "agent_name": name, "found": found, "reason": reason})
		return found, nil
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
