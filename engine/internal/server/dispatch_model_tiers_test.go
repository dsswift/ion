package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

func findModelTiersEvent(t *testing.T, lines []string) *types.EngineEvent {
	t.Helper()
	for _, line := range lines {
		var wrapper struct {
			Event json.RawMessage `json:"event"`
		}
		if json.Unmarshal([]byte(line), &wrapper) != nil {
			continue
		}
		var event types.EngineEvent
		if json.Unmarshal(wrapper.Event, &event) == nil && event.Type == types.EventModelTiers {
			return &event
		}
	}
	return nil
}

func TestDispatchModelTiersSetListRemoveBroadcastsSnapshots(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd": "set_model_tier", "requestId": "set", "text": "Standard",
		"model": "claude-sonnet-4-6", "fallbacks": []string{"claude-haiku-4-5"},
	})
	setLines := readLines(t, conn, 2, 3*time.Second)
	setEvent := findModelTiersEvent(t, setLines)
	if setEvent == nil || len(setEvent.ModelTiers) != 1 {
		t.Fatalf("set did not broadcast tier snapshot: %v", setLines)
	}
	entry := setEvent.ModelTiers[0]
	if entry.Name != "standard" || entry.Model != "claude-sonnet-4-6" || len(entry.Fallbacks) != 1 {
		t.Fatalf("set snapshot = %+v", entry)
	}

	data, err := os.ReadFile(filepath.Join(home, ".ion", "models.json"))
	if err != nil {
		t.Fatalf("read persisted config: %v", err)
	}
	if !strings.Contains(string(data), `"standard"`) {
		t.Fatalf("tier was not persisted: %s", data)
	}

	sendJSON(t, conn, map[string]interface{}{"cmd": "list_model_tiers", "requestId": "list"})
	listLines := readLines(t, conn, 2, 3*time.Second)
	listEvent := findModelTiersEvent(t, listLines)
	if listEvent == nil || len(listEvent.ModelTiers) != 1 || listEvent.ModelTiers[0].Name != entry.Name || listEvent.ModelTiers[0].Model != entry.Model || len(listEvent.ModelTiers[0].Fallbacks) != len(entry.Fallbacks) || listEvent.ModelTiers[0].Fallbacks[0] != entry.Fallbacks[0] {
		t.Fatalf("list snapshot = %+v, lines = %v", listEvent, listLines)
	}

	sendJSON(t, conn, map[string]interface{}{"cmd": "remove_model_tier", "requestId": "remove", "text": "standard"})
	removeLines := readLines(t, conn, 2, 3*time.Second)
	removeEvent := findModelTiersEvent(t, removeLines)
	if removeEvent == nil || len(removeEvent.ModelTiers) != 0 {
		t.Fatalf("remove did not broadcast empty snapshot: %v", removeLines)
	}
}

func TestDispatchModelTiersRejectsInvalidFallbackShape(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd": "set_model_tier", "requestId": "bad", "text": "standard",
		"model": "claude-sonnet-4-6", "fallbacks": "not-an-array",
	})
	lines := readLines(t, conn, 1, 3*time.Second)
	if !strings.Contains(lines[0], `"ok":false`) || !strings.Contains(lines[0], "invalid command") {
		t.Fatalf("invalid fallback shape response = %v", lines)
	}
}
