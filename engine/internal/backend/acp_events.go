package backend

import (
	"encoding/json"
	"strings"

	"github.com/dsswift/ion/engine/internal/acp"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// onSessionUpdate routes an ACP session/update notification to its run and
// translates it into NormalizedEvents.
func (b *AcpBackend) onSessionUpdate(n acp.SessionUpdateNotification) {
	b.mu.Lock()
	requestID := b.sessionToRun[n.SessionID]
	run := b.runs[requestID]
	events := translateAcpUpdate(run, n.Update)
	b.mu.Unlock()

	if run == nil {
		return
	}
	for _, ev := range events {
		b.emit(requestID, ev)
	}
}

// translateAcpUpdate converts one ACP session update into NormalizedEvents,
// mutating per-run translation state. Must be called with the backend mutex
// held; the caller emits after releasing it.
func translateAcpUpdate(run *acpRun, u acp.SessionUpdate) []types.NormalizedEvent {
	if run == nil {
		return nil
	}
	switch u.SessionUpdate {
	case acp.UpdateAgentMessageChunk:
		var events []types.NormalizedEvent
		events = append(events, acpCloseThinking(run)...)
		if u.Content != nil && u.Content.Text != "" {
			run.lastText += u.Content.Text
			events = append(events, types.NormalizedEvent{Data: &types.TextChunkEvent{Text: u.Content.Text}})
		}
		return events

	case acp.UpdateAgentThoughtChunk:
		var events []types.NormalizedEvent
		events = append(events, acpOpenThinking(run)...)
		if u.Content != nil && u.Content.Text != "" {
			events = append(events, types.NormalizedEvent{Data: &types.ThinkingDeltaEvent{Text: u.Content.Text}})
		}
		return events

	case acp.UpdateToolCall:
		idx := run.nextTool
		run.nextTool++
		name := u.Title
		if name == "" {
			name = u.Kind
		}
		events := acpCloseThinking(run)
		events = append(events, types.NormalizedEvent{Data: &types.ToolCallEvent{ToolName: name, ToolID: u.ToolCallID, Index: idx}})
		return events

	case acp.UpdateToolCallUpdate:
		if u.Status == "completed" || u.Status == "failed" {
			return []types.NormalizedEvent{{Data: &types.ToolResultEvent{
				ToolID:  u.ToolCallID,
				IsError: u.Status == "failed",
			}}}
		}
		return nil

	default:
		// The standard ACP "plan" session update (acp.UpdatePlan) is the
		// agent's progress checklist, NOT a plan proposal. Cursor proposes via
		// the cursor/create_plan extension request (see onExtRequest); it is
		// captured there, so nothing to do here.
		return nil
	}
}

// onExtRequest handles cursor's ACP extension requests. cursor/create_plan is
// the plan proposal (captured into the plan file); cursor/ask_question surfaces
// interactive questions. Runs on the ACP read loop and may block on a user
// decision, like onPermission. Returns handled=false for unknown methods so the
// client replies method-not-found.
func (b *AcpBackend) onExtRequest(method string, params json.RawMessage) (any, bool) {
	switch method {
	case acp.ReqCursorCreatePlan:
		var p acp.CursorCreatePlanParams
		if err := json.Unmarshal(params, &p); err != nil {
			utils.LogWithFields(utils.LevelWarn, "backend.acp", "cursor/create_plan decode failed", map[string]any{"kind": b.spec.kind, "error": err.Error()})
			return acp.CursorCreatePlanResult{Accepted: true}, true
		}
		requestID, planPath := b.resolvePlanRun(p.SessionID)
		if requestID == "" {
			utils.LogWithFields(utils.LevelWarn, "backend.acp", "cursor/create_plan with no active plan run", map[string]any{"kind": b.spec.kind})
			return acp.CursorCreatePlanResult{Accepted: true}, true
		}
		if _, err := capturePlanMarkdown(requestID, p.Plan, planPath, true, 0, b.emit); err != nil {
			utils.LogWithFields(utils.LevelError, "backend.acp", "native plan capture failed", map[string]any{"kind": b.spec.kind, "run_id": requestID, "error": err.Error()})
		} else {
			b.markPlanCaptured(requestID)
		}
		return acp.CursorCreatePlanResult{Accepted: true}, true

	case acp.ReqCursorAskQuestion:
		return b.onCursorAskQuestion(params), true

	default:
		return nil, false
	}
}

// resolvePlanRun maps a cursor extension request to its plan-mode run. It
// prefers an explicit sessionId, then falls back to the single active
// plan-mode run (cursor extension requests do not always carry a session
// scope, and one cursor conversation plans at a time in practice). Returns
// empty when there is no unambiguous plan-mode run.
func (b *AcpBackend) resolvePlanRun(sessionID string) (requestID, planPath string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if sessionID != "" {
		if rid, ok := b.sessionToRun[sessionID]; ok {
			if run := b.runs[rid]; run != nil && run.planMode {
				return rid, run.planFilePath
			}
		}
	}
	var found *acpRun
	count := 0
	for _, run := range b.runs {
		if run.planMode {
			found = run
			count++
		}
	}
	if count == 1 {
		return found.requestID, found.planFilePath
	}
	if count > 1 {
		utils.LogWithFields(utils.LevelWarn, "backend.acp", "cursor extension request is ambiguous across multiple plan-mode runs", map[string]any{"kind": b.spec.kind, "count": count})
	}
	return "", ""
}

// markPlanCaptured latches a run's plan as captured so finishPlanRun skips the
// auto-exit safety net.
func (b *AcpBackend) markPlanCaptured(requestID string) {
	b.mu.Lock()
	if run := b.runs[requestID]; run != nil {
		run.planCaptured = true
	}
	b.mu.Unlock()
}

// onCursorAskQuestion bridges a cursor/ask_question request to the engine's
// permission-ask callback (one question at a time) and returns the selected
// answers keyed by question id.
//
// NOTE: cursor's answer wire shape is `answers: Record<string, unknown>` in the
// public schema — the exact value shape cursor expects is cursor-private and
// not published. This maps questionId → selected optionId as the best-effort
// reading; it needs validation against a live cursor and may require adjusting
// the value shape.
func (b *AcpBackend) onCursorAskQuestion(params json.RawMessage) any {
	var p acp.CursorAskQuestionParams
	answers := map[string]any{}
	if err := json.Unmarshal(params, &p); err != nil {
		utils.LogWithFields(utils.LevelWarn, "backend.acp", "cursor/ask_question decode failed", map[string]any{"kind": b.spec.kind, "error": err.Error()})
		return map[string]any{"answers": answers}
	}
	requestID, _ := b.resolvePlanRun(p.SessionID)
	b.mu.Lock()
	askCb := b.askCb
	b.mu.Unlock()
	if askCb == nil || requestID == "" {
		return map[string]any{"answers": answers}
	}
	for _, q := range p.Questions {
		opts := make([]types.PermissionOpt, 0, len(q.Options))
		for _, o := range q.Options {
			opts = append(opts, types.PermissionOpt{ID: o.ID, Label: o.Label, Kind: "answer"})
		}
		ch := askCb(requestID, "cursor-q-"+q.ID, p.Title, q.Prompt, map[string]any{"questionId": q.ID}, opts)
		if ch == nil {
			continue
		}
		if sel := <-ch; sel != "" {
			answers[q.ID] = sel
		}
	}
	return map[string]any{"answers": answers}
}

// acpPlanModeAliases are the session-mode identifiers agents commonly use for
// their plan mode, in match-preference order.
var acpPlanModeAliases = []string{"plan", "architect"}

// acpDefaultModeAliases are the identifiers for the normal/implement mode, in
// match-preference order, used to reset a session left sticky in plan mode.
var acpDefaultModeAliases = []string{"code", "agent", "default", "chat", "implement"}

// acpPlanModeID resolves the agent's plan mode from its advertised session
// modes, matching id then name against the plan aliases. Empty when the agent
// advertises no plan-capable mode.
func acpPlanModeID(modes *acp.SessionModeState) string {
	return acpModeByAliases(modes, acpPlanModeAliases)
}

// acpDefaultModeID resolves the agent's normal (non-plan) mode: an alias match
// first, else the first advertised mode that is not the plan mode.
func acpDefaultModeID(modes *acp.SessionModeState) string {
	if id := acpModeByAliases(modes, acpDefaultModeAliases); id != "" {
		return id
	}
	if modes == nil {
		return ""
	}
	planID := acpPlanModeID(modes)
	for _, m := range modes.AvailableModes {
		if m.ID != planID {
			return m.ID
		}
	}
	return ""
}

// acpModeByAliases finds the first advertised mode whose id or name equals an
// alias (case-insensitive), honoring alias preference order.
func acpModeByAliases(modes *acp.SessionModeState, aliases []string) string {
	if modes == nil {
		return ""
	}
	for _, alias := range aliases {
		for _, m := range modes.AvailableModes {
			if strings.EqualFold(m.ID, alias) || strings.EqualFold(m.Name, alias) {
				return m.ID
			}
		}
	}
	return ""
}

func acpOpenThinking(run *acpRun) []types.NormalizedEvent {
	if run.thinkingOpen {
		return nil
	}
	run.thinkingOpen = true
	return []types.NormalizedEvent{{Data: &types.ThinkingBlockStartEvent{}}}
}

func acpCloseThinking(run *acpRun) []types.NormalizedEvent {
	if !run.thinkingOpen {
		return nil
	}
	run.thinkingOpen = false
	return []types.NormalizedEvent{{Data: &types.ThinkingBlockEndEvent{}}}
}

// onPermission bridges an ACP permission request into the engine permission
// flow, presenting the agent's own options and returning the selected outcome.
func (b *AcpBackend) onPermission(p acp.RequestPermissionParams) acp.PermissionOutcome {
	b.mu.Lock()
	requestID := b.sessionToRun[p.SessionID]
	askCb := b.askCb
	b.mu.Unlock()
	if askCb == nil || requestID == "" {
		return acp.PermissionOutcome{Outcome: acp.OutcomeCancelled}
	}

	opts := make([]types.PermissionOpt, len(p.Options))
	for i, o := range p.Options {
		opts[i] = types.PermissionOpt{ID: o.OptionID, Label: o.Name, Kind: o.Kind}
	}
	toolName := p.ToolCall.Title
	if toolName == "" {
		toolName = p.ToolCall.Kind
	}
	ch := askCb(requestID, "acp-"+p.SessionID, toolName, p.ToolCall.Title, map[string]any{"toolCallId": p.ToolCall.ToolCallID}, opts)
	if ch == nil {
		return acp.PermissionOutcome{Outcome: acp.OutcomeCancelled}
	}
	optionID := <-ch
	if optionID == "" {
		return acp.PermissionOutcome{Outcome: acp.OutcomeCancelled}
	}
	return acp.PermissionOutcome{Outcome: acp.OutcomeSelected, OptionID: optionID}
}
