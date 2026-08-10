package conversation

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestAddToolResultsOmitsEphemeralMCPImagesFromPersistence(t *testing.T) {
	const payload = "AAECAw=="
	conv := CreateConversation("attachment", "", "model")
	AddToolResults(conv, []ToolResultEntry{{
		ToolUseID: "example",
		Content:   "attachment.bin, 4 bytes",
		EphemeralImages: []*types.ImageSource{{
			Type: "base64", MediaType: "image/png", Data: payload,
		}},
	}})

	if len(conv.Messages) != 1 {
		t.Fatalf("Messages = %d, want 1", len(conv.Messages))
	}
	live, ok := conv.Messages[0].Content.([]types.LlmContentBlock)
	if !ok || len(live) != 2 || live[1].Source == nil || live[1].Source.Data != payload {
		t.Fatalf("live provider blocks = %#v, want ephemeral image", conv.Messages[0].Content)
	}

	dir := t.TempDir()
	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}
	for _, suffix := range []string{".llm.jsonl", ".tree.jsonl"} {
		data, err := os.ReadFile(filepath.Join(dir, conv.ID+suffix))
		if err != nil {
			t.Fatalf("read %s: %v", suffix, err)
		}
		if strings.Contains(string(data), payload) || strings.Contains(string(data), `"type":"image"`) {
			t.Fatalf("%s persisted ephemeral content: %s", suffix, data)
		}
	}
}
