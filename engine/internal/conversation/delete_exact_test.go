package conversation

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDeleteStoredExactRemovesConversationFileSet(t *testing.T) {
	dir := t.TempDir()
	for _, suffix := range []string{".tree.jsonl", ".llm.jsonl", ".memory.md"} {
		if err := os.WriteFile(filepath.Join(dir, "gone"+suffix), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	deleted, err := DeleteStoredExact(dir, []string{"gone"}, nil)
	if err != nil || deleted != 1 {
		t.Fatalf("DeleteStoredExact() = %d, %v", deleted, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "gone.llm.jsonl")); !os.IsNotExist(err) {
		t.Fatalf("conversation file remains: %v", err)
	}
}

func TestDeleteStoredExactRefusesActiveConversation(t *testing.T) {
	if _, err := DeleteStoredExact(t.TempDir(), []string{"live"}, []string{"live"}); err == nil {
		t.Fatal("DeleteStoredExact accepted active conversation")
	}
}

func TestDeleteStoredExactRejectsTraversal(t *testing.T) {
	if _, err := DeleteStoredExact(t.TempDir(), []string{"../escape"}, nil); err == nil {
		t.Fatal("DeleteStoredExact accepted traversal ID")
	}
}
