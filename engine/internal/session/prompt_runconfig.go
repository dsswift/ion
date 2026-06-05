package session

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/compaction"
	ionconfig "github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/permissions"
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

	// Thread the early-stop continuation config so the runloop can resolve
	// engine.json defaults. Nil here means "use built-in defaults" — the
	// runloop falls back via types.EarlyStopDefaults().
	if m.config != nil && m.config.EarlyStopContinue != nil {
		runCfg.EarlyStopContinue = m.config.EarlyStopContinue
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

	if extGroup != nil && !extGroup.IsEmpty() && !skipExtensions {
		m.wireExtensionHooks(s, key, requestID, apiBackend, extGroup, runCfg)
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
func (m *Manager) wireExtensionHooks(s *engineSession, key string, requestID string, apiBackend *backend.ApiBackend, extGroup *extension.ExtensionGroup, runCfg *backend.RunConfig) {
	capturedRequestID := requestID
	ctx := m.newExtContext(s, key)
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

	capturedEnterprise := func() *types.EnterpriseConfig {
		if m.config != nil {
			return m.config.Enterprise
		}
		return nil
	}()
	runCfg.Hooks.OnToolCall = func(info backend.ToolCallInfo) (*backend.ToolCallResult, error) {
		// G07: Enterprise tool restriction check
		if capturedEnterprise != nil && !ionconfig.IsToolAllowed(info.ToolName, capturedEnterprise) {
			return &backend.ToolCallResult{Block: true, Reason: "tool blocked by enterprise policy"}, nil
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
		utils.Debug("Session", fmt.Sprintf("ApiBackend OnTurnStart: task_created taskID=%s turn=%d", taskID, turnNum))
		_ = extGroup.FireTaskCreated(ctx, extension.TaskLifecycleInfo{
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
		utils.Debug("Session", fmt.Sprintf("ApiBackend OnTurnEnd: task_completed taskID=%s turn=%d", taskID, turnNum))
		_ = extGroup.FireTaskCompleted(ctx, extension.TaskLifecycleInfo{
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
		utils.Log("Session", fmt.Sprintf(
			"OnBeforeProviderRequest: provider=%s model=%s turn=%d messages=%d tools=%d sysPrompt=%v maxTokens=%d",
			info.Provider, info.Model, info.TurnNumber, info.MessageCount,
			info.ToolCount, info.HasSystemPrompt, info.MaxTokens,
		))
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
		rewritten, sysPrompt, _ := extGroup.FireBeforePrompt(ctx, prompt)
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
		cancel, _ := extGroup.FireSessionBeforeCompact(ctx, extension.CompactionInfo{})
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
		utils.Debug("Session", fmt.Sprintf("compact_summary_request bridge: strategy=%s msgCount=%d hookProvided=%v summaryLen=%d", strategy, len(messages), ok, len(summary)))
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
				utils.Debug("Session", fmt.Sprintf("session_compact bridge: forwarding %d facts to extensions", len(payload.Facts)))
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
						return "", true, err
					}
					return content, false, nil
				}
			}
			return "", true, fmt.Errorf("MCP server %q not connected", serverName)
		}
	}

	if extGroup != nil && !extGroup.IsEmpty() {
		extTools := extGroup.Tools()
		utils.Log("Session", fmt.Sprintf("SendPrompt[%s]: wiring %d extension tools", key, len(extTools)))
		for _, tool := range extTools {
			utils.Log("Session", fmt.Sprintf("SendPrompt[%s]:   tool: %s", key, tool.Name))
			combinedToolDefs = append(combinedToolDefs, types.LlmToolDef{
				Name:        tool.Name,
				Description: tool.Description,
				InputSchema: tool.Parameters,
			})
		}
	} else {
		utils.Log("Session", fmt.Sprintf("SendPrompt[%s]: no extension tools (extGroup=%v)", key, extGroup != nil))
	}

	utils.Log("Session", fmt.Sprintf("SendPrompt[%s]: total external tools: %d", key, len(combinedToolDefs)))
	if len(combinedToolDefs) == 0 {
		return
	}
	capturedExtGroup := extGroup
	runCfg.ExternalTools = combinedToolDefs
	runCfg.McpToolRouter = func(name string, input map[string]interface{}) (string, bool, error) {
		if mcpRouter != nil && strings.HasPrefix(name, "mcp__") {
			return mcpRouter(name, input)
		}
		if capturedExtGroup != nil {
			for _, tool := range capturedExtGroup.Tools() {
				if tool.Name == name {
					ctx := m.newExtContext(s, key)
					result, err := tool.Execute(input, ctx)
					if err != nil {
						return err.Error(), true, nil
					}
					if result == nil {
						return "", false, nil
					}
					return result.Content, result.IsError, nil
				}
			}
		}
		return "", true, fmt.Errorf("external tool %q not found", name)
	}
}

// mcpCallTimeout returns the configured MCP call timeout or the default (60s).
func (m *Manager) mcpCallTimeout() time.Duration {
	if m.config != nil && m.config.Timeouts != nil {
		return m.config.Timeouts.McpCall()
	}
	return 60 * time.Second
}
