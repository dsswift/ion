package acpagent

import (
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

// dispatchCard is one sub-agent dispatch in flight, shown to the client as
// a tool call whose content is the child's transcript as it streams.
type dispatchCard struct {
	agent      string
	transcript strings.Builder
}

// dispatchTranscriptMax bounds the transcript a card carries; a client
// shows the tail of a long one.
const dispatchTranscriptMax = 8000

func dispatchCallID(id string) string { return "dispatch:" + id }

// dispatchStart opens a card for a dispatched agent.
func (s *Session) dispatchStart(e map[string]any) {
	id := str(e, "dispatchId")
	agent := str(e, "dispatchAgent")
	task := str(e, "dispatchTask")
	s.mu.Lock()
	if s.dispatches == nil {
		s.dispatches = map[string]*dispatchCard{}
	}
	s.dispatches[id] = &dispatchCard{agent: agent}
	s.mu.Unlock()
	title := "Agent " + agent
	if task != "" {
		title += ": " + firstLine(task, 120)
	}
	update := SessionUpdate{SessionUpdate: UpdateToolCall, ToolCallID: dispatchCallID(id), Title: title, Name: "Agent", Kind: "think", Status: "in_progress", Meta: toolMeta("Agent")}
	if task != "" {
		update.ToolContent = []ToolCallContent{textContent(task)}
	}
	s.agent.notify(s.id, update)
}

// dispatchActivity appends one delta of the child's work to its card: a
// streamed text chunk, or the name of a tool it called.
func (s *Session) dispatchActivity(e map[string]any) {
	id := str(e, "dispatchAgentId")
	s.mu.Lock()
	card, ok := s.dispatches[id]
	if !ok {
		s.mu.Unlock()
		return
	}
	switch str(e, "dispatchActivityKind") {
	case "text":
		card.transcript.WriteString(str(e, "dispatchTextDelta"))
	case "tool_start":
		card.transcript.WriteString("\n▸ " + bareToolName(str(e, "toolName")) + "\n")
	default:
		s.mu.Unlock()
		return
	}
	text := transcriptTail(card.transcript.String())
	s.mu.Unlock()
	s.agent.notify(s.id, SessionUpdate{SessionUpdate: UpdateToolCallUpdate, ToolCallID: dispatchCallID(id), ToolContent: []ToolCallContent{textContent(text)}})
}

// dispatchEnd closes the card with the child's outcome and its cost.
func (s *Session) dispatchEnd(e map[string]any) {
	id := str(e, "dispatchId")
	s.mu.Lock()
	card, ok := s.dispatches[id]
	var text string
	if ok {
		text = card.transcript.String()
		delete(s.dispatches, id)
	}
	s.mu.Unlock()
	if !ok {
		return
	}
	status := "completed"
	if num(e, "dispatchExitCode") != 0 {
		status = "failed"
	}
	summary := fmt.Sprintf("\n\n(%s in %.0fs, %d tool calls, $%.4f)", status, numF(e, "dispatchElapsed"), num(e, "dispatchToolCount"), numF(e, "dispatchCost"))
	s.agent.notify(s.id, SessionUpdate{SessionUpdate: UpdateToolCallUpdate, ToolCallID: dispatchCallID(id), Status: status, ToolContent: []ToolCallContent{textContent(transcriptTail(text) + summary)}})
}

// dispatchLost closes the card of a dispatch the engine lost in a restart.
func (s *Session) dispatchLost(e map[string]any) {
	lost, _ := e["dispatchLost"].(map[string]any) //nolint:errcheck // absent means nothing to close
	id := str(lost, "dispatchId")
	if id == "" {
		return
	}
	s.mu.Lock()
	_, ok := s.dispatches[id]
	delete(s.dispatches, id)
	s.mu.Unlock()
	if !ok {
		return
	}
	utils.LogWithFields(utils.LevelWarn, "acp", "dispatch lost", map[string]any{"session_id": s.id, "dispatch_id": id})
	s.agent.notify(s.id, SessionUpdate{SessionUpdate: UpdateToolCallUpdate, ToolCallID: dispatchCallID(id), Status: "failed", ToolContent: []ToolCallContent{textContent("The engine restarted while this agent ran; its work was lost.")}})
}

func transcriptTail(text string) string {
	if len(text) <= dispatchTranscriptMax {
		return text
	}
	return "…" + text[len(text)-dispatchTranscriptMax:]
}
