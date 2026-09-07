package telemetryforwarder

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/telemetryformat"
)

// countingSink accepts every push and records how many streams it received.
func countingSink(t *testing.T, pushes *[]lokiPushRequest) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var push lokiPushRequest
		if err := json.NewDecoder(request.Body).Decode(&push); err != nil {
			t.Error(err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		*pushes = append(*pushes, push)
		writer.WriteHeader(http.StatusNoContent)
	}))
}

func pushedEventNames(pushes []lokiPushRequest) []string {
	var names []string
	for _, push := range pushes {
		for _, stream := range push.Streams {
			for _, entry := range stream.Values {
				var event map[string]any
				if err := json.Unmarshal([]byte(entry[1]), &event); err != nil {
					continue
				}
				if name, ok := event["name"].(string); ok {
					names = append(names, name)
				}
			}
		}
	}
	return names
}

// TestForwarderDropsUndecodableLineAndKeepsGoing is the head-of-line
// regression. A forwarder that returns the decode error never advances the
// cursor, so it re-reads the same offset on every poll and every later line in
// the file is stranded behind one bad one. This asserts the opposite: the bad
// line is skipped and the good line AFTER it is delivered in the same poll.
func TestForwarderDropsUndecodableLineAndKeepsGoing(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "telemetry.jsonl")
	cursorPath := filepath.Join(directory, "cursor.json")

	good, err := telemetryformat.EncodeCompactLine([]telemetryformat.Event{testEvent("after.poison", telemetryformat.FrameVersion)})
	if err != nil {
		t.Fatal(err)
	}
	poison := []byte("{\"record\":\"telemetry.frame\",\"schema\":4,\"identities\":[],\"contexts\":[],\"events\":[{\"i\":7,\"name\":\"x\",\"ts\":\"t\",\"payload\":{}}]}\n")
	if err := os.WriteFile(file, append(poison, good...), 0o600); err != nil {
		t.Fatal(err)
	}

	var pushes []lokiPushRequest
	server := countingSink(t, &pushes)
	defer server.Close()

	forwarder, err := New(Config{File: file, Cursor: cursorPath, Endpoint: server.URL + "/loki/api/v1/push"})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = forwarder.Close() }()

	if err := forwarder.Poll(context.Background()); err != nil {
		t.Fatalf("Poll returned %v, want nil (an undecodable line is a drop, not a failure)", err)
	}

	names := pushedEventNames(pushes)
	if len(names) != 1 || names[0] != "after.poison" {
		t.Fatalf("pushed %v, want exactly [after.poison] — the line behind the poison line must still ship", names)
	}
	if _, err := os.Stat(cursorPath); err != nil {
		t.Fatalf("cursor not written after a dropped line: %v", err)
	}

	// A second poll must find nothing left: the cursor moved past both lines,
	// so the poison line is dropped once rather than re-read forever.
	pushes = nil
	if err := forwarder.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := pushedEventNames(pushes); len(got) != 0 {
		t.Fatalf("second poll re-delivered %v, want nothing (cursor did not advance past the drop)", got)
	}
}
