package server

import "testing"

func TestStopPreparesManagerForProcessShutdown(t *testing.T) {
	server := NewServer(t.TempDir()+"/engine.sock", &mockBackend{})
	if server.manager.IsProcessShutdownPrepared() {
		t.Fatal("new manager unexpectedly marked shutting down")
	}
	if err := server.Stop(); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if !server.manager.IsProcessShutdownPrepared() {
		t.Fatal("server stop must preserve active-run journals through process teardown")
	}
}
