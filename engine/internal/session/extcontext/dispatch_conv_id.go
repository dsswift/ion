package extcontext

// dispatch_conv_id.go — helper for surfacing a dispatched child's conversation
// ID onto the parent's agent-state row the moment the child run initialises.
//
// Extracted from dispatch_agent.go so that file stays under the 800-line cap.
// The logic runs once per dispatch, on the first SessionInitEvent that carries
// a non-empty child session ID.

import (
	"time"

	"github.com/dsswift/ion/engine/internal/session/agents"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// recordChildConvID writes the child conversation ID into the parent's
// agent-state metadata (both the conversationIds list and the singular
// conversationId), updates the structured dispatches[] entry while the dispatch
// is still running, and emits an agent snapshot. Called once when the child's
// first SessionInitEvent arrives.
func recordChildConvID(sa SessionAccessor, agentID, childSessionID, agentName string, start time.Time) {
	elapsedSoFar := time.Since(start).Seconds()
	sa.UpdateAgentStateByID(agentID, func(state *types.AgentStateUpdate) {
		if state.Metadata == nil {
			state.Metadata = map[string]interface{}{}
		}
		existing, _ := state.Metadata["conversationIds"].([]interface{}) //nolint:errcheck // best-effort; failure not actionable here
		alreadyPresent := false
		for _, v := range existing {
			if s, ok := v.(string); ok && s == childSessionID {
				alreadyPresent = true
				break
			}
		}
		if !alreadyPresent {
			state.Metadata["conversationIds"] = append(existing, childSessionID)
		}
		state.Metadata["conversationId"] = childSessionID
		// Write the id into the structured dispatches[] entry while the dispatch
		// is still running so consumers can load the live conversation by ID.
		agents.UpdateDispatchEntry(state.Metadata, agentID, "running", elapsedSoFar, childSessionID)
	})
	sa.EmitAgentSnapshot("dispatch_conversation_id")
	utils.LogWithFields(utils.LevelInfo, "server", "captured child conversation id early", map[string]any{"agent_name": agentName, "child_session_i_d": childSessionID, "session_key": sa.SessionKey()})
}
