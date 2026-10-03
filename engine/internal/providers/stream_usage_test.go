package providers

import (
	"context"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// streamUsage folds every message_delta usage report in a provider stream the
// way a stream consumer does, and counts how many reports carried usage.
func streamUsage(events []types.LlmStreamEvent) (types.LlmUsage, int) {
	var usage types.LlmUsage
	reports := 0
	for _, ev := range events {
		if ev.Type != "message_delta" || ev.DeltaUsage == nil {
			continue
		}
		reports++
		usage.OutputTokens += ev.DeltaUsage.OutputTokens
		usage.MergeInputDelta(ev.DeltaUsage)
	}
	return usage, reports
}

// TestOpenAIStreamReportsUsageFromTrailingChunk pins the chat-completions
// usage path: the totals arrive on a final chunk with an empty choices array,
// after the finish_reason chunk, and must be reported exactly once with the
// cached part of the prompt split out.
func TestOpenAIStreamReportsUsageFromTrailingChunk(t *testing.T) {
	body := strings.Join([]string{
		`data: {"choices":[{"delta":{"content":"hi"}}]}`,
		`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
		`data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":12,"prompt_tokens_details":{"cached_tokens":600}}}`,
		`data: [DONE]`,
		"",
	}, "\n\n")

	srv := sseServer(t, body)
	defer srv.Close()

	events, err := drainStream(t, newTestOpenAI(srv.URL))
	if err != nil {
		t.Fatalf("stream error: %v", err)
	}

	usage, reports := streamUsage(events)
	if reports != 1 {
		t.Fatalf("usage-bearing message_delta count = %d, want exactly 1", reports)
	}
	want := types.LlmUsage{InputTokens: 400, CacheReadInputTokens: 600, OutputTokens: 12}
	if usage != want {
		t.Errorf("usage = %+v, want %+v", usage, want)
	}

	stopReason := ""
	for _, ev := range events {
		if ev.Type == "message_delta" && ev.Delta != nil && ev.Delta.StopReason != nil {
			stopReason = *ev.Delta.StopReason
		}
	}
	if stopReason != "end_turn" {
		t.Errorf("stop reason = %q, want end_turn", stopReason)
	}
	if last := events[len(events)-1]; last.Type != "message_stop" {
		t.Errorf("last event = %q, want message_stop after the usage report", last.Type)
	}
}

// TestOpenAIBuildRequestBody_RequestsStreamUsage pins that a streamed chat
// completion asks the provider for token usage.
func TestOpenAIBuildRequestBody_RequestsStreamUsage(t *testing.T) {
	body := (&openaiProvider{}).buildRequestBody(types.LlmStreamOptions{Model: "m"})
	opts, ok := body["stream_options"].(map[string]any)
	if !ok || opts["include_usage"] != true {
		t.Errorf("stream_options = %v, want include_usage true", body["stream_options"])
	}
}

// TestGoogleStreamReportsCachedPromptSplit pins Gemini usage: promptTokenCount
// includes the cached content tokens, which are split out.
func TestGoogleStreamReportsCachedPromptSplit(t *testing.T) {
	body := strings.Join([]string{
		`data: {"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":900,"candidatesTokenCount":7,"cachedContentTokenCount":300}}`,
		"",
	}, "\n\n")

	srv := sseServer(t, body)
	defer srv.Close()

	events, err := drainStream(t, newTestGoogle(srv.URL))
	if err != nil {
		t.Fatalf("stream error: %v", err)
	}
	usage, reports := streamUsage(events)
	if reports != 1 {
		t.Fatalf("usage-bearing message_delta count = %d, want exactly 1", reports)
	}
	want := types.LlmUsage{InputTokens: 600, CacheReadInputTokens: 300, OutputTokens: 7}
	if usage != want {
		t.Errorf("usage = %+v, want %+v", usage, want)
	}
}

// TestBedrockStreamReportsUsageFromMetadata pins Bedrock usage: the totals
// arrive on the metadata event after messageStop and carry the cache read and
// cache write counts as separate buckets.
func TestBedrockStreamReportsUsageFromMetadata(t *testing.T) {
	body := strings.Join([]string{
		`data: {"contentBlockStart":{"start":{}}}`,
		`data: {"contentBlockDelta":{"delta":{"text":"hi"}}}`,
		`data: {"contentBlockStop":{}}`,
		`data: {"messageStop":{"stopReason":"end_turn"}}`,
		`data: {"metadata":{"usage":{"inputTokens":50,"outputTokens":8,"cacheReadInputTokens":700,"cacheWriteInputTokens":30}}}`,
		"",
	}, "\n\n")

	events := make(chan types.LlmStreamEvent, 32)
	p := &bedrockProvider{}
	if err := p.parseBedrockStream(context.Background(), strings.NewReader(body), events); err != nil {
		t.Fatalf("parseBedrockStream: %v", err)
	}
	close(events)
	var collected []types.LlmStreamEvent
	for ev := range events {
		collected = append(collected, ev)
	}

	usage, reports := streamUsage(collected)
	if reports != 1 {
		t.Fatalf("usage-bearing message_delta count = %d, want exactly 1", reports)
	}
	want := types.LlmUsage{InputTokens: 50, CacheReadInputTokens: 700, CacheCreationInputTokens: 30, OutputTokens: 8}
	if usage != want {
		t.Errorf("usage = %+v, want %+v", usage, want)
	}
}

// TestSplitCachedPrompt pins the split, including a cached count the provider
// reports larger than the prompt, which is ignored instead of going negative.
func TestSplitCachedPrompt(t *testing.T) {
	if got, want := splitCachedPrompt(100, 100, 3), (types.LlmUsage{CacheReadInputTokens: 100, OutputTokens: 3}); got != want {
		t.Errorf("fully cached: got %+v, want %+v", got, want)
	}
	if got, want := splitCachedPrompt(100, 150, 3), (types.LlmUsage{InputTokens: 100, OutputTokens: 3}); got != want {
		t.Errorf("cached > prompt: got %+v, want %+v", got, want)
	}
}
