package session

// manager_context_breakdown.go — on-demand context breakdown outside any active run.
//
// ComputeAndEmitContextBreakdown reconstructs the full assembly pipeline
// (system prompt + tool list + conversation messages) for a given session key
// and emits engine_context_breakdown exactly as the runloop would. The caller
// does not need an active run: the method mirrors the pre-prompt assembly
// steps that prompt_dispatch.go runs before every prompt, using only the
// session's persisted state and the live session fields available outside a
// run.
//
// Design notes:
//
//   - For a fresh (empty) session the conversation has no messages; the
//     breakdown shows system prompt + tools with zero conversation tokens.
//     This is the accurate pre-first-prompt view. before_prompt extension
//     injection is per-prompt and is NOT fired here — the breakdown reflects
//     capabilities as of session start.
//
//   - For a historical session conversation.Load restores the full LLM-visible
//     message list; the breakdown carries those conversation tokens.
//
//   - The emitted breakdown is reconciled against the provider's own reported
//     usage (conversation.LastAssistantUsage) before emission, mirroring what
//     backend.maybeReconcileContextBreakdown does on the in-run path's first
//     usage event. The itemized per-category sum is an independent estimate; the
//     provider's input_tokens is truth. Reconciliation records the delta as an
//     explicit "unaccounted" row and sets APIReportedTotal so a consumer can
//     always distinguish the two. A conversation with no API response yet has
//     nothing to reconcile against and emits the itemized total with
//     APIReportedTotal == 0.
//
//   - For a ClaudeCodeBackend session (nil provider) BuildContextBreakdown falls back
//     to local BPE / char4 and still emits.
//
//   - Tool list assembly mirrors wireExternalTools (same sources: built-in
//     tools.GetToolDefs() + extGroup.Tools() + mcpConns), NOT buildToolDefs
//     (which requires an activeRun). Plan-mode filtering and provider-side
//     transforms are not applied here; the raw capability set is the useful
//     signal for an on-demand breakdown.

import (
	"context"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/cost"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/session/extcontext"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// contextBreakdownSnapshot holds all session fields needed outside the lock.
type contextBreakdownSnapshot struct {
	model          string
	conversationID string
	contextWindow  int
	extGroup       *extension.ExtensionGroup
	mcpConns       []*mcp.Connection
	sessionMemory  *SessionMemory
	// RunOptions fields (from buildRunOptions without a text prompt).
	runopts types.RunOptions
}

// ComputeAndEmitContextBreakdown assembles the context breakdown for the session
// identified by key and emits it as engine_context_breakdown. It is the
// wire-protocol entrypoint for the get_context_breakdown client command.
//
// The method is intentionally outside any active run: it reconstructs every
// input to BuildContextBreakdown using the session's persisted + live state,
// then emits via the normal manager event bus so every attached consumer
// receives the event.
//
// Returns silently when no session exists for the key (a Warn log fires so an
// out-of-sync caller is visible in the engine log), matching the behavior of
// QuerySessionStatus.
func (m *Manager) ComputeAndEmitContextBreakdown(key string) {
	// --- Phase 1: snapshot all session state under the lock. ---
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		utils.LogWithFields(utils.LevelWarn, "session", "computeandemitcontextbreakdown: session not found", map[string]any{"key": key})
		return
	}

	snap := contextBreakdownSnapshot{
		model:          s.lastModel,
		conversationID: s.conversationID,
		contextWindow:  s.lastContextWindow,
		extGroup:       s.extGroup,
		mcpConns:       s.mcpConns,
		sessionMemory:  s.sessionMemory,
		runopts:        buildRunOptions(s, "", nil),
	}
	if snap.model == "" && m.config != nil {
		snap.model = m.config.DefaultModel
	}
	m.mu.RUnlock()

	utils.LogWithFields(utils.LevelInfo, "session", "computeandemitcontextbreakdown", map[string]any{"key": key, "model": snap.model, "run_id": snap.conversationID})

	// --- Phase 2: load conversation outside the lock (disk I/O). ---
	var conv *conversation.Conversation
	if snap.conversationID != "" {
		loaded, err := conversation.Load(snap.conversationID, "")
		if err != nil {
			// Non-fatal: not-found is expected for a session whose conversation
			// file has not been written yet. Use an empty conversation so the
			// breakdown reflects system + tools only.
			utils.LogWithFields(utils.LevelInfo, "session", "computeandemitcontextbreakdown: conv load: (using empty)", map[string]any{"key": key, "error": err})
			conv = conversation.CreateConversation("", "", "")
		} else {
			conv = loaded
		}
	} else {
		conv = conversation.CreateConversation("", "", "")
	}

	// --- Phase 3: inject context + assemble prompt outside the lock. ---
	opts := snap.runopts
	m.applyConfigDefaults(&opts)
	if opts.Model == "" {
		opts.Model = snap.model
	}

	// Inject context (context files, extension context, git context, memory)
	// using the same helpers prompt_dispatch uses before every prompt.
	// injectContextFiles and injectGitContext only read s.config (WorkingDirectory,
	// ClaudeCompat) and do no locking themselves, so using the snapshotted s is safe.
	m.mu.RLock()
	s, ok = m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		utils.LogWithFields(utils.LevelWarn, "session", "computeandemitcontextbreakdown: session disappeared", map[string]any{"key": key})
		return
	}
	sForInject := s
	m.mu.RUnlock()

	injectContextFiles(sForInject, &opts)
	m.injectExtensionContext(sForInject, key, &opts)
	injectGitContext(sForInject, &opts)
	injectPluginContext(sForInject, &opts)
	if snap.sessionMemory != nil {
		snap.sessionMemory.InjectMemoryIntoSystemPrompt(&opts)
	}

	// Assemble the system prompt (nil run — sparse-reminder cache path skipped,
	// which is correct for on-demand: no run is in flight).
	systemPrompt := backend.AssembleSystemPromptOnDemand(&opts, conv)

	// Assemble the tool list from live session state. Mirrors wireExternalTools
	// sources (built-in + extension + MCP) without plan-mode filtering or
	// provider-side transforms.
	toolDefs := tools.GetToolDefs()
	if snap.extGroup != nil && !snap.extGroup.IsEmpty() {
		for _, t := range snap.extGroup.Tools() {
			toolDefs = append(toolDefs, types.LlmToolDef{
				Name:         t.Name,
				Description:  t.Description,
				InputSchema:  t.Parameters,
				PlanModeSafe: t.PlanModeSafe,
			})
		}
	}
	for _, conn := range snap.mcpConns {
		for _, t := range conn.Tools() {
			toolDefs = append(toolDefs, types.LlmToolDef{
				Name:        "mcp__" + conn.Name() + "__" + t.Name,
				Description: t.Description,
				InputSchema: t.InputSchema,
			})
		}
	}

	// Build the LlmStreamOptions that BuildContextBreakdown expects.
	streamOpts := types.LlmStreamOptions{
		Model:    opts.Model,
		System:   systemPrompt,
		Messages: conv.Messages,
		Tools:    toolDefs,
	}

	// Resolve the provider. For ClaudeCodeBackend (or any path where the type assertion
	// fails) provider is nil — BuildContextBreakdown degrades to local BPE / char4.
	var provider providers.LlmProvider
	if apiBackend, ok2 := m.resolvedBackend(opts.Model).(*backend.ApiBackend); ok2 {
		provider = apiBackend.ResolveProviderOnDemand(opts.Model)
	}

	ctx := context.Background()
	bd, err := providers.BuildContextBreakdown(ctx, opts.Model, provider, &streamOpts, nil, nil, "")
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "session", "computeandemitcontextbreakdown: buildcontextbreakdown failed", map[string]any{"key": key, "error": err})
		return
	}
	if bd == nil {
		return
	}

	// Publish the engine's authoritative occupancy figure alongside the itemized
	// sum. This is the same value engine_status carries as ContextTokens and the
	// same input the compaction gate measures, so a consumer rendering "how full
	// is the context" from the breakdown lands on the identical number as one
	// rendering it from a status event.
	//
	// GetContextUsage is used rather than LastAssistantUsage below because
	// occupancy must include messages appended since the last provider response
	// (tool results from an in-flight turn). The reconciliation baseline below
	// deliberately does NOT include those — it has to match what the provider
	// actually reported — which is exactly why the two figures are separate
	// fields instead of one.
	occupancy := conversation.GetContextUsage(conv, snap.contextWindow)
	bd.SetOccupancy(occupancy.Tokens)
	utils.LogWithFields(utils.LevelInfo, "session", "computeandemitcontextbreakdown: occupancy resolved", map[string]any{
		"key": key, "run_id": snap.conversationID,
		"occupancy_tokens": occupancy.Tokens, "context_window": occupancy.Limit,
		"percent": occupancy.Percent, "estimated": occupancy.Estimated,
	})

	// Reconcile the itemized sum against the provider's own accounting before
	// emitting, exactly as the in-run path does on its first usage event (see
	// backend.maybeReconcileContextBreakdown). Without this the event carries a
	// raw itemized estimate with APIReportedTotal == 0, and no consumer can
	// tell an estimate from provider truth — which is how a 256K-token
	// conversation was reported to clients as 1.03M.
	//
	// The summation is byte-identical to the in-run path's (runloop.go): input +
	// cache_read + cache_creation is what the model actually carried.
	if usage := conversation.LastAssistantUsage(conv); usage != nil {
		apiTotal := usage.InputTokens + usage.CacheReadInputTokens + usage.CacheCreationInputTokens
		itemized := bd.TotalTokens
		providers.ReconcileBreakdown(bd, apiTotal, usage.CacheReadInputTokens, usage.CacheCreationInputTokens)
		utils.LogWithFields(utils.LevelInfo, "session", "computeandemitcontextbreakdown: reconciled against provider usage", map[string]any{
			"key": key, "run_id": snap.conversationID,
			"itemized_total": itemized, "api_reported_total": apiTotal,
			"unaccounted": bd.Unaccounted,
		})
	} else {
		// Expected for a conversation with no API response yet (a fresh session,
		// or one whose only turns came from a backend that reports no usage).
		// The itemized sum is the only figure available; leaving
		// APIReportedTotal zero is the honest signal that nothing reconciled it.
		utils.LogWithFields(utils.LevelInfo, "session", "computeandemitcontextbreakdown: no persisted assistant usage, emitting unreconciled itemized total", map[string]any{
			"key": key, "run_id": snap.conversationID, "itemized_total": bd.TotalTokens,
		})
	}

	// Compute aggregate cost: this session + all descendant dispatches,
	// with per-model breakdown for cost visibility.
	liveIDs := m.liveChildConvIDs(key)
	aggregateCost, modelBreakdown, err := cost.ConversationCostBreakdown(snap.conversationID, liveIDs, "")
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "session", "computeandemitcontextbreakdown: aggregate cost failed", map[string]any{"key": key, "error": err})
	}

	utils.LogWithFields(utils.LevelInfo, "session", "computeandemitcontextbreakdown: emitting", map[string]any{
		"key": key, "model": opts.Model, "count": len(bd.Categories), "count_3": bd.TotalTokens,
		"api_reported_total": bd.APIReportedTotal, "unaccounted": bd.Unaccounted,
		"aggregate_cost": aggregateCost,
	})

	bdEvent := bd.ToNormalizedEvent()
	if bdEvent != nil {
		bdEvent.AggregateCostUsd = aggregateCost
		bdEvent.ModelBreakdown = modelBreakdown
	}
	engineEvent := translateToEngineEvent(types.NormalizedEvent{Data: bdEvent}, snap.contextWindow)
	m.emit(key, engineEvent)
}

// liveChildConvIDs returns the conversation IDs of all in-flight background
// dispatches for the session identified by key. Called without the manager
// lock; reads only the session's dispatchRegistry.
func (m *Manager) liveChildConvIDs(key string) []string {
	m.mu.RLock()
	s, ok := m.sessions[key]
	var registry *extcontext.DispatchRegistry
	if ok {
		registry = s.dispatchRegistry
	}
	m.mu.RUnlock()

	if registry == nil {
		return nil
	}
	return registry.LiveConvIDs()
}
