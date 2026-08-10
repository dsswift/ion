package backend

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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

// TestMcpEphemeralImagesReachOneProviderTurn pins full MCP image lifecycle:
// router output becomes first follow-up provider input, never becomes a durable
// event or image file, then disappears before the next provider request and
// conversation save. Reverting the EphemeralImages assignment in executeTools
// fails first-request assertion; removing run-loop cleanup fails second-request
// assertion.
func TestMcpEphemeralImagesReachOneProviderTurn(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)
	t.Setenv("ION_DATA_DIR", tmpHome)

	const payload = "AAECAw=="
	mock := setupTestProvider([][]types.LlmStreamEvent{
		toolUseResponse("mcp__charts__render", "mcp-image-tool", map[string]any{}, 10, 5),
		toolUseResponse("mcp__charts__follow_up", "mcp-follow-up-tool", map[string]any{}, 10, 5),
		textResponse("done", 10, 5),
	})

	b := NewApiBackend()
	collector := collectEvents(b, "mcp-ephemeral-image")
	b.StartRunWithConfig("mcp-ephemeral-image", types.RunOptions{
		Prompt:           "render then continue",
		ProjectPath:      tmpHome,
		Model:            testModel,
		ConversationID:   "mcp-ephemeral-image-conversation",
		EarlyStopEnabled: testEarlyStopDisabled(),
	}, &RunConfig{
		McpToolRouter: func(_ context.Context, name string, _ map[string]interface{}) (*types.ToolResult, error) {
			if name == "mcp__charts__render" {
				return &types.ToolResult{
					Content: "chart rendered",
					EphemeralImages: []*types.ImageSource{{
						Type: "base64", MediaType: "image/png", Data: payload,
					}},
				}, nil
			}
			return &types.ToolResult{Content: "follow-up complete"}, nil
		},
	})

	if !waitForExit(collector, 5*time.Second) {
		t.Fatal("timed out waiting for MCP image run")
	}

	mock.mu.Lock()
	requests := append([]types.LlmStreamOptions(nil), mock.requests...)
	mock.mu.Unlock()
	if len(requests) != 3 {
		t.Fatalf("provider requests = %d, want 3", len(requests))
	}
	if !streamOptionsContainImage(requests[1], payload) {
		t.Fatal("first provider request after MCP tool did not receive ephemeral image")
	}
	if streamOptionsContainImage(requests[2], payload) {
		t.Fatal("ephemeral MCP image replayed into later provider request")
	}

	collector.mu.Lock()
	for _, event := range collector.normalized {
		switch data := event.Data.(type) {
		case *types.ToolResultEvent:
			if len(data.Images) != 0 {
				collector.mu.Unlock()
				t.Fatalf("ephemeral MCP image emitted as durable tool image: %#v", data.Images)
			}
		case *types.ImageContentEvent:
			collector.mu.Unlock()
			t.Fatalf("ephemeral MCP image emitted as image content event: %#v", data)
		}
	}
	collector.mu.Unlock()

	conv, err := conversation.Load("mcp-ephemeral-image-conversation", "")
	if err != nil {
		t.Fatalf("load persisted conversation: %v", err)
	}
	for _, message := range conv.Messages {
		blocks, ok := message.Content.([]types.LlmContentBlock)
		if !ok {
			continue
		}
		for _, block := range blocks {
			if block.Source != nil && block.Source.Data == payload {
				t.Fatal("ephemeral MCP image persisted in conversation history")
			}
		}
	}

	conversationDir := conversation.DefaultConversationsDir()
	if err := filepath.Walk(conversationDir, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if info.IsDir() {
			return nil
		}
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		if strings.Contains(string(data), payload) {
			t.Fatalf("ephemeral MCP image persisted in %s", path)
		}
		return nil
	}); err != nil {
		t.Fatalf("scan conversation persistence: %v", err)
	}
}

func streamOptionsContainImage(opts types.LlmStreamOptions, payload string) bool {
	for _, message := range opts.Messages {
		blocks, ok := message.Content.([]types.LlmContentBlock)
		if !ok {
			continue
		}
		for _, block := range blocks {
			if block.Type == "image" && block.Source != nil && block.Source.Data == payload {
				return true
			}
		}
	}
	return false
}
