package protocol

import "github.com/dsswift/ion/engine/internal/types"

// AgentStateResponse is the requester-only payload returned by get_agent_state.
// Unlike engine_agent_state, this is not a broadcast event or a replacement
// snapshot: it carries full registry fidelity for an explicit recovery query.
type AgentStateResponse struct {
	Agents []types.AgentStateUpdate `json:"agents"`
}
