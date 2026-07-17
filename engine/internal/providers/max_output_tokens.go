package providers

import "github.com/dsswift/ion/engine/internal/types"

// resolveMaxOutputTokens computes the outbound max-output-token cap for a
// provider request from the model registry, WITHOUT imposing a hardcoded engine
// default. It is the single source of truth every provider body-builder calls so
// the sizing decision is made in one testable place.
//
// Resolution order (most specific first):
//  1. Explicit caller/session override (opts.MaxTokens > 0) wins verbatim.
//  2. Else the resolved model's registry MaxOutputTokens, when declared (> 0).
//  3. Else (0, false) — "no engine opinion". The caller decides what that means
//     for its wire shape: OpenAI/Google OMIT the field so the provider applies
//     the model's own maximum; Anthropic/Bedrock — whose APIs require the field —
//     substitute a conservative provider constant.
//
// The boolean return distinguishes "engine has a value to send" (true) from
// "engine has no value; do the provider-appropriate thing" (false). It is never
// (0, true).
func resolveMaxOutputTokens(opts types.LlmStreamOptions) (int, bool) {
	if opts.MaxTokens > 0 {
		return opts.MaxTokens, true
	}
	if info := GetModelInfo(opts.Model); info != nil && info.MaxOutputTokens > 0 {
		return info.MaxOutputTokens, true
	}
	return 0, false
}
