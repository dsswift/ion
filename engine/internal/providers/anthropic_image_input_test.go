package providers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestAnthropicRequestPreservesMediaFirstImageInput pins the final HTTP request
// shape after the backend has built a media-first user message. The payload is
// asserted at the provider boundary so a formatter change cannot silently drop
// the image bytes, MIME type, or ordering while earlier attachment tests pass.
func TestAnthropicRequestPreservesMediaFirstImageInput(t *testing.T) {
	const imageData = "AAECAwQ="
	bodyCh := make(chan map[string]any, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request body: %v", err)
			return
		}
		bodyCh <- body
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	}))
	defer server.Close()

	provider := NewAnthropicProvider(&ProviderOptions{APIKey: "test-key", BaseURL: server.URL})
	events, errc := provider.Stream(t.Context(), types.LlmStreamOptions{
		Model: "test-model",
		Messages: []types.LlmMessage{{
			Role: "user",
			Content: []types.LlmContentBlock{
				{
					Type: "image",
					Source: &types.ImageSource{
						Type:      "base64",
						MediaType: "image/jpeg",
						Data:      imageData,
					},
				},
				{Type: "text", Text: "Analyze the attached files."},
			},
		}},
	})
	for range events { //nolint:revive // drain the complete test stream
	}
	if err := <-errc; err != nil {
		t.Fatalf("stream request failed: %v", err)
	}

	body := <-bodyCh
	messages, ok := body["messages"].([]any)
	if !ok || len(messages) != 1 {
		t.Fatalf("messages = %#v, want one formatted message", body["messages"])
	}
	message, ok := messages[0].(map[string]any)
	if !ok {
		t.Fatalf("message = %#v, want object", messages[0])
	}
	content, ok := message["content"].([]any)
	if !ok || len(content) != 2 {
		t.Fatalf("content = %#v, want image then text", message["content"])
	}
	image, ok := content[0].(map[string]any)
	if !ok || image["type"] != "image" {
		t.Fatalf("first block = %#v, want image", content[0])
	}
	source, ok := image["source"].(map[string]any)
	if !ok {
		t.Fatalf("image source = %#v, want object", image["source"])
	}
	if source["type"] != "base64" || source["media_type"] != "image/jpeg" || source["data"] != imageData {
		t.Fatalf("image source = %#v, want original JPEG payload", source)
	}
	text, ok := content[1].(map[string]any)
	if !ok || text["type"] != "text" || text["text"] != "Analyze the attached files." {
		t.Fatalf("second block = %#v, want actionable text", content[1])
	}
}
