package protocol

import "testing"

// TestParseClientCommand_ToolGateImages pins the optional client-tool image
// result shape on the public socket contract.
func TestParseClientCommand_ToolGateImages(t *testing.T) {
	cmd := ParseClientCommand(`{"cmd":"tool_gate_response","key":"s1","gateRequestId":"gate-1","gateImages":[{"media_type":"image/png","data":"cG5nLWJ5dGVz","contentHash":"abc"}]}`)
	if cmd == nil {
		t.Fatal("tool_gate_response with images did not parse")
	}
	if len(cmd.GateImages) != 1 {
		t.Fatalf("GateImages = %d, want 1", len(cmd.GateImages))
	}
	image := cmd.GateImages[0]
	if image.MediaType != "image/png" || image.Data != "cG5nLWJ5dGVz" || image.ContentHash != "abc" {
		t.Fatalf("GateImages[0] = %#v", image)
	}
}
