package providers

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestFormatOpenAIMessagesToolResultPrecedesImageCarrier(t *testing.T) {
	messages := []types.LlmMessage{
		{Role: "assistant", Content: []types.LlmContentBlock{
			{Type: "tool_use", ID: "call_image", Name: "mcp__mobbin__search_screens", Input: map[string]any{}},
		}},
		{Role: "user", Content: []types.LlmContentBlock{
			{Type: "tool_result", ToolUseID: "call_image", Content: "screen result"},
			{Type: "image", Source: &types.ImageSource{Type: "base64", MediaType: "image/png", Data: "aGVsbG8="}},
		}},
	}

	result := formatOpenAIMessages("sys", messages)
	if len(result) != 4 {
		t.Fatalf("message count = %d, want system + assistant + tool + user: %#v", len(result), result)
	}
	if result[1]["role"] != "assistant" || result[2]["role"] != "tool" || result[3]["role"] != "user" {
		t.Fatalf("roles = %v, %v, %v, want assistant, tool, user", result[1]["role"], result[2]["role"], result[3]["role"])
	}
	if result[2]["tool_call_id"] != "call_image" {
		t.Fatalf("tool_call_id = %v, want call_image", result[2]["tool_call_id"])
	}
	parts, ok := result[3]["content"].([]map[string]any)
	if !ok || len(parts) != 1 || parts[0]["type"] != "image_url" {
		t.Fatalf("user image content = %#v", result[3]["content"])
	}
	imageURL := parts[0]["image_url"].(map[string]any)["url"]
	if imageURL != "data:image/png;base64,aGVsbG8=" {
		t.Fatalf("image URL = %v", imageURL)
	}
}
