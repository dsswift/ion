package conversation

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCleanupStored(t *testing.T) {
	dir := t.TempDir()

	// Create old conversations (30 days old)
	oldTime := time.Now().AddDate(0, 0, -30)
	writeTestConv(t, dir, "old-conv-1", oldTime)
	writeTestConv(t, dir, "old-conv-2", oldTime)

	// Create recent conversations (1 day old)
	recentTime := time.Now().AddDate(0, 0, -1)
	writeTestConv(t, dir, "recent-conv", recentTime)

	// Create an old conversation with a custom label
	writeTestConv(t, dir, "old-labeled", oldTime)
	addLabelToTree(t, dir, "old-labeled")

	// Create an old conversation that's excluded (open in a tab)
	writeTestConv(t, dir, "old-excluded", oldTime)

	// Create an old conversation that's an active session
	writeTestConv(t, dir, "old-active", oldTime)

	t.Run("dry run counts correctly", func(t *testing.T) {
		count, err := CleanupStored(dir, 14, []string{"old-excluded"}, []string{"old-active"}, true)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		// old-conv-1 and old-conv-2 should be candidates
		// old-labeled is skipped (has label)
		// old-excluded is skipped (in excludeIDs)
		// old-active is skipped (in activeSessionIDs)
		// recent-conv is too new
		if count != 2 {
			t.Errorf("expected 2, got %d", count)
		}
		// Verify no files were actually deleted
		if _, err := os.Stat(filepath.Join(dir, "old-conv-1.llm.jsonl")); err != nil {
			t.Errorf("old-conv-1 should still exist after dry run")
		}
	})

	t.Run("real cleanup deletes old conversations", func(t *testing.T) {
		count, err := CleanupStored(dir, 14, []string{"old-excluded"}, []string{"old-active"}, false)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if count != 2 {
			t.Errorf("expected 2 deleted, got %d", count)
		}
		// old-conv-1 and old-conv-2 should be gone
		for _, id := range []string{"old-conv-1", "old-conv-2"} {
			if _, err := os.Stat(filepath.Join(dir, id+".llm.jsonl")); !os.IsNotExist(err) {
				t.Errorf("%s should have been deleted", id)
			}
			if _, err := os.Stat(filepath.Join(dir, id+".tree.jsonl")); !os.IsNotExist(err) {
				t.Errorf("%s.tree.jsonl should have been deleted", id)
			}
		}
		// Protected conversations should still exist
		for _, id := range []string{"recent-conv", "old-labeled", "old-excluded", "old-active"} {
			if _, err := os.Stat(filepath.Join(dir, id+".llm.jsonl")); err != nil {
				t.Errorf("%s should still exist: %v", id, err)
			}
		}
	})

	t.Run("empty directory is fine", func(t *testing.T) {
		emptyDir := t.TempDir()
		count, err := CleanupStored(emptyDir, 14, nil, nil, false)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if count != 0 {
			t.Errorf("expected 0, got %d", count)
		}
	})

	t.Run("nonexistent directory is fine", func(t *testing.T) {
		count, err := CleanupStored("/nonexistent/path", 14, nil, nil, false)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if count != 0 {
			t.Errorf("expected 0, got %d", count)
		}
	})
}

func writeTestConv(t *testing.T, dir, id string, mtime time.Time) {
	t.Helper()
	llmPath := filepath.Join(dir, id+".llm.jsonl")
	treePath := filepath.Join(dir, id+".tree.jsonl")

	llmContent := `{"meta":true,"id":"` + id + `","version":2,"model":"test"}` + "\n"
	treeContent := `{"meta":true,"id":"` + id + `","version":2}` + "\n"

	if err := os.WriteFile(llmPath, []byte(llmContent), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(treePath, []byte(treeContent), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(llmPath, mtime, mtime); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(treePath, mtime, mtime); err != nil {
		t.Fatal(err)
	}
}

func addLabelToTree(t *testing.T, dir, id string) {
	t.Helper()
	treePath := filepath.Join(dir, id+".tree.jsonl")
	data, err := os.ReadFile(treePath)
	if err != nil {
		t.Fatal(err)
	}
	data = append(data, []byte(`{"id":"lbl1","parentId":null,"type":"label","timestamp":1234567890,"data":{"label":"Important"}}`+"\n")...)
	if err := os.WriteFile(treePath, data, 0o644); err != nil {
		t.Fatal(err)
	}
	// Keep the old mtime so it stays "old"
	oldTime := time.Now().AddDate(0, 0, -30)
	if err := os.Chtimes(treePath, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}
}


