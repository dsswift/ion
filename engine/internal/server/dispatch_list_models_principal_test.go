package server

import (
	"encoding/json"
	"net"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/types"
)

// readListModelsResult reads exactly one NDJSON ServerResult line off the pipe.
func readListModelsResult(t *testing.T, client net.Conn) protocol.ServerResult {
	t.Helper()
	buf := make([]byte, 65536)
	n, err := client.Read(buf)
	if err != nil {
		t.Fatalf("read result: %v", err)
	}
	var res protocol.ServerResult
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(buf[:n]))), &res); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	return res
}

// TestListModelsScopeUnattributed pins R-51: an unattributed request
// (cmd.Principal nil, the pre-existing shape) gets principalScoped=false,
// subject="", and today's unfiltered model content.
func TestListModelsScopeUnattributed(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	r := auth.NewResolver(nil)
	s := &Server{authResolver: r}

	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	resultCh := make(chan protocol.ServerResult, 1)
	go func() { resultCh <- readListModelsResult(t, client) }()

	s.dispatchListModels(server, &protocol.ClientCommand{Cmd: "list_models", RequestID: "req-1"})

	res := <-resultCh
	if !res.OK {
		t.Fatalf("expected ok result, got error %q", res.Error)
	}
	data, ok := res.Data.(map[string]any)
	if !ok {
		t.Fatalf("expected map result data, got %T", res.Data)
	}
	scope, ok := data["scope"].(map[string]any)
	if !ok {
		t.Fatalf("expected scope object in result, got %v", data["scope"])
	}
	if scope["principalScoped"] != false {
		t.Errorf("expected principalScoped=false for an unattributed request, got %v", scope["principalScoped"])
	}
	if scope["subject"] != "" {
		t.Errorf("expected empty subject for an unattributed request, got %v", scope["subject"])
	}
}

// TestListModelsScopeAttributed pins R-50: an attributed request
// (cmd.Principal set) gets principalScoped=true and the acting subject.
func TestListModelsScopeAttributed(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	r := auth.NewResolver(nil)
	s := &Server{authResolver: r}

	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	resultCh := make(chan protocol.ServerResult, 1)
	go func() { resultCh <- readListModelsResult(t, client) }()

	s.dispatchListModels(server, &protocol.ClientCommand{
		Cmd: "list_models", RequestID: "req-2",
		Principal: &types.SessionPrincipal{Subject: "alice"},
	})

	res := <-resultCh
	if !res.OK {
		t.Fatalf("expected ok result, got error %q", res.Error)
	}
	data, ok := res.Data.(map[string]any)
	if !ok {
		t.Fatalf("expected map result data, got %T", res.Data)
	}
	scope, ok := data["scope"].(map[string]any)
	if !ok {
		t.Fatalf("expected scope object in result, got %v", data["scope"])
	}
	if scope["principalScoped"] != true {
		t.Errorf("expected principalScoped=true for an attributed request, got %v", scope["principalScoped"])
	}
	if scope["subject"] != "alice" {
		t.Errorf("expected subject=alice, got %v", scope["subject"])
	}
}

// TestFilterModelsByEntitlement_UnknownDoesNotFilter pins that a nil
// entitlement (not yet discovered) leaves models for that provider
// unfiltered -- the honest "unknown" answer.
func TestFilterModelsByEntitlement_UnknownDoesNotFilter(t *testing.T) {
	models := []types.ModelEntry{
		{ID: "m1", ProviderID: "gw"},
		{ID: "m2", ProviderID: "gw"},
	}
	cc := &auth.CredentialContext{Entitlement: func(string) []string { return nil }}
	out := filterModelsByEntitlement(models, cc)
	if len(out) != 2 {
		t.Fatalf("expected unknown entitlement to leave models unfiltered, got %d entries", len(out))
	}
}

// TestFilterModelsByEntitlement_FiltersToKnownSet pins that a non-nil,
// non-empty entitlement filters models down to exactly that set.
func TestFilterModelsByEntitlement_FiltersToKnownSet(t *testing.T) {
	models := []types.ModelEntry{
		{ID: "m1", ProviderID: "gw"},
		{ID: "m2", ProviderID: "gw"},
	}
	cc := &auth.CredentialContext{Entitlement: func(string) []string { return []string{"m2"} }}
	out := filterModelsByEntitlement(models, cc)
	if len(out) != 1 || out[0].ID != "m2" {
		t.Fatalf("expected exactly [m2], got %v", out)
	}
}
