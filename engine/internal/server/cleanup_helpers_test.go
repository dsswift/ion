package server

import (
	"os"
	"path/filepath"
	"testing"
)

// TestLoadDesktopProtectedIDs covers the engine's Layer-1 safety guard:
// reading session-chains and session-labels files directly so that even when
// the desktop's excludeIDs list arrives empty, the engine still knows which
// conversations a tab might resume.
//
// The tests cover: missing files (must contribute zero IDs, never error),
// malformed JSON (must log and skip without aborting the whole helper),
// and the happy path with both chains and labels populated for both backends.
func TestLoadDesktopProtectedIDs(t *testing.T) {
	t.Run("missing files contribute zero IDs", func(t *testing.T) {
		home := t.TempDir()
		ids := loadDesktopProtectedIDs(home)
		if len(ids) != 0 {
			t.Errorf("expected 0 IDs from empty home, got %d", len(ids))
		}
	})

	t.Run("happy path collects from chains and labels for both backends", func(t *testing.T) {
		home := t.TempDir()

		// session-chains-api.json: api-root has continuations, plus a reverse map entry
		chainsAPI := `{
			"chains": {
				"api-root-1": ["api-cont-1a", "api-cont-1b"],
				"api-root-2": ["api-cont-2a"]
			},
			"reverse": {
				"api-cont-1a": "api-root-1",
				"api-cont-1b": "api-root-1",
				"api-cont-2a": "api-root-2",
				"api-orphan-rev": "api-orphan-root"
			}
		}`
		writeTestFile(t, filepath.Join(home, "session-chains-api.json"), chainsAPI)

		// session-chains-cli.json: a single chain
		chainsCLI := `{
			"chains": {
				"cli-root": ["cli-cont"]
			},
			"reverse": {
				"cli-cont": "cli-root"
			}
		}`
		writeTestFile(t, filepath.Join(home, "session-chains-cli.json"), chainsCLI)

		// session-labels-api.json: two labeled conversations
		labelsAPI := `{
			"api-labeled-1": "My important thread",
			"api-labeled-2": "Another important thread"
		}`
		writeTestFile(t, filepath.Join(home, "session-labels-api.json"), labelsAPI)

		// session-labels-cli.json: one labeled conversation
		labelsCLI := `{
			"cli-labeled": "CLI-side label"
		}`
		writeTestFile(t, filepath.Join(home, "session-labels-cli.json"), labelsCLI)

		ids := loadDesktopProtectedIDs(home)

		expected := map[string]bool{
			// api chains
			"api-root-1": true, "api-cont-1a": true, "api-cont-1b": true,
			"api-root-2": true, "api-cont-2a": true,
			"api-orphan-rev": true, "api-orphan-root": true,
			// cli chains
			"cli-root": true, "cli-cont": true,
			// labels
			"api-labeled-1": true, "api-labeled-2": true,
			"cli-labeled": true,
		}

		got := make(map[string]bool, len(ids))
		for _, id := range ids {
			got[id] = true
		}

		if len(got) != len(expected) {
			t.Errorf("expected %d unique IDs, got %d: %v", len(expected), len(got), ids)
		}
		for id := range expected {
			if !got[id] {
				t.Errorf("expected ID %q missing from result", id)
			}
		}
		for id := range got {
			if !expected[id] {
				t.Errorf("unexpected ID %q in result", id)
			}
		}
	})

	t.Run("malformed chains JSON is skipped but labels still load", func(t *testing.T) {
		home := t.TempDir()
		writeTestFile(t, filepath.Join(home, "session-chains-api.json"), `{not valid json`)
		writeTestFile(t, filepath.Join(home, "session-labels-api.json"), `{"good-id": "label"}`)

		ids := loadDesktopProtectedIDs(home)
		// chains-api is malformed → contributes 0
		// labels-api is fine → contributes 1
		// cli files are missing → contribute 0
		if len(ids) != 1 || ids[0] != "good-id" {
			t.Errorf("expected exactly [good-id], got %v", ids)
		}
	})

	t.Run("malformed labels JSON is skipped but chains still load", func(t *testing.T) {
		home := t.TempDir()
		writeTestFile(t, filepath.Join(home, "session-chains-api.json"), `{"chains":{"root":["cont"]},"reverse":{"cont":"root"}}`)
		writeTestFile(t, filepath.Join(home, "session-labels-api.json"), `[]`) // wrong shape (array, not object)

		ids := loadDesktopProtectedIDs(home)
		// chains-api gives 2 IDs (root + cont)
		// labels-api parses as array (Go's json.Unmarshal into map[string]string
		// will error on a JSON array) → contributes 0
		got := make(map[string]bool, len(ids))
		for _, id := range ids {
			got[id] = true
		}
		if len(got) != 2 || !got["root"] || !got["cont"] {
			t.Errorf("expected exactly [root, cont], got %v", ids)
		}
	})

	t.Run("empty chains and labels files contribute zero IDs without error", func(t *testing.T) {
		home := t.TempDir()
		writeTestFile(t, filepath.Join(home, "session-chains-api.json"), `{"chains":{},"reverse":{}}`)
		writeTestFile(t, filepath.Join(home, "session-labels-api.json"), `{}`)

		ids := loadDesktopProtectedIDs(home)
		if len(ids) != 0 {
			t.Errorf("expected 0 IDs, got %d: %v", len(ids), ids)
		}
	})

	t.Run("home defaults to ~/.ion when empty string passed", func(t *testing.T) {
		// We can't safely write to the real ~/.ion in a test, so this case
		// just verifies the function doesn't panic and returns a slice
		// (which may be empty or populated depending on the host system).
		ids := loadDesktopProtectedIDs("")
		// Just ensure it returned without panicking; ids may be nil or non-nil.
		_ = ids
	})
}

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
