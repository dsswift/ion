package server

import (
	"encoding/json"
	"net"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/protocol"
)

func TestGetAgentState_ReturnsFullRosterOnlyToRequester(t *testing.T) {
	client, peer := net.Pipe()
	defer client.Close()
	defer peer.Close()

	server := &Server{}
	command := &protocol.ClientCommand{Cmd: "get_agent_state", RequestID: "request", Key: "session"}
	roster := map[string]any{"agents": []any{map[string]any{"name": "agent", "metadata": map[string]any{"lastWork": strings.Repeat("x", 8192)}}}}

	done := make(chan struct{})
	go func() {
		server.sendResult(client, command, nil, roster)
		close(done)
	}()
	buf := make([]byte, 16384)
	n, err := peer.Read(buf)
	if err != nil {
		t.Fatalf("read result: %v", err)
	}
	<-done

	var result protocol.ServerResult
	if err := json.Unmarshal(buf[:n], &result); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if result.RequestID != "request" || !result.OK {
		t.Fatalf("unexpected result: %#v", result)
	}
	data, err := json.Marshal(result.Data)
	if err != nil {
		t.Fatalf("marshal result data: %v", err)
	}
	if !strings.Contains(string(data), strings.Repeat("x", 128)) {
		t.Fatal("request result lost full roster content")
	}
}
