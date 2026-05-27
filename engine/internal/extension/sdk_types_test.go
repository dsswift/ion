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
