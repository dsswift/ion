package conversation

// persistence_backend_test.go — pins the additive per-conversation backend
// discriminator. Only the API backend writes the Ion store, so a consumer can
// assert the history format from the conversation itself instead of a global
// mode; "" (legacy files) means api.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestConversation_BackendHeader_RoundTrip(t *testing.T) {
	dir := t.TempDir()

	conv := CreateConversation("backend-rt", "be helpful", "claude-3-5-sonnet")
	conv.Backend = "api"
	AddUserMessage(conv, "hello")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "hi"}},
		types.LlmUsage{InputTokens: 1, OutputTokens: 1})

	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := Load("backend-rt", dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.Backend != "api" {
		t.Fatalf("Backend = %q, want %q", loaded.Backend, "api")
	}

	// Wire shape: the serialized field must be present on BOTH headers, so a
	// consumer reading either sidecar can assert the format.
	for _, name := range []string{"backend-rt.llm.jsonl", "backend-rt.tree.jsonl"} {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		header := strings.SplitN(string(data), "\n", 2)[0]
		if !strings.Contains(header, `"backend":"api"`) {
			t.Errorf("%s header missing backend field: %s", name, header)
		}
	}
}

func TestConversation_BackendHeader_LegacyAbsent(t *testing.T) {
	dir := t.TempDir()

	// A conversation saved WITHOUT a backend (pre-field writer) must load with
	// Backend == "" and no error, and its headers must omit the key entirely
	// (omit-when-empty keeps old-shape consumers byte-compatible).
	conv := CreateConversation("backend-legacy", "sys", "claude-3-5-sonnet")
	AddUserMessage(conv, "hello")
	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	for _, name := range []string{"backend-legacy.llm.jsonl", "backend-legacy.tree.jsonl"} {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		header := strings.SplitN(string(data), "\n", 2)[0]
		if strings.Contains(header, `"backend"`) {
			t.Errorf("%s header should omit backend when unset: %s", name, header)
		}
	}

	loaded, err := Load("backend-legacy", dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.Backend != "" {
		t.Fatalf("Backend = %q, want empty for legacy header", loaded.Backend)
	}
}
