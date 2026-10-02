package backend

import (
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// noProviderMessage words the terminal "no provider" error for model and
// names its Policy Failure. A provider-qualified model ("<provider>/<model>")
// whose provider enterprise policy removed is provider_not_authorized, worded
// by the policy's message when one is configured. Any other model keeps the
// default text and carries no Policy Failure.
func noProviderMessage(run *activeRun, model string) (message, policyFailure string) {
	message = fmt.Sprintf("no provider found for model %q", model)
	if run.cfg == nil {
		return message, ""
	}
	providerID, _, qualified := strings.Cut(model, "/")
	if !qualified {
		return message, ""
	}
	for _, pruned := range run.cfg.PolicyPrunedProviders {
		if pruned != providerID {
			continue
		}
		policyFailure = types.PolicyFailureProviderNotAuthorized
		override := run.cfg.PolicyMessages[policyFailure]
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "no provider for model: provider removed by enterprise policy", map[string]any{
			"run_id": run.requestID, "model": model, "provider": providerID, "message_overridden": override != "",
		})
		if override != "" {
			message = override
		}
		return message, policyFailure
	}
	return message, ""
}

// emitBlockedToolResult emits the tool result of a call a tool_call hook
// blocked, carrying the block's Policy Failure when enterprise policy is what
// blocked it.
func (b *ApiBackend) emitBlockedToolResult(run *activeRun, toolID string, result *ToolCallResult) {
	b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
		ToolID:        toolID,
		Content:       "Blocked: " + result.Reason,
		IsError:       true,
		PolicyFailure: result.PolicyFailure,
	}})
}
