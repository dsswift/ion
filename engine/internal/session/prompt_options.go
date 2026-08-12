package session

import (
	"context"
	"strings"
	"time"

	ionconfig "github.com/dsswift/ion/engine/internal/config"
	ioncontext "github.com/dsswift/ion/engine/internal/context"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/gitcontext"
	"github.com/dsswift/ion/engine/internal/modelconfig"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
	"github.com/dsswift/ion/engine/internal/workspaces"
)

// buildPromptOverrides constructs the *PromptOverrides for a per-prompt
// dispatch from the run-scoped options every sendPrompt entry point carries:
// an optional model override, optional plan-mode Bash allowlist additions,
// and an optional injection kind that classifies extension-initiated turns.
// Returns nil when all are empty so callers pass nil (the "no overrides"
// sentinel) rather than an empty struct.
//
// This is the single seam every sendPrompt path routes through so the active-
// hook path (sessionAccessor.SendPrompt) and the fallback path (the
// onSendMessage closures wired in start_session.go and prompt_extensions.go)
// produce identical overrides for identical input. Centralizing it here is the
// "one pipeline" guarantee — there is no way for one entry point to build
// overrides differently from another.
//
// The bash additions are unioned with the session allowlist for this single
// run via opts.BashAllowlistAdditionsForThisPrompt (applied in buildRunOptions
// below) and the run loop's effectiveBashAllowlist; they are never persisted on
// the engineSession. See extension.Context.SendPrompt for the contract.
func buildPromptOverrides(model string, bashAllowlistAdditions []string, kind string) *PromptOverrides {
	if model == "" && len(bashAllowlistAdditions) == 0 && kind == "" {
		return nil
	}
	overrides := &PromptOverrides{Model: model, InjectionKind: kind}
	if len(bashAllowlistAdditions) > 0 {
		overrides.BashAllowlistAdditionsForThisPrompt = bashAllowlistAdditions
	}
	return overrides
}

// dispatchSendPromptPayload is the single onSendMessage callback body shared by
// every extension-wiring site (start_session.go's loadAndWireExtensions and
// prompt_extensions.go's lateLoadExtensions). Both sites install this exact
// method as the host's onSendMessage callback, so a follow-up prompt queued by
// an extension carries identical run configuration regardless of which wiring
// path created the host. Extracting it here removes the previously-duplicated
// closure bodies — the duplication was itself a "two ways to do one thing"
// hazard that could drift — and creates a directly-testable seam that pins the
// full payload (text + model + bash-allowlist additions) flows through to
// m.SendPrompt and is not dropped.
//
// origin is a short label ("start_session" / "prompt_extensions") used only in
// the log line so an operator can tell which wiring site queued the prompt.
func (m *Manager) dispatchSendPromptPayload(key, origin string, payload extension.SendPromptPayload) {
	overrides := buildPromptOverrides(payload.Model, payload.BashAllowlistAdditions, payload.Kind)
	if len(payload.BashAllowlistAdditions) > 0 {
		utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "onsendmessage(): forwarding bash-allowlist additions", map[string]any{"origin": origin, "key": key, "count": len(payload.BashAllowlistAdditions), "bash_allowlist_additions": payload.BashAllowlistAdditions})
	}
	// Classify the injection BEFORE SendPrompt consumes any pending slash
	// invocation (see resolvePromptInjectedKind).
	injectedKind := m.resolvePromptInjectedKind(key, payload.Kind)
	if err := m.SendPrompt(key, payload.Text, overrides); err != nil {
		utils.LogWithFields(utils.LevelInfo, "session", "ext/send_message failed", map[string]any{"error": err})
		return
	}
	// Extension-initiated prompt accepted: surface it as a typed event so
	// live clients can render the turn (see emitPromptInjected).
	m.emitPromptInjected(key, payload.Text, injectedKind)
}

// SlashCommandInjectionKind is the classification stamped on an
// engine_prompt_injected event when the injected prompt is the delivery of a
// slash command's expanded template body. When an extension registers a command
// and its handler calls ctx.sendPrompt with the expanded body, the engine has
// already stashed the raw invocation as a pendingSlashInvocation (see
// dispatchCommand). The run loop persists that raw invocation as the display
// turn via AddUserMessageWithInvocation, while the expanded body is the
// LLM-visible turn. The injected body is therefore REDUNDANT with the persisted
// display turn: both describe the same user action. The kind lets a consumer
// distinguish the redundant expansion from a genuine user turn and interpret it
// however it chooses (the reference clients suppress it). The persisted display
// entry is unaffected; it carries no injection kind and reloads identically.
//
// Aliases types.InjectionKindSlashCommand — the enumerated set in
// types/injection_kind.go is the definition. This name is retained because it
// is SDK-adjacent surface that external consumers may reference.
const SlashCommandInjectionKind = string(types.InjectionKindSlashCommand)

// resolvePromptInjectedKind derives the kind to stamp on the emitted
// engine_prompt_injected event. An explicit extension-provided kind always wins
// (e.g. "agent_completion"). Otherwise, when the injected prompt fulfills a
// pending slash-command invocation on this session — dispatchCommand stashed it
// and the imminent SendPrompt is about to consume it — classify the injection as
// SlashCommandInjectionKind so consumers can distinguish the redundant expansion
// body from a genuine user turn.
//
// MUST be called BEFORE m.SendPrompt, which consumes pendingSlashInvocation
// (prompt_dispatch.go). This only classifies the LIVE event; the persisted
// display entry is written by AddUserMessageWithInvocation and carries no
// injection kind, so a history reload is unaffected.
func (m *Manager) resolvePromptInjectedKind(key, extKind string) string {
	if extKind != "" {
		return extKind
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	if s, ok := m.sessions[key]; ok && s.pendingSlashInvocation != nil {
		return SlashCommandInjectionKind
	}
	return ""
}

// emitPromptInjected surfaces an ENGINE-SIDE prompt injection (extension
// ctx.sendPrompt — dispatch-completion delivery, check-ins, revives) as the
// typed engine_prompt_injected event. Client-submitted prompts (the wire
// `prompt` command in server/dispatch.go) must never route through this:
// each client does its own optimistic transcript insert, and echoing those
// back would duplicate them. Called only from the two extension entry seams
// (sessionAccessor.SendPromptWithKind and dispatchSendPromptPayload), after
// m.SendPrompt accepted the prompt.
//
// kind classifies the injection for consumers. See types.InjectionKind for the
// enumerated set. Empty means a genuine extension-initiated turn with no
// special classification.
//
// The event also carries MachineAuthored, derived from the kind HERE — this is
// the single emit seam for extension injections, so the derivation happens once
// rather than in each consumer. Consumers read the boolean instead of matching
// kind strings, which is what lets a new kind reach every client with no
// client-side edit.
func (m *Manager) emitPromptInjected(key, text, kind string) {
	m.mu.RLock()
	origin := ""
	if s, ok := m.sessions[key]; ok {
		origin = s.extensionName
	}
	m.mu.RUnlock()
	machineAuthored := types.InjectionKind(kind).IsMachineToMachine()
	utils.LogWithFields(utils.LevelInfo, "session", "prompt injected by extension, emitting engine_prompt_injected", map[string]any{"key": key, "origin": origin, "prompt_len": len(text), "kind": kind, "machine_authored": machineAuthored})
	m.emit(key, types.EngineEvent{
		Type:                          "engine_prompt_injected",
		InjectedPrompt:                text,
		InjectedPromptOrigin:          origin,
		InjectedPromptKind:            kind,
		InjectedPromptMachineAuthored: machineAuthored,
	})
}

func buildRunOptions(s *engineSession, text string, overrides *PromptOverrides) types.RunOptions {
	opts := types.RunOptions{
		Prompt:      text,
		ProjectPath: s.config.WorkingDirectory,
		// ClaudeCompat mirrors the session's Claude-compatibility setting onto
		// the run so the backend's nested context loader gates Claude files
		// (CLAUDE.md) the same way the eager walk does. Ion-native files load
		// regardless of this flag.
		ClaudeCompat: s.config.ClaudeCompat,
		// ConversationID is Ion's conversation-file identity. The API backend
		// uses it to load/create ~/.ion/conversations/<id>.* and to resume.
		ConversationID: s.conversationID,
		// SessionKey is the opaque client-supplied key for this session (the
		// tab UUID for desktop clients). The backend threads it into telemetry
		// so tier-4 events stamp session_id = the session key, consistent with
		// the session-layer correlationCtx emissions.
		SessionKey: s.key,
		// ExtensionName and ExtensionVersion carry the hosting extension's
		// identity into the backend so buildTelemCtx can stamp "extension" and
		// "extension_version" on llm.call and dispatch.agent spans. Both are
		// omit-when-empty so non-extension runs are unaffected.
		ExtensionName:    s.extensionName,
		ExtensionVersion: s.extensionVersion,
		// ParentConversationID is forwarded so a fresh conversation created by
		// this run records its descent from a prior session (client-driven
		// checkpoint cut). Inert when resuming an existing conversation.
		ParentConversationID: s.config.ParentConversationID,
		// CliResumeSessionID is deliberately NOT set here. The resume-vs-
		// bridge decision is made at dispatch by resolveCliContinuity
		// (native_session.go), after the model — and therefore the serving
		// backend kind — is final: a still-valid per-kind cursor sets the
		// field; a stale/absent one leaves it empty and bridges the
		// transcript instead. The API backend ignores the field; only the
		// CLI backends read it. Distinct identity space from SessionID.
		MaxTokens:                   s.config.MaxTokens,
		Thinking:                    s.config.Thinking,
		PlanMode:                    s.planMode,
		PlanModeTools:               s.planModeTools,
		PlanFilePath:                s.planFilePath,
		PlanModeAllowedBashCommands: s.planModeAllowedBashCommands,
	}

	if overrides != nil {
		if overrides.Model != "" {
			opts.Model = overrides.Model
		}
		if overrides.MaxTurns > 0 {
			opts.MaxTurns = overrides.MaxTurns
		}
		if overrides.MaxBudgetUsd > 0 {
			opts.MaxBudgetUsd = overrides.MaxBudgetUsd
		}
		if overrides.AppendSystemPrompt != "" {
			opts.AppendSystemPrompt += "\n\n" + overrides.AppendSystemPrompt
		}
		if len(overrides.Attachments) > 0 {
			opts.Attachments = overrides.Attachments
		}
		// Forward the structured implementation-phase flag onto RunOptions
		// so runloop_setup can suppress the EnterPlanMode sentinel-tool
		// injection. The flag is strictly subtractive — if the run is
		// already in plan mode the engine never injects EnterPlanMode
		// regardless, so the flag has no effect there.
		if overrides.ImplementationPhase {
			opts.ImplementationPhase = true
		}
		// Per-prompt thinking effort (live per-conversation control). Four
		// meaningful values:
		//   "low"/"medium"/"high" — set thinking AND pin the depth
		//   "adaptive"            — enable thinking, DO NOT pin depth: the
		//                           model self-regulates (Anthropic adaptive
		//                           models). Resolves to Effort:"" so the
		//                           provider omits output_config/effort.
		//   "off"                 — clear thinking entirely
		// This is the single place the per-prompt effort lands on the run; the
		// provider body-builders resolve the per-model mechanism downstream.
		//
		// "adaptive" exists because pinning effort:"high" on a self-regulating
		// model overrides its own judgment on EVERY turn, including turns that
		// need no reasoning — which is a large latency regression, not a
		// quality win. The engine carries the distinction; the client decides
		// which value to send.
		//
		// ThinkingCleared distinguishes a deliberate "off" from "no opinion"
		// — both leave Thinking nil, and applyConfigDefaults must not apply the
		// engine-wide default over an explicit off.
		if eff := overrides.ThinkingEffort; eff == types.ThinkingEffortAdaptive {
			opts.Thinking = &types.ThinkingConfig{Enabled: true}
		} else if eff != "" && eff != "off" {
			opts.Thinking = &types.ThinkingConfig{Enabled: true, Effort: eff}
		} else if eff == "off" {
			opts.Thinking = nil
			opts.ThinkingCleared = true
		}
		// Forward the harness-supplied EnterPlanMode tool description.
		// Empty string means "fall back to engine default" — runloop_setup
		// resolves the actual prose via tools.EnterPlanModeToolWithDescription.
		// Per ADR-004, the engine does not impose a policy default beyond
		// the one-line neutral fallback.
		if overrides.EnterPlanModeDescription != "" {
			opts.EnterPlanModeDescription = overrides.EnterPlanModeDescription
		}
		// Forward the harness-supplied sparse-reminder override.
		// Empty string means "use buildPlanModeSparseReminder default".
		if overrides.PlanModeSparseReminder != "" {
			opts.PlanModeSparseReminder = overrides.PlanModeSparseReminder
		}
		// Forward the per-prompt bash-allowlist additions. The field is
		// transient by design: opts.BashAllowlistAdditionsForThisPrompt is
		// unioned with the session allowlist when runloop_setup builds the
		// run-time tool list (see buildToolDefs). The session-level
		// engineSession.planModeAllowedBashCommands is NOT mutated by this
		// field — that invariant is the point of having a separate field
		// rather than a session-scoped mutation here.
		if len(overrides.BashAllowlistAdditionsForThisPrompt) > 0 {
			opts.BashAllowlistAdditionsForThisPrompt = overrides.BashAllowlistAdditionsForThisPrompt
		}
		// Compaction overrides — per-prompt tuning of context compaction.
		if overrides.CompactTargetPercent > 0 {
			opts.CompactTargetPercent = overrides.CompactTargetPercent
		}
		if overrides.CompactMicroKeepTurns > 0 {
			opts.CompactMicroKeepTurns = overrides.CompactMicroKeepTurns
		}
		if overrides.CompactEnabled != nil {
			opts.CompactEnabled = overrides.CompactEnabled
		}
		if overrides.CompactSummaryEnabled != nil {
			opts.CompactSummaryEnabled = overrides.CompactSummaryEnabled
		}
		if overrides.CompactMemoryEnabled != nil {
			opts.CompactMemoryEnabled = overrides.CompactMemoryEnabled
		}
		// Thread the injection kind onto RunOptions so appendInboundUserMessage
		// can stamp it on the persisted conversation entry, enabling consumers
		// to classify the turn on historical reload.
		if overrides.InjectionKind != "" {
			opts.InjectionKind = overrides.InjectionKind
		}
		// A steer that could not reach a live run: the backend persists the
		// steer marker so the degraded path leaves the same trace the live
		// path does.
		if overrides.SteerDegraded {
			opts.SteerDegraded = true
		}
	}

	if s.config.SystemHint != "" {
		opts.AppendSystemPrompt += "\n\n" + s.config.SystemHint
	}
	return opts
}

// applyConfigDefaults fills opts fields from manager-level config when
// the session/overrides did not specify them.
func (m *Manager) applyConfigDefaults(opts *types.RunOptions) {
	if m.config == nil {
		return
	}
	if opts.Model == "" {
		opts.Model = m.config.DefaultModel
	}
	if opts.MaxTurns <= 0 && m.config.Limits.MaxTurns != nil {
		opts.MaxTurns = *m.config.Limits.MaxTurns
	}
	if opts.MaxBudgetUsd <= 0 && m.config.Limits.MaxBudgetUsd != nil {
		opts.MaxBudgetUsd = *m.config.Limits.MaxBudgetUsd
	}
	// Engine-wide thinking default — the weakest layer of the precedence
	// chain (engine.json ← session config ← per-prompt effort). A nil
	// opts.Thinking here means neither stronger layer expressed an opinion:
	// buildRunOptions copies the session default, and the per-prompt "off"
	// sentinel sets nil only after explicitly clearing it. Those two cases
	// are indistinguishable at this point BY DESIGN — "off" means "no
	// thinking on this run", and re-applying the engine default would
	// resurrect exactly what the client just turned off.
	//
	// That is why the desktop sends the literal "off" rather than omitting
	// the field: the override arm runs before this and an omitted field
	// would arrive here as the same nil, silently inheriting the default.
	// buildRunOptions runs first, so a copy of the config value is safe to
	// share only if never mutated downstream — take a defensive copy.
	if opts.Thinking == nil && m.config.Thinking != nil && !opts.ThinkingCleared {
		cp := *m.config.Thinking
		opts.Thinking = &cp
		utils.LogWithFields(utils.LevelInfo, "session", "applied engine.json thinking default", map[string]any{
			"enabled": cp.Enabled, "reason": cp.Effort, "count": cp.BudgetTokens,
		})
	}
	if m.config.Compaction != nil {
		cc := m.config.Compaction
		if opts.CompactThreshold <= 0 && cc.Threshold > 0 {
			opts.CompactThreshold = cc.Threshold
		}
		if opts.CompactTargetPercent <= 0 && cc.TargetPercent > 0 {
			opts.CompactTargetPercent = cc.TargetPercent
		}
		if opts.CompactMicroKeepTurns <= 0 && cc.MicroCompactKeep > 0 {
			opts.CompactMicroKeepTurns = cc.MicroCompactKeep
		}
		if opts.CompactMinKeepTurns <= 0 && cc.KeepTurns > 0 {
			opts.CompactMinKeepTurns = cc.KeepTurns
		}
		if opts.CompactEstimationPadding <= 0 && cc.EstimationPadding > 0 {
			opts.CompactEstimationPadding = cc.EstimationPadding
		}
		if opts.CompactEnabled == nil && cc.Enabled != nil {
			opts.CompactEnabled = cc.Enabled
		}
		if opts.CompactSummaryEnabled == nil && cc.SummaryEnabled != nil {
			opts.CompactSummaryEnabled = cc.SummaryEnabled
		}
		if opts.CompactSummaryModel == "" && cc.SummaryModel != "" {
			opts.CompactSummaryModel = cc.SummaryModel
		}
		if opts.CompactSummaryMaxTokens <= 0 && cc.SummaryMaxTokens > 0 {
			opts.CompactSummaryMaxTokens = cc.SummaryMaxTokens
		}
		if opts.CompactMemoryEnabled == nil && cc.MemoryEnabled != nil {
			opts.CompactMemoryEnabled = cc.MemoryEnabled
		}
		if opts.CompactMemoryModel == "" && cc.MemoryModel != "" {
			opts.CompactMemoryModel = cc.MemoryModel
		}
		if opts.CompactMemoryUpdateThreshold <= 0 && cc.MemoryUpdateThreshold > 0 {
			opts.CompactMemoryUpdateThreshold = cc.MemoryUpdateThreshold
		}
		if opts.CompactMemoryUpdateMinTurns <= 0 && cc.MemoryUpdateMinTurns > 0 {
			opts.CompactMemoryUpdateMinTurns = cc.MemoryUpdateMinTurns
		}
		if opts.CompactMemoryMaxTokens <= 0 && cc.MemoryMaxTokens > 0 {
			opts.CompactMemoryMaxTokens = cc.MemoryMaxTokens
		}
	}
	if m.config.Limits.SuppressSystemMessages != nil && *m.config.Limits.SuppressSystemMessages {
		opts.SuppressSystemMessages = true
	}
	if m.config.Limits.DisablePlanModeReminder != nil && *m.config.Limits.DisablePlanModeReminder {
		opts.DisablePlanModeReminder = true
	}
	// Plan-mode Bash allowlist is ENGINE POLICY, resolved FRESH from
	// engine.json at each dispatch (not the boot-cached m.config), so an
	// operator editing limits.planModeAllowedBashCommands mid-conversation
	// sees it honored on the next prompt with no daemon restart. Only fills
	// when the client sent no session-scoped override (opts already empty):
	// a set_plan_mode override still wins, preserving the published contract.
	//
	// Tri-valued: ResolvePlanModeBashAllowlist returns found=true when a
	// config layer set the field (value used verbatim, INCLUDING an explicit
	// empty slice = "block Bash in plan mode"); found=false when no layer set
	// it, in which case we fall back to the boot-cached value (itself
	// typically nil = block). Both branches are logged per logging policy.
	if len(opts.PlanModeAllowedBashCommands) == 0 {
		if cmds, found := ionconfig.ResolvePlanModeBashAllowlist(opts.ProjectPath); found {
			opts.PlanModeAllowedBashCommands = cmds
			utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "bash allowlist resolved fresh from engine.json", map[string]any{
				"count":     len(cmds),
				"allowlist": cmds,
			})
		} else if len(m.config.Limits.PlanModeAllowedBashCommands) > 0 {
			opts.PlanModeAllowedBashCommands = m.config.Limits.PlanModeAllowedBashCommands
			utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "bash allowlist fell back to boot-cached config", map[string]any{
				"count":     len(m.config.Limits.PlanModeAllowedBashCommands),
				"allowlist": m.config.Limits.PlanModeAllowedBashCommands,
			})
		} else {
			utils.LogWithFields(utils.LevelDebug, "session.plan_mode", "no bash allowlist in engine config (Bash blocked in plan mode)", nil)
		}
	}
	if m.config.Limits.DisableTurnLimitWarning != nil && *m.config.Limits.DisableTurnLimitWarning {
		opts.DisableTurnLimitWarning = true
	}
	if m.config.Limits.DisableMaxTokenContinue != nil && *m.config.Limits.DisableMaxTokenContinue {
		opts.DisableMaxTokenContinue = true
	}
	if m.config.Limits.DisableSkillSystemPrompt != nil && *m.config.Limits.DisableSkillSystemPrompt {
		opts.DisableSkillSystemPrompt = true
	}
	if m.config.WebSearch != nil && m.config.WebSearch.Mode != "" {
		opts.WebSearchMode = m.config.WebSearch.Mode
	}
}

// resolveModelTier resolves model tier aliases (e.g. "fast" -> configured fast model)
// and populates the configured fallback chain. If the tier value in models.json
// is an object {"model": "...", "fallbacks": [...]}, the fallbacks land on
// RunOptions.FallbackChain and the retry loop walks them on overload.
func resolveModelTier(opts *types.RunOptions) {
	if opts.Model == "" {
		return
	}
	resolved, fallbacks := modelconfig.ResolveTierChain(opts.Model)
	if resolved != opts.Model {
		opts.Model = resolved
	}
	if len(fallbacks) > 0 && len(opts.FallbackChain) == 0 {
		opts.FallbackChain = fallbacks
	}
}

func finalizeSlashModelProvenance(opts *types.RunOptions, key string) {
	if opts.ResolvedSlashModelAlias == "" {
		return
	}
	opts.ResolvedSlashModelEffective = opts.Model
	utils.LogWithFields(utils.LevelInfo, "session.slash", "model provenance resolved", map[string]any{
		"session_id":  key,
		"model_alias": opts.ResolvedSlashModelAlias,
		"model":       opts.ResolvedSlashModelEffective,
	})
}

// injectContextFiles discovers Ion-native instruction files (AGENTS.md,
// ION.md, .ion/*) plus the user's ~/.ion root, and—when the session's
// ClaudeCompat flag is set—Claude-compat files (CLAUDE.md, .claude/*) and the
// ~/.claude root, then appends them to the system prompt. The gate mirrors the
// slash-command / skill subsystem: Ion roots are unconditional, Claude roots
// are honored only when the consumer enabled ClaudeCompat.
func injectContextFiles(s *engineSession, opts *types.RunOptions) {
	if s.config.WorkingDirectory == "" {
		utils.Log("Session", "injectContextFiles: skipped (empty WorkingDirectory)")
		return
	}
	// Root sessions always walk both layers; compat follows the session flag.
	// Shares the BuildContextPrompt formatter with the dispatch path so root
	// and child produce identical `# Context from <path>` framing.
	policy := ioncontext.ResolvedPolicy{
		IncludeGlobalContext:  true,
		IncludeProjectContext: true,
		ClaudeCompat:          s.config.ClaudeCompat,
	}
	content, ctxFiles := ioncontext.BuildContextPrompt(s.config.WorkingDirectory, "root", policy)
	if s.config.ClaudeCompat {
		utils.LogWithFields(utils.LevelInfo, "session", "injectcontextfiles: claudecompat=true, discovered context file(s) (ion-native + claude-compat)", map[string]any{"count": len(ctxFiles)})
	} else {
		utils.LogWithFields(utils.LevelInfo, "session", "injectcontextfiles: claudecompat=false, discovered context file(s) (ion-native only)", map[string]any{"count": len(ctxFiles)})
	}
	for _, cf := range ctxFiles {
		utils.LogWithFields(utils.LevelDebug, "session", "injectcontextfiles: including ()", map[string]any{"path": cf.Path, "source": cf.Source})
	}
	if content != "" {
		opts.AppendSystemPrompt += content
	}
}

// injectWorkspaceContext delivers workspace facts through both context hooks
// and model context. When clientCtx is non-nil the engine uses the client-
// supplied descriptor instead of its own worktree-registry lookup; otherwise
// the engine derives context from its registry (unchanged default). Hooks
// may replace or suppress the generic prose in either case.
func (m *Manager) injectWorkspaceContext(s *engineSession, key string, opts *types.RunOptions, clientCtx *types.ClientWorkspaceContext) *workspaces.PromptContext {
	if m.config != nil && !m.config.GetWorkspace().PromptContextEnabled() {
		utils.LogWithFields(utils.LevelInfo, "session.workspace_context", "workspace prompt context suppressed by config", map[string]any{"key": key})
		return nil
	}

	var workspace workspaces.PromptContext
	var text string

	if clientCtx != nil {
		workspace = workspaces.PromptContext{
			Kind:   workspaces.ContextKind(clientCtx.Kind),
			Cwd:    clientCtx.Cwd,
			Bench:  clientCtx.Bench,
			Client: clientCtx.Data,
		}
		text = clientCtx.Text
		utils.LogWithFields(utils.LevelInfo, "session.workspace_context", "using client-supplied workspace context", map[string]any{"key": key, "kind": clientCtx.Kind, "cwd": clientCtx.Cwd, "has_text": text != "", "has_bench": len(clientCtx.Bench) > 0, "has_data": len(clientCtx.Data) > 0})
	} else {
		workspace = workspaces.SharedChecker().PromptContextFor(s.config.WorkingDirectory)
		if workspace.Empty() {
			return nil
		}
		text = workspace.Format()
	}

	if s.extGroup != nil && !s.extGroup.IsEmpty() {
		ctx := m.newExtContext(s, key)
		var suppress bool
		text, suppress = s.extGroup.FireSystemInject(ctx, extension.SystemInjectInfo{
			Kind: "workspace_context", DefaultText: text, Workspace: &workspace,
		})
		if suppress {
			utils.LogWithFields(utils.LevelInfo, "session.workspace_context", "workspace prompt context suppressed by extension", map[string]any{"key": key, "kind": workspace.Kind})
			return &workspace
		}
	}
	if text != "" {
		if opts.AppendSystemPrompt != "" {
			opts.AppendSystemPrompt += "\n\n"
		}
		opts.AppendSystemPrompt += text
	}
	utils.LogWithFields(utils.LevelInfo, "session.workspace_context", "workspace prompt context delivered", map[string]any{"key": key, "kind": workspace.Kind, "chars": len(text)})
	return &workspace
}

// injectExtensionContext fires context_inject and capability injection on each host.
func (m *Manager) injectExtensionContext(s *engineSession, key string, opts *types.RunOptions, workspace *workspaces.PromptContext) {
	if s.extGroup == nil || s.extGroup.IsEmpty() {
		return
	}
	var discoveredPaths []string
	if s.config.WorkingDirectory != "" {
		cfg := ioncontext.IonPreset()
		cfg.ClaudeCompat = s.config.ClaudeCompat
		ctxFiles := ioncontext.WalkContextFiles(s.config.WorkingDirectory, cfg)
		for _, cf := range ctxFiles {
			discoveredPaths = append(discoveredPaths, cf.Path)
		}
		utils.LogWithFields(utils.LevelDebug, "session", "injectextensioncontext: , discovered path(s) for context_inject", map[string]any{"claude_compat": s.config.ClaudeCompat, "count": len(discoveredPaths)})
	}

	ctx := m.newExtContext(s, key)
	injected := s.extGroup.FireContextInject(ctx, extension.ContextInjectInfo{
		WorkingDirectory: s.config.WorkingDirectory,
		DiscoveredPaths:  discoveredPaths,
		Workspace:        workspace,
	})
	for _, entry := range injected {
		opts.AppendSystemPrompt += "\n# " + entry.Label + "\n" + entry.Content + "\n"
	}

	for _, host := range s.extGroup.Hosts() {
		sdk := host.SDK()
		toolCaps := sdk.CapabilitiesByMode(extension.CapabilityModeTool)
		for _, cap := range toolCaps {
			capCopy := cap
			opts.CapabilityTools = append(opts.CapabilityTools, types.LlmToolDef{
				Name:        cap.ID,
				Description: cap.Description,
				InputSchema: cap.InputSchema,
			})
			_ = capCopy
		}
		promptCaps := sdk.CapabilitiesByMode(extension.CapabilityModePrompt)
		var capPrompt strings.Builder
		for _, cap := range promptCaps {
			capPrompt.WriteString("\n# Capability: " + cap.Name + "\n")
			capPrompt.WriteString(cap.Prompt)
			capPrompt.WriteString("\n")
		}
		if capPrompt.Len() > 0 {
			opts.CapabilityPrompt += capPrompt.String()
		}
	}
}

// gitContextTimeout bounds the total wall-clock time git subprocesses may
// take during a single prompt dispatch. Each GetGitContext call spawns
// several git subprocesses (rev-parse, status, log); on a healthy repo
// they complete in <100ms. 5s gives generous margin for large repos or
// slow filesystems while preventing an indefinite hang.
const gitContextTimeout = 5 * time.Second

// testInjectGitContextHook is called at the start of injectGitContext when
// non-nil. Tests use it to inject delays that simulate slow git
// subprocesses without replacing the real binary. Nil in production.
var testInjectGitContextHook func()

// injectGitContext appends formatted git context to the system prompt.
// Git subprocesses are bounded by gitContextTimeout; a timeout produces
// a warning log and skips the injection rather than blocking the dispatch.
func injectGitContext(s *engineSession, opts *types.RunOptions) {
	if testInjectGitContextHook != nil {
		testInjectGitContextHook()
	}
	if s.config.WorkingDirectory == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), gitContextTimeout)
	defer cancel()
	gitCtx := gitcontext.GetGitContextWithContext(ctx, s.config.WorkingDirectory)
	if ctx.Err() != nil {
		utils.LogWithFields(utils.LevelWarn, "session", "git context timed out, skipping injection", map[string]any{
			"cwd":     s.config.WorkingDirectory,
			"timeout": gitContextTimeout.String(),
		})
		return
	}
	if gitCtx != nil {
		if formatted := gitcontext.FormatForPrompt(gitCtx); formatted != "" {
			opts.AppendSystemPrompt += "\n\n" + formatted
		}
	}
}

// injectPluginContext populates opts.InitialMessages with the plugin SessionStart
// messages so they are prepended to the provider message slice on every turn,
// matching Claude Code's hook_additional_context injection into conversation history
// (not the system prompt). The messages are already wrapped in <system-reminder>
// by loadAndWirePlugins.
func injectPluginContext(s *engineSession, opts *types.RunOptions) {
	if len(s.pluginSessionMessages) > 0 {
		opts.InitialMessages = append(opts.InitialMessages, s.pluginSessionMessages...)
	}
}
