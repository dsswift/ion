package backend

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/config"
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
// result drives both the plan-mode instruction prose
// (`buildPlanModePrompt`) and the plan policy's Bash rule
// (`run.planModeAllowedBashCommands`, read by `PlanPolicy.Decide`).
//
// Crucially this function returns a new slice — neither input is
// mutated, and the session-level `engineSession.planModeAllowedBashCommands`
// is never touched. The per-prompt additions live for exactly one
// run; the engine drops them when the activeRun goroutine ends and
// they have no effect on subsequent prompts in the same session.
// See docs/protocol/client-commands.md § set_plan_mode for the
// three-layer configuration model (engine config → session override
// → per-prompt additions).
//
// The union is then clamped to the enterprise ceiling. This is the single gate
// where all three sources are bounded: the engine.json layer is already capped
// during the config merge, but the session override and per-prompt additions
// arrive from a client and never pass through a config merge at all. Clamping
// here rather than at each source means a new caller cannot forget the check.
// Absent an enterprise policy the clamp is a pass-through, so an unmanaged
// machine keeps the full union (see docs/enterprise/sealed-config.md
// § "Plan-mode Bash allowlist").
func effectiveBashAllowlist(opts types.RunOptions) []string {
	return config.ClampPlanModeBashToEnterprise(unionPromptBashAllowlist(opts), opts.Principal)
}

// unionPromptBashAllowlist computes the un-clamped union of the session
// allowlist and any per-prompt additions. Split out from
// effectiveBashAllowlist so the union logic stays independently testable from
// the enterprise clamp applied on top of it.
func unionPromptBashAllowlist(opts types.RunOptions) []string {
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

func effectiveMcpAllowlist(opts types.RunOptions) []string {
	seen := make(map[string]struct{}, len(opts.PlanModeAllowedMcpTools)+len(opts.McpAllowlistAdditionsForThisPrompt))
	var tools []string
	for _, list := range [][]string{opts.PlanModeAllowedMcpTools, opts.McpAllowlistAdditionsForThisPrompt} {
		for _, tool := range list {
			if _, ok := seen[tool]; !ok {
				seen[tool] = struct{}{}
				tools = append(tools, tool)
			}
		}
	}
	return config.ClampPlanModeMcpToolsToEnterprise(tools, opts.Principal)
}

func mcpToolAllowed(name string, allowlist []string) bool {
	for _, allowed := range allowlist {
		if name == allowed || strings.HasPrefix(name, allowed+"__") {
			return true
		}
	}
	return false
}

// resolveProvider resolves the provider for the given model. Returns nil if
// no provider supports the model.
//
// This no longer writes a process-global provider key: the acting
// principal's authenticator is attached to the request context by
// resolveProviderAndAttachAuth (below), which every call site on the live
// run path uses instead. This unexported helper survives only for
// ResolveProviderOnDemand, an on-demand token-counting path with no request
// credential in play (see manager_context_breakdown.go).
func (b *ApiBackend) resolveProvider(model string) providers.LlmProvider {
	p := providers.ResolveProvider(model)
	providerName := providers.ProviderNameForModel(model)
	if p != nil {
		utils.LogWithFields(utils.LevelDebug, "backend.runloop", "resolve provider on-demand", map[string]any{
			"model": model, "provider": p.ID(), "name_for_model": providerName,
		})
	} else {
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "resolve provider on-demand: no match", map[string]any{
			"model": model, "name_for_model": providerName,
		})
	}
	return p
}

// resolveProviderAndAttachAuth resolves the provider for model and resolves
// the acting principal's authenticator for that provider, attaching it to
// the returned context via providers.WithRequestCredential.
//
// cc non-nil is the normal live-run path: the session layer always builds
// one per run (session.wireCredentialContext), attributed or not, so its
// Authenticator already falls through to the resolver's process-wide levels
// for an unattributed principal (R-10) or one that lacks its own credential
// under an allow-fall-through policy (child 04).
//
// cc nil is a defensive fallback for a call site that predates
// CredentialContext wiring (a test harness, an isolated RunConfig): it
// builds an unattributed context directly from b.authResolver so the
// request-credential path is exercised exactly the same way rather than
// silently sending an unauthenticated request.
func (b *ApiBackend) resolveProviderAndAttachAuth(ctx context.Context, model string, cc *auth.CredentialContext) (providers.LlmProvider, context.Context) {
	p := providers.ResolveProvider(model)
	if p == nil {
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "resolve provider: no match", map[string]any{"model": model})
		return nil, ctx
	}
	providerName := p.ID()
	if cc == nil {
		b.mu.Lock()
		authRes := b.authResolver
		b.mu.Unlock()
		if authRes == nil {
			utils.LogWithFields(utils.LevelDebug, "backend.runloop", "resolve provider: no credential context and no auth resolver", map[string]any{
				"model": model, "provider": providerName,
			})
			return p, ctx
		}
		cc = auth.NewCredentialContext(nil, authRes, nil)
	}
	a, err := cc.Authenticator(ctx, providerName)
	if err != nil {
		if errors.Is(err, auth.ErrPrincipalCredentialUnresolved) {
			// Mark the context so applyRequestAuth refuses at the actual
			// request-building point, pre-request (SC-4, R-07, R-22) --
			// rather than only here, which would let a custom-base-url
			// gateway proceed keyless (requireKeyForHost never gates those).
			utils.LogWithFields(utils.LevelInfo, "backend.runloop", "principal credential refused", map[string]any{
				"provider": providerName, "subject": cc.Subject(),
			})
			return p, providers.WithCredentialRefusal(ctx, cc.Subject())
		}
		// Any other source failure surfaces here. Do not abort resolution:
		// applyRequestAuth on the request path makes the authoritative
		// pre-request decision (fail fast on a key-required host, or proceed
		// keyless for a legitimately keyless custom base URL). Logging here
		// is purely diagnostic.
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "no request credential", map[string]any{
			"provider": providerName, "subject": cc.Subject(), "error": err.Error(),
		})
		return p, ctx
	}
	if a == nil {
		utils.LogWithFields(utils.LevelDebug, "backend.runloop", "no request credential", map[string]any{
			"provider": providerName, "subject": cc.Subject(),
		})
		return p, ctx
	}
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "request credential attached", map[string]any{
		"provider": providerName, "subject": cc.Subject(),
	})
	return p, providers.WithRequestCredential(ctx, a)
}

// loadOrCreateConversation returns an existing conversation when ConversationID
// resolves to one on disk, otherwise creates a new conversation with a
// timestamp+random suffix id that cannot collide with same-millisecond peers.
// When ConversationID is non-empty and Load fails with a non-not-found error
// (corrupt file, permission denied, etc.), the error is returned instead
// of silently creating a replacement — this prevents overwriting existing
// conversation files on transient read failures.
// Every conversation this seam returns is stamped Backend="api": only the
// API backend persists to the Ion conversation store (delegated-CLI backends
// keep their own stores), so the discriminator is a fact of this call site.
// Loaded legacy files with no backend header are backfilled and heal on the
// next Save.
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
				created.Backend = "api"
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
				stampPrincipalAtMint(created, opts.Principal)
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
		if loaded.Backend == "" {
			loaded.Backend = "api"
		}
		// First-touch backfill: a conversation that predates this feature (or
		// was never attributed) has no header principal. If this session
		// carries one, stamp it now rather than leaving the header
		// permanently unowned -- but only on first touch (loaded.Principal
		// is nil); an existing header's owner is never overwritten by a
		// later session that attaches a different principal (see the
		// "principal mismatch" WARN in session/start_session.go).
		stampPrincipalAtMint(loaded, opts.Principal)
		return loaded, nil
	}
	// Use the canonical conversation ID generator so two runs that begin
	// in the same millisecond cannot collide on the conversation file.
	created := conversation.CreateConversation(
		conversation.NewConversationID(),
		opts.SystemPrompt,
		model,
	)
	created.Backend = "api"
	if opts.ParentConversationID != "" {
		created.ParentID = opts.ParentConversationID
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "new conversation descends from", map[string]any{
			"id":        created.ID,
			"parent_id": opts.ParentConversationID,
		})
	}
	stampPrincipalAtMint(created, opts.Principal)
	return created, nil
}

// stampPrincipalAtMint writes conv.Principal from principal when the header
// carries no owner yet. A no-op when principal is nil (session attributed
// nothing) or the header already has an owner (never overwritten, matching
// the manifest's "backfill by first touch only" contract). When the header
// already has a DIFFERENT owner than the session's principal, the header
// keeps its owner and the mismatch is logged at WARN -- the session's turns
// still attribute to the session's own principal via RunOptions.Principal,
// but the durable header is never silently reassigned.
func stampPrincipalAtMint(conv *conversation.Conversation, principal *types.SessionPrincipal) {
	if conv == nil || principal == nil {
		return
	}
	if conv.Principal == nil {
		conv.Principal = principal.ToConversation()
		return
	}
	if conv.Principal.Subject != principal.Subject {
		utils.LogWithFields(utils.LevelWarn, "backend.runloop", "principal mismatch", map[string]any{
			"conversation_id": conv.ID,
			"header_subject":  conv.Principal.Subject,
			"session_subject": principal.Subject,
		})
	}
}

// buildSystemPrompt assembles the final system prompt for a run, layering in
// before_prompt hook contributions and the capability prompt. May rewrite
// opts.Prompt as a side effect when a hook returns a non-empty replacement.
//
// Nothing here depends on the run's mode. Plan-mode instructions are delivered
// as notices in the conversation (plan_mode_notice.go), because the system
// prompt is part of the provider's cached prefix and must not change when the
// mode does.
func buildSystemPrompt(opts *types.RunOptions, conv *conversation.Conversation, hooks RunHooks, requestID string) string {
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

	// Skill availability is a conversation-scoped typed announcement injected
	// by runLoop once and then only for deltas. Do not rebuild a full listing in
	// every run's system prompt: it wastes context and differs from Claude Code.
	// The config and system_inject seam are applied at that announcement site.

	return systemPrompt
}

// buildToolDefs assembles the tool list for a run: built-in tools plus
// external/MCP tools plus capability tools plus the engine sentinels, then
// applies the allowed/suppressed filters and the provider-side WebSearch swap.
// Returns the final tool definitions and any provider server-side tool
// descriptors.
//
// The result does not depend on the run's mode. See the sentinel block below.
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

	// Plan-mode sentinels, in every mode. The tool list is part of the
	// provider's cached prefix, so it must not depend on whether the run is
	// planning, in auto mode, or implementing an approved plan. What a call to
	// either sentinel does in the run's current mode is decided when it is
	// called (interceptEnterPlanMode / interceptExitPlanMode), and the
	// read-only boundary is the plan policy (plan_policy.go), not this list.
	//
	// The EnterPlanMode description is harness-supplied prose when present,
	// else the engine's one-line default (ADR-004).
	exitPlanDef := tools.ExitPlanModeTool()
	toolDefs = append(toolDefs, types.LlmToolDef{
		Name:        exitPlanDef.Name,
		Description: exitPlanDef.Description,
		InputSchema: exitPlanDef.InputSchema,
	})
	enterPlanDef := tools.EnterPlanModeToolWithDescription(opts.EnterPlanModeDescription)
	toolDefs = append(toolDefs, types.LlmToolDef{
		Name:        enterPlanDef.Name,
		Description: enterPlanDef.Description,
		InputSchema: enterPlanDef.InputSchema,
	})

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

	sortToolDefs(toolDefs)
	return toolDefs, serverTools
}

// AssembleSystemPromptOnDemand assembles the system prompt outside of an active
// run. Exported so the session layer can reconstruct the prompt for on-demand
// operations (e.g. ComputeAndEmitContextBreakdown) without a live activeRun.
func AssembleSystemPromptOnDemand(opts *types.RunOptions, conv *conversation.Conversation) string {
	return buildSystemPrompt(opts, conv, RunHooks{}, "on-demand")
}

// ResolveProviderOnDemand resolves the provider for the given model and returns
// it. Exported thin wrapper around the unexported resolveProvider, used by the
// session layer for on-demand operations (ComputeAndEmitContextBreakdown) that
// need a provider reference without a live activeRun.
func (b *ApiBackend) ResolveProviderOnDemand(model string) providers.LlmProvider {
	return b.resolveProvider(model)
}

// attachAuthFor builds the credential-attachment hook titling.GenerateTitleFor
// Principal / compaction.SummarizeForPrincipal take, so an in-run titling or
// compaction call authenticates as the SAME acting principal as the run's own
// provider calls (R-11), rather than the process-wide fallback. cc nil (an
// unattributed run, or a call site with no CredentialContext) returns nil,
// which both callers treat as "no credential attachment" -- falling through
// to whatever the provider's own request-time resolution does.
func attachAuthFor(cc *auth.CredentialContext) func(ctx context.Context, providerID string) context.Context {
	if cc == nil {
		return nil
	}
	return func(ctx context.Context, providerID string) context.Context {
		a, err := cc.Authenticator(ctx, providerID)
		if err != nil {
			if errors.Is(err, auth.ErrPrincipalCredentialUnresolved) {
				utils.LogWithFields(utils.LevelInfo, "backend.runloop", "principal credential refused for titling/compaction", map[string]any{
					"provider": providerID, "subject": cc.Subject(),
				})
				return providers.WithCredentialRefusal(ctx, cc.Subject())
			}
			utils.LogWithFields(utils.LevelInfo, "backend.runloop", "no request credential for titling/compaction", map[string]any{
				"provider": providerID, "subject": cc.Subject(), "error": err.Error(),
			})
			return ctx
		}
		if a == nil {
			return ctx
		}
		return providers.WithRequestCredential(ctx, a)
	}
}
