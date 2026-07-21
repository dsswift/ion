package session

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/compaction"
	ionconfig "github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/plugins"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// buildRunConfig assembles the per-run RunConfig that travels with the run on
// the API backend. Each session's hooks/perm engine/external tools/agent
// spawner live on the run, never on shared backend state.
func (m *Manager) buildRunConfig(
	s *engineSession,
	key string,
	requestID string,
	apiBackend *backend.ApiBackend,
	extGroup *extension.ExtensionGroup,
	skipExtensions bool,
	permEng *permissions.Engine,
	telemCollector *telemetry.Collector,
	mcpConns []*mcp.Connection,
	currentModel string,
) *backend.RunConfig {
	runCfg := &backend.RunConfig{}

	// Thread the engine's default model so the run loop can fall back
	// when a requested model doesn't resolve (e.g. unrecognized tier alias).
	if m.config != nil && m.config.DefaultModel != "" {
		runCfg.DefaultModel = m.config.DefaultModel
	}

	// Thread timeouts config into the run so tool execution and the run loop
	// can read configured values.
	if m.config != nil && m.config.Timeouts != nil {
		runCfg.Timeouts = m.config.Timeouts
	}

	// Thread shell config so the Bash tool can run commands through the user's
	// login shell when EngineRuntimeConfig.Shell.UseLoginShell is set. Nil
	// leaves the default non-login bash -c path.
	if m.config != nil && m.config.Shell != nil {
		runCfg.Shell = m.config.Shell
	}

	// Thread the early-stop continuation config so the runloop can resolve
	// engine.json defaults. Nil here means "use built-in defaults" — the
	// runloop falls back via types.EarlyStopDefaults().
	if m.config != nil && m.config.EarlyStopContinue != nil {
		runCfg.EarlyStopContinue = m.config.EarlyStopContinue
	}

	// Thread the plan-mode auto-exit safety-net setting from engine.json
	// (LimitsConfig.PlanModeAutoExitOnEndTurn) so the runloop can resolve
	// it without reaching back to the full engine config. Nil means
	// "use the built-in default (true)" — see resolvePlanModeAutoExit
	// in engine/internal/backend/runloop_plan_mode_auto_exit.go.
	if m.config != nil && m.config.Limits.PlanModeAutoExitOnEndTurn != nil {
		runCfg.PlanModeAutoExitOnEndTurn = m.config.Limits.PlanModeAutoExitOnEndTurn
	}

	// Thread the max_tokens thinking-only circuit-breaker cap from engine.json
	// (LimitsConfig.MaxTokenThinkingOnlyBreaker) so the runloop can resolve it
	// without reaching back to the full engine config. Zero means "use the
	// built-in default (3)"; -1 disables the breaker. See the max_tokens case in
	// engine/internal/backend/runloop.go.
	if m.config != nil && m.config.Limits.MaxTokenThinkingOnlyBreaker != 0 {
		runCfg.MaxTokenThinkingOnlyBreaker = m.config.Limits.MaxTokenThinkingOnlyBreaker
	}

	// Thread tool-result size cap from engine.json compaction config so the
	// runloop can persist oversized tool results to disk.
	if m.config != nil && m.config.Compaction != nil && m.config.Compaction.MaxToolResultChars > 0 {
		runCfg.MaxToolResultChars = m.config.Compaction.MaxToolResultChars
	}

	if permEng != nil {
		runCfg.PermEngine = permEng
	}
	if m.config != nil && m.config.Security != nil {
		runCfg.SecurityCfg = m.config.Security
	}

	// G07/D-009: Enterprise tool restrictions apply to EVERY session
	// unconditionally — enterprise policy is not an extension concern, so
	// the check is installed here rather than inside wireExtensionHooks.
	// A plain (extension-less) conversation gets the same tool gate as a
	// harness conversation. When an extension group attaches below,
	// wireExtensionHooks WRAPS this callback: the enterprise check runs
	// first, extension hooks second — an extension can be stricter than
	// enterprise policy but can never override an enterprise block.
	if m.config != nil && m.config.Enterprise != nil {
		capturedEnterprise := m.config.Enterprise
		runCfg.Hooks.OnToolCall = func(info backend.ToolCallInfo) (*backend.ToolCallResult, error) {
			if !ionconfig.IsToolAllowed(info.ToolName, capturedEnterprise) {
				utils.LogWithFields(utils.LevelInfo, "session", "enterprise policy blocked tool call", map[string]any{"key": key, "tool": info.ToolName})
				return &backend.ToolCallResult{Block: true, Reason: "tool blocked by enterprise policy"}, nil
			}
			return nil, nil
		}
	}

	if extGroup != nil && !extGroup.IsEmpty() && !skipExtensions {
		m.wireExtensionHooks(s, key, requestID, apiBackend, extGroup, runCfg, currentModel)
	}

	// Wire plugin UserPromptSubmit hooks via OnInitialMessages so their output
	// is injected as <system-reminder> user messages in the conversation history
	// rather than appended to the system prompt. This matches Claude Code's
	// hook_additional_context mechanism: per-turn hook output lands at the top
	// of the message history before each LLM call, giving it full attention
	// weight regardless of system prompt length.
	//
	// OnBeforePrompt is left solely for extension hooks (TS/Go SDK) — plugin
	// hooks use the parallel OnInitialMessages path to keep the two surfaces
	// cleanly separated.
	if len(s.pluginUserPromptHooks) > 0 {
		capturedPluginHooks := s.pluginUserPromptHooks
		runCfg.Hooks.OnInitialMessages = func(runID string, prompt string) []types.LlmMessage {
			// Build the Claude Code UserPromptSubmit stdin payload.
			stdinPayload := buildPromptStdinPayload(prompt)
			var msgs []types.LlmMessage
			for _, cmd := range capturedPluginHooks {
				out, hookErr := plugins.RunHookCommandWithStdin(cmd.Entry, cmd.PluginRoot, nil, stdinPayload)
				if hookErr == nil {
					if ctx := plugins.ParseHookOutput(out); ctx != "" {
						msgs = append(msgs, types.LlmMessage{
							Role:    "user",
							Content: wrapInSystemReminder("UserPromptSubmit hook additional context: " + ctx),
						})
					}
				}
			}
			return msgs
		}
	}

	if telemCollector != nil {
		runCfg.Telemetry = &telemetryAdapter{c: telemCollector}
	}

	m.wireExternalTools(s, key, extGroup, mcpConns, runCfg)
	// Pass extGroup to the spawner so it can fire agent_start / agent_end on
	// the parent extension host. When the caller opted out of extensions
	// (skipExtensions), pass nil so the spawner's own guard short-circuits
	// the fires -- mirroring how wireExtensionHooks above is gated.
	spawnerExtGroup := extGroup
	if skipExtensions {
		spawnerExtGroup = nil
	}
	m.wireAgentSpawner(s, key, currentModel, spawnerExtGroup, runCfg)

	// Wire session memory getter so compaction can use the pre-built
	// summary as a zero-cost alternative to LLM summarization.
	if s.sessionMemory != nil {
		sm := s.sessionMemory
		runCfg.GetSessionMemory = sm.GetMemory
		runCfg.GetLastSummarizedEntryID = sm.GetLastSummarizedEntryID
		runCfg.ResetMemoryTracking = func(tokens int) {
			sm.ResetUpdateTracking(tokens, sm.GetLastUpdateTurn())
		}
	}

	// Wire OnPlanModeEnter unconditionally: it calls RequestPlanModeEnter on
	// the manager which handles hook dispatch and session-state flipping
	// internally. This callback is always needed so the runloop interception
	// can approve/deny the model's EnterPlanMode tool call even when no
	// extension group is attached (default: auto-approve).
	capturedKey := key
	runCfg.Hooks.OnPlanModeEnter = func() (bool, string, string) {
		return m.RequestPlanModeEnter(capturedKey)
	}

	// Wire OnPlanModeExit: fires before_plan_mode_exit hook so extensions can
	// veto the model's ExitPlanMode call (e.g. to require more planning).
	// Default when no extensions: auto-allow.
	runCfg.Hooks.OnPlanModeExit = func(planFilePath string) (bool, string) {
		return m.RequestPlanModeExit(capturedKey, planFilePath)
	}

	// Wire OnPlanModeAutoExit: fires before_plan_mode_auto_exit hook so
	// extensions can observe, suppress, or override the runloop's
	// end-of-turn ExitPlanMode synthesis (issue #187). Default when no
	// extensions: no opinion (proceed with the engine's defaults). The
	// translation from backend.PlanModeAutoExitHookInfo to
	// extension.BeforePlanModeAutoExitInfo is a one-for-one field copy —
	// they have identical shape; the duplication exists because the
	// backend package deliberately does not import extension.
	runCfg.Hooks.OnPlanModeAutoExit = func(info backend.PlanModeAutoExitHookInfo) (bool, string, string) {
		return m.RequestPlanModeAutoExit(capturedKey, extension.BeforePlanModeAutoExitInfo{
			SessionID:     info.SessionID,
			RunID:         info.RunID,
			StopReason:    info.StopReason,
			PlanFilePath:  info.PlanFilePath,
			AssistantText: info.AssistantText,
			EmittedTools:  info.EmittedTools,
		})
	}

	// Wire GetSessionPlanFilePath: lets the ExitPlanMode interception resolve
	// the session-level planFilePath when the run's own planFilePath is empty.
	// This covers the case where the model calls ExitPlanMode in a non-plan-mode
	// run (prompt-level plan mode) after a prior plan-mode session set the path.
	runCfg.Hooks.GetSessionPlanFilePath = func() string {
		_, path := m.GetPlanModeState(capturedKey)
		return path
	}

	return runCfg
}

// wireExtensionHooks wires per-run extension hook callbacks into runCfg.Hooks.
func (m *Manager) wireExtensionHooks(s *engineSession, key string, requestID string, apiBackend *backend.ApiBackend, extGroup *extension.ExtensionGroup, runCfg *backend.RunConfig, currentModel string) {
	capturedRequestID := requestID
	ctx := m.newExtContext(s, key)
	// Populate ctx.Model with the SELECTED model so model-aware hooks on the
	// ApiBackend path (notably before_prompt via OnBeforePrompt below) can read
	// ctx.model. currentModel is the routed model threaded from buildRunConfig
	// (opts.Model at the dispatch site, post model_select).
	ctx.Model = modelRefFor(currentModel)
	ctx.GetContextUsage = func() *extension.ContextUsage {
		usage := apiBackend.GetContextUsage(capturedRequestID)
		if usage == nil {
			return nil
		}
		return &extension.ContextUsage{
			Percent: usage.Percent,
			Tokens:  usage.Tokens,
		}
	}
	// Reads the live run turn at hook-fire time, so callHook can attribute the
	// firing turn on each extension.hook_latency event. Mirrors GetContextUsage:
	// a closure over the backend accessor keyed by the captured request ID.
	ctx.GetTurn = func() int64 {
		return apiBackend.GetCurrentTurn(capturedRequestID)
	}

	// Compose with the base OnToolCall installed by buildRunConfig (the
	// unconditional enterprise tool gate, D-009). Evaluation order:
	// enterprise policy first, extension hooks second. Either layer blocking
	// blocks the call — an extension can be stricter than enterprise policy,
	// never more permissive. baseToolCall is nil when no enterprise config
	// is loaded; the extension hooks then run alone.
	baseToolCall := runCfg.Hooks.OnToolCall
	runCfg.Hooks.OnToolCall = func(info backend.ToolCallInfo) (*backend.ToolCallResult, error) {
		if baseToolCall != nil {
			result, err := baseToolCall(info)
			if err != nil {
				return nil, err
			}
			if result != nil && result.Block {
				return result, nil
			}
		}
		result, err := extGroup.FireToolCall(ctx, extension.ToolCallInfo{
			ToolName: info.ToolName,
			ToolID:   info.ToolID,
			Input:    info.Input,
		})
		if err != nil {
			return nil, err
		}
		if result != nil && result.Block {
			return &backend.ToolCallResult{Block: true, Reason: result.Reason}, nil
		}
		return nil, nil
	}

	runCfg.Hooks.OnPerToolHook = func(toolName string, info interface{}, phase string) (interface{}, error) {
		if phase == "before" {
			return extGroup.FirePerToolCall(ctx, toolName, info)
		}
		return extGroup.FirePerToolResult(ctx, toolName, info)
	}

	runCfg.Hooks.OnTurnStart = func(_ string, turnNum int) {
		extGroup.FireTurnStart(ctx, extension.TurnInfo{TurnNumber: turnNum})
		// Fire task_created in tandem with turn_start so the hook surface
		// is consistent across backends. The CLI backend fires both from
		// fireCliTurnHooks (see event_translation.go); the ApiBackend
		// path mirrors that here using the same TaskID format
		// (<session-key>-t<turn-number>) so external consumers observe
		// identical TaskIDs regardless of which backend serviced the run.
		taskID := fmt.Sprintf("%s-t%d", key, turnNum)
		utils.LogWithFields(utils.LevelDebug, "session", "apibackend onturnstart: task_created", map[string]any{"run_id": taskID, "turn": turnNum})
		extGroup.FireTaskCreated(ctx, extension.TaskLifecycleInfo{ //nolint:errcheck // errors logged internally by fireVoid/s.fire
			TaskID: taskID,
			Name:   fmt.Sprintf("turn-%d", turnNum),
			Status: "running",
		})
	}
	runCfg.Hooks.OnTurnEnd = func(_ string, turnNum int) {
		extGroup.FireTurnEnd(ctx, extension.TurnInfo{TurnNumber: turnNum})
		// Fire task_completed at turn end. Same TaskID format as the
		// matching task_created above.
		taskID := fmt.Sprintf("%s-t%d", key, turnNum)
		utils.LogWithFields(utils.LevelDebug, "session", "apibackend onturnend: task_completed", map[string]any{"run_id": taskID, "turn": turnNum})
		extGroup.FireTaskCompleted(ctx, extension.TaskLifecycleInfo{ //nolint:errcheck // errors logged internally by fireVoid/s.fire
			TaskID: taskID,
			Name:   fmt.Sprintf("turn-%d", turnNum),
			Status: "completed",
		})

		// Trigger background session memory update if wired. The session
		// memory debounces internally (turn count + token growth), so this
		// fires on every turn but only produces work when thresholds are met.
		if s.sessionMemory != nil {
			if conv := apiBackend.GetConversation(capturedRequestID); conv != nil {
				s.sessionMemory.OnTurnEnd(conv, turnNum)
			}
		}
	}

	// Translate the backend's BeforeProviderRequestInfo into the extension
	// layer's identically-shaped struct and fan out to every host. The two
	// types are intentionally separate so the backend can stay unaware of the
	// extension package; if a field is added on one side and not the other,
	// the build breaks here, which is the desired loud-failure mode.
	runCfg.Hooks.OnBeforeProviderRequest = func(_ string, info backend.BeforeProviderRequestInfo) {
		utils.LogWithFields(utils.LevelInfo, "session", "onbeforeproviderrequest", map[string]any{"provider": info.Provider, "model": info.Model, "turn_number": info.TurnNumber, "message_count": info.MessageCount, "tool_count": info.ToolCount, "has_system_prompt": info.HasSystemPrompt, "max_tokens": info.MaxTokens})
		extGroup.FireBeforeProviderRequest(ctx, extension.BeforeProviderRequestInfo{
			Provider:        info.Provider,
			Model:           info.Model,
			TurnNumber:      info.TurnNumber,
			MessageCount:    info.MessageCount,
			ToolCount:       info.ToolCount,
			HasSystemPrompt: info.HasSystemPrompt,
			MaxTokens:       info.MaxTokens,
		})
	}

	runCfg.Hooks.OnBeforePrompt = func(_ string, prompt string) (string, string) {
		rewritten, sysPrompt, _ := extGroup.FireBeforePrompt(ctx, prompt) //nolint:errcheck // errors logged internally by fireVoid/s.fire
		return rewritten, sysPrompt
	}

	runCfg.Hooks.OnPlanModePrompt = func(planFilePath string) (string, []string, string) {
		return extGroup.FirePlanModePrompt(ctx, planFilePath)
	}

	runCfg.Hooks.OnSystemInject = func(kind, defaultText string, turn, maxTurns int) (string, bool) {
		return extGroup.FireSystemInject(ctx, extension.SystemInjectInfo{
			Kind:        kind,
			DefaultText: defaultText,
			Turn:        turn,
			MaxTurns:    maxTurns,
		})
	}

	// Early-stop continuation hooks. Two-way translation between the
	// backend-layer EarlyStopDecisionInfo/Result and the extension-layer
	// shapes mirrors the BeforeProviderRequestInfo pattern above: the
	// backend deliberately does not import extension, so structs are
	// duplicated and translated here. If a field is added on one side and
	// not the other, the build breaks at this call site.
	//
	// Resolution order INSIDE the callback (most specific first):
	//  1. Subprocess extension hook (extGroup.FireBeforeEarlyStopDecision).
	//     Used when the consumer ships a TS/Go SDK extension.
	//  2. Wire-protocol request (Manager.requestEarlyStopDecisionViaWire).
	//     Emits engine_early_stop_decision_request, blocks briefly on the
	//     consumer's early_stop_decision_response command. Used by
	//     socket-only harnesses that participate in this
	//     hook without running a subprocess extension.
	//  3. Nil (no opinion) — engine's existing merge logic proceeds with
	//     engine.json + RunOptions defaults. Without a ContinueMessage from
	//     any of these layers, the no-message skip in maybeContinueEarlyStop
	//     causes the run to complete normally.
	capturedKey := key
	runCfg.Hooks.OnBeforeEarlyStopDecision = func(info backend.EarlyStopDecisionInfo) *backend.EarlyStopDecisionResult {
		extInfo := extension.EarlyStopDecisionInfo{
			RunID:                  info.RunID,
			Model:                  info.Model,
			TurnNumber:             info.TurnNumber,
			StopReason:             info.StopReason,
			CumulativeOutputTokens: info.CumulativeOutputTokens,
			Budget:                 info.Budget,
			ThresholdPct:           info.ThresholdPct,
			ContinuationCount:      info.ContinuationCount,
			MaxContinuations:       info.MaxContinuations,
			LastContinuationDelta:  info.LastContinuationDelta,
			WouldContinue:          info.WouldContinue,
			IsSubagent:             info.IsSubagent,
		}
		if res := extGroup.FireBeforeEarlyStopDecision(ctx, extInfo); res != nil {
			return &backend.EarlyStopDecisionResult{
				ForceContinue:        res.ForceContinue,
				OverrideBudget:       res.OverrideBudget,
				OverrideThresholdPct: res.OverrideThresholdPct,
				ContinueMessage:      res.ContinueMessage,
			}
		}
		// Extension said nothing decisive — fan out to the wire protocol
		// so socket-only consumers can participate.
		return m.requestEarlyStopDecisionViaWire(capturedKey, info)
	}
	runCfg.Hooks.OnEarlyStopContinued = func(info backend.EarlyStopContinuedInfo) {
		extGroup.FireEarlyStopContinued(ctx, extension.EarlyStopContinuedInfo{
			RunID:                  info.RunID,
			TurnNumber:             info.TurnNumber,
			ContinuationCount:      info.ContinuationCount,
			Pct:                    info.Pct,
			CumulativeOutputTokens: info.CumulativeOutputTokens,
			Budget:                 info.Budget,
			InjectedText:           info.InjectedText,
		})
	}

	runCfg.Hooks.OnSessionBeforeCompact = func(_ string) bool {
		cancel, _ := extGroup.FireSessionBeforeCompact(ctx, extension.CompactionInfo{}) //nolint:errcheck // errors logged internally by fireVoid/s.fire
		return cancel
	}
	runCfg.Hooks.OnRequestCompactSummary = func(_ string, strategy string, messages []types.LlmMessage) (string, bool) {
		// Fan out to the extension group. The hook is observe+respond:
		// returning ("", false) means "no opinion", which the runloop
		// reads as a signal to fall back to the regex fact extractor.
		// Strategy is "auto" (proactive token-limit driven) or "reactive"
		// (prompt_too_long retry) — handlers branch on it to tune their
		// summariser to the trigger (e.g. shorter output on reactive
		// because the provider just rejected the prompt).
		summary, ok := extGroup.FireCompactSummaryRequest(ctx, extension.CompactSummaryRequestInfo{
			Strategy:     strategy,
			MessageCount: len(messages),
			Messages:     messages,
		})
		utils.LogWithFields(utils.LevelDebug, "session", "compact_summary_request bridge", map[string]any{"strategy": strategy, "count": len(messages), "ok": ok, "count_3": len(summary)})
		return summary, ok
	}
	runCfg.Hooks.OnSessionCompact = func(_ string, info interface{}) {
		if ci, ok := info.(map[string]interface{}); ok {
			payload := extension.CompactionInfo{
				Strategy:         fmt.Sprintf("%v", ci["strategy"]),
				MessagesBefore:   toInt(ci["messagesBefore"]),
				MessagesAfter:    toInt(ci["messagesAfter"]),
				TokensBefore:     toInt(ci["tokensBefore"]),
				TokenLimit:       toInt(ci["tokenLimit"]),
				TargetTokens:     toInt(ci["targetTokens"]),
				MicroCompactKeep: toInt(ci["microCompactKeep"]),
				TokensAfter:      toInt(ci["tokensAfter"]),
			}
			if sm, ok := ci["sessionMemory"].(string); ok {
				payload.SessionMemory = sm
			}
			// Decode the typed facts slice. The producer
			// (backend.compactIfNeeded / compactReactive) embeds
			// []compaction.Fact directly on the map under "facts" — no
			// stringly-typed intermediate, so a single type assertion is
			// enough. Missing key and empty slice are treated identically.
			if rawFacts, ok := ci["facts"].([]compaction.Fact); ok && len(rawFacts) > 0 {
				payload.Facts = make([]extension.CompactionFact, 0, len(rawFacts))
				for _, f := range rawFacts {
					// Source (message index) is intentionally dropped — the
					// messages it points into are gone by the time the hook
					// fires, and index stability across hook boundaries is
					// not part of the contract.
					payload.Facts = append(payload.Facts, extension.CompactionFact{
						Type:    f.Type,
						Content: f.Content,
					})
				}
				utils.LogWithFields(utils.LevelDebug, "session", "session_compact bridge: forwarding facts to extensions", map[string]any{"count": len(payload.Facts)})
			} else {
				utils.Debug("Session", "session_compact bridge: no facts in payload")
			}
			extGroup.FireSessionCompact(ctx, payload)
		}
	}

	runCfg.Hooks.OnPermissionRequest = func(_ string, info interface{}) {
		if pi, ok := info.(map[string]interface{}); ok {
			req := extension.PermissionRequestInfo{
				ToolName: fmt.Sprintf("%v", pi["tool_name"]),
				Input:    toStringMap(pi["input"]),
				Decision: fmt.Sprintf("%v", pi["decision"]),
			}
			if t, ok := pi["tier"].(string); ok {
				req.Tier = t
			}
			extGroup.FirePermissionRequest(ctx, req)
		}
	}
	runCfg.Hooks.OnPermissionDenied = func(_ string, info interface{}) {
		if pi, ok := info.(map[string]interface{}); ok {
			extGroup.FirePermissionDenied(ctx, extension.PermissionDeniedInfo{
				ToolName: fmt.Sprintf("%v", pi["tool_name"]),
				Input:    toStringMap(pi["input"]),
				Reason:   fmt.Sprintf("%v", pi["reason"]),
			})
		}
	}

	runCfg.Hooks.OnPermissionClassify = func(toolName string, input map[string]interface{}) string {
		return extGroup.FirePermissionClassify(ctx, extension.PermissionClassifyInfo{
			ToolName: toolName,
			Input:    input,
		})
	}

	runCfg.Hooks.OnFileChanged = func(_ string, path string, action string) {
		extGroup.FireFileChanged(ctx, extension.FileChangedInfo{Path: path, Action: action})
	}
}

// wireExternalTools attaches MCP and extension-registered tools to the run config.
func (m *Manager) wireExternalTools(s *engineSession, key string, extGroup *extension.ExtensionGroup, mcpConns []*mcp.Connection, runCfg *backend.RunConfig) {
	var combinedToolDefs []types.LlmToolDef
	var mcpRouter func(string, map[string]interface{}) (string, bool, error)

	if len(mcpConns) > 0 {
		for _, conn := range mcpConns {
			for _, tool := range conn.Tools() {
				combinedToolDefs = append(combinedToolDefs, types.LlmToolDef{
					Name:        "mcp__" + conn.Name() + "__" + tool.Name,
					Description: tool.Description,
					InputSchema: tool.InputSchema,
				})
			}
		}
		mcpRouter = func(fullName string, input map[string]interface{}) (string, bool, error) {
			parts := strings.SplitN(fullName, "__", 3)
			if len(parts) != 3 {
				return "", true, fmt.Errorf("invalid MCP tool name: %s", fullName)
			}
			serverName := parts[1]
			toolName := parts[2]
			for _, conn := range mcpConns {
				if conn.Name() == serverName {
					mcpTimeout := m.mcpCallTimeout()
					callCtx, callCancel := context.WithTimeout(context.Background(), mcpTimeout)
					content, err := conn.CallTool(callCtx, toolName, input)
					callCancel()
					if err != nil {
						// Log at the call site so an MCP tool failure inside the
						// agent loop — which server, which tool — is visible from
						// logs alone, not only via the returned error.
						utils.LogWithFields(utils.LevelError, "session", "mcp tool call failed", map[string]any{"serverName": serverName, "toolName": toolName, "conversation_id": key, "error": utils.ErrStr(err)})
						return "", true, err
					}
					return content, false, nil
				}
			}
			utils.LogWithFields(utils.LevelWarn, "session", "mcp server not connected", map[string]any{"serverName": serverName, "toolName": toolName, "conversation_id": key})
			return "", true, fmt.Errorf("MCP server %q not connected", serverName)
		}
	}

	if extGroup != nil && !extGroup.IsEmpty() {
		extTools := extGroup.Tools()
		utils.LogWithFields(utils.LevelInfo, "session", "sendprompt[]: wiring extension tools", map[string]any{"key": key, "count": len(extTools)})
		for _, tool := range extTools {
			utils.LogWithFields(utils.LevelInfo, "session", "sendprompt[]: tool", map[string]any{"key": key, "model": tool.Name})
			combinedToolDefs = append(combinedToolDefs, types.LlmToolDef{
				Name:         tool.Name,
				Description:  tool.Description,
				InputSchema:  tool.Parameters,
				PlanModeSafe: tool.PlanModeSafe,
			})
		}
	} else {
		utils.LogWithFields(utils.LevelInfo, "session", "sendprompt[]: no extension tools ()", map[string]any{"key": key, "ext_group != nil": extGroup != nil})
	}

	utils.LogWithFields(utils.LevelInfo, "session", "sendprompt[]: total external tools", map[string]any{"key": key, "count": len(combinedToolDefs)})
	if len(combinedToolDefs) == 0 {
		return
	}
	capturedExtGroup := extGroup
	runCfg.ExternalTools = combinedToolDefs
	runCfg.McpToolRouter = func(ctx context.Context, name string, input map[string]interface{}) (*types.ToolResult, error) {
		if mcpRouter != nil && strings.HasPrefix(name, "mcp__") {
			content, isErr, err := mcpRouter(name, input)
			if err != nil {
				return nil, err
			}
			// MCP connections return text content only today; wrap it in a
			// ToolResult so the router surface is uniform. Images arrive via
			// the extension path below.
			return &types.ToolResult{Content: content, IsError: isErr}, nil
		}
		if capturedExtGroup != nil {
			for _, tool := range capturedExtGroup.Tools() {
				if tool.Name == name {
					// Build the per-tool-call extension context carrying the
					// tool's DeadlineSuspender (from ctx), so a synchronous
					// ctx.elicit() inside this tool can suspend the finite
					// tool deadline while blocked on the human.
					extCtx := m.newExtContextWithSuspender(s, key, types.DeadlineSuspenderFrom(ctx))
					result, err := tool.Execute(input, extCtx)
					if err != nil {
						return &types.ToolResult{Content: err.Error(), IsError: true}, nil
					}
					if result == nil {
						return nil, nil
					}
					// Return the whole result so Images (vision output) survive
					// the routing hop into the agent loop.
					return result, nil
				}
			}
		}
		return nil, fmt.Errorf("external tool %q not found", name)
	}
}

// mcpCallTimeout returns the configured MCP call timeout or the default (60s).
func (m *Manager) mcpCallTimeout() time.Duration {
	if m.config != nil && m.config.Timeouts != nil {
		return m.config.Timeouts.McpCall()
	}
	return 60 * time.Second
}

// buildPromptStdinPayload serializes the prompt into the JSON payload that
// Claude Code pipes to UserPromptSubmit hook stdin. The format is:
//
//	{"prompt": "<prompt text>"}
//
// transcript_path is omitted — the engine has no equivalent concept and the
// caveman hook (the primary consumer) only reads data.prompt. Falls back to
// the raw prompt string on marshal error (hooks that read stdin as plain text
// will still see the right content; hooks that parse JSON will fail gracefully
// via their own try/catch).
func buildPromptStdinPayload(prompt string) string {
	payload := map[string]string{"prompt": prompt}
	data, err := json.Marshal(payload)
	if err != nil {
		return prompt
	}
	return string(data)
}
