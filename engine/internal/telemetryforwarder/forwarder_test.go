package telemetryforwarder

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/telemetryformat"
)

func TestForwarderPushesExpandedEventsAndAdvancesCursorAfterSuccess(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "telemetry.jsonl")
	cursor := filepath.Join(directory, "cursor.json")
	legacy := testEvent("legacy.event", 3)
	first := testEvent("frame.first", 3)
	second := testEvent("frame.second", 3)
	legacyLine, err := telemetryformat.EncodeEventLine(legacy)
	if err != nil {
		t.Fatal(err)
	}
	frameLine, err := telemetryformat.EncodeCompactLine([]telemetryformat.Event{first, second})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, append(legacyLine, frameLine...), 0o600); err != nil {
		t.Fatal(err)
	}

	var requests []lokiPushRequest
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/loki/api/v1/push" {
			t.Errorf("path = %q", request.URL.Path)
		}
		var push lokiPushRequest
		if err := json.NewDecoder(request.Body).Decode(&push); err != nil {
			t.Error(err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		requests = append(requests, push)
		writer.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	forwarder, err := New(Config{File: file, Cursor: cursor, Endpoint: server.URL + "/loki/api/v1/push"})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = forwarder.Close() }()
	if err := forwarder.Poll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(requests) != 2 {
		t.Fatalf("request count = %d, want 2", len(requests))
	}
	for _, request := range requests {
		stream := request.Streams[0]
		if stream.Stream["service"] != "ion-telemetry" || stream.Stream["service_name"] != "ion-telemetry" {
			t.Fatalf("labels = %v", stream.Stream)
		}
	}
	if got, want := len(requests[1].Streams[0].Values), 2; got != want {
		t.Fatalf("v4 expanded values = %d, want %d", got, want)
	}
	var forwarded telemetryformat.Event
	if err := json.Unmarshal([]byte(requests[1].Streams[0].Values[0][1]), &forwarded); err != nil {
		t.Fatal(err)
	}
	if forwarded.Name != first.Name || forwarded.SchemaVersion != telemetryformat.FrameVersion {
		t.Fatalf("forwarded event = %#v", forwarded)
	}
	if got, want := requests[1].Streams[0].Values[0][0], strconv.FormatInt(time.Date(2026, 3, 20, 12, 0, 0, 0, time.UTC).UnixNano(), 10); got != want {
		t.Fatalf("timestamp = %s, want %s", got, want)
	}
	stored, err := loadCursor(cursor)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := stored.Offset, int64(len(legacyLine)+len(frameLine)); got != want {
		t.Fatalf("cursor offset = %d, want %d", got, want)
	}
}

func TestForwarderRunRetriesStartupSinkFailure(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "telemetry.jsonl")
	cursor := filepath.Join(directory, "cursor.json")
	line, err := telemetryformat.EncodeEventLine(testEvent("retry", 3))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, line, 0o600); err != nil {
		t.Fatal(err)
	}

	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		attempts++
		if attempts == 1 {
			writer.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		writer.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	forwarder, err := New(Config{File: file, Cursor: cursor, Endpoint: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = forwarder.Close() }()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := forwarder.Run(ctx, time.Millisecond); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Run error = %v, want deadline exceeded", err)
	}
	if attempts < 2 {
		t.Fatalf("push attempts = %d, want retry after startup failure", attempts)
	}
	stored, err := loadCursor(cursor)
	if err != nil {
		t.Fatalf("load cursor after retry: %v", err)
	}
	if got, want := stored.Offset, int64(len(line)); got != want {
		t.Fatalf("cursor offset = %d, want %d", got, want)
	}
}

func TestForwarderDoesNotAdvanceCursorAfterFailedPush(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "telemetry.jsonl")
	cursor := filepath.Join(directory, "cursor.json")
	line, err := telemetryformat.EncodeEventLine(testEvent("failure", 3))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, line, 0o600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	forwarder, err := New(Config{File: file, Cursor: cursor, Endpoint: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = forwarder.Close() }()
	if err := forwarder.Poll(context.Background()); err == nil {
		t.Fatal("Poll succeeded after rejected push")
	}
	if _, err := os.Stat(cursor); !os.IsNotExist(err) {
		t.Fatalf("cursor exists after failed push: %v", err)
	}
	if got := forwarder.follower.Cursor().Offset; got != 0 {
		t.Fatalf("cursor offset = %d, want 0", got)
	}
}

func testEvent(name string, schema int) telemetryformat.Event {
	return telemetryformat.Event{
		Name: name, Ts: "2026-03-20T12:00:00Z", SchemaVersion: schema,
		Component: "engine", Payload: map[string]any{"ok": true},
	}
}
