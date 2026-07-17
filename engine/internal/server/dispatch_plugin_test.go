package server

// dispatch_plugin_test.go — end-to-end tests for the plugin protocol commands
// (plugin_install, plugin_list, plugin_remove). Each test goes through the full
// JSON-decode → dispatch → result-marshaling path so the wire contract a client
// decodes is exercised against actual socket input.
//
// The registry is isolated per-test via HOME (mirroring the OIDC test suite):
// plugins.RegistryPath() resolves under $HOME/.ion, so a temp HOME gives each
// test a clean registry it can seed through plugins.Register.
//
// plugin_install's happy path performs a live GitHub fetch, so it is not
// exercised here; instead the reachable non-network error path (an invalid
// "owner/repo" source that Install rejects before any HTTP call) plus the
// wire-level malformed-JSON rejection cover the install command's error
// contract.

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/plugins"
)

// seedPlugin registers a plugin record in the (HOME-isolated) registry so the
// list/remove commands have something to operate on.
func seedPlugin(t *testing.T, p plugins.InstalledPlugin) {
	t.Helper()
	if err := plugins.Register(p); err != nil {
		t.Fatalf("seed plugin %q: %v", p.Name, err)
	}
}

// pluginListData coerces a plugin_list result's Data field into a slice of
// per-plugin maps. Fails the test if the shape does not match the wire
// contract a client would decode (a JSON array of objects).
func pluginListData(t *testing.T, data any) []map[string]any {
	t.Helper()
	arr, ok := data.([]any)
	if !ok {
		t.Fatalf("plugin_list Data is not a JSON array: %T (%v)", data, data)
	}
	out := make([]map[string]any, 0, len(arr))
	for i, el := range arr {
		m, ok := el.(map[string]any)
		if !ok {
			t.Fatalf("plugin_list Data[%d] is not an object: %T", i, el)
		}
		out = append(out, m)
	}
	return out
}

func TestDispatchPlugin_ListReturnsRecordArray(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	seedPlugin(t, plugins.InstalledPlugin{
		Name:        "caveman",
		Source:      "JuliusBrussee/caveman",
		InstallPath: t.TempDir(),
		Version:     "abc123def456",
		InstalledAt: time.Now().UTC(),
	})

	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "plugin_list",
		"requestId": "req-list",
	})

	lines := readLines(t, conn, 2, 2*time.Second)
	r := findResult(t, lines)
	if r == nil {
		t.Fatalf("plugin_list: no result received; lines=%v", lines)
	}
	if !r.OK {
		t.Fatalf("plugin_list: server returned error: %s", r.Error)
	}

	records := pluginListData(t, r.Data)
	if len(records) != 1 {
		t.Fatalf("plugin_list: expected 1 record, got %d (%v)", len(records), records)
	}
	rec := records[0]
	// Assert the exact field names a client decodes. A rename in the dispatch
	// handler would fail here.
	for _, field := range []string{"name", "source", "version", "installedAt"} {
		if _, ok := rec[field]; !ok {
			t.Errorf("plugin_list record missing %q field: %v", field, rec)
		}
	}
	if rec["name"] != "caveman" {
		t.Errorf("plugin_list name = %v, want caveman", rec["name"])
	}
	if rec["source"] != "JuliusBrussee/caveman" {
		t.Errorf("plugin_list source = %v", rec["source"])
	}
	if rec["version"] != "abc123def456" {
		t.Errorf("plugin_list version = %v", rec["version"])
	}
}

func TestDispatchPlugin_RemoveValidAndUnknown(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	seedPlugin(t, plugins.InstalledPlugin{
		Name:        "caveman",
		Source:      "JuliusBrussee/caveman",
		InstallPath: t.TempDir(),
		Version:     "abc123def456",
		InstalledAt: time.Now().UTC(),
	})

	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	// Valid remove: result carries {"removed": <name>}.
	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "plugin_remove",
		"requestId": "req-rm",
		"label":     "caveman",
	})
	lines := readLines(t, conn, 2, 2*time.Second)
	r := findResult(t, lines)
	if r == nil {
		t.Fatalf("plugin_remove: no result received; lines=%v", lines)
	}
	if !r.OK {
		t.Fatalf("plugin_remove: server returned error: %s", r.Error)
	}
	data, ok := r.Data.(map[string]any)
	if !ok {
		t.Fatalf("plugin_remove Data is not an object: %T (%v)", r.Data, r.Data)
	}
	if data["removed"] != "caveman" {
		t.Errorf("plugin_remove removed = %v, want caveman", data["removed"])
	}
	// The registry must no longer carry the removed plugin.
	if installed, err := plugins.ListInstalled(); err != nil {
		t.Fatalf("ListInstalled after remove: %v", err)
	} else if len(installed) != 0 {
		t.Errorf("plugin still present after remove: %v", installed)
	}

	// Error path: removing an unknown plugin returns a not-found error.
	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "plugin_remove",
		"requestId": "req-rm-unknown",
		"label":     "does-not-exist",
	})
	lines = readLines(t, conn, 2, 2*time.Second)
	r = findResult(t, lines)
	if r == nil {
		t.Fatalf("plugin_remove unknown: no result received; lines=%v", lines)
	}
	if r.OK {
		t.Error("plugin_remove unknown: expected error result, got OK")
	}
	if !strings.Contains(r.Error, "not found") {
		t.Errorf("plugin_remove unknown: error = %q, want a not-found error", r.Error)
	}
}

func TestDispatchPlugin_InstallErrorPaths(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	// Reachable non-network error path: an invalid source ("owner/repo"
	// format violated) is rejected by Install before any HTTP call, so the
	// dispatch handler returns an error result.
	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "plugin_install",
		"requestId": "req-install-bad",
		"source":    "not-a-valid-source",
	})
	lines := readLines(t, conn, 2, 2*time.Second)
	r := findResult(t, lines)
	if r == nil {
		t.Fatalf("plugin_install bad source: no result received; lines=%v", lines)
	}
	if r.OK {
		t.Error("plugin_install bad source: expected error result, got OK")
	}
	if !strings.Contains(r.Error, "invalid plugin source") {
		t.Errorf("plugin_install bad source: error = %q, want an invalid-source error", r.Error)
	}

	// Malformed JSON on the wire is rejected before dispatch with the generic
	// "invalid command" error (the read loop cannot parse a ClientCommand).
	if _, err := conn.Write([]byte("{ this is not valid json\n")); err != nil {
		t.Fatalf("write malformed frame: %v", err)
	}
	lines = readLines(t, conn, 1, 2*time.Second)
	found := false
	for _, l := range lines {
		var res struct {
			OK    bool   `json:"ok"`
			Error string `json:"error"`
		}
		if err := json.Unmarshal([]byte(l), &res); err != nil {
			continue
		}
		if !res.OK && strings.Contains(res.Error, "invalid command") {
			found = true
		}
	}
	if !found {
		t.Errorf("malformed JSON: expected an 'invalid command' error, got %v", lines)
	}
}
