package backend

import (
	"github.com/dsswift/ion/engine/internal/acp"
	"github.com/dsswift/ion/engine/internal/types"
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
		return nil
	}
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
