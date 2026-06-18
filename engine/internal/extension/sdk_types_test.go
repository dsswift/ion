package extension

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDispatchAgentResult_CacheTokenFields_JSON(t *testing.T) {
	// Round-trip: populated cache fields appear in JSON and survive unmarshal.
	orig := DispatchAgentResult{
		Output:                   "done",
		ExitCode:                 0,
		Elapsed:                  1.5,
		Cost:                     0.003,
		InputTokens:              100,
		OutputTokens:             50,
		CacheReadInputTokens:     80,
		CacheCreationInputTokens: 20,
		SessionID:                "sess-1",
	}

	data, err := json.Marshal(orig)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	raw := string(data)
	if !strings.Contains(raw, `"cacheReadInputTokens"`) {
		t.Errorf("JSON missing cacheReadInputTokens key: %s", raw)
	}
	if !strings.Contains(raw, `"cacheCreationInputTokens"`) {
		t.Errorf("JSON missing cacheCreationInputTokens key: %s", raw)
	}

	var decoded DispatchAgentResult
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if decoded.CacheReadInputTokens != 80 {
		t.Errorf("CacheReadInputTokens = %d, want 80", decoded.CacheReadInputTokens)
	}
	if decoded.CacheCreationInputTokens != 20 {
		t.Errorf("CacheCreationInputTokens = %d, want 20", decoded.CacheCreationInputTokens)
	}

	// Omitempty: zero-value cache fields must be absent from JSON output.
	zero := DispatchAgentResult{
		Output:       "done",
		InputTokens:  100,
		OutputTokens: 50,
	}

	zeroData, err := json.Marshal(zero)
	if err != nil {
		t.Fatalf("marshal zero: %v", err)
	}

	zeroRaw := string(zeroData)
	if strings.Contains(zeroRaw, "cacheReadInputTokens") {
		t.Errorf("zero-value JSON should omit cacheReadInputTokens: %s", zeroRaw)
	}
	if strings.Contains(zeroRaw, "cacheCreationInputTokens") {
		t.Errorf("zero-value JSON should omit cacheCreationInputTokens: %s", zeroRaw)
	}
}

// TestDispatchAgentResult_ThinkingTokens_JSON pins the issue #158 telemetry
// field: ThinkingTokens serializes when non-zero and is omitted when zero.
func TestDispatchAgentResult_ThinkingTokens_JSON(t *testing.T) {
	orig := DispatchAgentResult{
		Output:         "done",
		InputTokens:    100,
		OutputTokens:   50,
		ThinkingTokens: 30,
	}
	data, err := json.Marshal(orig)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(data), `"thinkingTokens":30`) {
		t.Errorf("JSON missing thinkingTokens=30: %s", string(data))
	}

	var decoded DispatchAgentResult
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if decoded.ThinkingTokens != 30 {
		t.Errorf("ThinkingTokens = %d, want 30", decoded.ThinkingTokens)
	}

	// Omitempty: zero thinking tokens must be absent.
	zero := DispatchAgentResult{Output: "done"}
	zeroData, err := json.Marshal(zero)
	if err != nil {
		t.Fatalf("marshal zero: %v", err)
	}
	if strings.Contains(string(zeroData), "thinkingTokens") {
		t.Errorf("zero-value JSON should omit thinkingTokens: %s", string(zeroData))
	}
}
