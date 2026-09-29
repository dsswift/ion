package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// fakeRunner scripts command outcomes by their joined argv prefix and
// records every call, so the manager branch logic is testable without
// launchctl or systemctl.
type fakeRunner struct {
	calls   []string
	results map[string]fakeResult
}

type fakeResult struct {
	out  string
	code int
}

func (f *fakeRunner) Run(name string, args ...string) (string, int, error) {
	call := name + " " + strings.Join(args, " ")
	f.calls = append(f.calls, call)
	// Longest matching prefix wins so a specific script ("launchctl print
	// gui/501/com.ion.engine") beats a broad one ("launchctl print gui/").
	best, bestLen := fakeResult{code: 1}, -1
	for prefix, r := range f.results {
		if strings.HasPrefix(call, prefix) && len(prefix) > bestLen {
			best, bestLen = r, len(prefix)
		}
	}
	return best.out, best.code, nil
}

func (f *fakeRunner) called(prefix string) bool {
	for _, c := range f.calls {
		if strings.HasPrefix(c, prefix) {
			return true
		}
	}
	return false
}

func testLayout(t *testing.T) studioLayout {
	t.Helper()
	home := t.TempDir()
	data := filepath.Join(home, ".ion")
	root := filepath.Join(data, "studio-server")
	return studioLayout{dataDir: data, root: root, current: filepath.Join(root, "current"), versions: filepath.Join(root, "versions"), home: home, user: "tester", port: studioServerPort}
}

func TestStudioUnits_PathsAndOrder(t *testing.T) {
	l := testLayout(t)
	units := studioUnits(l)
	if len(units) != 2 || units[0].Label != studioEngineLabel || units[1].Label != studioServerLabel {
		t.Fatalf("units = %+v", units)
	}
	if units[0].ProgramArgs[0] != l.ionBin() || units[0].ProgramArgs[1] != "serve" {
		t.Fatalf("engine args = %v", units[0].ProgramArgs)
	}
	if units[1].ProgramArgs[0] != l.nodeBin() || units[1].ProgramArgs[1] != l.serverMain() {
		t.Fatalf("server args = %v", units[1].ProgramArgs)
	}
	for _, u := range units {
		if u.Env["ION_DATA_DIR"] != l.dataDir || u.Env["HOME"] != l.home {
			t.Fatalf("%s env = %v", u.Label, u.Env)
		}
	}
	if !strings.HasPrefix(units[1].Env["PATH"], filepath.Dir(l.nodeBin())) {
		t.Fatalf("server PATH must lead with the bundled node: %s", units[1].Env["PATH"])
	}
}

func TestRenderLaunchdPlist(t *testing.T) {
	l := testLayout(t)
	u := studioUnits(l)[1]
	agent := renderLaunchdPlist(u, false, "tester")
	if strings.Contains(agent, "UserName") {
		t.Fatal("gui-domain plist must not carry UserName")
	}
	daemon := renderLaunchdPlist(u, true, "tester")
	for _, want := range []string{
		"<key>UserName</key><string>tester</string>",
		"<key>Label</key><string>com.ion.studio-server.tester</string>",
		"<string>" + l.nodeBin() + "</string><string>" + l.serverMain() + "</string>",
		"<key>ION_DATA_DIR</key><string>" + l.dataDir + "</string>",
		"<key>NODE_ENV</key><string>production</string>",
		"<key>ExitTimeOut</key><integer>30</integer>",
		"<key>SuccessfulExit</key><false/>",
	} {
		if !strings.Contains(daemon, want) {
			t.Fatalf("plist missing %q:\n%s", want, daemon)
		}
	}
	escaped := renderLaunchdPlist(serviceUnit{Label: "x", ProgramArgs: []string{"a&b"}, Env: map[string]string{}}, false, "")
	if !strings.Contains(escaped, "a&amp;b") {
		t.Fatal("plist must XML-escape program arguments")
	}
}

func TestRenderSystemdUnit(t *testing.T) {
	l := testLayout(t)
	engine := renderSystemdUnit(studioUnits(l)[0])
	server := renderSystemdUnit(studioUnits(l)[1])
	if strings.Contains(engine, "Wants=ion-engine.service") {
		t.Fatal("engine unit must not depend on itself")
	}
	for _, want := range []string{
		"After=ion-engine.service", "Wants=ion-engine.service",
		"ExecStart=" + l.nodeBin() + " " + l.serverMain(),
		"Environment=ION_DATA_DIR=" + l.dataDir,
		"Restart=on-failure", "WantedBy=default.target",
		"StandardError=append:" + filepath.Join(l.dataDir, "studio-server-stderr.log"),
	} {
		if !strings.Contains(server, want) {
			t.Fatalf("unit missing %q:\n%s", want, server)
		}
	}
}

func TestLaunchdManager_GuiDomainWhenLoadable(t *testing.T) {
	l := testLayout(t)
	r := &fakeRunner{results: map[string]fakeResult{"launchctl print gui/": {code: 0}}}
	m, err := newLaunchdManager(r, l, false)
	if err != nil {
		t.Fatal(err)
	}
	if m.system {
		t.Fatal("a loadable gui domain must select LaunchAgents")
	}
	if r.called("sudo") {
		t.Fatal("gui domain must never touch sudo")
	}
	if !strings.HasSuffix(m.plistPath(studioUnits(l)[0]), "/Library/LaunchAgents/com.ion.engine.plist") || !strings.HasPrefix(m.plistPath(studioUnits(l)[0]), l.home) {
		t.Fatalf("plist path = %s", m.plistPath(studioUnits(l)[0]))
	}
}

func TestLaunchdManager_SystemDomainWhenHeadlessWithPasswordlessSudo(t *testing.T) {
	l := testLayout(t)
	r := &fakeRunner{results: map[string]fakeResult{"sudo -n true": {code: 0}}}
	m, err := newLaunchdManager(r, l, false)
	if err != nil {
		t.Fatal(err)
	}
	if !m.system {
		t.Fatal("an unloadable gui domain must fall back to the system domain")
	}
	// The system domain is the whole host's, so the label names the account.
	if m.plistPath(studioUnits(l)[0]) != "/Library/LaunchDaemons/com.ion.engine.tester.plist" {
		t.Fatalf("plist path = %s", m.plistPath(studioUnits(l)[0]))
	}
	if m.target(studioUnits(l)[1]) != "system/com.ion.studio-server.tester" {
		t.Fatalf("target = %s", m.target(studioUnits(l)[1]))
	}
	if !strings.Contains(renderLaunchdPlist(studioUnits(l)[1], true, "tester"), "<key>Label</key><string>com.ion.studio-server.tester</string>") {
		t.Fatal("system plist must carry the account-qualified label")
	}
	if !strings.Contains(renderLaunchdPlist(studioUnits(l)[1], false, "tester"), "<key>Label</key><string>com.ion.studio-server</string>") {
		t.Fatal("gui plist keeps the bare label")
	}
}

// A headless install made before labels carried the account name left
// `/Library/LaunchDaemons/com.ion.studio-server.plist`. A reinstall boots
// that out and removes it -- only when it is this data dir's -- before
// bootstrapping the qualified label, so the host never runs both.
func TestLaunchdManager_RetiresLegacySystemLabelForThisDataDir(t *testing.T) {
	l := testLayout(t)
	r := &fakeRunner{results: map[string]fakeResult{"sudo -n true": {code: 0}, "sudo launchctl bootout system/com.ion.studio-server": {code: 0}, "sudo rm -f": {code: 0}}}
	m, err := newLaunchdManager(r, l, false)
	if err != nil {
		t.Fatal(err)
	}
	m.sleep = func(time.Duration) {}
	u := studioUnits(l)[1]
	legacy := filepath.Join(t.TempDir(), "com.ion.studio-server.plist")
	if err := os.WriteFile(legacy, []byte(renderLaunchdPlist(u, false, "")+"<key>ION_DATA_DIR</key><string>"+l.dataDir+"</string>"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Point the legacy path at the temp file by swapping the helper's root.
	orig := legacyDaemonsDir
	legacyDaemonsDir = filepath.Dir(legacy)
	defer func() { legacyDaemonsDir = orig }()
	if err := m.retireLegacyLabel(u); err != nil {
		t.Fatal(err)
	}
	if !r.called("sudo launchctl bootout system/com.ion.studio-server") || !r.called("sudo rm -f "+legacy) {
		t.Fatalf("legacy label must be booted out and removed: %v", r.calls)
	}

	// Someone else's install under the bare label is not ours to touch.
	r2 := &fakeRunner{results: map[string]fakeResult{"sudo -n true": {code: 0}}}
	m2, _ := newLaunchdManager(r2, l, false)
	if err := os.WriteFile(legacy, []byte("<key>ION_DATA_DIR</key><string>/Users/someone-else/.ion</string>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := m2.retireLegacyLabel(u); err != nil {
		t.Fatal(err)
	}
	if r2.called("sudo launchctl bootout") || r2.called("sudo rm -f") {
		t.Fatalf("another account's plist must be left alone: %v", r2.calls)
	}
}

func TestResolveStudioPort(t *testing.T) {
	l := testLayout(t)
	busy := map[int]bool{7331: true, 7332: true}
	free := func(p int) bool { return !busy[p] }

	// A fresh install with the default taken moves to the next free port.
	if port, err := resolveStudioPort(l, map[string]string{}, free); err != nil || port != 7333 {
		t.Fatalf("port = %d, err = %v", port, err)
	}
	// --port is honored when free and refused when busy.
	if port, err := resolveStudioPort(l, map[string]string{"port": "8000"}, free); err != nil || port != 8000 {
		t.Fatalf("port = %d, err = %v", port, err)
	}
	if _, err := resolveStudioPort(l, map[string]string{"port": "7331"}, free); err == nil {
		t.Fatal("a busy --port must be refused")
	}
	if _, err := resolveStudioPort(l, map[string]string{"port": "nope"}, free); err == nil {
		t.Fatal("a non-numeric --port must be refused")
	}
	// An existing server.json is authoritative, even when its port is busy
	// (it is busy because this install's own server is running on it).
	if err := os.MkdirAll(l.dataDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(l.dataDir, "server.json"), []byte(`{"listen":{"tcp":{"port":7332}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if port, err := resolveStudioPort(l, map[string]string{"port": "9000"}, free); err != nil || port != 7332 {
		t.Fatalf("port = %d, err = %v", port, err)
	}
	// A server.json that names no port means the server's own default.
	if err := os.WriteFile(filepath.Join(l.dataDir, "server.json"), []byte(`{"label":"x"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if port, err := resolveStudioPort(l, map[string]string{}, free); err != nil || port != studioServerPort {
		t.Fatalf("port = %d, err = %v", port, err)
	}
}

func TestLaunchdManager_HeadlessWithoutSudoAndNoTTYFails(t *testing.T) {
	if stdinIsTerminal() {
		t.Skip("stdin is a tty; the no-tty branch cannot be exercised here")
	}
	l := testLayout(t)
	r := &fakeRunner{results: map[string]fakeResult{"sudo -n true": {code: 1}}}
	_, err := newLaunchdManager(r, l, false)
	if err == nil || !strings.Contains(err.Error(), "ssh -t") {
		t.Fatalf("expected the ssh -t remediation, got %v", err)
	}
}

func TestLaunchdManager_EngineOwnedElsewhere(t *testing.T) {
	l := testLayout(t)
	r := &fakeRunner{results: map[string]fakeResult{
		"launchctl print gui/" + "": {code: 0},
	}}
	// Refine: the engine label prints a foreign program path.
	r.results["launchctl print gui/"+itoa(os.Getuid())+"/"+studioEngineLabel] = fakeResult{code: 0, out: "program = /Users/x/.ion/bin/ion\nstate = running\n"}
	m, err := newLaunchdManager(r, l, false)
	if err != nil {
		t.Fatal(err)
	}
	if !m.EngineOwnedElsewhere() {
		t.Fatal("a loaded engine at a foreign path must be reported as owned elsewhere")
	}
	own := &fakeRunner{results: map[string]fakeResult{"launchctl print gui/": {code: 0}}}
	own.results["launchctl print gui/"+itoa(os.Getuid())+"/"+studioEngineLabel] = fakeResult{code: 0, out: "program = " + l.ionBin() + "\n"}
	m2, _ := newLaunchdManager(own, l, false)
	if m2.EngineOwnedElsewhere() {
		t.Fatal("our own bundle path must not count as elsewhere")
	}
}

func TestLaunchdManager_InstallWritesAgentAndBootstraps(t *testing.T) {
	l := testLayout(t)
	r := &fakeRunner{results: map[string]fakeResult{"launchctl print gui/": {code: 0}, "launchctl bootstrap": {code: 0}}}
	m, _ := newLaunchdManager(r, l, false)
	u := studioUnits(l)[1]
	if err := m.Install(u); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(m.plistPath(u)); err != nil {
		t.Fatalf("plist not written: %v", err)
	}
	if !r.called("launchctl bootout gui/") || !r.called("launchctl bootstrap gui/") {
		t.Fatalf("calls = %v", r.calls)
	}
}

// A reinstall boots the old service out and must not bootstrap until launchd
// has finished tearing it down: a bootstrap inside that window fails with
// EIO. The fake reports the label loaded for two polls, then gone.
func TestLaunchdManager_InstallWaitsForUnloadAfterBootout(t *testing.T) {
	l := testLayout(t)
	u := studioUnits(l)[1]
	polls := 0
	r := &fakeRunner{results: map[string]fakeResult{"launchctl print gui/": {code: 0}, "launchctl bootstrap": {code: 0}, "launchctl bootout": {code: 0}}}
	m, _ := newLaunchdManager(r, l, false)
	m.sleep = func(time.Duration) {}
	// The unit's own print answers "loaded" twice, then "not found".
	label := "launchctl print gui/" + itoa(os.Getuid()) + "/" + u.Label
	r.results[label] = fakeResult{code: 0, out: "state = running"}
	// Wrap the runner so the label's print flips after two polls.
	wrapped := &pollingRunner{inner: r, label: label, flipAfter: 2, polls: &polls}
	m.r = wrapped
	if err := m.Install(u); err != nil {
		t.Fatal(err)
	}
	if polls < 3 {
		t.Fatalf("expected at least 3 unload polls before bootstrap, got %d", polls)
	}
	bootstrapIdx, lastPrintIdx := -1, -1
	for i, c := range r.calls {
		if strings.HasPrefix(c, "launchctl bootstrap") {
			bootstrapIdx = i
		}
		if strings.HasPrefix(c, label) {
			lastPrintIdx = i
		}
	}
	if bootstrapIdx < lastPrintIdx {
		t.Fatalf("bootstrap ran before the unload poll finished: calls = %v", r.calls)
	}
}

// pollingRunner answers `label` as loaded for the first flipAfter polls and
// as absent afterward, delegating everything else to inner.
type pollingRunner struct {
	inner     *fakeRunner
	label     string
	flipAfter int
	polls     *int
}

func (p *pollingRunner) Run(name string, args ...string) (string, int, error) {
	call := name + " " + strings.Join(args, " ")
	if strings.HasPrefix(call, p.label) {
		*p.polls++
		p.inner.calls = append(p.inner.calls, call)
		if *p.polls <= p.flipAfter {
			return "state = running", 0, nil
		}
		return "Could not find service", 113, nil
	}
	return p.inner.Run(name, args...)
}

func TestParseLaunchdPrint(t *testing.T) {
	st := parseLaunchdPrint("x", "\tstate = running\n\tpid = 4242\n")
	if st.State != "running" || st.PID != "4242" {
		t.Fatalf("%+v", st)
	}
	if st := parseLaunchdPrint("x", "\tstate = waiting\n"); st.State != "waiting" || st.PID != "" {
		t.Fatalf("%+v", st)
	}
}

func TestParseSystemdShow(t *testing.T) {
	st := parseSystemdShow("x", "ActiveState=active\nMainPID=99\n")
	if st.State != "running" || st.PID != "99" {
		t.Fatalf("%+v", st)
	}
	st = parseSystemdShow("x", "ActiveState=failed\nMainPID=0\n")
	if st.State != "stopped" || st.Detail != "failed" || st.PID != "" {
		t.Fatalf("%+v", st)
	}
}

func TestSystemdManager_InstallEnablesAndLingers(t *testing.T) {
	l := testLayout(t)
	r := &fakeRunner{results: map[string]fakeResult{"systemctl --user": {code: 0}, "loginctl enable-linger tester": {code: 0}}}
	m, err := newSystemdManager(r, l)
	if err != nil {
		t.Fatal(err)
	}
	u := studioUnits(l)[0]
	if err := m.Install(u); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(m.unitPath(u)); err != nil {
		t.Fatalf("unit not written: %v", err)
	}
	for _, want := range []string{"systemctl --user daemon-reload", "systemctl --user enable --now ion-engine.service", "loginctl enable-linger tester"} {
		if !r.called(want) {
			t.Fatalf("missing %q in %v", want, r.calls)
		}
	}
}

func TestPickStudioRelease(t *testing.T) {
	releases := []ghRelease{
		{TagName: "engine-v9.9.9", Assets: []ghAsset{{Name: "ion-studio-server-darwin-arm64.tar.gz", DownloadURL: "wrong"}}},
		{TagName: "server-v0.3.0", Prerelease: true, Assets: []ghAsset{{Name: "ion-studio-server-darwin-arm64.tar.gz", DownloadURL: "pre"}}},
		{TagName: "server-v0.2.0", Assets: []ghAsset{{Name: "ion-studio-server-darwin-arm64.tar.gz", DownloadURL: "u2"}}},
		{TagName: "server-v0.1.0", Assets: []ghAsset{{Name: "ion-studio-server-darwin-arm64.tar.gz", DownloadURL: "u1"}}},
	}
	asset := studioBundleAssetName("darwin", "arm64")
	v, u, err := pickStudioRelease(releases, "", asset)
	if err != nil || v != "0.2.0" || u != "u2" {
		t.Fatalf("latest = %s %s %v", v, u, err)
	}
	v, u, err = pickStudioRelease(releases, "0.1.0", asset)
	if err != nil || v != "0.1.0" || u != "u1" {
		t.Fatalf("pinned = %s %s %v", v, u, err)
	}
	if _, _, err := pickStudioRelease(releases, "", studioBundleAssetName("linux", "amd64")); err == nil {
		t.Fatal("a platform with no asset must error")
	}
}

func TestParseChecksums(t *testing.T) {
	m := parseChecksums("abc  ./ion-studio-server-linux-amd64.tar.gz\ndef  install-studio-server.sh\n\nbad line here\n")
	if m["ion-studio-server-linux-amd64.tar.gz"] != "abc" || m["install-studio-server.sh"] != "def" || len(m) != 2 {
		t.Fatalf("%v", m)
	}
}

func TestStudioServerConfigDefaults(t *testing.T) {
	l := testLayout(t)
	cfg, err := studioServerConfigDefaults(l, map[string]string{"label": "grover", "advertise-url": "http://grover.local:7331"})
	if err != nil {
		t.Fatal(err)
	}
	if !contains(cfg.scopes, "admin") {
		t.Fatalf("shared tenancy must grant admin by default: %v", cfg.scopes)
	}
	if cfg.tenancy != "shared" || cfg.json["tenancy"].(map[string]any)["mode"] != "shared" {
		t.Fatal("default tenancy must be shared")
	}
	if cfg.json["pairing"].(map[string]any)["advertiseUrl"] != "http://grover.local:7331" {
		t.Fatalf("advertiseUrl not carried into json: %v", cfg.json["pairing"])
	}
	iso, _ := studioServerConfigDefaults(l, map[string]string{"tenancy": "isolated"})
	if contains(iso.scopes, "admin") {
		t.Fatal("isolated tenancy must not grant admin by default")
	}
	if _, err := studioServerConfigDefaults(l, map[string]string{"tenancy": "weird"}); err == nil {
		t.Fatal("bad tenancy must be refused")
	}
	if _, err := studioServerConfigDefaults(l, map[string]string{"relay": "wss://r.example"}); err == nil {
		t.Fatal("--relay without --relay-key must be refused")
	}
	withRelay, _ := studioServerConfigDefaults(l, map[string]string{"relay": "wss://r.example", "relay-key": "k"})
	if len(withRelay.relays) != 1 || withRelay.relays[0]["url"] != "wss://r.example" || withRelay.relays[0]["psk"] != "k" {
		t.Fatalf("relays = %v", withRelay.relays)
	}
	if _, ok := withRelay.json["relays"]; !ok {
		t.Fatal("relays must land in the json shape")
	}
}

func TestDefaultAdvertiseURL(t *testing.T) {
	if got := defaultAdvertiseURL("darwin", "grover", 7331); got != "http://grover.local:7331" {
		t.Fatal(got)
	}
	if got := defaultAdvertiseURL("darwin", "grover.local", 7331); got != "http://grover.local:7331" {
		t.Fatal(got)
	}
	if got := defaultAdvertiseURL("linux", "box", 7331); got != "http://box:7331" {
		t.Fatal(got)
	}
}

func TestWriteServerConfigIfAbsent(t *testing.T) {
	dir := t.TempDir()
	wrote, err := writeServerConfigIfAbsent(dir, map[string]any{"label": "a"})
	if err != nil || !wrote {
		t.Fatalf("first write: %v %v", wrote, err)
	}
	wrote, err = writeServerConfigIfAbsent(dir, map[string]any{"label": "b"})
	if err != nil || wrote {
		t.Fatalf("second write must be a no-op: %v %v", wrote, err)
	}
	data, _ := os.ReadFile(filepath.Join(dir, "server.json"))
	var got map[string]any
	if err := json.Unmarshal(data, &got); err != nil || got["label"] != "a" {
		t.Fatalf("existing server.json must be kept: %s", data)
	}
}

func TestStudioPairArgs(t *testing.T) {
	got := studioPairArgs(map[string]string{"label": "my laptop", "scopes": "admin,git:write", "relay": "true", "json": "true"})
	want := []string{"--label", "my laptop", "--scopes", "admin,git:write", "--relay", "--json"}
	if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("got %v want %v", got, want)
	}
	if len(studioPairArgs(map[string]string{})) != 0 {
		t.Fatal("no flags must map to no args")
	}
}

func TestRepointCurrent(t *testing.T) {
	l := testLayout(t)
	v1 := filepath.Join(l.versions, "1")
	v2 := filepath.Join(l.versions, "2")
	for _, d := range []string{v1, v2} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := repointCurrent(l, v1); err != nil {
		t.Fatal(err)
	}
	if err := repointCurrent(l, v2); err != nil {
		t.Fatal(err)
	}
	target, err := os.Readlink(l.current)
	if err != nil || target != v2 {
		t.Fatalf("current -> %s (%v)", target, err)
	}
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func itoa(i int) string { return strconv.Itoa(i) }

func TestEnsureStudioEngineBackend(t *testing.T) {
	dir := t.TempDir()
	note, err := ensureStudioEngineBackend(dir)
	if err != nil {
		t.Fatalf("ensureStudioEngineBackend: %v", err)
	}
	if !strings.Contains(note, "set backend") {
		t.Errorf("note = %q, want a write", note)
	}
	data, err := os.ReadFile(filepath.Join(dir, "engine.json"))
	if err != nil {
		t.Fatalf("read engine.json: %v", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("engine.json is not JSON: %v", err)
	}
	if raw["backend"] != "hybrid" {
		t.Errorf("backend = %v, want hybrid", raw["backend"])
	}

	// An explicit backend is the operator's.
	if err := os.WriteFile(filepath.Join(dir, "engine.json"), []byte(`{"backend":"api"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	note, err = ensureStudioEngineBackend(dir)
	if err != nil {
		t.Fatalf("ensureStudioEngineBackend: %v", err)
	}
	if !strings.Contains(note, `kept backend "api"`) {
		t.Errorf("note = %q, want the explicit value kept", note)
	}
}
