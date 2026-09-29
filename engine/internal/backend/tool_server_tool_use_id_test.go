package backend

import (
	"context"
	"net"
	"testing"

	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

// callSeenToolUseID registers a tool that records the tool-use ID on its
// context, sends one tools/call with the given params over the real socket, and
// returns what the handler saw.
func callSeenToolUseID(t *testing.T, params map[string]interface{}) string {
	t.Helper()
	seen := "unset"
	ts := NewToolServer("tool-use-id-test")
	ts.RegisterTool("probe", func(ctx context.Context, _ map[string]interface{}) (*types.ToolResult, error) {
		seen = tools.BackgroundToolIDFromContext(ctx)
		return &types.ToolResult{Content: "ok"}, nil
	}, "Probe tool", nil)
	defer ts.Stop()
	if err := ts.Start(); err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	conn, err := net.Dial("unix", ts.SocketPath())
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close()
	initializeSession(t, conn)

	resp := sendJSONRPC(t, conn, "tools/call", 1, params)
	if _, ok := resp["result"].(map[string]interface{}); !ok {
		t.Fatalf("expected result object, got: %v", resp)
	}
	return seen
}

// A delegated Claude Code CLI sends the model's tool-use ID in `_meta`. A
// background command the tool starts must carry it, or the client cannot tie
// the live task to the transcript row that started it.
func TestToolServer_StampsToolUseIDFromMeta(t *testing.T) {
	got := callSeenToolUseID(t, map[string]interface{}{
		"name":      "probe",
		"arguments": map[string]interface{}{},
		"_meta":     map[string]interface{}{"claudecode/toolUseId": "toolu_meta_1"},
	})
	if got != "toolu_meta_1" {
		t.Fatalf("handler saw tool-use id %q, want %q", got, "toolu_meta_1")
	}
}

func TestToolServer_NoMetaLeavesToolUseIDEmpty(t *testing.T) {
	got := callSeenToolUseID(t, map[string]interface{}{
		"name":      "probe",
		"arguments": map[string]interface{}{},
	})
	if got != "" {
		t.Fatalf("handler saw tool-use id %q, want none", got)
	}
}
