package providers

import (
	"crypto/sha256"
	"fmt"
	"strings"
	"sync"

	tiktoken "github.com/pkoukk/tiktoken-go"
)

// TokenizerTier identifies how a token count was obtained.
type TokenizerTier string

const (
	TierExact       TokenizerTier = "exact"
	TierLocal       TokenizerTier = "local"
	TierApproximate TokenizerTier = "approximate"
)

// ErrCountUnsupported is returned by providers that have no native
// count-tokens endpoint. The caller falls back to local BPE or char/4.
var ErrCountUnsupported = fmt.Errorf("count tokens not supported by this provider")

// encoderCache caches tiktoken encoders by encoding name to avoid
// re-initializing the BPE tables on every call.
var encoderCache sync.Map // map[string]*tiktoken.Tiktoken

// encodingForModel resolves the tiktoken encoding name for a model string.
// Returns ("", false) when no local encoder is applicable.
func encodingForModel(model string) (string, bool) {
	lower := strings.ToLower(model)
	switch {
	// GPT-4o, o-series, and Claude family all use o200k_base
	case strings.HasPrefix(lower, "gpt-4o"),
		strings.HasPrefix(lower, "o1"), strings.HasPrefix(lower, "o3"), strings.HasPrefix(lower, "o4"),
		strings.HasPrefix(lower, "claude-"):
		return "o200k_base", true
	// Legacy GPT-4/3.5 family
	case strings.HasPrefix(lower, "gpt-4"), strings.HasPrefix(lower, "gpt-3.5"),
		strings.HasPrefix(lower, "text-embedding"):
		return "cl100k_base", true
	// Gemini, Llama, etc. — no local BPE that exactly matches, fall back to cl100k_base as best-effort
	case strings.HasPrefix(lower, "gemini-"), strings.HasPrefix(lower, "llama"),
		strings.HasPrefix(lower, "meta-llama"), strings.HasPrefix(lower, "mistral"),
		strings.HasPrefix(lower, "mixtral"), strings.HasPrefix(lower, "deepseek"),
		strings.HasPrefix(lower, "qwen"), strings.HasPrefix(lower, "grok"):
		return "cl100k_base", true
	// Bedrock model IDs contain "anthropic." or "meta." etc.
	case strings.Contains(lower, "anthropic."), strings.Contains(lower, "claude"):
		return "o200k_base", true
	}
	return "", false
}

// getEncoder returns a cached tiktoken encoder for the given encoding name.
func getEncoder(encodingName string) (*tiktoken.Tiktoken, error) {
	if v, ok := encoderCache.Load(encodingName); ok {
		return v.(*tiktoken.Tiktoken), nil
	}
	enc, err := tiktoken.GetEncoding(encodingName)
	if err != nil {
		return nil, fmt.Errorf("load encoding %q: %w", encodingName, err)
	}
	actual, _ := encoderCache.LoadOrStore(encodingName, enc)
	return actual.(*tiktoken.Tiktoken), nil
}

// LocalTokenCount counts tokens using the local BPE encoder for model.
// Returns (count, TierLocal, nil) on success.
// Returns (0, TierApproximate, err) when no encoder resolves.
func LocalTokenCount(model, text string) (int, TokenizerTier, error) {
	encodingName, ok := encodingForModel(model)
	if !ok {
		return 0, TierApproximate, fmt.Errorf("no local encoder for model %q", model)
	}
	enc, err := getEncoder(encodingName)
	if err != nil {
		return 0, TierApproximate, err
	}
	tokens := enc.Encode(text, nil, nil)
	return len(tokens), TierLocal, nil
}

// EstimateTokensChar4 is the char/4 heuristic fallback.
func EstimateTokensChar4(text string) int {
	n := len([]rune(text))
	if n == 0 {
		return 0
	}
	est := n / 4
	if est == 0 {
		est = 1
	}
	return est
}

// ContentHashKey produces a cache key from text + model/endpoint.
func ContentHashKey(text, scopeKey string) string {
	h := sha256.New()
	h.Write([]byte(scopeKey))
	h.Write([]byte{0})
	h.Write([]byte(text))
	return fmt.Sprintf("%x", h.Sum(nil))
}
