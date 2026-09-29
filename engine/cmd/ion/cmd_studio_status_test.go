package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/compat"
	"github.com/dsswift/ion/engine/internal/studiostatus"
)

// shortDir is a temp dir short enough for a unix socket path on macOS.
func shortDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "ion")
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) }) //nolint:errcheck // test temp dir cleanup
	return dir
}

// fakeEngine answers health and list_sessions on a unix socket, one command
// per connection, the way connectAndSendTimeout asks.
func fakeEngine(t *testing.T, sock string, health map[string]any, sessions []map[string]any) {
	t.Helper()
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() }) //nolint:errcheck // test listener cleanup
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close() //nolint:errcheck // test conn cleanup
				line, err := bufio.NewReader(c).ReadBytes('\n')
				if err != nil {
					return
				}
				var cmd map[string]any
				if json.Unmarshal(line, &cmd) != nil {
					return
				}
				var data any = health
				if cmd["cmd"] == "list_sessions" {
					data = sessions
				}
				reply, _ := json.Marshal(map[string]any{"cmd": "result", "requestId": cmd["requestId"], "ok": true, "data": data}) //nolint:errcheck // fixed test payload
				c.Write(append(reply, '\n'))                                                                                       //nolint:errcheck // test reply
			}(conn)
		}
	}()
}

func engineFormats(conversation string) []compat.Format {
	return []compat.Format{{ID: "conversation-file", Owner: "engine", Version: conversation, Rule: compat.RuleHostStorage, Meaning: "m"}}
}

func serverFormatsJSON(transfer string) []compat.Format {
	return []compat.Format{{ID: "transfer-archive", Owner: "server", Version: transfer, Rule: compat.RuleExact, Meaning: "m"}}
}

func writeJSON(t *testing.T, path string, v any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

type statusFixture struct {
	dir    string
	layout studioLayout
	deps   statusDeps
}

func newStatusFixture(t *testing.T) *statusFixture {
	dir := shortDir(t)
	data := filepath.Join(dir, "d")
	root := filepath.Join(data, "studio-server")
	f := &statusFixture{dir: dir, layout: studioLayout{dataDir: data, root: root, current: filepath.Join(root, "current"), versions: filepath.Join(root, "versions"), home: dir, user: "u", port: 7331}}
	f.deps = statusDeps{
		engineSocket: filepath.Join(dir, "e.sock"),
		services: func() ([]studiostatus.Service, error) {
			return []studiostatus.Service{{Label: "com.ion.engine", State: "running", PID: "42"}}, nil
		},
		runVersionJSON: func(bin string) ([]byte, error) {
			switch {
			case strings.Contains(bin, "Ion.app"):
				return json.Marshal(versionReport{Version: "desktop-v1.101.0", Formats: engineFormats("2")})
			case strings.Contains(bin, "studio-server"):
				return json.Marshal(versionReport{Version: "1.85.2", Formats: engineFormats("2")})
			}
			return nil, errors.New("no such binary")
		},
		httpGet: func(url string) ([]byte, int, error) {
			if strings.HasSuffix(url, "/readyz") {
				return []byte(`{"ready":true}`), http.StatusOK, nil
			}
			body, _ := json.Marshal(map[string]any{"engineMinVersion": "0.0.0", "engineMeetsMin": true, "formats": append(serverFormatsJSON("3"), engineFormats("2")...)}) //nolint:errcheck // fixed test payload
			return body, http.StatusOK, nil
		},
	}
	if err := os.MkdirAll(data, 0o700); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *statusFixture) installBundle(t *testing.T, engine string) {
	writeJSON(t, filepath.Join(f.layout.current, "VERSION"), studioBundleVersion{Server: "0.1.0", Engine: engine, Node: "v22"})
	writeJSON(t, filepath.Join(f.layout.current, "compat.json"), map[string]any{"formats": serverFormatsJSON("3")})
}

func (f *statusFixture) installDesktop(t *testing.T) {
	app := filepath.Join(f.dir, "Ion.app")
	plist := `<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key><string>1.101.0</string></dict></plist>`
	if err := os.MkdirAll(filepath.Join(app, "Contents"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(app, "Contents", "Info.plist"), []byte(plist), 0o644); err != nil {
		t.Fatal(err)
	}
	inst, err := locateMacDesktop(app)
	if err != nil || inst == nil {
		t.Fatalf("locate: %v %v", inst, err)
	}
	writeJSON(t, inst.serverFile("compat.json"), map[string]any{"formats": serverFormatsJSON("3")})
	if err := os.WriteFile(inst.serverFile("VERSION"), []byte("0.2.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	f.deps.desktop = inst
}

var sampleMetrics = map[string]any{
	"sampledAt": 1, "intervalMs": 30000,
	"host":      map[string]any{"cpuUtilization": 0.25, "cpuCount": 8, "memoryTotalBytes": 1000, "memoryAvailableBytes": 400},
	"processes": []map[string]any{{"cpuPercent": 12.5, "rssBytes": 100}, {"cpuPercent": nil, "rssBytes": 50}},
	"runtime":   map[string]any{},
}

func TestStudioStatus_ServerHost(t *testing.T) {
	f := newStatusFixture(t)
	f.installBundle(t, "1.85.2")
	writeJSON(t, filepath.Join(f.layout.dataDir, "server.json"), map[string]any{"relays": []map[string]any{{"url": "wss://relay.example.org", "auth": map[string]any{"mode": "psk", "key": "secret"}}}})
	fakeEngine(t, f.deps.engineSocket,
		map[string]any{"version": "1.85.2", "uptimeSec": 60, "systemMetrics": sampleMetrics, "compat": engineFormats("2")},
		[]map[string]any{{"key": "a", "hasActiveRun": true}, {"key": "b"}, {"key": "c", "hasActiveRun": true}})

	r := collectStudioStatus(f.layout, f.deps)
	if r.Kind != studiostatus.KindServer || r.InstalledVersion != "0.1.0" || r.EngineVersion != "1.85.2" {
		t.Fatalf("install = %s %s %s", r.Kind, r.InstalledVersion, r.EngineVersion)
	}
	if !r.Engine.Running || r.Engine.PendingRestart || r.Engine.Version != "1.85.2" {
		t.Errorf("engine = %+v", r.Engine)
	}
	if r.RunningConversations == nil || *r.RunningConversations != 2 {
		t.Errorf("running conversations = %v", r.RunningConversations)
	}
	if m := r.Metrics; m == nil || *m.CPUUtilization != 0.25 || m.IonCPUPercent != 12.5 || m.IonRSSBytes != 150 {
		t.Errorf("metrics = %+v", r.Metrics)
	}
	if !reflect.DeepEqual(r.Relays, []string{"wss://relay.example.org"}) {
		t.Errorf("relays = %v", r.Relays)
	}
	if strings.Contains(string(mustMarshalCLI(r)), "secret") {
		t.Error("a relay key reached the report")
	}
	transfer, ok := r.Format("server", "transfer-archive")
	if !ok || transfer.Installed != "3" || transfer.Running != "3" || transfer.PendingRestart {
		t.Errorf("transfer = %+v", transfer)
	}
	if !r.Ready || len(r.Problems) != 0 {
		t.Errorf("ready=%v problems=%v", r.Ready, r.Problems)
	}
}

func TestStudioStatus_DesktopHost(t *testing.T) {
	f := newStatusFixture(t)
	f.installDesktop(t)
	fakeEngine(t, f.deps.engineSocket, map[string]any{"version": "desktop-v1.101.0", "systemMetrics": sampleMetrics, "compat": engineFormats("2")}, nil)

	r := collectStudioStatus(f.layout, f.deps)
	if r.Kind != studiostatus.KindDesktop || r.InstalledVersion != "" {
		t.Fatalf("kind = %s installed = %q", r.Kind, r.InstalledVersion)
	}
	d := r.Components.Desktop
	if d == nil || d.Version != "1.101.0" || d.ServerVersion != "0.2.0" || d.EngineVersion != "desktop-v1.101.0" {
		t.Fatalf("desktop = %+v", d)
	}
	if r.Engine.PendingRestart {
		t.Error("the desktop's own engine is running; no restart is pending")
	}
	if f, ok := r.Format("engine", "conversation-file"); !ok || f.Installed != "2" || f.Running != "2" {
		t.Errorf("conversation-file = %+v", f)
	}
}

func TestStudioStatus_BothInstalled(t *testing.T) {
	f := newStatusFixture(t)
	f.installBundle(t, "1.85.2")
	f.installDesktop(t)
	fakeEngine(t, f.deps.engineSocket, map[string]any{"version": "1.85.2", "systemMetrics": sampleMetrics}, nil)
	if r := collectStudioStatus(f.layout, f.deps); r.Kind != studiostatus.KindBoth {
		t.Fatalf("kind = %s", r.Kind)
	}
}

func TestStudioStatus_EngineDownAndNothingInstalled(t *testing.T) {
	f := newStatusFixture(t)
	f.deps.httpGet = func(string) ([]byte, int, error) { return nil, 0, errors.New("connection refused") }
	r := collectStudioStatus(f.layout, f.deps)
	if r.Kind != studiostatus.KindNone || r.Engine.Running || r.RunningConversations != nil || r.Metrics != nil || r.Ready {
		t.Fatalf("report = %+v", r)
	}
	if !hasProblem(r, "engine:") || !hasProblem(r, "server /versionz:") {
		t.Errorf("problems = %v", r.Problems)
	}
}

func TestStudioStatus_MetricsDisabled(t *testing.T) {
	f := newStatusFixture(t)
	f.installBundle(t, "1.85.2")
	fakeEngine(t, f.deps.engineSocket, map[string]any{"version": "1.85.2"}, []map[string]any{})
	r := collectStudioStatus(f.layout, f.deps)
	if r.Metrics != nil || !hasProblem(r, "metrics:") {
		t.Fatalf("metrics=%v problems=%v", r.Metrics, r.Problems)
	}
	if r.RunningConversations == nil || *r.RunningConversations != 0 {
		t.Errorf("running = %v", r.RunningConversations)
	}
}

func TestStudioStatus_PendingRestart(t *testing.T) {
	f := newStatusFixture(t)
	f.installBundle(t, "1.86.0")
	// The installed engine writes conversation files v3; the running one v2.
	f.deps.runVersionJSON = func(string) ([]byte, error) {
		return json.Marshal(versionReport{Version: "1.86.0", Formats: engineFormats("3")})
	}
	fakeEngine(t, f.deps.engineSocket, map[string]any{"version": "1.85.2", "systemMetrics": sampleMetrics, "compat": engineFormats("2")}, nil)
	r := collectStudioStatus(f.layout, f.deps)
	if !r.Engine.PendingRestart || r.Engine.InstalledVersion != "1.86.0" {
		t.Errorf("engine = %+v", r.Engine)
	}
	conv, _ := r.Format("engine", "conversation-file")
	if !conv.PendingRestart || conv.Installed != "3" || conv.Running != "2" || conv.Effective() != "2" {
		t.Errorf("conversation-file = %+v", conv)
	}
}

// TestStudioStatus_JSONShape pins the report's field names: `ion fleet` and
// any script reading `ion studio status --json` decode them.
func TestStudioStatus_JSONShape(t *testing.T) {
	f := newStatusFixture(t)
	f.installBundle(t, "1.85.2")
	fakeEngine(t, f.deps.engineSocket, map[string]any{"version": "1.85.2", "systemMetrics": sampleMetrics, "compat": engineFormats("2")}, []map[string]any{})
	var top map[string]json.RawMessage
	if err := json.Unmarshal(mustMarshalCLI(collectStudioStatus(f.layout, f.deps)), &top); err != nil {
		t.Fatal(err)
	}
	var keys []string
	for k := range top {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	want := []string{"arch", "components", "dataDir", "devices", "engine", "engineVersion", "formats", "hostname", "installedVersion", "logs", "metrics", "platform", "port", "ready", "relays", "runningConversations", "schemaVersion", "services", "user", "kind"}
	sort.Strings(want)
	if !reflect.DeepEqual(keys, want) {
		t.Errorf("keys = %v\nwant %v", keys, want)
	}
}

// Devices come from the running server: read when its /versionz answers,
// named as a problem when clients.js fails, and not asked for when the
// server is down.
func TestStudioStatus_Devices(t *testing.T) {
	f := newStatusFixture(t)
	f.installBundle(t, "1.85.2")
	asked := 0
	f.deps.devices = func() ([]studiostatus.PairedDevice, error) {
		asked++
		return []studiostatus.PairedDevice{{ClientID: "p", Label: "iPhone", Kind: "mobile", Connected: true}}, nil
	}
	if r := collectStudioStatus(f.layout, f.deps); len(r.Devices) != 1 || r.Devices[0].Label != "iPhone" {
		t.Fatalf("devices = %+v", r.Devices)
	}
	f.deps.devices = func() ([]studiostatus.PairedDevice, error) { asked++; return nil, errors.New("clients.js is missing") }
	if r := collectStudioStatus(f.layout, f.deps); r.Devices != nil || !hasProblem(r, "devices:") {
		t.Errorf("a failed read must be a problem: %+v %v", r.Devices, r.Problems)
	}
	f.deps.httpGet = func(string) ([]byte, int, error) { return nil, 0, errors.New("connection refused") }
	before := asked
	if r := collectStudioStatus(f.layout, f.deps); r.Devices != nil || asked != before {
		t.Errorf("a stopped server must not be asked: asked %d", asked-before)
	}
}

func TestDecodePairedDevices(t *testing.T) {
	got, err := decodePairedDevices([]byte(`{"devices":[{"clientId":"p","label":"iPhone","kind":"mobile","pairedAt":1,"lastSeen":2,"connected":true,"connectedAt":2,"admin":false,"self":false}]}`))
	if err != nil || len(got) != 1 || !got[0].Connected || got[0].ConnectedAt == nil || *got[0].ConnectedAt != 2 {
		t.Fatalf("got %+v err %v", got, err)
	}
	if got, err := decodePairedDevices([]byte(`{"devices":[]}`)); err != nil || got == nil || len(got) != 0 {
		t.Errorf("none paired must read as an empty list, not unknown: %v %v", got, err)
	}
	if _, err := decodePairedDevices([]byte("usage")); err == nil {
		t.Error("garbage must be an error")
	}
}

func TestParseVersionJSON_PreFormatEngine(t *testing.T) {
	v, err := parseVersionJSON([]byte("ion-engine 1.85.1\n"))
	if err == nil || v.Version != "1.85.1" || len(v.Formats) != 0 {
		t.Fatalf("v=%+v err=%v", v, err)
	}
}

func TestStudioServerCLI_FallsBackToTheDesktop(t *testing.T) {
	f := newStatusFixture(t)
	f.installDesktop(t)
	if err := os.WriteFile(f.deps.desktop.serverFile("pair.js"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	bin, script, env, err := studioServerCLI(f.layout, f.deps.desktop, "pair.js")
	if err != nil {
		t.Fatal(err)
	}
	if bin != f.deps.desktop.executable() || !strings.HasSuffix(filepath.ToSlash(script), "dist/server/pair.js") || !contains(env, "ELECTRON_RUN_AS_NODE=1") {
		t.Errorf("bin=%s script=%s env=%v", bin, script, env)
	}
	f.installBundle(t, "1.85.2")
	if err := os.MkdirAll(filepath.Dir(f.layout.serverScript("pair.js")), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.layout.serverScript("pair.js"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if bin, _, _, _ := studioServerCLI(f.layout, f.deps.desktop, "pair.js"); bin != f.layout.nodeBin() { //nolint:errcheck // asserted by the bin check
		t.Errorf("a bundle install must pair with its own node, got %s", bin)
	}
	if _, _, _, err := studioServerCLI(studioLayout{current: "/nope"}, nil, "pair.js"); err == nil {
		t.Error("no bundle and no desktop must be an error")
	}
}

func hasProblem(r studiostatus.Report, prefix string) bool {
	for _, p := range r.Problems {
		if strings.HasPrefix(p, prefix) {
			return true
		}
	}
	return false
}
