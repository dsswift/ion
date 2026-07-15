package providers

import (
	"strings"
	"testing"
)

func newTestGoogle(baseURL string) LlmProvider {
	return NewGoogleProvider(&ProviderOptions{
		ID:      "google-test",
		APIKey:  "test-key",
		BaseURL: baseURL,
	})
}

// TestGoogleStreamInlineDataImage pins Gemini image-output parsing: a candidate
// part carrying inlineData:{mimeType,data} must emit an image content block
// carrying the MIME type + base64 payload. Without the geminiPart.InlineData
// parsing this block is never emitted and the assertion fails.
func TestGoogleStreamInlineDataImage(t *testing.T) {
	body := strings.Join([]string{
		`data: {"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"AAECAwQ="}}]}}]}`,
		`data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}`,
		"",
	}, "\n\n")

	srv := sseServer(t, body)
	defer srv.Close()

	events, err := drainStream(t, newTestGoogle(srv.URL))
	if err != nil {
		t.Fatalf("stream error: %v", err)
	}
	img := findImageBlock(events)
	if img == nil {
		t.Fatal("no image content block emitted; Gemini dropped the inlineData image output")
	}
	if img.ImageMediaType != "image/png" {
		t.Errorf("media type = %q, want image/png", img.ImageMediaType)
	}
	if img.ImageData != "AAECAwQ=" {
		t.Errorf("image data = %q, want the inlineData base64 payload", img.ImageData)
	}
}
