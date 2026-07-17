package backend

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestExecuteToolsMcpImagesSurviveAndEmit pins the tool-result image path end to
// end through executeTools:
//
//  1. Images returned by an MCP/extension tool via the McpToolRouter survive
//     into results[i].Images (regression for the original dropped-image bug,
//     where prompt_runconfig flattened the ToolResult to (content, isErr)).
//  2. executeTools emits a ToolResultEvent carrying ToolResultImage entries with
//     the on-disk FILE PATH (never base64), Source="tool".
//  3. executeTools emits one ImageContentEvent per image with Source="tool" and
//     the producing tool's ToolID.
//
// Revert-check: dropping ToolResult.Images in the McpToolRouter path, or the
// image emission in runloop_tools.go, turns this red.
func TestExecuteToolsMcpImagesSurviveAndEmit(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	b := NewApiBackend()
	var captured []types.NormalizedEvent
	b.OnNormalized(func(_ string, ev types.NormalizedEvent) {
		captured = append(captured, ev)
	})

	const b64 = "AAECAwQ=" // 5 bytes
	run := &activeRun{
		requestID: "mcp-images",
		conv:      &conversation.Conversation{ID: "conv-tool-img"},
		cfg: &RunConfig{
			McpToolRouter: func(_ context.Context, name string, _ map[string]interface{}) (*types.ToolResult, error) {
				return &types.ToolResult{
					Content: "rendered the chart",
					Images: []*types.ImageSource{
						{Type: "base64", MediaType: "image/png", Data: b64},
					},
				}, nil
			},
		},
	}

	blocks := []types.LlmContentBlock{{
		Name:  "mcp__charts__render",
		ID:    "tc-img-1",
		Input: map[string]interface{}{"spec": "bar"},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatalf("executeTools error: %v", err)
	}

	// (1) Images survived the routing hop into the ToolResultEntry.
	if len(results[0].Images) != 1 {
		t.Fatalf("results[0].Images len = %d, want 1 (router images were dropped)", len(results[0].Images))
	}

	// (2) ToolResultEvent carries a path-bearing image, not base64.
	var tre *types.ToolResultEvent
	var ice *types.ImageContentEvent
	for _, ev := range captured {
		switch d := ev.Data.(type) {
		case *types.ToolResultEvent:
			if d.ToolID == "tc-img-1" {
				tre = d
			}
		case *types.ImageContentEvent:
			ice = d
		}
	}
	if tre == nil {
		t.Fatal("no ToolResultEvent emitted for the tool call")
	}
	if len(tre.Images) != 1 {
		t.Fatalf("ToolResultEvent.Images len = %d, want 1", len(tre.Images))
	}
	if tre.Images[0].Source != "tool" {
		t.Errorf("ToolResultImage.Source = %q, want tool", tre.Images[0].Source)
	}
	if tre.Images[0].Path == b64 || tre.Images[0].Path == "" {
		t.Errorf("ToolResultImage.Path = %q, want an on-disk file path (not base64)", tre.Images[0].Path)
	}

	// (3) ImageContentEvent with Source="tool" and the producing ToolID.
	if ice == nil {
		t.Fatal("no ImageContentEvent emitted for the tool image")
	}
	if ice.Source != "tool" {
		t.Errorf("ImageContentEvent.Source = %q, want tool", ice.Source)
	}
	if ice.ToolID != "tc-img-1" {
		t.Errorf("ImageContentEvent.ToolID = %q, want tc-img-1", ice.ToolID)
	}

	// The saved file exists under the conversation images dir and holds the
	// decoded bytes.
	wantPrefix := filepath.Join(tmpHome, ".ion", "conversations", "conv-tool-img", "images")
	if len(ice.Path) < len(wantPrefix) || ice.Path[:len(wantPrefix)] != wantPrefix {
		t.Errorf("ImageContentEvent.Path = %q, want it under %q", ice.Path, wantPrefix)
	}
	data, readErr := os.ReadFile(ice.Path)
	if readErr != nil {
		t.Fatalf("saved image not readable: %v", readErr)
	}
	if len(data) != 5 {
		t.Errorf("saved image bytes = %d, want 5", len(data))
	}
}
