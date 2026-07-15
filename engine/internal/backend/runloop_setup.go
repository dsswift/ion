package backend

import (
	"errors"
	"fmt"
	"os"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// effectiveBashAllowlist computes the run-time bash allowlist as the
// de-duplicated union of:
//
//   - opts.PlanModeAllowedBashCommands           (session-scoped override)
//   - opts.BashAllowlistAdditionsForThisPrompt   (per-prompt additions)
//
// The order is preserved: session entries first (in their original
// order), then per-prompt additions that aren't already present. The
// result drives both the system-prompt prose (`buildPlanModePrompt`)
// and the run-time gate (`run.planModeAllowedBashCommands` consulted
// by `applyPlanModeBashGate` in runloop_plan_mode_gates.go).
//
// Crucially this function returns a new slice — neither input is
// mutated, and the session-level `engineSession.planModeAllowedBashCommands`
// is never touched. The per-prompt additions live for exactly one
// run; the engine drops them when the activeRun goroutine ends and
// they have no effect on subsequent prompts in the same session.
// See docs/protocol/client-commands.md § set_plan_mode for the
// three-layer configuration model (engine config → session override
// → per-prompt additions).
func effectiveBashAllowlist(opts types.RunOptions) []string {
	if len(opts.BashAllowlistAdditionsForThisPrompt) == 0 {
		// Hot path: most runs carry no per-prompt additions; return the
		// session allowlist as-is so the caller can compare lengths
		// without allocating.
		return opts.PlanModeAllowedBashCommands
	}
	seen := make(map[string]struct{}, len(opts.PlanModeAllowedBashCommands)+len(opts.BashAllowlistAdditionsForThisPrompt))
	out := make([]string, 0, len(opts.PlanModeAllowedBashCommands)+len(opts.BashAllowlistAdditionsForThisPrompt))
	for _, cmd := range opts.PlanModeAllowedBashCommands {
		if _, dup := seen[cmd]; dup {
			continue
		}
		seen[cmd] = struct{}{}
		out = append(out, cmd)
	}
	for _, cmd := range opts.BashAllowlistAdditionsForThisPrompt {
		if _, dup := seen[cmd]; dup {
			continue
		}
		seen[cmd] = struct{}{}
		out = append(out, cmd)
	}
	return out
}

// resolveProvider resolves the provider for the given model and injects the
// provider's API key (if available) into the global provider key registry.
// Returns nil if no provider supports the model.
func (b *ApiBackend) resolveProvider(model string) providers.LlmProvider {
	b.mu.Lock()
	authRes := b.authResolver
	b.mu.Unlock()
	providerName := providers.ProviderNameForModel(model)
	if authRes != nil && providerName != "" {
		if key, err := authRes.ResolveKey(providerName); err == nil && key != "" {
			providers.SetProviderKey(providerName, key)
			utils.LogWithFields(utils.LevelInfo, "backend.runloop", "resolved key for", map[string]any{
				"provider": providerName,
				"len":      len(key),
			})
		} else if err != nil {
			utils.LogWithFields(utils.LevelInfo, "backend.runloop", "no key for", map[string]any{
				"provider": providerName,
				"error":    utils.ErrStr(err),
			})
		}
	}
	p := providers.ResolveProvider(model)
	if p != nil {
		// Also check what key the provider will actually use at request time
		runtimeKey := providers.GetProviderKey(p.ID())
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "resolved → (, )", map[string]any{
			"model":           model,
			"provider":        p.ID(),
			"name_for_model":  providerName,
			"runtime_key_len": len(runtimeKey),
		})
	} else {
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "resolved → nil", map[string]any{
			"model":          model,
			"name_for_model": providerName,
		})
	}
	return p
}

// loadOrCreateConversation returns an existing conversation when ConversationID
// resolves to one on disk, otherwise creates a new conversation with a
// timestamp+random suffix id that cannot collide with same-millisecond peers.
// When ConversationID is non-empty and Load fails with a non-not-found error
// (corrupt file, permission denied, etc.), the error is returned instead
// of silently creating a replacement — this prevents overwriting existing
// conversation files on transient read failures.
func loadOrCreateConversation(opts types.RunOptions, model string) (*conversation.Conversation, error) {
	if opts.ConversationID != "" {
		loaded, err := conversation.Load(opts.ConversationID, "")
		if err != nil {
			// Distinguish "not found" (first run with this ConversationID) from
			// real failures (corrupt file, permission denied). Not-found is
			// the normal first-run case — create a new conversation with the
			// caller's desired ID. Real errors surface immediately so the
			// caller can diagnose and retry without data loss.
			if errors.Is(err, conversation.ErrNotFound) {
				utils.LogWithFields(utils.LevelInfo, "backend.runloop", "creating new conversation", map[string]any{
					"conversation_id": opts.ConversationID,
				})
				created := conversation.CreateConversation(opts.ConversationID, opts.SystemPrompt, model)
				// Record on-disk descent when the caller supplied a parent (a
				// client-driven checkpoint cut for an existing tab). Empty leaves
				// parentId unset, as before.
				if opts.ParentConversationID != "" {
					created.ParentID = opts.ParentConversationID
					utils.LogWithFields(utils.LevelInfo, "backend.runloop", "new conversation descends from", map[string]any{
						"conversation_id": opts.ConversationID,
						"parent_id":       opts.ParentConversationID,
					})
				}
				return created, nil
			}
			utils.LogWithFields(utils.LevelError, "backend.runloop", "failed to load conversation", map[string]any{
				"conversation_id": opts.ConversationID,
				"error":           utils.ErrStr(err),
			})
			return nil, fmt.Errorf("failed to load conversation %s: %w", opts.ConversationID, err)
		}
		// Sanitize loaded messages (fix orphaned tool_result blocks, remove thinking)
		loaded.Messages = conversation.SanitizeMessages(loaded.Messages)
		// Replace [plan-file] placeholder with actual plan file path in loaded
		// history — fixes both Messages (sent to LLM) and Entries (persisted to
		// disk via saveSplit / BuildContextPath / .tree.jsonl).
		if opts.PlanFilePath != "" {
			conversation.ReplacePlanFilePlaceholder(loaded, opts.PlanFilePath)
		}
		return loaded, nil
	}
	// Use the canonical conversation ID generator so two runs that begin
	// in the same millisecond cannot collide on the conversation file.
	created := conversation.CreateConversation(
		conversation.NewConversationID(),
		opts.SystemPrompt,
		model,
	)
	if opts.ParentConversationID != "" {
		created.ParentID = opts.ParentConversationID
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "new conversation descends from", map[string]any{
			"id":        created.ID,
			"parent_id": opts.ParentConversationID,
		})
	}
	return created, nil
}

// buildSystemPrompt assembles the final system prompt for a run, layering in
// plan-mode prompt, before_prompt hook contributions, and the capability
// prompt. May rewrite opts.Prompt and opts.PlanModeTools as a side effect when
// a hook returns a non-empty replacement. When run is non-nil and the
// plan_mode_prompt hook returns a SparseReminder, the override is cached on
// run.planModeSparseReminderOverride for use by per-turn reminder injections
// (the RunOptions.PlanModeSparseReminder field takes precedence over the hook
// at injection time — see runloop.go).
func buildSystemPrompt(opts *types.RunOptions, conv *conversation.Conversation, hooks RunHooks, requestID string, run *activeRun) string {
	systemPrompt := conv.System
	if opts.SystemPrompt != "" {
		systemPrompt = opts.SystemPrompt
	}
	if opts.AppendSystemPrompt != "" {
		// When AppendSystemPrompt is set, always rebuild from the explicit
		// SystemPrompt base (or empty string). This prevents duplication
		// when conv.System already contains content from a previous run.
		base := opts.SystemPrompt // explicit override, or ""
		systemPrompt = base + "\n\n" + opts.AppendSystemPrompt
	}
	if opts.PlanMode {
		// Check extension hook for custom plan mode prompt
		planPrompt := opts.PlanModePrompt
		if planPrompt == "" && hooks.OnPlanModePrompt != nil {
			customPrompt, customTools, customSparseReminder := hooks.OnPlanModePrompt(opts.PlanFilePath)
			if customPrompt != "" {
				planPrompt = customPrompt
			}
			if customTools != nil {
				opts.PlanModeTools = customTools
			}
			// Cache the hook's sparse-reminder override on the run so per-turn
			// reminder injections in runloop.go can reuse it without re-firing
			// the hook. RunOptions.PlanModeSparseReminder takes precedence (see
			// runloop.go reminder resolution block), so we only cache the hook
			// result here; the resolution priority check happens at injection time.
			if customSparseReminder != "" && run != nil && run.planModeSparseReminderOverride == "" {
				run.planModeSparseReminderOverride = customSparseReminder
				utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "sparse_reminder_override=hook", map[string]any{
					"run_id": requestID,
					"len":    len(customSparseReminder),
				})
			}
		}
		if planPrompt == "" {
			// Use default plan mode prompt. The bash allowlist passed into
			// the prompt prose is the EFFECTIVE allowlist (session ∪ per-
			// prompt additions, de-duplicated), so when a slash command
			// declares additional commands in its frontmatter the model
			// sees them in the prompt-time tool list.
			_, err := os.Stat(opts.PlanFilePath)
			planPrompt = buildPlanModePrompt(opts.PlanFilePath, err == nil, effectiveBashAllowlist(*opts))
		}
		// Prepend reentry guidance when returning to plan mode after a
		// previous exit. This tells the LLM to read the existing plan and
		// decide whether to amend, replace, or extend it.
		if opts.PlanModeReentry {
			planPrompt = buildPlanModeReentryPrompt(opts.PlanFilePath) + "\n\n" + planPrompt
		}
		systemPrompt += "\n\n" + planPrompt
	}
	// Fire before_prompt hook (before finalizing system prompt)
	if hooks.OnBeforePrompt != nil {
		rewrittenPrompt, extraSystem := hooks.OnBeforePrompt(requestID, opts.Prompt)
		if rewrittenPrompt != "" {
			opts.Prompt = rewrittenPrompt
		}
		if extraSystem != "" {
			systemPrompt += "\n\n" + extraSystem
		}
	}

	// Add capability prompt
	if opts.CapabilityPrompt != "" {
		systemPrompt += "\n" + opts.CapabilityPrompt
	}

	// Inject skill listing + proactive-invocation instruction when skills are
	// loaded. Mirrors Claude Code's skill_listing attachment which injects the
	// same block as a <system-reminder> user message on every turn. Doing it
	// here means the listing is present from turn 1 and survives compaction
	// (buildSystemPrompt is called fresh for every run, including post-compact
	// runs). Skills with disable-model-invocation:true are excluded by
	// BuildSkillSystemPromptSection.
	//
	// This is an opinion the engine carries generically: the coarse gate is
	// RunOptions.DisableSkillSystemPrompt (from engine.json's
	// LimitsConfig.DisableSkillSystemPrompt), and the fine-grained seam is the
	// system_inject hook (kind "skill_listing"), which lets a harness observe,
	// replace, or suppress the exact section text per run even when injection
	// is enabled. A consumer that wants softer phrasing, a fully custom block,
	// or no skill directive at all reaches it through one of these two paths
	// instead of being forced onto the engine's default directive.
	if !opts.DisableSkillSystemPrompt {
		if skillSection := tools.BuildSkillSystemPromptSection(); skillSection != "" {
			text := skillSection
			if hooks.OnSystemInject != nil {
				hookText, suppress := hooks.OnSystemInject("skill_listing", skillSection, 0, 0)
				if suppress {
					text = ""
				} else if hookText != "" {
					text = hookText
				}
			}
			if text != "" {
				systemPrompt += "\n\n" + text
			}
		}
	}

	return systemPrompt
}

// buildToolDefs assembles the active tool list for a run: built-in tools plus
// external/MCP tools plus capability tools, then applies plan-mode filtering,
// allowed/suppressed filters, and provider-side WebSearch swap. Returns the
// final tool definitions and any provider server-side tool descriptors.
func (b *ApiBackend) buildToolDefs(run *activeRun, opts types.RunOptions, provider providers.LlmProvider) ([]types.LlmToolDef, []map[string]any) {
	toolDefs := tools.GetToolDefs()
	var externalTools []types.LlmToolDef
	if run.cfg != nil {
		externalTools = run.cfg.ExternalTools
	}
	extToolCount := len(externalTools)
	if extToolCount > 0 {
		toolDefs = append(toolDefs, externalTools...)
	}
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "tool count", map[string]any{
		"builtin":  len(toolDefs) - extToolCount,
		"external": extToolCount,
		"total":    len(toolDefs),
	})
	if len(opts.CapabilityTools) > 0 {
		toolDefs = append(toolDefs, opts.CapabilityTools...)
	}

	// Always inject AskUserQuestion so the LLM can pause the run to ask a
	// clarifying question in any mode. The engine intercepts calls to this tool
	// unconditionally (see runloop_tools.go), records a PermissionDenial with
	// the question payload, and terminates the run so the client can surface
	// the question and feed the user's answer back as the next prompt.
	askDef := tools.AskUserQuestionTool()
	toolDefs = append(toolDefs, types.LlmToolDef{
		Name:        askDef.Name,
		Description: askDef.Description,
		InputSchema: askDef.InputSchema,
	})

	// Filter tools if plan mode and inject ExitPlanMode
	if opts.PlanMode {
		planTools := opts.PlanModeTools
		if len(planTools) == 0 {
			planTools = defaultPlanModeTools
		}
		allowed := make(map[string]bool, len(planTools)+2)
		for _, t := range planTools {
			allowed[t] = true
		}
		// Always allow Write/Edit so the LLM can write to the plan file
		// (plan-file-only gate in executeTools enforces the target restriction)
		allowed["Write"] = true
		allowed["Edit"] = true
		// Compute the effective allowlist (session ∪ per-prompt additions,
		// de-duplicated) so the Bash-tool-inclusion gate, the run-time
		// gate state, and the system-prompt prose all agree on what Bash
		// commands are permitted for this run.
		effectiveAllowlist := effectiveBashAllowlist(opts)
		// Include Bash when the effective allowlist is non-empty (either
		// the session has an allowlist, or the prompt carries per-prompt
		// additions, or both).
		if len(effectiveAllowlist) > 0 {
			allowed["Bash"] = true
		}
		// AskUserQuestion is injected unconditionally above; keep it through
		// the plan-mode filter so it is still available during plan mode.
		allowed[tools.AskUserQuestionName] = true
		var filtered []types.LlmToolDef
		for _, td := range toolDefs {
			if allowed[td.Name] || td.PlanModeSafe {
				filtered = append(filtered, td)
			}
		}
		toolDefs = filtered

		// Always inject ExitPlanMode sentinel when in plan mode
		exitPlanDef := tools.ExitPlanModeTool()
		toolDefs = append(toolDefs, types.LlmToolDef{
			Name:        exitPlanDef.Name,
			Description: exitPlanDef.Description,
			InputSchema: exitPlanDef.InputSchema,
		})

		// Emit a state-transition event so consumers can mirror the active
		// plan-mode flag. Snapshot-style: the event is the authoritative
		// signal that the run is now in plan mode.
		//
		// Carry the plan identity (path + slug) on every emission. This site
		// fires when a run STARTS while the session is already in plan mode
		// (a continuation/subsequent turn of an existing plan); run.planFilePath
		// is already populated from options.PlanFilePath at run creation
		// (api_backend.go), so the path is available here. Populating it
		// matches the model-initiated EnterPlanMode emit in
		// runloop_plan_mode_gates.go and lets consumers (a) render the plan
		// slug on the divider and (b) distinguish the first divider for a path
		// ("Plan created") from subsequent ones ("Plan updated"). Omitting the
		// path here produced a nameless, non-dedupable second divider on the
		// clients. PlanSlugFromPath returns "" for an empty path, so the
		// pathological empty-path case degrades to today's slug-less divider.
		b.emit(run, types.NormalizedEvent{Data: &types.PlanModeChangedEvent{
			Enabled:      true,
			PlanFilePath: run.planFilePath,
			PlanSlug:     types.PlanSlugFromPath(run.planFilePath),
		}})
		utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "event", map[string]any{
			"run_id":         run.requestID,
			"tools_filtered": len(toolDefs),
			"allowed":        planTools,
		})
		// Install the EFFECTIVE allowlist on the run so applyPlanModeBashGate
		// (executed per-tool-call in runloop_plan_mode_gates.go) sees the
		// same set the system prompt advertised and the tool-list gate
		// included Bash for. The per-prompt additions live ONLY in this
		// run's activeRun.planModeAllowedBashCommands and never persist
		// to the session-level engineSession.planModeAllowedBashCommands.
		run.planModeAllowedBashCommands = effectiveAllowlist
		// Log both sides of the conditional per AGENTS.md logging-policy.
		// The bash-allowlist transition from RunOptions → activeRun is
		// the boundary where session-level config + per-prompt additions
		// become run-local state; if a future bug surfaces in the bash gate
		// the log line here lets a developer confirm the list arrived intact.
		// When per-prompt additions are present, log the breakdown so an
		// operator can distinguish session-level entries from per-prompt
		// additions when investigating "why was this command allowed?"
		if len(effectiveAllowlist) > 0 {
			if len(opts.BashAllowlistAdditionsForThisPrompt) > 0 {
				utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "applied_to_run ( + )", map[string]any{
					"run_id":               run.requestID,
					"bash_allowlist":       effectiveAllowlist,
					"session_id":           opts.PlanModeAllowedBashCommands,
					"per_prompt_additions": opts.BashAllowlistAdditionsForThisPrompt,
				})
			} else {
				utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "applied_to_run", map[string]any{
					"run_id":         run.requestID,
					"bash_allowlist": effectiveAllowlist,
				})
			}
		} else {
			utils.LogWithFields(utils.LevelDebug, "backend.plan_mode", "no bash_allowlist (default-deny)", map[string]any{
				"run_id": run.requestID,
			})
		}
	} else {
		// Inject EnterPlanMode sentinel in auto mode so the LLM can request
		// a transition into plan mode when it judges the task warrants planning.
		// Symmetric with ExitPlanMode which is injected only in plan mode.
		//
		// Implementation-phase suppression: when the harness has set
		// RunOptions.ImplementationPhase=true (e.g. a harness button that
		// hands off an approved plan to an "implement" run), the engine
		// skips the injection entirely so the model can't propose a fresh
		// plan-mode entry mid-implementation. This replaces the previous
		// prompt-text substring-matching mechanism with a structured
		// boolean — see the field comment in
		// engine/internal/types/types.go.
		if opts.ImplementationPhase {
			utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "skipping EnterPlanMode injection (implementation_phase=true)", map[string]any{
				"run_id": run.requestID,
			})
		} else {
			// Resolve the EnterPlanMode tool description: harness-supplied
			// prose wins; empty falls back to the engine's one-line
			// default. Per ADR-004 the policy prose lives in the harness;
			// the engine never composes its own opinionated framing.
			// Log which branch ran so the operational log captures the
			// resolution path (logging policy: log both sides of every
			// decision).
			descSource := "default"
			descLen := 0
			if opts.EnterPlanModeDescription != "" {
				descSource = "harness"
				descLen = len(opts.EnterPlanModeDescription)
			}
			enterPlanDef := tools.EnterPlanModeToolWithDescription(opts.EnterPlanModeDescription)
			toolDefs = append(toolDefs, types.LlmToolDef{
				Name:        enterPlanDef.Name,
				Description: enterPlanDef.Description,
				InputSchema: enterPlanDef.InputSchema,
			})
			utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "injected EnterPlanMode in auto mode", map[string]any{
				"run_id":               run.requestID,
				"enter_plan_mode_desc": descSource,
				"len":                  descLen,
			})
		}
	}

	// Filter by allowedTools if specified (empty list = no tools, nil = all tools)
	if opts.AllowedTools != nil {
		allowed := make(map[string]bool, len(opts.AllowedTools))
		for _, t := range opts.AllowedTools {
			allowed[t] = true
		}
		var filtered []types.LlmToolDef
		for _, td := range toolDefs {
			if allowed[td.Name] {
				filtered = append(filtered, td)
			}
		}
		toolDefs = filtered
	}

	// Filter out suppressed tools
	if len(opts.SuppressTools) > 0 {
		suppressed := make(map[string]bool, len(opts.SuppressTools))
		for _, t := range opts.SuppressTools {
			suppressed[t] = true
		}
		var filtered []types.LlmToolDef
		for _, td := range toolDefs {
			if !suppressed[td.Name] {
				filtered = append(filtered, td)
			}
		}
		toolDefs = filtered
	}

	// Web search mode resolution: determine whether to use server-side
	// (Anthropic built-in) or client-side (Brave/Tavily/SearXNG) web search.
	var serverTools []map[string]any
	providerID := provider.ID()
	supportsServer := providerID == "anthropic" || providerID == "vertex"
	mode := opts.WebSearchMode
	if mode == "" {
		mode = "auto"
	}

	useServer := false
	switch mode {
	case "server":
		useServer = supportsServer
	case "client":
		useServer = false
	default: // "auto"
		// Prefer client if a backend key is configured (better reliability:
		// model gets a follow-up turn to process results). Fall back to
		// server on Anthropic/Vertex when no client key is available.
		if supportsServer && !tools.HasSearchBackend() {
			useServer = true
		}
	}

	if useServer {
		filtered := toolDefs[:0]
		for _, td := range toolDefs {
			if td.Name != "WebSearch" {
				filtered = append(filtered, td)
			}
		}
		toolDefs = filtered
		serverTools = []map[string]any{{
			"type":     "web_search_20250305",
			"name":     "web_search",
			"max_uses": 5,
		}}
	}

	return toolDefs, serverTools
}

// AssembleSystemPromptOnDemand assembles the system prompt outside of an active
// run. Exported so the session layer can reconstruct the prompt for on-demand
// operations (e.g. ComputeAndEmitContextBreakdown) without needing a live
// activeRun. Equivalent to buildSystemPrompt with a nil run — the nil-guard
// inside that function means the plan_mode_sparse_reminder cache path is
// skipped, which is correct for the on-demand case (no run is in flight).
func AssembleSystemPromptOnDemand(opts *types.RunOptions, conv *conversation.Conversation) string {
	return buildSystemPrompt(opts, conv, RunHooks{}, "on-demand", nil)
}

// ResolveProviderOnDemand resolves the provider for the given model and returns
// it. Exported thin wrapper around the unexported resolveProvider, used by the
// session layer for on-demand operations (ComputeAndEmitContextBreakdown) that
// need a provider reference without a live activeRun.
func (b *ApiBackend) ResolveProviderOnDemand(model string) providers.LlmProvider {
	return b.resolveProvider(model)
}
