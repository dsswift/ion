package server

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

func findDefaultProviderEvent(t *testing.T, lines []string) *types.EngineEvent {
	t.Helper()
	for _, line := range lines {
		var wrapper struct {
			Event json.RawMessage `json:"event"`
		}
		if json.Unmarshal([]byte(line), &wrapper) != nil {
			continue
		}
		var event types.EngineEvent
		if json.Unmarshal(wrapper.Event, &event) == nil && event.Type == types.EventDefaultProvider {
			return &event
		}
	}
	return nil
}

func TestDispatchDefaultProviderSetGetClearRoundTrips(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	srv := newShortPathTestServer(t, newMockBackend())
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd": "set_default_provider", "requestId": "set", "text": "DCI-Marketing",
	})
	setLines := readLines(t, conn, 2, 3*time.Second)
	setEvent := findDefaultProviderEvent(t, setLines)
	if setEvent == nil || setEvent.DefaultProvider == nil || *setEvent.DefaultProvider != "dci-marketing" {
		t.Fatalf("set did not broadcast normalized default provider: %v", setLines)
	}

	sendJSON(t, conn, map[string]interface{}{"cmd": "get_default_provider", "requestId": "get"})
	getLines := readLines(t, conn, 2, 3*time.Second)
	getEvent := findDefaultProviderEvent(t, getLines)
	if getEvent == nil || getEvent.DefaultProvider == nil || *getEvent.DefaultProvider != "dci-marketing" {
		t.Fatalf("get snapshot = %+v, lines = %v", getEvent, getLines)
	}

	sendJSON(t, conn, map[string]interface{}{"cmd": "set_default_provider", "requestId": "clear", "text": ""})
	clearLines := readLines(t, conn, 2, 3*time.Second)
	clearEvent := findDefaultProviderEvent(t, clearLines)
	if clearEvent == nil || clearEvent.DefaultProvider == nil || *clearEvent.DefaultProvider != "" {
		t.Fatalf("clear did not broadcast empty preference: %v", clearLines)
	}

	sendJSON(t, conn, map[string]interface{}{"cmd": "get_default_provider", "requestId": "get2"})
	finalLines := readLines(t, conn, 2, 3*time.Second)
	finalEvent := findDefaultProviderEvent(t, finalLines)
	if finalEvent == nil || finalEvent.DefaultProvider == nil || *finalEvent.DefaultProvider != "" {
		t.Fatalf("get after clear = %+v, lines = %v", finalEvent, finalLines)
	}
}
