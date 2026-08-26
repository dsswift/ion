package server

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeServerJSON(t *testing.T, path, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestResolveNewConversationDefaults_SingleAndBatch(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	projectOne := t.TempDir()
	projectTwo := t.TempDir()
	writeServerJSON(t, filepath.Join(projectOne, ".ion", "engine.json"), `{"newConversationDefaults":{"baseDirectory":"/one"}}`)
	writeServerJSON(t, filepath.Join(projectTwo, ".ion", "engine.json"), `{"newConversationDefaults":{"baseDirectory":"/two"}}`)

	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]any{"cmd": "resolve_new_conversation_defaults", "path": projectOne, "requestId": "one"})
	single := findResult(t, readLines(t, conn, 3, 2*time.Second))
	if single == nil || !single.OK {
		t.Fatalf("single result = %+v", single)
	}
	singleData, ok := single.Data.(map[string]any)
	if !ok || singleData["baseDirectory"] != "/one" {
		t.Fatalf("single defaults = %#v", single.Data)
	}

	sendJSON(t, conn, map[string]any{"cmd": "resolve_new_conversation_defaults", "paths": []string{projectOne, projectTwo}, "requestId": "batch"})
	batch := findResult(t, readLines(t, conn, 3, 2*time.Second))
	if batch == nil || !batch.OK {
		t.Fatalf("batch result = %+v", batch)
	}
	batchData, ok := batch.Data.(map[string]any)
	if !ok {
		t.Fatalf("batch data = %#v", batch.Data)
	}
	defaults, ok := batchData["defaults"].([]any)
	if !ok || len(defaults) != 2 {
		t.Fatalf("batch defaults = %#v", batchData["defaults"])
	}
	first := defaults[0].(map[string]any)
	second := defaults[1].(map[string]any)
	if first["baseDirectory"] != "/one" || second["baseDirectory"] != "/two" {
		t.Fatalf("batch order/value = %#v", defaults)
	}
}
