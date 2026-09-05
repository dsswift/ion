package normalizer

import (
	"encoding/json"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// Claude Code reports Anthropic-shaped usage, where cache_read_input_tokens
// and cache_creation_input_tokens are counted SEPARATELY from input_tokens
// rather than as a subset of it. UsageEvent's contract is the opposite: its
// InputTokens is the summed occupancy, which is the single field
// translateToEngineEvent reads to derive both the token count and the context
// percent it publishes. Forwarding the raw record reported an ~841K-token
// context as 2 tokens.
func TestNormalizeMessageStart_SumsCacheTokensIntoOccupancy(t *testing.T) {
	raw := json.RawMessage(`{
		"type":"stream_event",
		"event":{"type":"message_start","message":{"usage":{
			"input_tokens":2,
			"output_tokens":135,
			"cache_read_input_tokens":840543,
			"cache_creation_input_tokens":344
		}}}
	}`)

	events := Normalize(raw)
	var usage *types.UsageEvent
	for i := range events {
		if u, ok := events[i].Data.(*types.UsageEvent); ok {
			usage = u
		}
	}
	if usage == nil {
		t.Fatal("message_start produced no UsageEvent")
	}
	if usage.Usage.InputTokens == nil {
		t.Fatal("UsageEvent carried no InputTokens")
	}
	const want = 2 + 840543 + 344
	if *usage.Usage.InputTokens != want {
		t.Errorf("InputTokens = %d, want %d (input + cache_read + cache_creation)", *usage.Usage.InputTokens, want)
	}
	// The components ride alongside the total, matching the runloop's emission.
	if usage.Usage.CacheReadInputTokens == nil || *usage.Usage.CacheReadInputTokens != 840543 {
		t.Errorf("CacheReadInputTokens not preserved: %v", usage.Usage.CacheReadInputTokens)
	}
	if usage.Usage.CacheCreationInputTokens == nil || *usage.Usage.CacheCreationInputTokens != 344 {
		t.Errorf("CacheCreationInputTokens not preserved: %v", usage.Usage.CacheCreationInputTokens)
	}
}

// A message_start with no input accounting at all must produce no UsageEvent,
// so a run that reports nothing cannot set a bogus zero baseline.
func TestNormalizeMessageStart_NoAccountingEmitsNothing(t *testing.T) {
	raw := json.RawMessage(`{"type":"stream_event","event":{"type":"message_start","message":{"usage":{"output_tokens":5}}}}`)
	for _, ev := range Normalize(raw) {
		if _, ok := ev.Data.(*types.UsageEvent); ok {
			t.Fatal("expected no UsageEvent when the message carries no input accounting")
		}
	}
}
