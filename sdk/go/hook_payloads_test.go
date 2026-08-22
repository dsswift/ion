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

// TestElicitationInfoJSONWire pins the optional fields shared with the engine
// contract so extensions can receive MCP metadata and distinguish declines.
func TestElicitationInfoJSONWire(t *testing.T) {
	request := ElicitationRequestInfo{
		RequestID: "request-1",
		Mode:      "form",
		Source:    "mcp",
		Server:    "server-1",
		Message:   "confirm action",
		Action:    "decline",
	}
	requestJSON, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("marshal ElicitationRequestInfo: %v", err)
	}
	for _, field := range []string{
		`"source":"mcp"`,
		`"server":"server-1"`,
		`"message":"confirm action"`,
		`"action":"decline"`,
	} {
		if !strings.Contains(string(requestJSON), field) {
			t.Errorf("ElicitationRequestInfo did not serialize %s: %s", field, requestJSON)
		}
	}

	resultJSON, err := json.Marshal(ElicitationResultInfo{
		RequestID: "request-1",
		Declined:  true,
	})
	if err != nil {
		t.Fatalf("marshal ElicitationResultInfo: %v", err)
	}
	if !strings.Contains(string(resultJSON), `"declined":true`) {
		t.Fatalf("ElicitationResultInfo did not serialize declined: %s", resultJSON)
	}
}
