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

// A tool's always-load mark survives the init handshake and a later registry
// snapshot, so the session can keep it loaded under tool search.
func TestHostToolRegistryCarriesAlwaysLoad(t *testing.T) {
	host := NewHost()
	raw := []byte(`{"tools":[{"name":"core","description":"core","parameters":{"type":"object"},"alwaysLoad":true},{"name":"lazy","description":"lazy","parameters":{"type":"object"}}]}`)
	if err := host.parseInitResult(raw); err != nil {
		t.Fatalf("parse init: %v", err)
	}
	always := map[string]bool{}
	for _, tool := range host.SDK().Tools() {
		always[tool.Name] = tool.AlwaysLoad
	}
	if !always["core"] || always["lazy"] {
		t.Fatalf("init always-load = %v, want core only", always)
	}

	if err := host.applyToolSnapshot(toolRegistrySnapshot{Revision: 1, Tools: []toolRegistryTool{{Name: "core", Description: "core", Parameters: map[string]any{"type": "object"}, AlwaysLoad: true}}}, false); err != nil {
		t.Fatalf("apply snapshot: %v", err)
	}
	for _, tool := range host.SDK().Tools() {
		if tool.Name == "core" && !tool.AlwaysLoad {
			t.Fatal("the snapshot dropped core's always-load mark")
		}
	}
}
