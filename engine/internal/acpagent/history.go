package acpagent

import (
	"context"
	"encoding/json"
	"time"
)

// replayHistory streams the loaded conversation to the client as the
// chunks and tool calls it would have seen live, marked as replay, so a
// session/load shows the transcript before the next prompt. The history
// is the conversation the key is bound to; an older engine that reports
// no conversation id is asked by key.
func (s *Session) replayHistory(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := map[string]any{"cmd": "load_session_history", "key": s.id}
	s.mu.Lock()
	if s.conversationID != "" {
		cmd["sessionIds"] = []string{s.conversationID}
	}
	s.mu.Unlock()
	res, err := s.agent.engine.Send(ctx, cmd)
	if err != nil {
		return err
	}
	replay := map[string]any{"isReplay": true}
	rows, _ := res["data"].([]any) //nolint:errcheck // no data means an empty conversation
	for _, item := range rows {
		m, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if internal, _ := m["internal"].(bool); internal { //nolint:errcheck // absent means visible
			continue
		}
		content := str(m, "content")
		switch str(m, "role") {
		case "user":
			if content != "" {
				s.agent.notifyMeta(s.id, SessionUpdate{SessionUpdate: UpdateUserMessageChunk, Content: &ContentBlock{Type: "text", Text: content}}, replay)
			}
		case "assistant":
			if content != "" {
				s.agent.notifyMeta(s.id, SessionUpdate{SessionUpdate: UpdateAgentMessageChunk, Content: &ContentBlock{Type: "text", Text: content}}, replay)
			}
		case "tool":
			name, id := str(m, "toolName"), str(m, "toolId")
			if name == "" {
				continue
			}
			update := SessionUpdate{SessionUpdate: UpdateToolCall, ToolCallID: id, Title: bareToolName(name), Name: name, Kind: toolKind(name), Status: "completed", Meta: toolMeta(name)}
			if input := str(m, "toolInput"); input != "" && json.Valid([]byte(input)) {
				s.applyInput(&update, name, input)
			}
			if isErr, _ := m["isError"].(bool); isErr { //nolint:errcheck // absent means success
				update.Status = "failed"
			}
			if content != "" {
				// A persisted tool row carries its result as content.
				update.ToolContent = append(update.ToolContent, textContent(content))
			}
			s.agent.notifyMeta(s.id, update, replay)
		}
	}
	return nil
}
