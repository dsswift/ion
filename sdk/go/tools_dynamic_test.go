package ion

import (
	"context"
	"testing"
)

func TestDeregisterToolKeepsPreInitRevisionZero(t *testing.T) {
	sdk := New()
	sdk.RegisterTool(ToolDef{Name: "one", Description: "one", Parameters: map[string]any{"type": "object"}})
	if !sdk.DeregisterTool("one") {
		t.Fatal("registered tool was not removed")
	}
	if sdk.toolRevision != 0 {
		t.Fatalf("pre-init revision = %d, want 0", sdk.toolRevision)
	}
	if sdk.DeregisterTool("one") {
		t.Fatal("missing tool reported removed")
	}
	if _, err := sdk.SyncTools(context.Background()); err != nil {
		t.Fatalf("pre-init sync: %v", err)
	}
}
