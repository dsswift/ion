package conversation

// persistence_native_sessions_test.go — pins the additive per-provider
// native-session cursor map persisted in the .tree.jsonl header. Cursors are
// a disposable per-provider cache over the transcript; persistence is what
// carries delegated-CLI continuity across an engine restart.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestConversation_NativeSessions_RoundTrip(t *testing.T) {
	dir := t.TempDir()

	conv := CreateConversation("ns-rt", "sys", "claude-opus-4-8")
	AddUserMessage(conv, "hello")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "hi"}},
		types.LlmUsage{InputTokens: 1, OutputTokens: 1})
	leaf := ""
	if conv.LeafID != nil {
		leaf = *conv.LeafID
	}
	conv.NativeSessions = map[string]NativeSessionCursor{
		"claude-code": {Cursor: "11111111-2222-3333-4444-555555555555", HeadEntryID: leaf},
		"codex":       {Cursor: "thread-abc", HeadEntryID: "stale-head"},
	}

	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := Load("ns-rt", dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(loaded.NativeSessions) != 2 {
		t.Fatalf("NativeSessions len = %d, want 2", len(loaded.NativeSessions))
	}
	cc := loaded.NativeSessions["claude-code"]
	if cc.Cursor != "11111111-2222-3333-4444-555555555555" || cc.HeadEntryID != leaf {
		t.Errorf("claude-code cursor = %+v, want {uuid %s}", cc, leaf)
	}
	cx := loaded.NativeSessions["codex"]
	if cx.Cursor != "thread-abc" || cx.HeadEntryID != "stale-head" {
		t.Errorf("codex cursor = %+v, want {thread-abc stale-head}", cx)
	}

	// Wire shape: the cursor map lives on the TREE header (it is
	// position-tagged against the tree's leaf), not the llm header.
	treeData, err := os.ReadFile(filepath.Join(dir, "ns-rt.tree.jsonl"))
	if err != nil {
		t.Fatalf("read tree file: %v", err)
	}
	treeHeader := strings.SplitN(string(treeData), "\n", 2)[0]
	if !strings.Contains(treeHeader, `"nativeSessions"`) || !strings.Contains(treeHeader, `"headEntryId"`) {
		t.Errorf("tree header missing nativeSessions field: %s", treeHeader)
	}
}

func TestConversation_NativeSessions_AbsentOnLegacyHeader(t *testing.T) {
	dir := t.TempDir()

	// A conversation saved with no cursors must omit the key entirely
	// (omit-when-empty keeps old-shape consumers byte-compatible) and load
	// with a nil map.
	conv := CreateConversation("ns-legacy", "sys", "claude-opus-4-8")
	AddUserMessage(conv, "hello")
	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	treeData, err := os.ReadFile(filepath.Join(dir, "ns-legacy.tree.jsonl"))
	if err != nil {
		t.Fatalf("read tree file: %v", err)
	}
	treeHeader := strings.SplitN(string(treeData), "\n", 2)[0]
	if strings.Contains(treeHeader, `"nativeSessions"`) {
		t.Errorf("tree header should omit nativeSessions when empty: %s", treeHeader)
	}

	loaded, err := Load("ns-legacy", dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.NativeSessions != nil {
		t.Fatalf("NativeSessions = %v, want nil for legacy header", loaded.NativeSessions)
	}
}
