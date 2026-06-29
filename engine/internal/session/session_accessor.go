package session

import (
	"context"
	"fmt"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/modelconfig"
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/resource"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// sessionAccessor adapts *Manager + *engineSession to the
// extcontext.SessionAccessor interface. Each method delegates to the manager
// and session with appropriate locking.
type sessionAccessor struct {
	m   *Manager
	s   *engineSession
	key string
	// suspender, when non-nil, is the DeadlineSuspender of the tool call
	// through which this accessor was created. The Elicit path uses it to
	// suspend the tool's finite deadline while blocked on a human. nil for
	// accessors not created on behalf of a tool call (hooks, commands, etc.),
	// in which case the elicit wait is governed only by session lifecycle.
	suspender types.DeadlineSuspender
}

func (a *sessionAccessor) SessionKey() string       { return a.key }
func (a *sessionAccessor) ConversationID() string   { return a.s.conversationID }
func (a *sessionAccessor) WorkingDirectory() string { return a.s.config.WorkingDirectory }

func (a *sessionAccessor) Emit(ev types.EngineEvent) { a.m.emit(a.key, ev) }

func (a *sessionAccessor) SendAbort() { a.m.SendAbort(a.key) }

// RootContext returns the session's cancellation root so extcontext-built
// operations (ctx.llmCall, agent dispatch) derive from it and are cancelled
// by a session-level abort. Never nil — rootContext() falls back to
// context.Background() for test-constructed sessions. See
// session_root_context.go.
func (a *sessionAccessor) RootContext() context.Context { return a.s.rootContext() }

func (a *sessionAccessor) SendPrompt(text string, model string, bashAllowlistAdditions []string) error {
	overrides := buildPromptOverrides(model, bashAllowlistAdditions)
	if len(bashAllowlistAdditions) > 0 {
		utils.Info("PlanMode", fmt.Sprintf("sessionAccessor.SendPrompt: key=%s threading %d bash-allowlist additions for this prompt: %v", a.key, len(bashAllowlistAdditions), bashAllowlistAdditions))
	}
	return a.m.SendPrompt(a.key, text, overrides)
}

// SteerSelfMainLoop steers this session's own main run loop (depth-0 /
// orchestrator). It delegates to SteerAgent with an empty agent name, which
// targets the main loop's in-flight run. Returns true when the steer reached
// a live run (any delivered outcome), false when there is no active main run
// — the ctx.SteerSelf wiring then falls back to SendPrompt so the message is
// delivered as a fresh prompt on the idle session.
func (a *sessionAccessor) SteerSelfMainLoop(message string) bool {
	outcome := a.m.SteerAgent(a.key, "", message)
	utils.Info("Session", fmt.Sprintf(
		"sessionAccessor.SteerSelfMainLoop: key=%s msgLen=%d outcome=%s delivered=%t",
		a.key, len(message), outcome, outcome.Delivered(),
	))
	return outcome.Delivered()
}

func (a *sessionAccessor) SuppressTool(name string) {
	a.m.mu.Lock()
	a.s.suppressedTools = append(a.s.suppressedTools, name)
	a.m.mu.Unlock()
}

func (a *sessionAccessor) CacheExtAgentStates(agentStates []types.AgentStateUpdate) {
	a.s.agents.CacheExtStates(agentStates)
}

func (a *sessionAccessor) RegisterAgent(name string, handle types.AgentHandle) {
	a.s.agents.RegisterHandle(name, handle)
}

func (a *sessionAccessor) DeregisterAgent(name string) {
	a.s.agents.DeregisterHandle(name)
}

func (a *sessionAccessor) RegisterAgentSpec(spec types.AgentSpec) {
	a.s.agents.RegisterSpec(spec)
}

func (a *sessionAccessor) DeregisterAgentSpec(name string) {
	a.s.agents.DeregisterSpec(name)
}

func (a *sessionAccessor) LookupAgentSpec(name string) (types.AgentSpec, bool) {
	return a.s.agents.LookupSpec(name)
}

func (a *sessionAccessor) LookupExtDisplayName(name string) string {
	return a.s.agents.LookupExtDisplayName(name)
}

func (a *sessionAccessor) ExtGroup() *extension.ExtensionGroup { return a.s.extGroup }

func (a *sessionAccessor) ExtConfig() *extension.ExtensionConfig {
	if a.s.extGroup != nil && !a.s.extGroup.IsEmpty() {
		return &extension.ExtensionConfig{
			WorkingDirectory: a.s.config.WorkingDirectory,
		}
	}
	return nil
}

func (a *sessionAccessor) ProcRegistry() *extension.ProcessRegistry { return a.s.procRegistry }

func (a *sessionAccessor) NewChildBackend() backend.RunBackend { return a.m.newChildBackend() }

// BumpParentProgress refreshes the parent run's run-progress watchdog clock
// for this session's active run. Delegates to the Manager, which resolves the
// parent backend and the session's current requestID. No-op when the session
// has no active run or the backend cannot bump progress (CLI / test stubs).
func (a *sessionAccessor) BumpParentProgress() { a.m.bumpParentProgress(a.s) }

func (a *sessionAccessor) EngineConfig() *types.EngineRuntimeConfig { return a.m.config }

func (a *sessionAccessor) ResolveTier(name string) string { return modelconfig.ResolveTier(name) }

func (a *sessionAccessor) PermissionCheck(toolName string, input map[string]interface{}) (string, string) {
	if a.s.permEngine == nil {
		return "", ""
	}
	result := a.s.permEngine.Check(permissions.CheckInfo{
		Tool:      toolName,
		Input:     input,
		Cwd:       a.s.config.WorkingDirectory,
		SessionID: a.key,
	})
	return result.Decision, result.Reason
}

func (a *sessionAccessor) McpConnections() []*mcp.Connection {
	a.m.mu.RLock()
	defer a.m.mu.RUnlock()
	return a.s.mcpConns
}

func (a *sessionAccessor) SearchHistory(query string, maxResults int) []extension.HistoryMatch {
	a.m.mu.RLock()
	requestID := a.s.requestID
	lastModel := a.s.lastModel
	a.m.mu.RUnlock()
	if requestID == "" {
		return nil
	}
	// resolvedBackend resolves to the inner *ApiBackend for hybrid (when the
	// last dispatched model was non-Anthropic) or returns m.backend as-is
	// for plain ApiBackend. CLI-routed hybrid runs and plain CliBackend
	// return nil here — SearchHistory only operates on the API backend's
	// in-process conversation buffer.
	apiBackend, ok := a.m.resolvedBackend(lastModel).(*backend.ApiBackend)
	if !ok {
		return nil
	}
	convMatches := apiBackend.SearchHistory(requestID, query, maxResults)
	if len(convMatches) == 0 {
		return nil
	}
	// Convert conversation.HistoryMatch → extension.HistoryMatch
	result := make([]extension.HistoryMatch, len(convMatches))
	for i, m := range convMatches {
		result[i] = extension.HistoryMatch{
			Index:     m.Index,
			Role:      m.Role,
			Type:      m.Type,
			Snippet:   m.Snippet,
			ToolName:  m.ToolName,
			ToolUseID: m.ToolUseID,
		}
	}
	return result
}

func (a *sessionAccessor) GetSessionMemory() string {
	a.m.mu.RLock()
	sm := a.s.sessionMemory
	a.m.mu.RUnlock()
	if sm == nil {
		return ""
	}
	return sm.GetMemory()
}

func (a *sessionAccessor) SetSessionMemory(content string) {
	a.m.mu.RLock()
	sm := a.s.sessionMemory
	a.m.mu.RUnlock()
	if sm == nil {
		utils.Log("Session", "SetSessionMemory: no session memory active, ignoring")
		return
	}
	sm.SetMemory(content)
}

func (a *sessionAccessor) TranslateEvent(ev types.NormalizedEvent, contextWindow int) types.EngineEvent {
	return translateToEngineEvent(ev, contextWindow)
}

// SetPlanMode imperatively flips plan mode for this session. Used by
// extensions via ctx.SetPlanMode. Delegates to Manager.SetPlanMode so all
// the planFilePath-preservation and hasExitedPlanMode logic applies.
func (a *sessionAccessor) SetPlanMode(enabled bool, source string) {
	// Extensions do not supply a plan-file path; pass "" so the manager's
	// restore branch is a no-op and existing planFilePath-preservation logic
	// applies unchanged.
	a.m.SetPlanMode(a.key, enabled, nil, source, "")
}

// GetPlanModeState returns (enabled, planFilePath) for this session.
func (a *sessionAccessor) GetPlanModeState() (bool, string) {
	return a.m.GetPlanModeState(a.key)
}

func (a *sessionAccessor) AppendOrUpdateAgentState(state types.AgentStateUpdate) string {
	a.s.agents.AppendOrUpdate(state, func(existing *types.AgentStateUpdate) {
		// Preserve and merge the structured dispatches array from previous
		// dispatches. When the incoming state carries new dispatch entries
		// (e.g. a re-dispatch of the same agent name), merge them with any
		// existing entries rather than replacing.
		var prevDispatches []interface{}
		if existing.Metadata != nil {
			if pd, ok := existing.Metadata["dispatches"].([]interface{}); ok {
				prevDispatches = pd
			}
		}
		existing.ID = state.ID
		existing.Status = state.Status
		existing.Metadata = state.Metadata
		if len(prevDispatches) > 0 && existing.Metadata != nil {
			if newDisp, ok := existing.Metadata["dispatches"].([]interface{}); ok {
				existing.Metadata["dispatches"] = append(prevDispatches, newDisp...)
			} else {
				existing.Metadata["dispatches"] = prevDispatches
			}
		}
	})
	return state.ID
}

func (a *sessionAccessor) UpdateAgentStateByID(id string, updater func(*types.AgentStateUpdate)) {
	a.s.agents.UpdateStateByID(id, updater)
}

func (a *sessionAccessor) EmitAgentSnapshot(reason string) {
	snapshot := a.s.agents.MergedSnapshot()
	utils.Log("Session", fmt.Sprintf("agent_snapshot_emitted key=%s count=%d reason=%s", a.key, len(snapshot), reason))
	a.m.emit(a.key, types.EngineEvent{Type: "engine_agent_state", Agents: snapshot})
}

func (a *sessionAccessor) ResourceBroker() *resource.Broker       { return a.s.resourceBroker }
func (a *sessionAccessor) GlobalResourceBroker() *resource.Broker { return a.m.globalBroker }

// BroadcastNotification emits an engine_notification event with push flags
// set so the relay forwards it to APNs when the mobile peer is offline.
// When TargetSessionKey is set, the notification is emitted on the target
// session's event stream instead of the caller's. The target must exist;
// if it doesn't, the notification is emitted on the caller's session and
// a warning is logged.
func (a *sessionAccessor) BroadcastNotification(opts types.NotifyOpts) {
	ev := types.EngineEvent{
		Type:             "engine_notification",
		Push:             true,
		PushTitle:        opts.Title,
		PushBody:         opts.Body,
		NotifyKind:       opts.Kind,
		NotifyResourceID: opts.ResourceID,
		NotifyTitle:      opts.Title,
		NotifyBody:       opts.Body,
		NotifySound:      opts.Sound,
		NotifyScope:      opts.Scope,
	}

	targetKey := opts.TargetSessionKey
	if targetKey != "" && targetKey != a.key {
		// Verify the target session exists.
		a.m.mu.RLock()
		_, exists := a.m.sessions[targetKey]
		a.m.mu.RUnlock()
		if exists {
			utils.Log("session", fmt.Sprintf("BroadcastNotification: routing to target session key=%s (from %s)", targetKey, a.key))
			a.m.emit(targetKey, ev)
			return
		}
		utils.Warn("session", fmt.Sprintf("BroadcastNotification: target session %q not found, falling back to caller %s", targetKey, a.key))
	}

	a.m.emit(a.key, ev)
}

// BroadcastIntercept emits an engine_intercept event on the target session's
// stream. This is a fire-and-forget signal — the engine attaches no semantics
// beyond routing the event. When TargetSessionKey is set and the session
// exists, the event is emitted on that session's stream. Otherwise it falls
// back to the caller's session and a warning is logged.
func (a *sessionAccessor) BroadcastIntercept(opts extension.InterceptOpts) {
	ev := types.EngineEvent{
		Type:              "engine_intercept",
		InterceptLevel:    opts.Level,
		InterceptTitle:    opts.Title,
		InterceptMessage:  opts.Message,
		InterceptSource:   opts.Source,
		InterceptMetadata: opts.Metadata,
	}

	targetKey := opts.TargetSessionKey
	if targetKey != "" && targetKey != a.key {
		a.m.mu.RLock()
		_, exists := a.m.sessions[targetKey]
		a.m.mu.RUnlock()
		if exists {
			utils.Log("session", fmt.Sprintf("BroadcastIntercept: routing to target session key=%s (from %s)", targetKey, a.key))
			a.m.emit(targetKey, ev)
			return
		}
		utils.Warn("session", fmt.Sprintf("BroadcastIntercept: target session %q not found, falling back to caller %s", targetKey, a.key))
	}

	a.m.emit(a.key, ev)
}

func (a *sessionAccessor) ListAllSessions() []extension.SessionListEntry {
	infos := a.m.ListSessions()
	entries := make([]extension.SessionListEntry, len(infos))
	for i, info := range infos {
		entries[i] = extension.SessionListEntry{
			Key:            info.Key,
			HasActiveRun:   info.HasActiveRun,
			ExtensionName:  info.ExtensionName,
			ConversationID: info.ConversationID,
		}
	}
	return entries
}

func (a *sessionAccessor) SendToSession(senderKey, targetKey, kind string, payload map[string]interface{}) error {
	a.m.mu.RLock()
	senderSession, senderOK := a.m.sessions[senderKey]
	targetSession, targetOK := a.m.sessions[targetKey]
	a.m.mu.RUnlock()

	if !targetOK {
		return fmt.Errorf("target session %q not found", targetKey)
	}
	if !senderOK {
		return fmt.Errorf("sender session %q not found", senderKey)
	}

	// Enforce same extension type.
	if senderSession.extensionName != targetSession.extensionName {
		return fmt.Errorf("cross-session messaging requires same extension type (sender=%q target=%q)",
			senderSession.extensionName, targetSession.extensionName)
	}

	// Check the target session has an extension group.
	if targetSession.extGroup == nil || targetSession.extGroup.IsEmpty() {
		return fmt.Errorf("target session %q has no extension group", targetKey)
	}

	// Fire the session_message hook on each host in the target session's
	// extension group, using the target session's context.
	info := extension.SessionMessageInfo{
		SenderSessionKey: senderKey,
		Kind:             kind,
		Payload:          payload,
	}

	ctx := a.m.newExtContext(targetSession, targetKey)
	for _, h := range targetSession.extGroup.Hosts() {
		if err := h.SDK().FireSessionMessage(ctx, info); err != nil {
			utils.Log("session", fmt.Sprintf("SendToSession: hook fire failed sender=%s target=%s kind=%s err=%v", senderKey, targetKey, kind, err))
		}
	}

	utils.Log("session", fmt.Sprintf("SendToSession: delivered sender=%s target=%s kind=%s", senderKey, targetKey, kind))
	return nil
}

// RunOnceCheck delegates to the Manager's runOnce registry, scoped to this
// session's loaded extension directory.
func (a *sessionAccessor) RunOnceCheck(operationID string, debounceMs int64) (bool, string) {
	result := a.m.RunOnceCheck(a.key, operationID, debounceMs)
	return result.Execute, result.Reason
}

// RunOnceComplete delegates to the Manager's runOnce registry.
func (a *sessionAccessor) RunOnceComplete(operationID string, failed bool) {
	a.m.RunOnceComplete(a.key, operationID, failed)
}
