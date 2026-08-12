package ion

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestAgentInfoRemainingDepthBudgetJSONWire pins the optional depth budget
// field consumed by before_agent_start handlers.
func TestAgentInfoRemainingDepthBudgetJSONWire(t *testing.T) {
	payload, err := json.Marshal(AgentInfo{RemainingDepthBudget: 2})
	if err != nil {
		t.Fatalf("marshal AgentInfo: %v", err)
	}
	if !strings.Contains(string(payload), `"remainingDepthBudget":2`) {
		t.Fatalf("AgentInfo did not serialize remainingDepthBudget: %s", payload)
	}
}
