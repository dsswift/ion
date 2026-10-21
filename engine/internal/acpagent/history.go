package acpagent

import (
	"context"
	"encoding/json"
	"time"
)

// replayHistory streams the loaded conversation to the client as the
// chunks and tool calls it would have seen live, so a session/load shows
// the transcript before the next prompt.
func (s *Session) replayHistory(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	res, err := s.agent.engine.Send(ctx, map[string]any{"cmd": "load_session_history", "key": s.id})
	if err != nil {
		return err
	}
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
			s.chunk(UpdateUserMessageChunk, content)
		case "assistant":
			s.chunk(UpdateAgentMessageChunk, content)
		case "tool":
			name, id := str(m, "toolName"), str(m, "toolId")
			if name == "" {
				continue
			}
			update := SessionUpdate{SessionUpdate: UpdateToolCall, ToolCallID: id, Title: name, Name: name, Kind: toolKind(name), Status: "completed"}
			if input := str(m, "toolInput"); input != "" && json.Valid([]byte(input)) {
				update.RawInput = json.RawMessage(input)
				if title := toolTitle(name, input); title != "" {
					update.Title = title
				}
			}
			if isErr, _ := m["isError"].(bool); isErr { //nolint:errcheck // absent means success
				update.Status = "failed"
			}
			if content != "" {
				// A persisted tool row carries its result as content.
				update.ToolContent = []ToolCallContent{{Type: "content", Content: ContentBlock{Type: "text", Text: content}}}
			}
			s.agent.notify(s.id, update)
		}
	}
	return nil
}
