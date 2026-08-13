package session

import (
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// backfillDispatchTranscripts repairs conversations written before dispatched
// native-session output gained an Ion transcript mirror. Root completion turns
// already persist the full child output; match their Dispatch ID marker to the
// corresponding terminal dispatch record and materialize the missing child file.
func backfillDispatchTranscripts(parent *conversation.Conversation, dispatches []conversation.AgentDispatchData) {
	if parent == nil {
		return
	}
	legacyResults := legacyAgentToolResults(parent)
	for _, dispatch := range dispatches {
		if dispatch.ConversationID == "" {
			continue
		}
		if _, err := conversation.Load(dispatch.ConversationID, ""); err == nil {
			continue
		}
		needle := "Dispatch ID: " + dispatch.AgentID
		var output string
		for _, entry := range parent.Entries {
			md := conversation.AsMessageData(entry.Data)
			if md == nil || md.Role != "user" || md.InjectionKind != string(types.InjectionKindAgentCompletion) {
				continue
			}
			text := messageContentText(md.Content)
			if !strings.Contains(text, needle) {
				continue
			}
			if split := strings.Index(text, "\n\n"); split >= 0 {
				output = text[split+2:]
			} else {
				output = text
			}
		}
		if output == "" {
			output = legacyResults[dispatch.Task]
		}
		if output == "" {
			continue
		}
		if err := conversation.MaterializeDispatchTranscript(dispatch.ConversationID, dispatch.Task, output, dispatch.Model); err != nil {
			utils.LogWithFields(utils.LevelWarn, "session.dispatch_transcript", "dispatch transcript backfill failed", map[string]any{
				"conversation_id": dispatch.ConversationID, "run_id": dispatch.AgentID, "error": err.Error(),
			})
		}
	}
}

// legacyAgentToolResults recovers foreground Agent-tool output. Older parent
// conversations persisted the full result as a tool_result linked to the Agent
// tool_use id, but did not stamp the generated dispatch id into that result.
// Match the Agent call's exact prompt to its result; dispatch tasks are the same
// prompt string and concurrent identical tasks are inherently indistinguishable.
func legacyAgentToolResults(parent *conversation.Conversation) map[string]string {
	toolTask := make(map[string]string)
	results := make(map[string]string)
	for _, entry := range parent.Entries {
		md := conversation.AsMessageData(entry.Data)
		if md == nil {
			continue
		}
		blocks := normalizedMessageBlocks(md.Content)
		if md.Role == "assistant" {
			for _, block := range blocks {
				if block.Type != "tool_use" || block.Name != "Agent" || block.ID == "" {
					continue
				}
				if prompt, ok := block.Input["prompt"].(string); ok && prompt != "" {
					toolTask[block.ID] = prompt
				}
			}
		}
		if md.Role == "user" {
			for _, block := range blocks {
				if block.Type != "tool_result" || block.ToolUseID == "" || block.Content == "" {
					continue
				}
				if task := toolTask[block.ToolUseID]; task != "" {
					results[task] = block.Content
				}
			}
		}
	}
	return results
}

func normalizedMessageBlocks(content any) []types.LlmContentBlock {
	switch value := content.(type) {
	case []types.LlmContentBlock:
		return value
	case []any:
		blocks := make([]types.LlmContentBlock, 0, len(value))
		for _, item := range value {
			if block, ok := item.(map[string]any); ok {
				var out types.LlmContentBlock
				if kind, ok := block["type"].(string); ok {
					out.Type = kind
				}
				if id, ok := block["id"].(string); ok {
					out.ID = id
				}
				if name, ok := block["name"].(string); ok {
					out.Name = name
				}
				if input, ok := block["input"].(map[string]any); ok {
					out.Input = input
				}
				if toolID, ok := block["tool_use_id"].(string); ok {
					out.ToolUseID = toolID
				}
				if text, ok := block["content"].(string); ok {
					out.Content = text
				}
				blocks = append(blocks, out)
			}
		}
		return blocks
	default:
		return nil
	}
}

func messageContentText(content any) string {
	switch value := content.(type) {
	case string:
		return value
	case []types.LlmContentBlock:
		var out strings.Builder
		for _, block := range value {
			if block.Type == "text" {
				out.WriteString(block.Text)
			}
		}
		return out.String()
	case []any:
		var out strings.Builder
		for _, item := range value {
			out.WriteString(messageContentText(item))
		}
		return out.String()
	case map[string]any:
		if text, ok := value["text"].(string); ok {
			return text
		}
		if text, ok := value["content"].(string); ok {
			return text
		}
		return ""
	default:
		return fmt.Sprint(value)
	}
}
