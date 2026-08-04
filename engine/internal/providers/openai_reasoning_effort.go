package providers

import (
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// openai_reasoning_effort.go — the reasoning_effort decision for the
// chat-completions client.
//
// Extracted from openai.go's buildRequestBody to keep that file under the
// 800-line Go cap. The seam is a real one: this is a POLICY question ("may
// this request carry reasoning_effort?") separable from request assembly, and
// it is the piece with the subtle scoping rule worth reading on its own.

// resolveReasoningEffortForChat decides whether a chat-completions request may
// carry `reasoning_effort`, returning the level to send and whether to send it.
//
// Only models declared with ThinkingMode=="reasoning_effort" produce a
// directive at all; everything else (and a disabled or unsupported config)
// resolves to none via the shared capability resolver.
//
// The guard covers a self-contradictory gateway declaration. A model advertised
// with BOTH dialect:"openai-chat" AND thinkingMode:"reasoning_effort" is
// unserviceable when function tools are present — OpenAI's hosted endpoint
// rejects the combination outright:
//
//	"Function tools with reasoning_effort are not supported for <model> in
//	 /v1/chat/completions. Please use /v1/responses instead."
//
// Ion sends tools on essentially every turn, so such a model fails ~100% of
// real turns. The correct fix belongs to the gateway: declare
// dialect:"openai-responses" and the request routes to the Responses client,
// which serves reasoning and tools together (verified against a live gateway,
// streaming included). Until it does, sending the field guarantees a hard 400
// and the whole turn fails; dropping it costs reasoning depth but the turn
// succeeds. Dropping is the better failure mode — but it is a real degradation,
// so it logs at WARN naming the misdeclaration rather than quietly handing the
// user a less capable model.
//
// The scoping is deliberate and load-bearing: the guard keys on an explicit
// "openai-chat" dialect, i.e. only models a dialect-dispatching gateway
// described. Stock OpenAI-compatible providers (xAI/grok, DeepSeek, Groq,
// Ollama, ...) reach this SAME client with no dialect declared; they implement
// the protocol without OpenAI's restriction, and suppressing their reasoning on
// a transport technicality would be an unforced regression. A guard keyed on
// the transport, or on a per-model allowlist, gets that wrong — see
// openai_dialect_reasoning_test.go, which pins it.
func resolveReasoningEffortForChat(providerID string, opts types.LlmStreamOptions) (string, bool) {
	res := resolveThinking(opts.Model, opts.Thinking)
	if res.Mode != "reasoning_effort" || res.Effort == "" {
		return "", false
	}

	info := GetModelInfo(opts.Model)
	if info != nil && info.Dialect == "openai-chat" && len(opts.Tools) > 0 {
		utils.LogWithFields(utils.LevelWarn, "Providers",
			"suppressing reasoning_effort: model declares dialect openai-chat with reasoning_effort, which the chat-completions endpoint refuses alongside function tools; the gateway should declare dialect openai-responses for this model",
			map[string]any{
				"model":    opts.Model,
				"provider": providerID,
				"reason":   res.Effort,
				"count":    len(opts.Tools),
			})
		return "", false
	}

	return res.Effort, true
}
