package providers

// assistant_image_rehome_test.go pins the provider-formatting contract for
// persisted assistant image blocks (provider-generated images from chat models
// or the image-generation loop):
//
//   - Neither API accepts an image inside an assistant message (Anthropic
//     400s; OpenAI's assistant shape has no image part).
//   - The image is real conversation content the model must SEE on follow-up
//     turns, exactly like a user-uploaded image.
//   - So both formatters carry assistant image blocks forward and re-home
//     them into the NEXT user message (native image block for Anthropic,
//     image_url data URL for OpenAI).
//
// Without the re-homing, Anthropic requests with generated-image history fail
// with invalid_request_error and OpenAI silently drops the image — the
// "switch back to a chat model and it can see the image" workflow breaks.

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

const rehomeB64 = "dGVzdGltYWdlYnl0ZXM=" // "testimagebytes"

func rehomeHistory() []types.LlmMessage {
	return []types.LlmMessage{
		{Role: "user", Content: "generate a cat image"},
		{Role: "assistant", Content: []types.LlmContentBlock{
			{Type: "text", Text: "A fluffy cat."},
			{Type: "image", Source: &types.ImageSource{Type: "base64", MediaType: "image/png", Data: rehomeB64}},
		}},
		{Role: "user", Content: []types.LlmContentBlock{
			{Type: "text", Text: "make it fluffier"},
		}},
	}
}

func TestAnthropicRehomesAssistantImageIntoNextUserMessage(t *testing.T) {
	p := &anthropicProvider{}
	formatted := p.formatMessages(rehomeHistory())

	if len(formatted) != 3 {
		t.Fatalf("formatted message count = %d, want 3", len(formatted))
	}

	// Assistant message must carry NO image block.
	assistant := formatted[1]
	if assistant["role"] != "assistant" {
		t.Fatalf("formatted[1] role = %v, want assistant", assistant["role"])
	}
	for _, blk := range assistant["content"].([]map[string]any) {
		if blk["type"] == "image" {
			t.Error("assistant message still contains an image block; Anthropic rejects this with a 400")
		}
	}

	// The FOLLOWING user message must carry the image block.
	user := formatted[2]
	if user["role"] != "user" {
		t.Fatalf("formatted[2] role = %v, want user", user["role"])
	}
	foundImage := false
	foundProvenance := false
	imageAfterProvenance := false
	for _, blk := range user["content"].([]map[string]any) {
		if blk["type"] == "text" && blk["text"] == assistantImageProvenanceText {
			foundProvenance = true
		}
		if blk["type"] == "image" {
			foundImage = true
			imageAfterProvenance = foundProvenance
			src := blk["source"].(map[string]any)
			if src["data"] != rehomeB64 {
				t.Errorf("re-homed image data = %v, want the original base64", src["data"])
			}
		}
	}
	if !foundImage {
		t.Error("assistant image was not re-homed into the next user message; the model cannot see the generated image")
	}
	if !foundProvenance {
		t.Error("provenance text missing: the model cannot distinguish its own generation from a user upload")
	}
	if !imageAfterProvenance {
		t.Error("provenance text must PRECEDE the re-homed image")
	}
}

func TestOpenAIRehomesAssistantImageIntoNextUserMessage(t *testing.T) {
	formatted := formatOpenAIMessages("sys", rehomeHistory())

	// [0]=system, [1]=user, [2]=assistant, [3]=user
	if len(formatted) != 4 {
		t.Fatalf("formatted message count = %d, want 4", len(formatted))
	}

	assistant := formatted[2]
	if assistant["role"] != "assistant" {
		t.Fatalf("formatted[2] role = %v, want assistant", assistant["role"])
	}
	// OpenAI assistant content is a combined string — must not contain the raw base64.
	if s, ok := assistant["content"].(string); ok && strings.Contains(s, rehomeB64) {
		t.Error("assistant content contains raw image base64")
	}

	user := formatted[3]
	if user["role"] != "user" {
		t.Fatalf("formatted[3] role = %v, want user", user["role"])
	}
	parts, ok := user["content"].([]map[string]any)
	if !ok {
		t.Fatalf("user content is %T, want parts array", user["content"])
	}
	foundImage := false
	for _, part := range parts {
		if part["type"] == "image_url" {
			foundImage = true
			iu := part["image_url"].(map[string]any)
			url := iu["url"].(string)
			if !strings.HasPrefix(url, "data:image/png;base64,") || !strings.Contains(url, rehomeB64) {
				t.Errorf("re-homed image_url = %q, want a data URL carrying the original base64", url)
			}
		}
	}
	if !foundImage {
		t.Error("assistant image was not re-homed into the next user message; the model cannot see the generated image")
	}
}

// TestOpenAIRehomeIntoStringUserMessage pins the string-content user message
// path: when the next user turn is plain string content (the common case), the
// carried image still rides along by promoting the message to parts form.
func TestOpenAIRehomeIntoStringUserMessage(t *testing.T) {
	history := []types.LlmMessage{
		{Role: "assistant", Content: []types.LlmContentBlock{
			{Type: "image", Source: &types.ImageSource{Type: "base64", MediaType: "image/png", Data: rehomeB64}},
		}},
		{Role: "user", Content: "what color is it?"},
	}
	formatted := formatOpenAIMessages("sys", history)

	// [0]=system, [1]=assistant (empty text — may be omitted), last=user
	user := formatted[len(formatted)-1]
	if user["role"] != "user" {
		t.Fatalf("last message role = %v, want user", user["role"])
	}
	parts, ok := user["content"].([]map[string]any)
	if !ok {
		t.Fatalf("user content is %T, want parts array (promoted from string to carry the image)", user["content"])
	}
	foundImage, foundText := false, false
	for _, part := range parts {
		if part["type"] == "image_url" {
			foundImage = true
		}
		if part["type"] == "text" && part["text"] == "what color is it?" {
			foundText = true
		}
	}
	if !foundImage {
		t.Error("carried image missing from promoted user message")
	}
	if !foundText {
		t.Error("original user text missing from promoted user message")
	}
}
