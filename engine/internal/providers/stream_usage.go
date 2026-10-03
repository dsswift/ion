package providers

import "github.com/dsswift/ion/engine/internal/types"

type openaiUsage struct {
	PromptTokens        int `json:"prompt_tokens"`
	CompletionTokens    int `json:"completion_tokens"`
	PromptTokensDetails *struct {
		CachedTokens int `json:"cached_tokens"`
	} `json:"prompt_tokens_details,omitempty"`
}

// llmUsage splits the chat-completions usage into the engine's raw components.
// prompt_tokens counts the whole prompt, cached part included, so the cached
// part is moved out into CacheReadInputTokens.
func (u *openaiUsage) llmUsage() types.LlmUsage {
	cached := 0
	if u.PromptTokensDetails != nil {
		cached = u.PromptTokensDetails.CachedTokens
	}
	return splitCachedPrompt(u.PromptTokens, cached, u.CompletionTokens)
}

// splitCachedPrompt builds an LlmUsage from a provider report whose prompt
// count includes the cached tokens. LlmUsage keeps the two apart: InputTokens
// is the uncached remainder and CacheReadInputTokens is the cached part, so
// their sum is the prompt the provider counted.
func splitCachedPrompt(promptTokens, cachedTokens, outputTokens int) types.LlmUsage {
	if cachedTokens < 0 || cachedTokens > promptTokens {
		cachedTokens = 0
	}
	return types.LlmUsage{
		InputTokens:          promptTokens - cachedTokens,
		CacheReadInputTokens: cachedTokens,
		OutputTokens:         outputTokens,
	}
}
