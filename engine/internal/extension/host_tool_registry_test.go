package extension

import "testing"

func TestHostToolRegistryRejectsStaleAndInvalidSnapshots(t *testing.T) {
	host := NewHost()
	initial := []toolRegistryTool{{Name: "one", Description: "first", Parameters: map[string]any{"type": "object"}}}
	if err := host.initToolRegistry(initial); err != nil {
		t.Fatalf("init registry: %v", err)
	}
	if !host.hasAcceptedTool("one") {
		t.Fatal("initial tool missing")
	}
	if err := host.applyToolSnapshot(toolRegistrySnapshot{Revision: 1, Tools: []toolRegistryTool{{Name: "two", Description: "second", Parameters: map[string]any{"type": "object"}}}}, false); err != nil {
		t.Fatalf("apply newer snapshot: %v", err)
	}
	if host.hasAcceptedTool("one") || !host.hasAcceptedTool("two") {
		t.Fatal("snapshot did not atomically replace tools")
	}
	if err := host.applyToolSnapshot(toolRegistrySnapshot{Revision: 0, Tools: initial}, false); err == nil {
		t.Fatal("stale revision accepted")
	}
	if err := host.applyToolSnapshot(toolRegistrySnapshot{Revision: 2, Tools: []toolRegistryTool{{Name: "bad", Description: "bad", Parameters: map[string]any{"type": "array"}}}}, false); err == nil {
		t.Fatal("invalid schema accepted")
	}
	if !host.hasAcceptedTool("two") {
		t.Fatal("invalid snapshot changed accepted registry")
	}
}
