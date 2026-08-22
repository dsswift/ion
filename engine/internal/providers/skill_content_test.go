package providers

import (
	"encoding/json"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func skillBlock(text string) types.LlmContentBlock {
	return types.LlmContentBlock{
		Type: "skill_content",
		Text: text,
	}
}

func TestFormatAnthropicBlock_SkillContentFlattensToText(t *testing.T) {
	const body = "# Deploy checklist\n- run tests\n- push"

	out := formatAnthropicBlock(skillBlock(body))
	if out == nil {
		t.Fatal("formatAnthropicBlock returned nil for skill_content")
	}
	if got := out["type"]; got != "text" {
		t.Errorf("type = %v, want text", got)
	}
	if got := out["text"]; got != body {
		t.Errorf("text = %v, want %q", got, body)
	}
	allowed := map[string]struct{}{"type": {}, "text": {}}
	for k := range out {
		if _, ok := allowed[k]; !ok {
			t.Errorf("unexpected wire field %q", k)
		}
	}
}

func TestFormatAnthropicBlock_SkillContentEmptyFallback(t *testing.T) {
	out := formatAnthropicBlock(types.LlmContentBlock{Type: "skill_content"})
	if out == nil {
		t.Fatal("returned nil for empty skill_content")
	}
	if got := out["type"]; got != "text" {
		t.Errorf("type = %v, want text", got)
	}
	text, _ := out["text"].(string)
	if text == "" {
		t.Error("text must be non-empty even when Text is empty")
	}
}

func TestOpenAI_SkillContentFlattensToText(t *testing.T) {
	const body = "skill rendered body"
	msgs := []types.LlmMessage{{
		Role:    "user",
		Content: []types.LlmContentBlock{skillBlock(body)},
	}}
	result := formatOpenAIMessages("", msgs)
	// result[0] is the system message; user message is result[1].
	if len(result) < 2 {
		t.Fatal("expected at least 2 messages (system + user)")
	}
	raw, _ := json.Marshal(result[1]["content"])
	var parts []map[string]any
	if err := json.Unmarshal(raw, &parts); err != nil {
		t.Fatalf("content not a list: %v", err)
	}
	if len(parts) == 0 {
		t.Fatal("no content parts")
	}
	if got := parts[0]["type"]; got != "text" {
		t.Errorf("type = %v, want text", got)
	}
	if got := parts[0]["text"]; got != body {
		t.Errorf("text = %v, want %q", got, body)
	}
}

func TestOpenAIResponses_SkillContentFlattensToInputText(t *testing.T) {
	const body = "responses skill body"
	msgs := []types.LlmMessage{{
		Role:    "user",
		Content: []types.LlmContentBlock{skillBlock(body)},
	}}
	items := formatResponsesInput(msgs)
	if len(items) == 0 {
		t.Fatal("no items returned")
	}
	raw, _ := json.Marshal(items[0]["content"])
	var parts []map[string]any
	if err := json.Unmarshal(raw, &parts); err != nil {
		t.Fatalf("content not a list: %v", err)
	}
	if len(parts) == 0 {
		t.Fatal("no content parts")
	}
	if got := parts[0]["type"]; got != "input_text" {
		t.Errorf("type = %v, want input_text", got)
	}
	if got := parts[0]["text"]; got != body {
		t.Errorf("text = %v, want %q", got, body)
	}
}

func TestGoogle_SkillContentFlattensToText(t *testing.T) {
	const body = "google skill body"
	msgs := []types.LlmMessage{{
		Role:    "user",
		Content: []types.LlmContentBlock{skillBlock(body)},
	}}
	result := formatGeminiMessages(msgs)
	if len(result) == 0 {
		t.Fatal("no messages returned")
	}
	raw, _ := json.Marshal(result[0]["parts"])
	var parts []map[string]any
	if err := json.Unmarshal(raw, &parts); err != nil {
		t.Fatalf("parts not a list: %v", err)
	}
	if len(parts) == 0 {
		t.Fatal("no parts")
	}
	if got := parts[0]["text"]; got != body {
		t.Errorf("text = %v, want %q", got, body)
	}
}

func TestBedrock_SkillContentFlattensToText(t *testing.T) {
	const body = "bedrock skill body"
	msgs := []types.LlmMessage{{
		Role:    "user",
		Content: []types.LlmContentBlock{skillBlock(body)},
	}}
	result := formatBedrockMessages(msgs)
	if len(result) == 0 {
		t.Fatal("no messages returned")
	}
	raw, _ := json.Marshal(result[0]["content"])
	var parts []map[string]any
	if err := json.Unmarshal(raw, &parts); err != nil {
		t.Fatalf("content not a list: %v", err)
	}
	if len(parts) == 0 {
		t.Fatal("no content parts")
	}
	if got := parts[0]["text"]; got != body {
		t.Errorf("text = %v, want %q", got, body)
	}
}
