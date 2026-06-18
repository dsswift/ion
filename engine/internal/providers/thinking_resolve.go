package providers

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ThinkingResolution is the provider-neutral result of resolving a
// ThinkingConfig against a model's declared capability. Each provider's
// body-builder reads the fields relevant to its wire shape:
//
//   - Anthropic adaptive  → Mode=="adaptive", Effort
//   - Anthropic budget    → Mode=="budget",   Budget
//   - OpenAI reasoning    → Mode=="reasoning_effort", Effort
//   - Gemini              → Mode=="gemini",   Budget
//
// When Mode=="none" the caller emits NO thinking directive (the model does
// not support reasoning, the config is disabled, or the requested effort is
// not in the model's allowed set). This is the fail-loud path: the resolver
// logs the reason rather than letting an unsupported directive reach the
// provider and trip a 400.
type ThinkingResolution struct {
	Mode   string // "adaptive" | "budget" | "reasoning_effort" | "gemini" | "none"
	Effort string // "low" | "medium" | "high" (empty when Mode is budget/gemini/none)
	Budget int    // token budget (set when Mode is budget/gemini; 0 otherwise)
}

// effortBudgetTokens maps an effort level to a thinking-token budget for the
// mechanisms that take a raw budget (Anthropic legacy `budget`, Gemini
// `thinkingConfig`). The triple low/medium/high → 4k/10k/24k is the
// reviewer-confirmed mapping from the plan. An unknown level falls back to the
// medium budget so a malformed effort never disables thinking silently when
// the caller explicitly asked for it.
func effortBudgetTokens(effort string) int {
	switch effort {
	case "low":
		return 4000
	case "high":
		return 24000
	case "medium":
		return 10000
	default:
		return 10000
	}
}

// modelSupportsEffort reports whether the model's declared ThinkingEfforts set
// contains the requested level. An empty allowed-set means "no effort gradient
// declared" → not supported.
func modelSupportsEffort(info *types.ModelInfo, effort string) bool {
	if info == nil {
		return false
	}
	for _, e := range info.ThinkingEfforts {
		if e == effort {
			return true
		}
	}
	return false
}

// resolveThinking turns a (model, ThinkingConfig) pair into a provider-neutral
// ThinkingResolution. It is the single source of truth for the capability
// logic; all three provider body-builders call it so the per-model decision is
// made in one testable place.
//
// Resolution order:
//  1. cfg nil or !Enabled              → none (no directive).
//  2. model unknown / ThinkingMode none → none (logged; fail-loud).
//  3. Effort set but not in the model's allowed set → none (logged).
//  4. Otherwise dispatch on the model's ThinkingMode, carrying either the
//     effort (adaptive / reasoning_effort) or a budget mapped from the effort
//     (budget / gemini). When Effort is empty but a legacy BudgetTokens was
//     supplied, the budget path honors it directly (back-compat).
func resolveThinking(model string, cfg *types.ThinkingConfig) ThinkingResolution {
	if cfg == nil || !cfg.Enabled {
		return ThinkingResolution{Mode: "none"}
	}

	info := GetModelInfo(model)
	mode := ""
	if info != nil {
		mode = info.ThinkingMode
	}
	// No declared thinking mechanism → no directive, deliberately. This covers
	// three shapes that all mean "the engine has no basis to ask for reasoning":
	// the model is unknown (info==nil), or it is registered with an empty
	// ThinkingMode (the shape every runtime-discovered model gets —
	// model_discovery.go registers ModelInfo{ProviderID: providerID} with no
	// ThinkingMode), or it is explicitly tagged "none". The engine NEVER forces
	// a default reasoning_effort on an undeclared model (the prior behavior,
	// which hardcoded reasoning_effort:"high" for any thinking-enabled model and
	// risked provider 400s). An operator opts a model in by declaring
	// thinkingMode + thinkingEfforts in ~/.ion model config (merged via
	// modelconfig.UserModels). Pinned by thinking_resolve_test.go
	// ("openai discovered model without thinkingMode → no directive") and
	// thinking_body_test.go (test-nothink → no reasoning_effort).
	if info == nil || mode == "" || mode == "none" {
		utils.Log("Thinking", fmt.Sprintf(
			"resolveThinking: model=%s does not support thinking (mode=%q) — emitting no directive",
			model, mode))
		return ThinkingResolution{Mode: "none"}
	}

	// Effort-based path: validate against the model's allowed efforts.
	effort := cfg.Effort
	if effort != "" && !modelSupportsEffort(info, effort) {
		utils.Log("Thinking", fmt.Sprintf(
			"resolveThinking: model=%s rejects effort=%q (allowed=%v) — emitting no directive",
			model, effort, info.ThinkingEfforts))
		return ThinkingResolution{Mode: "none"}
	}

	switch mode {
	case "adaptive":
		utils.Log("Thinking", fmt.Sprintf("resolveThinking: model=%s mode=adaptive effort=%q", model, effort))
		return ThinkingResolution{Mode: "adaptive", Effort: effort}
	case "reasoning_effort":
		utils.Log("Thinking", fmt.Sprintf("resolveThinking: model=%s mode=reasoning_effort effort=%q", model, effort))
		return ThinkingResolution{Mode: "reasoning_effort", Effort: effort}
	case "budget":
		budget := cfg.BudgetTokens
		if budget <= 0 {
			budget = effortBudgetTokens(effort)
		}
		utils.Log("Thinking", fmt.Sprintf("resolveThinking: model=%s mode=budget budget=%d (effort=%q)", model, budget, effort))
		return ThinkingResolution{Mode: "budget", Budget: budget}
	case "gemini":
		budget := cfg.BudgetTokens
		if budget <= 0 {
			budget = effortBudgetTokens(effort)
		}
		utils.Log("Thinking", fmt.Sprintf("resolveThinking: model=%s mode=gemini budget=%d (effort=%q)", model, budget, effort))
		return ThinkingResolution{Mode: "gemini", Budget: budget}
	default:
		utils.Log("Thinking", fmt.Sprintf("resolveThinking: model=%s unknown mode=%q — emitting no directive", model, mode))
		return ThinkingResolution{Mode: "none"}
	}
}
