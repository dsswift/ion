package conversation

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// modelChangeEntries returns every model_change entry on the conversation with
// its data decoded, whichever concrete shape the entry is carrying (a live
// append holds the struct; a reload holds the decoded persisted form).
func modelChangeEntries(t *testing.T, conv *Conversation) []ModelChangeData {
	t.Helper()
	var out []ModelChangeData
	for _, entry := range conv.Entries {
		if entry.Type != EntryModelChange {
			continue
		}
		switch d := entry.Data.(type) {
		case ModelChangeData:
			out = append(out, d)
		case *ModelChangeData:
			out = append(out, *d)
		default:
			raw, err := json.Marshal(entry.Data)
			if err != nil {
				t.Fatalf("model_change data unmarshalable: %v", err)
			}
			var md ModelChangeData
			if err := json.Unmarshal(raw, &md); err != nil {
				t.Fatalf("model_change data undecodable: %v", err)
			}
			out = append(out, md)
		}
	}
	return out
}

// A run on a different model than the conversation last used records the
// switch and advances the header. Revert SyncModel's append and
// this goes red: the entry list stays empty.
func TestSyncModel_RecordsChange(t *testing.T) {
	conv := CreateConversation("conv-model-change", "sys", "claude-fable-5-1")
	if !SyncModel(conv, "claude-opus-5", "run-1") {
		t.Fatal("expected the model change to be reported as an update")
	}
	if conv.Model != "claude-opus-5" {
		t.Errorf("expected header model to advance to the serving model, got %q", conv.Model)
	}
	changes := modelChangeEntries(t, conv)
	if len(changes) != 1 {
		t.Fatalf("expected exactly one model_change entry, got %d", len(changes))
	}
	if changes[0].Model != "claude-opus-5" || changes[0].PreviousModel != "claude-fable-5-1" {
		t.Errorf("expected opus from fable, got %+v", changes[0])
	}
}

// A run on the same model records nothing. Without this, every turn of a
// steady conversation would append an entry and the timeline would be noise.
func TestSyncModel_SameModelRecordsNothing(t *testing.T) {
	conv := CreateConversation("conv-model-same", "sys", "claude-opus-5")
	if SyncModel(conv, "claude-opus-5", "run-1") {
		t.Error("expected no update when the serving model is unchanged")
	}
	if got := len(modelChangeEntries(t, conv)); got != 0 {
		t.Errorf("expected no model_change entries, got %d", got)
	}
}

// A run that carries no model never erases the recorded one.
func TestSyncModel_EmptyRunModelPreservesHeader(t *testing.T) {
	conv := CreateConversation("conv-model-empty-run", "sys", "claude-opus-5")
	if SyncModel(conv, "", "run-1") {
		t.Error("expected no update when the run carries no model")
	}
	if conv.Model != "claude-opus-5" {
		t.Errorf("expected the recorded model to be preserved, got %q", conv.Model)
	}
	if got := len(modelChangeEntries(t, conv)); got != 0 {
		t.Errorf("expected no model_change entries, got %d", got)
	}
}

// A conversation with no recorded model adopts the run's model without
// claiming a change happened — there is no previous model to change from.
func TestSyncModel_AdoptsWhenHeaderEmpty(t *testing.T) {
	conv := CreateConversation("conv-model-adopt", "sys", "")
	if !SyncModel(conv, "claude-sonnet-5", "run-1") {
		t.Fatal("expected the adoption to be reported as an update")
	}
	if conv.Model != "claude-sonnet-5" {
		t.Errorf("expected the run model to be adopted, got %q", conv.Model)
	}
	if got := len(modelChangeEntries(t, conv)); got != 0 {
		t.Errorf("expected no model_change entry on adoption, got %d", got)
	}
}

// The entry survives a save/load round trip with the field names consumers
// read. A telemetry reader parses the persisted JSON, not the Go struct, so
// the wire shape is the contract this pins.
func TestSyncModel_PersistsWireShape(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("ION_DATA_DIR", tmp)

	conv := CreateConversation("conv-model-persist", "sys", "claude-fable-5-1")
	SyncModel(conv, "claude-opus-5", "run-1")
	if err := Save(conv, ""); err != nil {
		t.Fatalf("save: %v", err)
	}

	raw, err := os.ReadFile(filepath.Join(tmp, "conversations", "conv-model-persist.tree.jsonl"))
	if err != nil {
		t.Fatalf("read tree file: %v", err)
	}
	var found bool
	for _, line := range strings.Split(string(raw), "\n") {
		if !strings.Contains(line, `"model_change"`) {
			continue
		}
		found = true
		if !strings.Contains(line, `"model":"claude-opus-5"`) {
			t.Errorf("persisted entry is missing the serving model: %s", line)
		}
		if !strings.Contains(line, `"previousModel":"claude-fable-5-1"`) {
			t.Errorf("persisted entry is missing the previous model: %s", line)
		}
	}
	if !found {
		t.Fatal("expected a model_change entry in the persisted tree file")
	}

	loaded, err := Load("conv-model-persist", "")
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	changes := modelChangeEntries(t, loaded)
	if len(changes) != 1 || changes[0].Model != "claude-opus-5" || changes[0].PreviousModel != "claude-fable-5-1" {
		t.Fatalf("expected one decoded model change opus<-fable, got %+v", changes)
	}
}
