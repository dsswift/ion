package config

import "github.com/dsswift/ion/engine/internal/types"

// mergeInto applies fields from src onto dst (dst is mutated).
func mergeInto(dst, src *types.EngineRuntimeConfig) {
	if src.Backend != "" {
		dst.Backend = src.Backend
	}
	if src.DefaultModel != "" {
		dst.DefaultModel = src.DefaultModel
	}

	// Providers: merge maps
	if len(src.Providers) > 0 {
		if dst.Providers == nil {
			dst.Providers = make(map[string]types.ProviderConfig)
		}
		for k, v := range src.Providers {
			dst.Providers[k] = v
		}
	}

	// Limits: override if explicitly set (nil means "not set")
	if src.Limits.MaxTurns != nil {
		dst.Limits.MaxTurns = src.Limits.MaxTurns
	}
	if src.Limits.MaxBudgetUsd != nil {
		dst.Limits.MaxBudgetUsd = src.Limits.MaxBudgetUsd
	}
	if src.Limits.SuppressSystemMessages != nil {
		dst.Limits.SuppressSystemMessages = src.Limits.SuppressSystemMessages
	}
	if src.Limits.DisablePlanModeReminder != nil {
		dst.Limits.DisablePlanModeReminder = src.Limits.DisablePlanModeReminder
	}
	if src.Limits.DisableTurnLimitWarning != nil {
		dst.Limits.DisableTurnLimitWarning = src.Limits.DisableTurnLimitWarning
	}
	if src.Limits.DisableMaxTokenContinue != nil {
		dst.Limits.DisableMaxTokenContinue = src.Limits.DisableMaxTokenContinue
	}
	// PlanModeAllowedBashCommands is a slice, not a pointer, and carries a
	// tri-valued contract across layers:
	//
	//   nil        — this layer did not set the field; the earlier layer stands.
	//   non-empty  — ADDITIVE. Unioned with the earlier layer's list, so a
	//                project .ion/engine.json can permit a command the user's
	//                global config never mentioned (and vice versa) without
	//                either layer having to restate the other's entries.
	//   empty ([]) — an intentional "block Bash entirely in plan mode" signal.
	//                It wins over any earlier non-empty list, matching normal
	//                layer precedence: the later, more specific layer decides.
	//
	// Additive-union (rather than whole-slice replacement) is what makes the
	// project layer portable: a repo that needs one extra command ships it in
	// .ion/engine.json and every clone gains it on top of whatever each
	// developer already allows globally. Replacement would force the project
	// file to restate every developer's personal list, which it cannot know.
	//
	// This union is deliberately NOT a security boundary. When an enterprise
	// policy exists, EnforceEnterprise intersects the merged result against
	// the enterprise ceiling AFTER this merge runs, so no combination of user
	// and project entries can widen past what the enterprise permits. Absent
	// an enterprise policy there is no policy to circumvent — an unmanaged
	// machine configuring its own tool is the point of the project layer.
	if src.Limits.PlanModeAllowedBashCommands != nil {
		if len(src.Limits.PlanModeAllowedBashCommands) == 0 {
			// Explicit block-all from the higher-precedence layer.
			dst.Limits.PlanModeAllowedBashCommands = []string{}
		} else {
			dst.Limits.PlanModeAllowedBashCommands = unionBashCommands(
				dst.Limits.PlanModeAllowedBashCommands,
				src.Limits.PlanModeAllowedBashCommands,
			)
		}
	}
	if src.Limits.PlanModeAllowedMcpTools != nil {
		if len(src.Limits.PlanModeAllowedMcpTools) == 0 {
			dst.Limits.PlanModeAllowedMcpTools = []string{}
		} else {
			dst.Limits.PlanModeAllowedMcpTools = unionBashCommands(dst.Limits.PlanModeAllowedMcpTools, src.Limits.PlanModeAllowedMcpTools)
		}
	}
	// MaxTokenThinkingOnlyBreaker is a non-pointer int: zero means "not set /
	// use the built-in default", so only a non-zero value from a later layer
	// overrides. -1 (disable the breaker) is a legitimate non-zero override.
	if src.Limits.MaxTokenThinkingOnlyBreaker != 0 {
		dst.Limits.MaxTokenThinkingOnlyBreaker = src.Limits.MaxTokenThinkingOnlyBreaker
	}
	if src.Limits.PlanModeAutoExitOnEndTurn != nil {
		dst.Limits.PlanModeAutoExitOnEndTurn = src.Limits.PlanModeAutoExitOnEndTurn
	}
	if src.Limits.DisableSkillSystemPrompt != nil {
		dst.Limits.DisableSkillSystemPrompt = src.Limits.DisableSkillSystemPrompt
	}

	// MCP servers: merge maps
	if len(src.McpServers) > 0 {
		if dst.McpServers == nil {
			dst.McpServers = make(map[string]types.McpServerConfig)
		}
		for k, v := range src.McpServers {
			dst.McpServers[k] = v
		}
	}

	// Plugins: whole-block override (pointer). A later layer that sets the block
	// replaces an earlier one; nil leaves the earlier value intact. Same convention
	// as Permissions / Network / Telemetry.
	if src.Plugins != nil {
		dst.Plugins = src.Plugins
	}

	// ResourceLimits: whole-block override (pointer), same convention as
	// Plugins above. Enterprise ceiling enforcement happens later in
	// EnforceEnterprise; this merge only carries the user/project layers.
	if src.ResourceLimits != nil {
		dst.ResourceLimits = src.ResourceLimits
	}

	// Profiles: replace if provided
	if len(src.Profiles) > 0 {
		dst.Profiles = src.Profiles
	}

	// Optional fields: override if set
	if src.Permissions != nil {
		dst.Permissions = src.Permissions
	}
	if src.Auth != nil {
		dst.Auth = src.Auth
	}
	if src.Network != nil {
		dst.Network = src.Network
	}
	if src.Telemetry != nil {
		dst.Telemetry = src.Telemetry
	}
	if src.Compaction != nil {
		dst.Compaction = src.Compaction
	}

	// Shell: override the whole pointer if set. The engine.json shell block
	// (useLoginShell / shellPath) is small and atomic, so whole-pointer
	// replacement matches the Permissions/Network/Telemetry convention above
	// and avoids a field-by-field merge that would add no value.
	if src.Shell != nil {
		dst.Shell = src.Shell
	}

	// Optional pointer blocks that are consumed from the merged config by
	// downstream layers (cmd_serve, the session layer, prompt options) but
	// were historically not carried through this merge. Each is overridden
	// as a whole pointer when the source layer sets it, matching the
	// Permissions/Network/Telemetry convention. Without these, a user who
	// sets the block in ~/.ion/engine.json or a project .ion/engine.json
	// has it silently dropped. See TestMergeCarriesOptionalPointerBlocks.
	if src.Security != nil {
		dst.Security = src.Security
	}
	if src.FeatureFlags != nil {
		dst.FeatureFlags = src.FeatureFlags
	}
	if src.Relay != nil {
		dst.Relay = src.Relay
	}
	if src.WebSearch != nil {
		dst.WebSearch = src.WebSearch
	}
	if src.Webhooks != nil {
		dst.Webhooks = src.Webhooks
	}
	if src.Scheduling != nil {
		dst.Scheduling = src.Scheduling
	}

	// LogLevel: project-level overrides global
	if src.LogLevel != "" {
		dst.LogLevel = src.LogLevel
	}

	// Logging: whole-block override (pointer). A later layer that sets the
	// block replaces an earlier one; nil leaves the earlier value intact.
	if src.Logging != nil {
		dst.Logging = src.Logging
	}

	// EarlyStopContinue: merge field-by-field so engine.json can override a
	// single sub-field (e.g. just `enabled`) without nuking the others.
	// Built-in defaults are applied later at the run-loop layer; merge here
	// only carries forward explicit values from JSON layers.
	if src.EarlyStopContinue != nil {
		if dst.EarlyStopContinue == nil {
			cp := *src.EarlyStopContinue
			dst.EarlyStopContinue = &cp
		} else {
			if src.EarlyStopContinue.Enabled != nil {
				dst.EarlyStopContinue.Enabled = src.EarlyStopContinue.Enabled
			}
			if src.EarlyStopContinue.Budget != 0 {
				dst.EarlyStopContinue.Budget = src.EarlyStopContinue.Budget
			}
			if src.EarlyStopContinue.ThresholdPct != 0 {
				dst.EarlyStopContinue.ThresholdPct = src.EarlyStopContinue.ThresholdPct
			}
			if src.EarlyStopContinue.MaxContinuations != 0 {
				dst.EarlyStopContinue.MaxContinuations = src.EarlyStopContinue.MaxContinuations
			}
			if src.EarlyStopContinue.DiminishingDelta != 0 {
				dst.EarlyStopContinue.DiminishingDelta = src.EarlyStopContinue.DiminishingDelta
			}
		}
	}

	// Thinking: merge field-by-field so a layer can override a single
	// sub-field (e.g. just `effort`) without nuking the others. Mirrors the
	// EarlyStopContinue treatment above.
	//
	// Enabled is a plain bool, so it cannot distinguish "absent" from
	// "explicitly false" the way the pointer-bools can. It is therefore
	// carried whenever the source declares the block at all — a layer that
	// writes `"thinking": {"enabled": false}` is expressing intent to
	// disable, and that must beat a weaker layer that enabled it.
	// StreamDeltas and Persist are pointer-bools and carry only when set.
	if src.Thinking != nil {
		if dst.Thinking == nil {
			cp := *src.Thinking
			dst.Thinking = &cp
		} else {
			dst.Thinking.Enabled = src.Thinking.Enabled
			if src.Thinking.Effort != "" {
				dst.Thinking.Effort = src.Thinking.Effort
			}
			if src.Thinking.BudgetTokens != 0 {
				dst.Thinking.BudgetTokens = src.Thinking.BudgetTokens
			}
			if src.Thinking.StreamDeltas != nil {
				dst.Thinking.StreamDeltas = src.Thinking.StreamDeltas
			}
			if src.Thinking.Persist != nil {
				dst.Thinking.Persist = src.Thinking.Persist
			}
		}
	}

	// Timeouts: merge non-zero fields
	if src.Timeouts != nil {
		dst.Timeouts = types.MergeTimeouts(dst.Timeouts, src.Timeouts)
	}

	// Workspace: merge non-zero fields (reap grace window, watcher dir cap)
	if src.Workspace != nil {
		dst.Workspace = types.MergeWorkspace(dst.Workspace, src.Workspace)
	}

	// ThinkingPolicy: whole-block override. A later layer that sets this
	// install-wide policy decides; nil leaves the earlier value intact. Enterprise
	// sealing happens later in EnforceEnterprise.
	if src.ThinkingPolicy != nil {
		cp := *src.ThinkingPolicy
		dst.ThinkingPolicy = &cp
	}
}
