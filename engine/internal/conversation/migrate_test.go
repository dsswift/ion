//go:build integration

package conversation

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// --- helpers ---

var noUsage = types.LlmUsage{}

func textBlocks(s string) []types.LlmContentBlock {
	return []types.LlmContentBlock{{Type: "text", Text: s}}
}

func writeClaudeFixture(t *testing.T, dir, name string, lines []map[string]any) string {
	t.Helper()
	var parts []string
	for _, l := range lines {
		b, err := json.Marshal(l)
		if err != nil {
			t.Fatal(err)
		}
		parts = append(parts, string(b))
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(strings.Join(parts, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func claudeLine(role, text, uuid string) map[string]any {
	return map[string]any{
		"type":      role,
		"uuid":      uuid,
		"timestamp": "2024-01-01T00:00:00Z",
		"message":   map[string]any{"role": role, "content": text},
	}
}

// --- tests ---

func TestConvertIonToClaudeCode_Basic(t *testing.T) {
	conv := CreateConversation("ion2cc-basic", "", "claude-3")
	conv.WorkingDirectory = "/home/user/project"
	AddUserMessage(conv, "hello")
	AddAssistantMessage(conv, textBlocks("hi"), noUsage)
	AddUserMessage(conv, "how are you")
	AddAssistantMessage(conv, textBlocks("good"), noUsage)

	res, err := ConvertIonToClaudeCode(conv, "cc-sess", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if res.MessageCount != 4 {
		t.Fatalf("MessageCount = %d, want 4", res.MessageCount)
	}
	data, err := os.ReadFile(res.OutputPath)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 4 {
		t.Fatalf("output lines = %d, want 4", len(lines))
	}

	// Verify full envelope fields
	requiredKeys := []string{"type", "uuid", "parentUuid", "sessionId", "timestamp", "isSidechain", "userType", "cwd", "version", "message"}
	for i, line := range lines {
		var obj map[string]any
		if err := json.Unmarshal([]byte(line), &obj); err != nil {
			t.Fatalf("line %d: invalid JSON: %v", i, err)
		}
		for _, key := range requiredKeys {
			if _, ok := obj[key]; !ok {
				t.Errorf("line %d: missing field %q", i, key)
			}
		}
		if obj["sessionId"] != "cc-sess" {
			t.Errorf("line %d: sessionId = %v, want cc-sess", i, obj["sessionId"])
		}
		if obj["cwd"] != "/home/user/project" {
			t.Errorf("line %d: cwd = %v, want /home/user/project", i, obj["cwd"])
		}
	}

	// Verify parentUuid chain
	var first, second map[string]any
	json.Unmarshal([]byte(lines[0]), &first)
	json.Unmarshal([]byte(lines[1]), &second)
	if first["parentUuid"] != nil {
		t.Errorf("first line parentUuid should be null, got %v", first["parentUuid"])
	}
	if second["parentUuid"] != first["uuid"] {
		t.Errorf("second line parentUuid = %v, want %v", second["parentUuid"], first["uuid"])
	}

	// user maps to user (modern Claude Code format)
	if first["type"] != "user" {
		t.Errorf("first line type = %v, want user", first["type"])
	}
}

func TestConvertIonToClaudeCode_ToolUse(t *testing.T) {
	conv := CreateConversation("ion2cc-tool", "", "claude-3")
	AddUserMessage(conv, "use a tool")
	AddAssistantMessage(conv, []types.LlmContentBlock{
		{Type: "text", Text: "calling tool"},
		{Type: "tool_use", ID: "tu_1", Name: "bash", Input: map[string]any{"cmd": "ls"}},
	}, noUsage)
	isErr := false
	AppendEntry(conv, EntryMessage, MessageData{Role: "user", Content: []types.LlmContentBlock{
		{Type: "tool_result", ToolUseID: "tu_1", Content: "file.txt", IsError: &isErr},
	}})

	res, err := ConvertIonToClaudeCode(conv, "cc-tool", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(res.OutputPath)
	if !strings.Contains(string(data), "tool_use") {
		t.Error("output should contain tool_use block")
	}
}

func TestConvertIonToClaudeCode_SkipsNonMessage(t *testing.T) {
	conv := CreateConversation("ion2cc-skip", "", "claude-3")
	AddUserMessage(conv, "first")
	label := "checkpoint"
	AppendEntry(conv, EntryLabel, LabelData{TargetID: conv.Entries[0].ID, Label: &label})
	AddUserMessage(conv, "second")

	res, err := ConvertIonToClaudeCode(conv, "cc-skip", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if res.MessageCount != 2 {
		t.Fatalf("MessageCount = %d, want 2 (label skipped)", res.MessageCount)
	}
}

func TestConvertClaudeCodeToIon_Basic(t *testing.T) {
	dir, outDir := t.TempDir(), t.TempDir()
	fixture := writeClaudeFixture(t, dir, "input.jsonl", []map[string]any{
		claudeLine("human", "hello", "uuid-1"),
		claudeLine("assistant", "hi there", "uuid-2"),
		claudeLine("human", "bye", "uuid-3"),
	})

	res, err := ConvertClaudeCodeToIon(fixture, "ion-sess", outDir)
	if err != nil {
		t.Fatal(err)
	}
	if res.MessageCount != 3 {
		t.Fatalf("MessageCount = %d, want 3", res.MessageCount)
	}
	loaded, err := Load("ion-sess", outDir)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Version != CurrentVersion {
		t.Errorf("Version = %d, want %d", loaded.Version, CurrentVersion)
	}
	if len(loaded.Entries) != 3 {
		t.Fatalf("Entries = %d, want 3", len(loaded.Entries))
	}
	if loaded.Entries[0].ParentID != nil {
		t.Error("first entry should have nil parent")
	}
	if loaded.Entries[1].ParentID == nil || *loaded.Entries[1].ParentID != loaded.Entries[0].ID {
		t.Error("second entry should chain to first")
	}
	if loaded.Entries[2].ParentID == nil || *loaded.Entries[2].ParentID != loaded.Entries[1].ID {
		t.Error("third entry should chain to second")
	}
	if loaded.LeafID == nil || *loaded.LeafID != loaded.Entries[2].ID {
		t.Error("leafId should point to last entry")
	}
}

func TestConvertClaudeCodeToIon_ToolUse(t *testing.T) {
	dir, outDir := t.TempDir(), t.TempDir()
	fixture := writeClaudeFixture(t, dir, "tool.jsonl", []map[string]any{
		claudeLine("human", "do something", "uuid-1"),
		{
			"type": "assistant", "uuid": "uuid-2", "timestamp": "2024-01-01T00:00:00Z",
			"message": map[string]any{
				"role": "assistant",
				"content": []any{
					map[string]any{"type": "text", "text": "calling tool"},
					map[string]any{"type": "tool_use", "id": "tu_1", "name": "bash", "input": map[string]any{"cmd": "ls"}},
				},
			},
		},
	})
	res, err := ConvertClaudeCodeToIon(fixture, "ion-tool", outDir)
	if err != nil {
		t.Fatal(err)
	}
	if res.MessageCount != 2 {
		t.Fatalf("MessageCount = %d, want 2", res.MessageCount)
	}
	raw, _ := os.ReadFile(filepath.Join(outDir, "ion-tool.jsonl"))
	if !strings.Contains(string(raw), "tool_use") {
		t.Error("tool_use block should be preserved in Ion output")
	}
}

func TestConvertRoundTrip_IonToClaudeToIon(t *testing.T) {
	conv := CreateConversation("rt-i2c2i", "", "claude-3")
	for i := 0; i < 3; i++ {
		AddUserMessage(conv, fmt.Sprintf("question %d", i))
		AddAssistantMessage(conv, textBlocks(fmt.Sprintf("answer %d", i)), noUsage)
	}
	res1, err := ConvertIonToClaudeCode(conv, "cc-rt", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	res2, err := ConvertClaudeCodeToIon(res1.OutputPath, "ion-rt", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if res1.ContentHash != res2.ContentHash {
		t.Errorf("hash mismatch: %s vs %s", res1.ContentHash, res2.ContentHash)
	}
}

func TestConvertRoundTrip_ClaudeToIonToClaude(t *testing.T) {
	fixture := writeClaudeFixture(t, t.TempDir(), "rt.jsonl", []map[string]any{
		claudeLine("human", "hello", "u1"),
		claudeLine("assistant", "hi", "u2"),
		claudeLine("human", "bye", "u3"),
	})
	ionDir := t.TempDir()
	res1, err := ConvertClaudeCodeToIon(fixture, "ion-rt2", ionDir)
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := Load("ion-rt2", ionDir)
	if err != nil {
		t.Fatal(err)
	}
	res2, err := ConvertIonToClaudeCode(loaded, "cc-rt2", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if res1.ContentHash != res2.ContentHash {
		t.Errorf("hash mismatch: %s vs %s", res1.ContentHash, res2.ContentHash)
	}
}

func TestValidateConversion_Valid(t *testing.T) {
	conv := CreateConversation("val-ok", "", "claude-3")
	AddUserMessage(conv, "hello")
	AddAssistantMessage(conv, textBlocks("hi"), noUsage)

	res, err := ConvertIonToClaudeCode(conv, "val-ok", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateConversion(ExtractValidationMsgs(conv), res.OutputPath, "claude_code"); err != nil {
		t.Fatalf("validation should pass: %v", err)
	}
}

func TestValidateConversion_WrongCount(t *testing.T) {
	conv := CreateConversation("val-cnt", "", "claude-3")
	AddUserMessage(conv, "one")
	AddAssistantMessage(conv, textBlocks("two"), noUsage)
	AddUserMessage(conv, "three")
	srcMsgs := ExtractValidationMsgs(conv)

	// Write a Claude Code file with only 2 messages (source has 3)
	ccPath := writeClaudeFixture(t, t.TempDir(), "wrong.jsonl", []map[string]any{
		claudeLine("human", "one", "u1"),
		claudeLine("assistant", "two", "u2"),
	})
	err := ValidateConversion(srcMsgs, ccPath, "claude_code")
	if err == nil {
		t.Fatal("expected validation error for count mismatch")
	}
	if !strings.Contains(err.Error(), "count mismatch") {
		t.Errorf("unexpected error: %v", err)
	}
	if _, statErr := os.Stat(ccPath); statErr == nil {
		t.Error("converted file should be deleted on count mismatch")
	}
}

func TestValidateConversion_CorruptContent(t *testing.T) {
	conv := CreateConversation("val-hash", "", "claude-3")
	AddUserMessage(conv, "original")
	AddAssistantMessage(conv, textBlocks("response"), noUsage)
	srcMsgs := ExtractValidationMsgs(conv)

	ccPath := writeClaudeFixture(t, t.TempDir(), "corrupt.jsonl", []map[string]any{
		claudeLine("human", "original", "u1"),
		claudeLine("assistant", "CORRUPTED", "u2"),
	})
	err := ValidateConversion(srcMsgs, ccPath, "claude_code")
	if err == nil {
		t.Fatal("expected validation error for content mismatch")
	}
	if !strings.Contains(err.Error(), "hash mismatch") {
		t.Errorf("unexpected error: %v", err)
	}
	if _, statErr := os.Stat(ccPath); statErr == nil {
		t.Error("converted file should be deleted on hash mismatch")
	}
}

func TestValidateConversion_MalformedFile(t *testing.T) {
	dir := t.TempDir()
	badPath := filepath.Join(dir, "bad.jsonl")
	os.WriteFile(badPath, []byte("not valid json\n"), 0o644)

	err := ValidateConversion(nil, badPath, "claude_code")
	if err == nil {
		t.Fatal("expected error for malformed file")
	}
}

func TestLoadClaudeCodeMessages_MissingFields(t *testing.T) {
	dir := t.TempDir()
	// Line with type "user" but missing uuid field — should fail validation
	bad := `{"type":"user","timestamp":"2024-01-01T00:00:00Z","message":{"role":"user","content":"hello"}}` + "\n"
	path := filepath.Join(dir, "missing.jsonl")
	os.WriteFile(path, []byte(bad), 0o644)

	_, err := LoadClaudeCodeMessages(path)
	if err == nil {
		t.Fatal("expected error for missing uuid field")
	}
	if !strings.Contains(err.Error(), "missing uuid or timestamp") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestConvertLargeConversation(t *testing.T) {
	conv := CreateConversation("large-mig", "", "claude-3")
	for i := 0; i < 50; i++ {
		AddUserMessage(conv, fmt.Sprintf("question %d", i))
		AddAssistantMessage(conv, textBlocks(fmt.Sprintf("answer %d", i)), noUsage)
	}
	ccDir, ionDir := t.TempDir(), t.TempDir()
	res1, err := ConvertIonToClaudeCode(conv, "large-cc", ccDir)
	if err != nil {
		t.Fatal(err)
	}
	if res1.MessageCount != 100 {
		t.Fatalf("MessageCount = %d, want 100", res1.MessageCount)
	}
	res2, err := ConvertClaudeCodeToIon(res1.OutputPath, "large-ion", ionDir)
	if err != nil {
		t.Fatal(err)
	}
	if res1.ContentHash != res2.ContentHash {
		t.Errorf("Ion→CC→Ion hash mismatch: %s vs %s", res1.ContentHash, res2.ContentHash)
	}
	// Reverse: Ion→Claude
	loaded, err := Load("large-ion", ionDir)
	if err != nil {
		t.Fatal(err)
	}
	res3, err := ConvertIonToClaudeCode(loaded, "large-cc2", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if res2.ContentHash != res3.ContentHash {
		t.Errorf("CC→Ion→CC hash mismatch: %s vs %s", res2.ContentHash, res3.ContentHash)
	}
}
