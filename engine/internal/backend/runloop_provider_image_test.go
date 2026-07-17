package backend

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestProcessStreamProviderImageEmitsImageContentEvent pins the provider
// image-output path end to end at processStream: an "image" content block
// carrying base64 bytes + media type must be saved to the conversation's
// images/ directory and surfaced as an ImageContentEvent whose Path is the
// on-disk file (never base64), Source is "provider", and ToolID is empty.
//
// Reverting the content_block_start image branch (or saveProviderImage) turns
// this red: no ImageContentEvent is emitted.
func TestProcessStreamProviderImageEmitsImageContentEvent(t *testing.T) {
	// Point ~/.ion at a temp dir so the shared image saver writes under it.
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	b := NewApiBackend()
	var captured []types.NormalizedEvent
	b.OnNormalized(func(_ string, ev types.NormalizedEvent) {
		captured = append(captured, ev)
	})

	run := &activeRun{requestID: "prov-img", conv: &conversation.Conversation{ID: "conv-img-1"}}

	// base64 of the 5 bytes {0,1,2,3,4}
	const b64 = "AAECAwQ="
	evs := []types.LlmStreamEvent{
		{Type: "message_start", MessageInfo: &types.LlmStreamMessageInfo{ID: "m1", Model: "test"}},
		{
			Type:       "content_block_start",
			BlockIndex: 0,
			ContentBlock: &types.LlmStreamContentBlock{
				Type:           "image",
				ImageData:      b64,
				ImageMediaType: "image/png",
			},
		},
		{Type: "content_block_stop", BlockIndex: 0},
		{Type: "message_delta", Delta: &types.LlmStreamDelta{Type: "message_delta", StopReason: strPtr("end_turn")}},
	}

	events, errc := streamEventChan(evs)
	if _, _, _, err := b.processStream(context.Background(), run, events, errc); err != nil {
		t.Fatalf("processStream error: %v", err)
	}

	var img *types.ImageContentEvent
	for _, ev := range captured {
		if ic, ok := ev.Data.(*types.ImageContentEvent); ok {
			img = ic
			break
		}
	}
	if img == nil {
		t.Fatal("no ImageContentEvent emitted for a provider image content block")
	}
	if img.Source != "provider" {
		t.Errorf("Source = %q, want provider", img.Source)
	}
	if img.ToolID != "" {
		t.Errorf("ToolID = %q, want empty for provider-generated image", img.ToolID)
	}
	if img.MediaType != "image/png" {
		t.Errorf("MediaType = %q, want image/png", img.MediaType)
	}
	if img.Path == "" {
		t.Fatal("Path is empty; provider image was not saved to disk")
	}
	// Path must be a real file under the temp HOME, and must not be base64.
	if img.Path == b64 {
		t.Fatal("Path carries base64 data instead of a file path")
	}
	wantPrefix := filepath.Join(tmpHome, ".ion", "conversations", "conv-img-1", "images")
	if len(img.Path) < len(wantPrefix) || img.Path[:len(wantPrefix)] != wantPrefix {
		t.Errorf("Path = %q, want it under %q", img.Path, wantPrefix)
	}
	data, err := os.ReadFile(img.Path)
	if err != nil {
		t.Fatalf("saved image not readable at %q: %v", img.Path, err)
	}
	if len(data) != 5 {
		t.Errorf("saved image bytes = %d, want 5 (the decoded payload)", len(data))
	}
}
